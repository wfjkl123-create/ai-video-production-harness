import { join, resolve } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { assertQualityReview } from '../domain/quality-review.js';
import { createGate5FailureReturn } from '../domain/failure-return.js';
import { readJson } from '../storage/json-store.js';
import { verifyArtifactFile } from './artifact-file-service.js';

const RETURN_ACTIONS = Object.freeze({
  intake: 'rebuild_intake_contract',
  source_analysis: 'revise_source_analysis',
  creative: 'revise_creative_direction',
  story: 'revise_story_plan',
  segmentation: 'revise_segmentation',
  storyboard: 'revise_storyboard_control',
  assets: 'revise_asset_binding',
  prompt: 'revise_prompt_package',
  paid_approval: 'rebuild_paid_approval_package',
  generation: 'generate_replacement_unit',
  editing: 'revise_final_edit',
  technical_review: 'rerun_technical_review',
  gate5: 'create_reviewable_successor'
});

export function reworkActionForReturnStage(returnStage) {
  const action = RETURN_ACTIONS[returnStage];
  if (!action) throw new TypeError(`unsupported Gate 5 return stage: ${returnStage}`);
  return action;
}

function sortOpenReturns(state, left, right) {
  if (left.scope !== right.scope) return left.scope === 'project' ? -1 : 1;
  const leftActive = left.segmentId === state.activeSegmentId ? 1 : 0;
  const rightActive = right.segmentId === state.activeSegmentId ? 1 : 0;
  return rightActive - leftActive
    || String(left.segmentId ?? '').localeCompare(String(right.segmentId ?? ''))
    || right.rejection.artifactRevision - left.rejection.artifactRevision;
}

export async function inspectOpenGate5FailureReturns(root, stateInput, currentArtifacts) {
  const projectRoot = resolve(root);
  const state = stateInput ? assertProjectState(stateInput) : assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
  if (!Array.isArray(currentArtifacts)) throw new TypeError('currentArtifacts must be an array');
  const rejected = currentArtifacts.filter(item => ['video_segment', 'final_edit'].includes(item.type) && item.status === 'rejected');
  const open = [];
  const unclassified = [];
  for (const artifact of rejected) {
    if (!artifact.rejectedByReviewId) {
      unclassified.push({ artifactId: artifact.id, artifactType: artifact.type, segmentId: artifact.segmentId ?? null });
      continue;
    }
    const reviewPath = `reviews/${encodeURIComponent(artifact.rejectedByReviewId)}.json`;
    const review = assertQualityReview(await readJson(join(projectRoot, reviewPath)));
    if (review.id !== artifact.rejectedByReviewId || review.artifactId !== artifact.id || review.decision !== 'rejected') {
      throw new Error(`Gate 5 rejection binding is invalid for ${artifact.id}`);
    }
    const inspected = await verifyArtifactFile(projectRoot, artifact);
    if (review.artifactSha256 !== inspected.sha256 || artifact.sha256 !== inspected.sha256) {
      throw new Error(`Gate 5 rejection artifact SHA changed for ${artifact.id}`);
    }
    if (!review.failureObservation) {
      unclassified.push({ artifactId: artifact.id, artifactType: artifact.type, segmentId: artifact.segmentId ?? null, reviewId: review.id });
      continue;
    }
    open.push(createGate5FailureReturn({ projectId: state.projectId, artifact, review }));
  }
  open.sort((left, right) => sortOpenReturns(state, left, right));
  return { open, unclassified };
}

export function failureReturnAction(failureReturn, additionalOpenReturnCount = 0, workOrder = null) {
  const currentStep = workOrder?.steps?.find(step => step.status !== 'completed') ?? null;
  return {
    id: 'execute_gate5_failure_return',
    failureReturn,
    segmentId: failureReturn.segmentId,
    artifactId: failureReturn.rejection.artifactId,
    reviewId: failureReturn.rejection.reviewId,
    returnStage: failureReturn.routing.returnStage,
    responsibilityStage: failureReturn.routing.responsibilityStage,
    reworkAction: reworkActionForReturnStage(failureReturn.routing.returnStage),
    workOrder,
    workOrderProgress: workOrder ? {
      status: workOrder.status,
      currentStage: currentStep?.stage ?? null,
      currentStageStatus: currentStep?.status ?? null,
      completedStages: workOrder.steps.filter(step => step.status === 'completed').length,
      totalStages: workOrder.steps.length,
      progressRevision: workOrder.progressRevision ?? 0
    } : null,
    additionalOpenReturnCount,
    reason: `Gate 5 rejected this artifact; resume only from ${failureReturn.routing.returnStage} and preserve earlier locked evidence`
  };
}
