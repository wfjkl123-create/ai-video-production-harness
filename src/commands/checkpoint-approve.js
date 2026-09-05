import { join, resolve } from 'node:path';
import { batchApproveByTypes } from '../services/review-service.js';
import { CHECKPOINTS } from '../domain/review-policy.js';
import { option } from './args.js';
import { routeLockedStoryPlan } from '../services/director-route-service.js';
import { readJson } from '../storage/json-store.js';
import { assertProjectState } from '../domain/project-state.js';
import { assertStoryPlan } from '../domain/story-plan.js';
import { compileDirectorCapabilityManifest } from '../domain/director-capability.js';
import { verifyArtifactFile } from '../services/artifact-file-service.js';
import { requirePassingSourceComparatorAudit } from '../services/source-comparator-audit-service.js';
import {
  autoLockStoryPlanSegmentationCandidate,
  validateStoryPlanSegmentationCandidate
} from '../services/gate2-segmentation-lock-service.js';
import { isSourceFactMachineDelegated } from '../domain/reference-workflow.js';

const CHECKPOINT_MAP = Object.fromEntries(
  Object.values(CHECKPOINTS).map(cp => [cp.id, cp])
);

async function preflightStoryCheckpoint(root, dependencies = {}) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const pending = state.artifacts.filter(item => item.type === 'story_plan' && item.status === 'awaiting_review');
  if (pending.length !== 1) throw new Error(`checkpoint requires exactly one awaiting-review artifact, found ${pending.length}`);
  const artifact = pending[0];
  const inspected = await verifyArtifactFile(root, artifact);
  const plan = assertStoryPlan(await readJson(inspected.path));
  if (plan.schemaVersion !== 2) {
    const error = new Error('Gate 2 cannot approve a legacy story plan as a precise director route; the AI must publish a schemaVersion 2 replacement in this same Gate 2');
    error.code = 'STORY_PLAN_V2_REQUIRED';
    throw error;
  }
  if ((plan.creativeDecision.referenceWorkflow?.requiresSourceFactWorkflow === true
    || plan.creativeDecision.referenceWorkflow?.workflowRoute === 'source_fact')
    && !isSourceFactMachineDelegated(plan.creativeDecision.referenceWorkflow, plan.creativeDecision, plan.sourceFactDelegation?.workflowProfileId ?? null)) {
    await (dependencies.requirePassingSourceComparatorAudit ?? requirePassingSourceComparatorAudit)(root, artifact);
  }
  compileDirectorCapabilityManifest(plan, {
    storyPlanId: artifact.id,
    storyPlanSha256: inspected.sha256
  });
  await validateStoryPlanSegmentationCandidate(root, {
    storyArtifact: artifact,
    plan,
    storyPlanSha256: inspected.sha256
  });
}

export async function runCheckpointApprove(args, dependencies = {}) {
  const root = resolve(option(args, 'project'));
  const checkpointId = option(args, 'checkpoint');
  const note = option(args, 'note') ?? `checkpoint ${checkpointId} approved`;

  const checkpoint = CHECKPOINT_MAP[checkpointId];
  if (!checkpoint) {
    throw new Error(`unknown checkpoint: ${checkpointId}. Valid: ${Object.keys(CHECKPOINT_MAP).join(', ')}`);
  }
  if (checkpoint.coversTypes.length === 0) {
    throw new Error(`checkpoint ${checkpointId} is handled by the existing dry-run/approve-paid-generation flow; no batch-approve needed`);
  }

  if (checkpoint.id === 'checkpoint_story') await preflightStoryCheckpoint(root, dependencies);

  const reviews = await batchApproveByTypes(root, checkpoint.coversTypes, note, {
    requireExactlyOne: checkpoint.singleArtifact === true
  });
  const segmentationRoute = checkpoint.id === 'checkpoint_story' && reviews.length === 1
    ? await autoLockStoryPlanSegmentationCandidate(root, reviews[0].artifactId)
    : null;
  const directorRoute = checkpoint.id === 'checkpoint_story' && reviews.length === 1
    ? await routeLockedStoryPlan(root, reviews[0].artifactId)
    : null;
  return {
    checkpoint: checkpoint.id,
    description: checkpoint.description,
    approvedCount: reviews.length,
    reviews: reviews.map(r => ({ id: r.id, artifactId: r.artifactId })),
    ...(segmentationRoute ? {
      segmentationArtifactId: segmentationRoute.artifactId,
      segmentationAutoLockReviewId: segmentationRoute.reviewId
    } : {}),
    ...(directorRoute ? { capabilityManifestId: directorRoute.artifact.id, directorRouteReused: directorRoute.reused } : {})
  };
}
