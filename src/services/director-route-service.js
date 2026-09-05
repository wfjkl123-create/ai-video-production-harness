import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { assertProjectState } from '../domain/project-state.js';
import { assertStoryPlan } from '../domain/story-plan.js';
import { assertCapabilityManifest, compileDirectorCapabilityManifest, DIRECTOR_ROUTE_VERSION } from '../domain/director-capability.js';
import { verifyArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { registerArtifact } from './intake-service.js';
import { autoLockArtifact } from './review-service.js';
import { withProjectLock } from '../storage/project-lock.js';
import { loadCanonicalSegments } from '../commands/assets.js';

function latestLockedStoryPlan(state, requestedId) {
  const candidates = state.artifacts
    .filter(item => item.type === 'story_plan'
      && item.status === 'locked'
      && typeof item.invalidatedByScopeRevisionId !== 'string'
      && (!requestedId || item.id === requestedId))
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id));
  if (candidates.length === 0) throw new Error(`a locked story_plan is required${requestedId ? `: ${requestedId}` : ''}`);
  if (candidates.length > 1 && candidates[0].revision === candidates[1].revision) throw new Error(`multiple locked story_plan artifacts have revision ${candidates[0].revision}`);
  return candidates[0];
}

function durationOfCanonicalSegment(segment) {
  if (Number.isFinite(segment?.duration)) return Number(segment.duration);
  if (Array.isArray(segment?.timeRange) && segment.timeRange.length === 2
    && Number.isFinite(segment.timeRange[0]) && Number.isFinite(segment.timeRange[1])) {
    return Number(segment.timeRange[1]) - Number(segment.timeRange[0]);
  }
  return null;
}

function remapSegmentKeyedRecord(value, identityMap) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([segmentId, entry]) => [identityMap.get(segmentId) ?? segmentId, entry]));
}

// The story plan and the locked segmentation are independently reviewed contracts.
// A legacy-friendly story plan can use editorial unit IDs (for example u01), while
// the generation plan uses canonical segment IDs. We may bridge only when the two
// locked contracts prove an exact, ordered, duration-preserving one-to-one mapping.
// Any partial or ambiguous mapping remains a hard error rather than silently moving
// work across segments.
export function reconcileCapabilityManifestSegmentIds(manifest, canonicalSegments) {
  // Some workflow-v2 projects intentionally defer the canonical segmentation
  // artifact until segment execution. With no canonical contract to compare,
  // preserve the exact reviewed story-plan IDs instead of inventing a map.
  if (canonicalSegments.length === 0) return { manifest, segmentIdentityMap: null };
  const routedSegmentIds = [...new Set(manifest.shots.map(shot => shot.segmentId))];
  const canonicalIds = canonicalSegments.map(segment => segment?.id);
  if (routedSegmentIds.every(segmentId => canonicalIds.includes(segmentId))) {
    const guidance = manifest.executability?.generationGuidance;
    if (!Array.isArray(guidance) || guidance.length !== routedSegmentIds.length) {
      throw new Error('capability manifest and locked segmentation require one exact duration record per named segment');
    }
    for (const canonical of canonicalSegments) {
      const expectedDuration = durationOfCanonicalSegment(canonical);
      const entry = guidance.find(item => item?.segmentId === canonical.id);
      if (expectedDuration === null || !entry
        || Math.abs(entry.finalEditDurationSec - expectedDuration) > 0.001
        || entry.generationDurationSec + 0.001 < expectedDuration) {
        throw new Error(`capability manifest and locked segmentation disagree for ${canonical?.id ?? 'unknown'}; create a reviewed segmentation replacement instead of silently reusing the named segment`);
      }
    }
    return { manifest, segmentIdentityMap: null };
  }
  if (routedSegmentIds.some(segmentId => canonicalIds.includes(segmentId))) {
    throw new Error('capability manifest mixes canonical and non-canonical segment identities; create a reviewed reconciliation instead of guessing a map');
  }
  const guidance = manifest.executability?.generationGuidance;
  if (!Array.isArray(guidance) || routedSegmentIds.length !== canonicalSegments.length || guidance.length !== routedSegmentIds.length) {
    throw new Error('capability manifest and locked segmentation cannot be reconciled one-to-one; create a reviewed story-plan replacement');
  }
  const identityMap = new Map();
  for (let index = 0; index < routedSegmentIds.length; index += 1) {
    const routedId = routedSegmentIds[index];
    const canonical = canonicalSegments[index];
    const canonicalDuration = durationOfCanonicalSegment(canonical);
    const guidanceEntry = guidance[index];
    if (!canonical?.id || canonicalDuration === null || guidanceEntry?.segmentId !== routedId
      || guidanceEntry.finalEditDurationSec !== canonicalDuration
      || guidanceEntry.generationDurationSec + 0.001 < canonicalDuration) {
      throw new Error('capability manifest and locked segmentation differ in order or duration; create a reviewed story-plan replacement');
    }
    identityMap.set(routedId, canonical.id);
  }
  const remapped = assertCapabilityManifest({
    ...manifest,
    shots: manifest.shots.map(shot => ({ ...shot, segmentId: identityMap.get(shot.segmentId) })),
    requiredAssetsBySegment: remapSegmentKeyedRecord(manifest.requiredAssetsBySegment, identityMap),
    requiredArtifactsBySegment: remapSegmentKeyedRecord(manifest.requiredArtifactsBySegment, identityMap),
    executability: {
      ...manifest.executability,
      generationGuidance: guidance.map(entry => ({ ...entry, segmentId: identityMap.get(entry.segmentId) }))
    }
  }, { allowLegacyMissingProjectRequiredAssets: true });
  return {
    manifest: remapped,
    segmentIdentityMap: Object.fromEntries(identityMap)
  };
}

