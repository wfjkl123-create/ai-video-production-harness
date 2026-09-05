import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { compileAssetManifest, requiresObservedHandoff } from '../services/asset-service.js';
import { assertArtifact } from '../domain/artifact.js';
import { option } from './args.js';
import { verifyLockedArtifact } from '../services/artifact-file-service.js';
import { verifyObservedHandoffEvidence } from '../services/handoff-evidence-service.js';

function canonicalSegmentOrder(segments) {
  return [...segments].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function positiveDuration(segment) {
  return Number.isFinite(segment?.duration) && segment.duration > 0 ? Number(segment.duration) : null;
}

function isCurrentArtifact(artifact) {
  return typeof artifact?.invalidatedByScopeRevisionId !== 'string';
}

// A reviewed story plan may use editorial unit IDs (A1, B1, …) while the
// locked generation segmentation uses canonical IDs (segment-001, …).  The
// director route service already reconciles those IDs for prompt compilation;
// asset compilation must use the same conservative bridge instead of silently
// dropping all asset requirements.  Mapping is allowed only for a complete,
// ordered, final-edit-duration-identical one-to-one correspondence.  A
// platform generation container may legitimately be longer than the final
// source interval (for example, a 2.2s source window in a 4s minimum-duration
// generation unit), but it must never be shorter.
async function resolveCapabilityRequirements(root, project, segments) {
  if (!project.verifiedCapabilityManifestId) return null;
  const artifact = (project.artifacts ?? []).find(item => item.id === project.verifiedCapabilityManifestId
    && item.type === 'capability_manifest'
    && item.status === 'locked'
    && typeof item.invalidatedByScopeRevisionId !== 'string');
  if (!artifact) throw new Error('verified capability manifest is missing or unlocked');
  await verifyLockedArtifact(root, artifact);
  const manifest = await readJson(join(root, artifact.path));
  const routedIds = [...new Set((manifest.shots ?? []).map(shot => shot?.segmentId).filter(Boolean))];
  const canonical = canonicalSegmentOrder(segments);
  const canonicalIds = new Set(canonical.map(item => item.id));
  const requirements = manifest.requiredAssetsBySegment ?? {};
  const artifacts = manifest.requiredArtifactsBySegment ?? {};
  if (routedIds.every(id => canonicalIds.has(id))) {
    return { assetsBySegment: requirements, artifactsBySegment: artifacts, identityMap: null };
  }
  if (routedIds.some(id => canonicalIds.has(id))) {
    throw new Error('capability manifest mixes canonical and editorial segment IDs; create a reviewed reconciliation instead of guessing');
  }
  const guidance = manifest.executability?.generationGuidance;
  if (!Array.isArray(guidance) || routedIds.length === 0 || routedIds.length !== canonical.length || guidance.length !== routedIds.length) {
    throw new Error('capability manifest and locked segmentation cannot be reconciled one-to-one for asset requirements');
  }
  const assetsBySegment = {};
  const artifactsBySegment = {};
  const identityMap = {};
  for (let index = 0; index < routedIds.length; index += 1) {
    const sourceId = routedIds[index];
    const target = canonical[index];
    const guidanceEntry = guidance[index];
    const duration = positiveDuration(target);
    if (!duration || guidanceEntry?.segmentId !== sourceId
      || guidanceEntry.finalEditDurationSec !== duration
      || !Number.isFinite(guidanceEntry.generationDurationSec)
      || guidanceEntry.generationDurationSec + 0.001 < duration) {
      throw new Error('capability manifest and locked segmentation disagree in order or duration; do not remap asset requirements');
    }
    identityMap[sourceId] = target.id;
    assetsBySegment[target.id] = structuredClone(requirements[sourceId] ?? []);
    artifactsBySegment[target.id] = structuredClone(artifacts[sourceId] ?? []);
  }
  return { assetsBySegment, artifactsBySegment, identityMap };
}

async function resolveAssetSuccessorLedger(root, project, storyPlan) {
  const candidates = (project.artifacts ?? [])
    .filter(artifact => artifact.type === 'segment_contract' && artifact.status === 'locked' && isCurrentArtifact(artifact))
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  const matches = [];
  for (const artifact of candidates) {
    await verifyLockedArtifact(root, artifact);
    const document = await readJson(resolve(root, artifact.path));
    if (document?.kind !== 'asset_successor_resolution_ledger') continue;
    if (document.sourceStoryPlanId !== storyPlan.id || document.sourceStoryPlanSha256 !== storyPlan.sha256) continue;
    matches.push({ artifact, document });
  }
  if (matches.length === 0) return null;
  const topRevision = matches[0].artifact.revision;
  const latest = matches.filter(({ artifact }) => artifact.revision === topRevision);
  if (latest.length !== 1) throw new Error(`multiple locked asset successor ledgers have revision ${topRevision}`);

  const resolved = {};
  const targets = new Set();
  for (const mapping of latest[0].document.mappings ?? []) {
    if (mapping?.scopeChange !== false || mapping?.resolution !== 'use_successor_only') {
      throw new Error('asset successor ledger contains a scope-changing or non-final mapping');
    }
    if (typeof mapping.fromAssetId !== 'string' || typeof mapping.toAssetId !== 'string' || typeof mapping.assetType !== 'string') {
      throw new Error('asset successor ledger contains an incomplete mapping');
    }
    if (resolved[mapping.fromAssetId]) throw new Error(`asset successor ledger repeats source ${mapping.fromAssetId}`);
    if (targets.has(mapping.toAssetId)) throw new Error(`asset successor ledger repeats target ${mapping.toAssetId}`);
    const target = (project.artifacts ?? []).find(artifact => artifact.id === mapping.toAssetId && isCurrentArtifact(artifact));
    if (!target || target.status !== 'locked' || !['project_asset', 'segment_asset'].includes(target.type)) {
      throw new Error(`asset successor ledger target ${mapping.toAssetId} is missing, unlocked, or not an asset`);
    }
    resolved[mapping.fromAssetId] = mapping.toAssetId;
    targets.add(mapping.toAssetId);
  }
  return resolved;
}

export async function loadCanonicalSegments(root, project, { requireLockedSegmentation = false } = {}) {
  const lockedSegmentations = (project.artifacts ?? [])
    .filter(artifact => artifact.type === 'segmentation' && artifact.status === 'locked' && isCurrentArtifact(artifact))
    .map(assertArtifact)
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (lockedSegmentations.length > 0) {
    if (lockedSegmentations.length > 1 && lockedSegmentations[0].revision === lockedSegmentations[1].revision) {
      throw new Error(`multiple locked segmentation artifacts have revision ${lockedSegmentations[0].revision}`);
    }
    await verifyLockedArtifact(root, lockedSegmentations[0]);
    const persisted = await readJson(resolve(root, lockedSegmentations[0].path));
    const segments = Array.isArray(persisted) ? persisted : persisted?.segments;
    if (!Array.isArray(segments)) throw new Error('locked segmentation artifact must contain a segments array');
    return segments;
  }

  if (requireLockedSegmentation) throw new Error('a locked segmentation artifact is required');

  const segmentDirectory = join(root, 'segments');
  const entries = await readdir(segmentDirectory);
  const segmentFiles = entries.filter((entry) => entry.endsWith('.json') && !entry.startsWith('._'));
  return Promise.all(segmentFiles.map((entry) => readJson(join(segmentDirectory, entry))));
}

export async function compileProjectAssetManifest(root, segmentId) {
  root = resolve(root);
  const project = await readJson(join(root, 'project-state.json'));
  let verifiedStoryPlanId = null;
  let verifiedStoryPlan = null;
  if ((project.workflowVersion ?? 1) >= 2) {
    const plans = (project.artifacts ?? [])
      .filter(artifact => artifact.type === 'story_plan' && artifact.status === 'locked' && isCurrentArtifact(artifact))
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
    if (plans.length === 0) throw new Error('workflowVersion 2 requires a locked human-reviewed story_plan before asset compilation');
    if (plans.length > 1 && plans[0].revision === plans[1].revision) throw new Error(`multiple locked story_plan artifacts have revision ${plans[0].revision}`);
    await verifyLockedArtifact(root, plans[0]);
    verifiedStoryPlanId = plans[0].id;
    verifiedStoryPlan = plans[0];
  }
  const segments = await loadCanonicalSegments(root, project);
  const resolvedCapabilityRequirements = await resolveCapabilityRequirements(root, project, segments);
  const resolvedAssetSuccessorMap = verifiedStoryPlan
    ? await resolveAssetSuccessorLedger(root, project, verifiedStoryPlan)
    : null;
  const verifiedSegmentation = (project.artifacts ?? [])
    .filter(artifact => artifact.type === 'segmentation' && artifact.status === 'locked' && isCurrentArtifact(artifact))
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0] ?? null;
  const segment = segments.find(({ id }) => id === segmentId);
  if (!segment) throw new Error(`segment not found: ${segmentId}`);
  const verifiedObservedHandoffIds = [];
  const segmentIndex = segments.indexOf(segment);
  if (requiresObservedHandoff(segment, segmentIndex)) {
    const previousId = segment.previousSegmentId;
    const matches = (project.artifacts ?? []).filter(artifact => artifact.type === 'handoff'
      && artifact.segmentId === previousId && artifact.status === 'locked' && artifact.observed === true
      && isCurrentArtifact(artifact));
    if (matches.length !== 1) throw new Error(`a unique locked observed handoff for ${previousId} is required`);
    const evidence = await verifyObservedHandoffEvidence(root, matches[0]);
    verifiedObservedHandoffIds.push(evidence.artifactId);
  }
  return compileAssetManifest({
    ...project,
    segments,
    verifiedObservedHandoffIds,
    verifiedStoryPlanId,
    verifiedSegmentationId: verifiedSegmentation?.id ?? null,
    verifiedSegmentationRevision: verifiedSegmentation?.revision ?? null,
    verifiedSegmentationSha256: verifiedSegmentation?.sha256 ?? null,
    ...(resolvedAssetSuccessorMap ? { resolvedAssetSuccessorMap } : {}),
    ...(resolvedCapabilityRequirements ? {
      resolvedCapabilityRequirementsBySegment: resolvedCapabilityRequirements.assetsBySegment,
      resolvedCapabilityArtifactsBySegment: resolvedCapabilityRequirements.artifactsBySegment,
      capabilitySegmentIdentityMap: resolvedCapabilityRequirements.identityMap
    } : {})
  }, segment);
}

export async function runAssets(args) {
  return compileProjectAssetManifest(resolve(option(args, 'project')), option(args, 'segment'));
}
