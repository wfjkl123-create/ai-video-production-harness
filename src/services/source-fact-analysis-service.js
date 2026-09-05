import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertSourceFactAnalysis,
  buildSourceFactAnalysis,
  sourceFactInputFingerprint
} from '../domain/source-fact-analysis.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { assertProjectState } from '../domain/project-state.js';
import { registerArtifact } from './intake-service.js';
import { autoLockArtifact } from './review-service.js';
import { verifyLockedArtifact } from './artifact-file-service.js';

export function sourceFactAnalysisDirectory(root) {
  return join(resolve(root), 'planning', 'source-facts');
}

async function existingAnalyses(root) {
  const directory = sourceFactAnalysisDirectory(root);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('._'))
    .map(entry => entry.name)
    .sort();
  const analyses = await Promise.all(files.map(async name => ({
    name,
    analysis: assertSourceFactAnalysis(await readJson(join(directory, name)))
  })));
  for (const item of analyses) {
    if (item.name !== `${item.analysis.id}.json`) {
      throw new Error(`source fact filename does not match persisted analysis id: ${item.name}`);
    }
  }
  const revisions = analyses.map(item => item.analysis.revision);
  if (new Set(revisions).size !== revisions.length) throw new Error('source fact revisions must be unique');
  return analyses;
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must produce a valid date');
  return date.toISOString();
}

export async function persistSourceFactAnalysis(root, input, options = {}) {
  root = resolve(root);
  if (options.requireProjectBinding !== false) {
    const state = assertProjectState(await readJson(join(root, 'project-state.json')));
    if (state.projectId !== input.projectId) throw new Error('source fact analysis projectId does not match project state');
    const reference = state.artifacts.find(artifact => artifact.id === input.referenceVideo?.artifactId
      && artifact.type === 'reference_video' && artifact.status === 'locked'
      && artifact.revision === input.referenceVideo?.artifactRevision
      && artifact.sha256 === input.referenceVideo?.artifactSha256);
    if (!reference) throw new Error('source fact analysis requires the exact locked reference video artifact revision and SHA');
    await verifyLockedArtifact(root, reference);
  }
  const requestedFingerprint = sourceFactInputFingerprint(input);
  const requestedProjectId = input.projectId.trim();
  const persisted = await withProjectLock(root, async () => {
    const existing = await existingAnalyses(root);
    const foreign = existing.find(item => item.analysis.projectId !== requestedProjectId);
    if (foreign) throw new Error('planning/source-facts contains an analysis for a different projectId');
    const currentState = options.requireProjectBinding === false
      ? null
      : assertProjectState(await readJson(join(root, 'project-state.json')));
    const reusable = existing
      .filter(item => item.analysis.contentFingerprintSha256 === requestedFingerprint)
      .sort((left, right) => right.analysis.revision - left.analysis.revision)
      .find(item => {
        if (!currentState) return true;
        const artifact = currentState.artifacts.find(candidate => candidate.id === item.analysis.id
          && candidate.type === 'source_fact_analysis');
        return !artifact?.invalidatedByScopeRevisionId;
      });
    if (reusable) {
      return {
        analysis: reusable.analysis,
        path: `planning/source-facts/${reusable.name}`,
        reused: true
      };
    }

    const revision = Math.max(0, ...existing.map(item => item.analysis.revision)) + 1;
    const analysis = buildSourceFactAnalysis(input, {
      revision,
      createdAt: timestamp(options.now ?? (() => new Date()))
    });
    const name = `${analysis.id}.json`;
    const path = `planning/source-facts/${name}`;
    await (options.write ?? writeJsonAtomic)(join(root, path), analysis);
    return { analysis, path, reused: false };
  });
  if (options.publishArtifact === false) return persisted;

  const descriptor = {
    id: persisted.analysis.id,
    type: 'source_fact_analysis',
    revision: persisted.analysis.revision,
    status: 'draft',
    path: persisted.path,
    sourceVideoId: persisted.analysis.referenceVideo.artifactId,
    sourceVideoRevision: persisted.analysis.referenceVideo.artifactRevision,
    sourceVideoSha256: persisted.analysis.referenceVideo.artifactSha256,
    contentFingerprintSha256: persisted.analysis.contentFingerprintSha256
  };
  let state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const predecessor = state.artifacts
    .filter(item => item.type === 'source_fact_analysis'
      && item.status === 'locked'
      && item.sourceVideoId === descriptor.sourceVideoId
      && item.id !== descriptor.id)
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id))[0];
  if (predecessor) descriptor.supersedesArtifactId = predecessor.id;
  let artifact = state.artifacts.find(item => item.id === descriptor.id);
  if (!artifact) {
    try {
      artifact = await registerArtifact(root, descriptor);
    } catch (error) {
      if (!/artifact already exists/.test(error.message)) throw error;
      state = assertProjectState(await readJson(join(root, 'project-state.json')));
      artifact = state.artifacts.find(item => item.id === descriptor.id);
    }
  }
  if (!artifact || artifact.type !== 'source_fact_analysis'
    || artifact.contentFingerprintSha256 !== persisted.analysis.contentFingerprintSha256) {
    throw new Error('source fact artifact registration conflicts with the persisted analysis');
  }
  await autoLockArtifact(root, artifact.id, 'Adaptive source analysis passed deterministic evidence validation');
  state = assertProjectState(await readJson(join(root, 'project-state.json')));
  return { ...persisted, artifact: state.artifacts.find(item => item.id === artifact.id) };
}