export async function routeLockedStoryPlan(root, requestedId) {
  let state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const storyArtifact = latestLockedStoryPlan(state, requestedId);
  const inspected = await verifyLockedArtifact(root, storyArtifact);
  const plan = assertStoryPlan(await readJson(inspected.path));
  if (plan.schemaVersion !== 2) {
    const error = new Error(`locked story plan ${storyArtifact.id} uses schemaVersion ${plan.schemaVersion}; create a schemaVersion 2 replacement and review it at the existing Gate 2 before director routing`);
    error.code = 'DIRECTOR_ROUTE_STORY_PLAN_V2_REQUIRED';
    throw error;
  }
  const existing = state.artifacts.find(item => item.type === 'capability_manifest'
    && item.storyPlanId === storyArtifact.id && item.storyPlanSha256 === storyArtifact.sha256
    && item.routeVersion === DIRECTOR_ROUTE_VERSION
    && typeof item.invalidatedByScopeRevisionId !== 'string');
  if (existing?.status === 'locked') {
    const existingFile = await verifyLockedArtifact(root, existing);
    assertCapabilityManifest(await readJson(existingFile.path), { allowLegacyMissingProjectRequiredAssets: true });
    if (state.verifiedCapabilityManifestId !== existing.id || state.directorRoutingVersion !== 1) {
      await withProjectLock(root, async () => {
        const statePath = join(root, 'project-state.json');
        const current = assertProjectState(await readJson(statePath));
        current.verifiedCapabilityManifestId = existing.id;
        current.directorRoutingVersion = 1;
        current.updatedAt = new Date().toISOString();
        assertProjectState(current);
        await writeJsonAtomic(statePath, current);
      });
    }
    return { artifact: existing, reused: true };
  }
  if (existing && !['draft', 'rework'].includes(existing.status)) throw new Error(`existing capability manifest ${existing.id} is ${existing.status}; resolve it before rerouting`);

  const manifest = assertCapabilityManifest(compileDirectorCapabilityManifest(plan, {
    storyPlanId: storyArtifact.id,
    storyPlanSha256: inspected.sha256
  }));
  const relativePath = `planning/capability-manifests/${manifest.id}.json`;
  if (existing) {
    const existingFile = await verifyArtifactFile(root, existing);
    const existingManifest = assertCapabilityManifest(await readJson(existingFile.path), { allowLegacyMissingProjectRequiredAssets: true });
    if (existingManifest.id !== manifest.id
      || existingManifest.storyPlanId !== storyArtifact.id
      || existingManifest.storyPlanSha256 !== inspected.sha256) {
      throw new Error(`existing capability manifest ${existing.id} does not match the exact locked story plan`);
    }
  } else {
    await writeJsonAtomic(join(root, relativePath), manifest);
  }
  const artifact = existing ?? await registerArtifact(root, {
    id: manifest.id,
    type: 'capability_manifest',
    revision: storyArtifact.revision,
    status: 'draft',
    path: relativePath,
    storyPlanId: storyArtifact.id,
    storyPlanSha256: inspected.sha256,
    routeVersion: manifest.routeVersion,
    routePrecision: manifest.routePrecision,
    storyPlanSchemaVersion: manifest.storyPlanSchemaVersion,
    segmentIds: Object.keys(manifest.requiredAssetsBySegment),
    projectRequiredAssets: structuredClone(manifest.projectRequiredAssets),
    requiredAssetsBySegment: structuredClone(manifest.requiredAssetsBySegment),
    requiredArtifactsBySegment: structuredClone(manifest.requiredArtifactsBySegment)
  });
  await autoLockArtifact(root, artifact.id, 'auto-locked: deterministic director capability route compiled from the exact locked story plan');

  await withProjectLock(root, async () => {
    const statePath = join(root, 'project-state.json');
    const current = assertProjectState(await readJson(statePath));
    const locked = current.artifacts.find(item => item.id === artifact.id && item.type === 'capability_manifest' && item.status === 'locked');
    if (!locked) throw new Error('capability manifest was not locked after routing');
    const currentStory = current.artifacts.find(item => item.id === storyArtifact.id
      && item.status === 'locked'
      && typeof item.invalidatedByScopeRevisionId !== 'string');
    if (!currentStory || currentStory.sha256 !== inspected.sha256) throw new Error('story plan changed before capability route activation');
    current.verifiedCapabilityManifestId = locked.id;
    current.directorRoutingVersion = 1;
    current.updatedAt = new Date().toISOString();
    assertProjectState(current);
    await writeJsonAtomic(statePath, current);
    state = current;
  });
  return { artifact: state.artifacts.find(item => item.id === artifact.id), reused: false, manifest };
}

