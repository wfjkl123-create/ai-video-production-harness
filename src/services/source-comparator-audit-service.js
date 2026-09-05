import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { assertSourceFactAnalysis } from '../domain/source-fact-analysis.js';
import { assertStoryPlan } from '../domain/story-plan.js';
import { assertSourceComparatorAudit, buildSourceComparatorAudit } from '../domain/source-comparator-audit.js';
import { currentArtifactOf } from '../domain/current-artifact.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { verifyArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';

export function sourceComparatorAuditDirectory(root) {
  return join(resolve(root), 'planning', 'source-comparator-audits');
}

async function existingAudits(root) {
  const directory = sourceComparatorAuditDirectory(root);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('._')).sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    const audit = assertSourceComparatorAudit(await readJson(join(directory, entry.name)));
    if (entry.name !== `${audit.id}.json`) throw new Error(`source comparator audit filename does not match id: ${entry.name}`);
    return { audit, name: entry.name };
  }));
}

function chooseArtifact(state, type, requestedId, allowedStatuses) {
  const artifact = currentArtifactOf(state.artifacts, candidate => candidate.type === type
    && allowedStatuses.includes(candidate.status)
    && (requestedId === undefined || candidate.id === requestedId));
  if (!artifact) throw new Error(`source comparator requires exactly one current ${allowedStatuses.join('/')} ${type}, found 0`);
  return artifact;
}

async function resolveInputs(root, request, options) {
  if (options.requireProjectBinding === false
    && request.sourceAnalysis && request.storyPlan && request.sourceAnalysisBinding && request.storyPlanBinding) return request;
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const sourceArtifact = chooseArtifact(state, 'source_fact_analysis', request.sourceAnalysisId ?? request.sourceAnalysisBinding?.artifactId, ['locked']);
  const storyArtifact = chooseArtifact(state, 'story_plan', request.storyPlanId ?? request.storyPlanBinding?.artifactId, ['draft', 'awaiting_review']);
  const sourceFile = await verifyLockedArtifact(root, sourceArtifact);
  const storyFile = await verifyArtifactFile(root, storyArtifact);
  const sourceAnalysis = assertSourceFactAnalysis(await readJson(sourceFile.path));
  const storyPlan = assertStoryPlan(await readJson(storyFile.path));
  if (sourceAnalysis.projectId !== state.projectId || storyPlan.projectId !== state.projectId) throw new Error('source comparator inputs must belong to the current project');
  return {
    sourceAnalysis,
    storyPlan,
    sourceAnalysisBinding: { artifactId: sourceArtifact.id, artifactRevision: sourceArtifact.revision, artifactSha256: sourceFile.sha256 },
    storyPlanBinding: { artifactId: storyArtifact.id, artifactRevision: storyArtifact.revision, artifactSha256: storyFile.sha256 }
  };
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must produce a valid date');
  return date.toISOString();
}

export async function persistSourceComparatorAudit(root, request = {}, options = {}) {
  root = resolve(root);
  const input = await resolveInputs(root, request, options);
  const candidate = buildSourceComparatorAudit(input, { createdAt: timestamp(options.now ?? (() => new Date())) });
  return withProjectLock(root, async () => {
    const existing = await existingAudits(root);
    const reusable = existing.find(item => item.audit.inputFingerprintSha256 === candidate.inputFingerprintSha256);
    if (reusable) return { audit: reusable.audit, path: `planning/source-comparator-audits/${reusable.name}`, reused: true };
    const path = `planning/source-comparator-audits/${candidate.id}.json`;
    await (options.write ?? writeJsonAtomic)(join(root, path), candidate);
    return { audit: candidate, path, reused: false };
  });
}

export async function requirePassingSourceComparatorAudit(root, storyPlanArtifact) {
  root = resolve(root);
  const storyFile = await verifyArtifactFile(root, storyPlanArtifact);
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const audits = await existingAudits(root);
  const storyMatches = audits.filter(item => item.audit.storyPlanBinding.artifactId === storyPlanArtifact.id
    && item.audit.storyPlanBinding.artifactRevision === storyPlanArtifact.revision
    && item.audit.storyPlanBinding.artifactSha256 === storyFile.sha256);
  const matches = [];
  for (const item of storyMatches) {
    const binding = item.audit.sourceAnalysisBinding;
    const sourceArtifact = currentArtifactOf(state.artifacts, artifact => artifact.type === 'source_fact_analysis'
      && artifact.status === 'locked' && artifact.id === binding.artifactId
      && artifact.revision === binding.artifactRevision && artifact.sha256 === binding.artifactSha256);
    if (!sourceArtifact) continue;
    await verifyLockedArtifact(root, sourceArtifact);
    matches.push(item);
  }
  if (matches.length !== 1) throw new Error(`Gate 2 requires exactly one source comparator audit for the current story plan fingerprint, found ${matches.length}`);
  if (matches[0].audit.decision !== 'PASS' || matches[0].audit.gateEffect !== 'GATE_2_ELIGIBLE') {
    throw new Error(`Gate 2 blocked by source comparator audit ${matches[0].audit.id}`);
  }
  return matches[0].audit;
}
