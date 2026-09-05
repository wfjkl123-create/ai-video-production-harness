import { join } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { assertProjectState } from '../domain/project-state.js';
import { assertStoryPlan, storyPlanSegmentationFingerprint } from '../domain/story-plan.js';
import { assertCapabilityManifest, compileDirectorCapabilityManifest } from '../domain/director-capability.js';
import { verifyArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { autoLockArtifact } from './review-service.js';
import { reconcileCapabilityManifestSegmentIds } from './director-route-service.js';

function requireCandidate(plan) {
  const candidate = plan.segmentationCandidate;
  if (!candidate) return null;
  if (!candidate.artifactId) throw new Error('story plan segmentationCandidate must name an artifactId');
  return candidate;
}

async function loadCandidate(root, storyArtifact, plan, storyPlanSha256) {
  const binding = requireCandidate(plan);
  if (!binding) return null;
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const candidate = state.artifacts.find(item => item.id === binding.artifactId);
  if (!candidate || candidate.type !== 'segmentation') {
    throw new Error(`story plan ${storyArtifact.id} requires segmentation candidate ${binding.artifactId}, but no matching segmentation artifact exists`);
  }
  if (!['draft', 'rework', 'awaiting_review', 'locked'].includes(candidate.status)) {
    throw new Error(`segmentation candidate ${candidate.id} is ${candidate.status}; publish a fresh matching candidate`);
  }
  if (binding.expectedRevision !== undefined && candidate.revision !== binding.expectedRevision) {
    throw new Error(`segmentation candidate ${candidate.id} revision ${candidate.revision} does not match the story-plan binding ${binding.expectedRevision}`);
  }
  const inspected = candidate.status === 'locked'
    ? await verifyLockedArtifact(root, candidate)
    : await verifyArtifactFile(root, candidate);
  const payload = await readJson(inspected.path);
  if (!Array.isArray(payload?.segments) || payload.segments.length === 0) {
    throw new Error(`segmentation candidate ${candidate.id} must contain a non-empty segments array`);
  }
  const expectedFingerprint = plan.segmentationCandidate?.expectedStoryPlanFingerprintSha256;
  if (expectedFingerprint !== undefined) {
    const binding = payload.storyPlanBinding;
    const actualFingerprint = storyPlanSegmentationFingerprint(plan);
    if (!binding || binding.storyPlanId !== storyArtifact.id
      || binding.storyPlanSemanticSha256 !== expectedFingerprint
      || expectedFingerprint !== actualFingerprint) {
      throw new Error(`segmentation candidate ${candidate.id} does not bind the exact semantic fingerprint of ${storyArtifact.id}`);
    }
  }
  const manifest = assertCapabilityManifest(compileDirectorCapabilityManifest(plan, {
    storyPlanId: storyArtifact.id,
    storyPlanSha256
  }));
  const reconciled = reconcileCapabilityManifestSegmentIds(manifest, payload.segments);
  if (reconciled.segmentIdentityMap !== null) {
    throw new Error('Gate 2 segmentation candidate must use the exact canonical segment IDs; editorial ID remapping is not permitted here');
  }
  return { artifact: candidate, inspected, manifest };
}

// Read-only preflight. It is intentionally invoked before the human Gate 2
// decision so a malformed companion segmentation cannot be discovered only
// after the story plan has already been approved.
export async function validateStoryPlanSegmentationCandidate(root, {
  storyArtifact,
  plan,
  storyPlanSha256
}) {
  return loadCandidate(root, storyArtifact, plan, storyPlanSha256);
}

// The matching segmentation is an AUTO_LOCK artifact, but only after it proves
// exact agreement with the just-locked human-reviewed story plan and its
// deterministic capability manifest. This is not a sixth user approval gate.
export async function autoLockStoryPlanSegmentationCandidate(root, storyArtifactId) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const storyArtifact = state.artifacts.find(item => item.id === storyArtifactId && item.type === 'story_plan');
  if (!storyArtifact || storyArtifact.status !== 'locked') {
    throw new Error(`a locked story plan is required before segmentation auto-lock: ${storyArtifactId}`);
  }
  const storyFile = await verifyLockedArtifact(root, storyArtifact);
  const plan = assertStoryPlan(await readJson(storyFile.path));
  const candidate = await loadCandidate(root, storyArtifact, plan, storyFile.sha256);
  if (!candidate) return null;
  const review = await autoLockArtifact(root, candidate.artifact.id,
    `auto-locked: exact ${storyArtifact.id}/${storyFile.sha256} capability route reconciled canonical segmentation duration, order, and IDs`);
  return {
    artifactId: candidate.artifact.id,
    artifactSha256: review.artifactSha256,
    reviewId: review.id,
    capabilityManifestId: candidate.manifest.id
  };
}