export async function loadVerifiedCapabilityManifest(root, state, { segmentId } = {}) {
  if (!state.verifiedCapabilityManifestId) return null;
  const artifact = state.artifacts.find(item => item.id === state.verifiedCapabilityManifestId && item.type === 'capability_manifest');
  if (!artifact || artifact.status !== 'locked') throw new Error('verified capability manifest must reference a locked artifact');
  if (typeof artifact.invalidatedByScopeRevisionId === 'string') {
    throw new Error(`verified capability manifest ${artifact.id} was invalidated by ${artifact.invalidatedByScopeRevisionId}`);
  }
  const inspected = await verifyLockedArtifact(root, artifact);
  const persistedManifest = assertCapabilityManifest(await readJson(inspected.path), { allowLegacyMissingProjectRequiredAssets: true });
  const canonicalSegments = await loadCanonicalSegments(root, state, { requireLockedSegmentation: false });
  const { manifest, segmentIdentityMap } = reconcileCapabilityManifestSegmentIds(persistedManifest, canonicalSegments);
  if (manifest.shots.some(shot => shot.legacyInference !== false)) {
    throw new Error('verified capability manifest contains legacy inference; replace its story plan with schemaVersion 2 before continuing');
  }
  if (manifest.id !== artifact.id || manifest.storyPlanId !== artifact.storyPlanId || manifest.storyPlanSha256 !== artifact.storyPlanSha256) {
    throw new Error('capability manifest identity does not match its artifact descriptor');
  }
  if (artifact.routePrecision !== 'explicit_v2' || artifact.storyPlanSchemaVersion !== 2) {
    throw new Error('verified capability artifact descriptor does not prove explicit schemaVersion 2 routing');
  }
  if (segmentId && !manifest.shots.some(shot => shot.segmentId === segmentId)) throw new Error(`capability manifest has no routed shot for ${segmentId}`);
  return { artifact, manifest, sha256: inspected.sha256, segmentIdentityMap };
}
