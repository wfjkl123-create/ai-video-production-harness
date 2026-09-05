import { assertProjectId } from './project-id.js';
import { EXECUTION_OBSERVATION_STAGES } from './execution-ledger.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LEGACY_STATUSES = new Set(['READY', 'IN_PROGRESS']);
const STATUSES = new Set(['READY', 'IN_PROGRESS', 'PAUSED', 'COMPLETED']);
const STEP_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const TRANSITION_ACTIONS = new Set(['start', 'complete', 'pause', 'resume']);

export const ARTIFACT_STAGE_BY_TYPE = Object.freeze({
  brief: 'intake',
  reference_video: 'intake',
  source_fact_analysis: 'source_analysis',
  creative_brief: 'creative',
  script: 'story',
  shotlist: 'story',
  story_plan: 'story',
  capability_manifest: 'segmentation',
  segmentation: 'segmentation',
  spatial_control_model: 'storyboard',
  storyboard_panel: 'storyboard',
  project_asset: 'assets',
  segment_asset: 'assets',
  asset_visual_audit: 'assets',
  human_visual_exception: 'assets',
  shot_narration: 'prompt',
  seedance_prompt: 'prompt',
  independent_creative_audit: 'prompt',
  quality_rubric: 'technical_review',
  segment_contract: 'prompt',
  video_segment: 'generation',
  final_edit: 'editing',
  handoff: 'gate5',
  rule: 'prompt'
});

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function sha256(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

export function artifactResponsibilityStage(artifact) {
  return ARTIFACT_STAGE_BY_TYPE[artifact?.type] ?? null;
}

export function assertGate5ReworkWorkOrder(value) {
  object(value, 'Gate 5 rework work order');
  if (![1, 2].includes(value.schemaVersion) || value.kind !== 'gate5_rework_work_order') throw new TypeError('invalid Gate 5 rework work-order contract');
  safeId(value.id, 'id');
  assertProjectId(value.projectId);
  if (!(value.schemaVersion === 1 ? LEGACY_STATUSES : STATUSES).has(value.status)) throw new TypeError('work-order status is invalid');
  safeId(value.failureReturnId, 'failureReturnId');
  sha256(value.failureReturnSha256, 'failureReturnSha256');
  if (!['project', 'segment'].includes(value.scope)) throw new TypeError('scope must be project or segment');
  if (value.scope === 'segment') safeId(value.segmentId, 'segmentId');
  else if (value.segmentId !== null) throw new TypeError('project work order segmentId must be null');
  object(value.rejection, 'rejection');
  safeId(value.rejection.reviewId, 'rejection.reviewId');
  safeId(value.rejection.artifactId, 'rejection.artifactId');
  sha256(value.rejection.artifactSha256, 'rejection.artifactSha256');
  if (!EXECUTION_OBSERVATION_STAGES.includes(value.returnStage)) throw new TypeError('returnStage is invalid');
  if (!EXECUTION_OBSERVATION_STAGES.includes(value.responsibilityStage)) throw new TypeError('responsibilityStage is invalid');
  const returnStageIndex = EXECUTION_OBSERVATION_STAGES.indexOf(value.returnStage);
  const responsibilityStageIndex = EXECUTION_OBSERVATION_STAGES.indexOf(value.responsibilityStage);
  const gate5StageIndex = EXECUTION_OBSERVATION_STAGES.indexOf('gate5');
  if (returnStageIndex > responsibilityStageIndex || responsibilityStageIndex > gate5StageIndex) {
    throw new TypeError('returnStage must not follow responsibilityStage or gate5');
  }
  text(value.reworkAction, 'reworkAction');
  object(value.frozenEvidence, 'frozenEvidence');
  if (!Array.isArray(value.frozenEvidence.artifacts)) throw new TypeError('frozenEvidence.artifacts must be an array');
  sha256(value.frozenEvidence.fingerprintSha256, 'frozenEvidence.fingerprintSha256');
  for (const [index, artifact] of value.frozenEvidence.artifacts.entries()) {
    object(artifact, `frozenEvidence.artifacts[${index}]`);
    safeId(artifact.id, `frozenEvidence.artifacts[${index}].id`);
    text(artifact.type, `frozenEvidence.artifacts[${index}].type`);
    text(artifact.stage, `frozenEvidence.artifacts[${index}].stage`);
    if (!EXECUTION_OBSERVATION_STAGES.includes(artifact.stage)) throw new TypeError('frozen artifact stage is invalid');
    if (!Number.isInteger(artifact.revision) || artifact.revision < 1) throw new TypeError('frozen artifact revision must be positive');
    if (artifact.status !== 'locked') throw new TypeError('frozen artifact must be locked');
    text(artifact.path, `frozenEvidence.artifacts[${index}].path`);
    sha256(artifact.sha256, `frozenEvidence.artifacts[${index}].sha256`);
    safeId(artifact.lockedByReviewId, `frozenEvidence.artifacts[${index}].lockedByReviewId`);
  }
  if (!Array.isArray(value.allowedMutationStages) || value.allowedMutationStages.length === 0) {
    throw new TypeError('allowedMutationStages must be non-empty');
  }
  value.allowedMutationStages.forEach(stage => {
    if (!EXECUTION_OBSERVATION_STAGES.includes(stage)) throw new TypeError('allowedMutationStages contains an invalid stage');
  });
  const expectedMutationStages = EXECUTION_OBSERVATION_STAGES.slice(returnStageIndex, gate5StageIndex + 1);
  if (new Set(value.allowedMutationStages).size !== value.allowedMutationStages.length
    || value.allowedMutationStages.length !== expectedMutationStages.length
    || value.allowedMutationStages.some((stage, index) => stage !== expectedMutationStages[index])) {
    throw new TypeError('allowedMutationStages must be the unique ordered path from returnStage through gate5');
  }
  object(value.replacementContract, 'replacementContract');
  safeId(value.replacementContract.mustSupersedeArtifactId, 'replacementContract.mustSupersedeArtifactId');
  if (value.replacementContract.mustSupersedeArtifactId !== value.rejection.artifactId) {
    throw new TypeError('replacement must directly supersede the rejected artifact');
  }
  if (!Number.isInteger(value.replacementContract.minimumRevision) || value.replacementContract.minimumRevision < 2) {
    throw new TypeError('replacementContract.minimumRevision must be at least 2');
  }
  if (value.replacementContract.mustReturnToGate5 !== true) throw new TypeError('replacement must return to Gate 5');
  object(value.paidBoundary, 'paidBoundary');
  if (typeof value.paidBoundary.newAuthorizationRequired !== 'boolean') throw new TypeError('paidBoundary.newAuthorizationRequired must be boolean');
  if (value.paidBoundary.automaticRetryAllowed !== false || value.paidBoundary.existingApprovalReusable !== false) {
    throw new TypeError('Gate 5 rework cannot automatically retry or reuse an old approval');
  }
  if (!Array.isArray(value.steps) || value.steps.length !== value.allowedMutationStages.length) {
    throw new TypeError('steps must cover each allowed mutation stage exactly once');
  }
  for (const [index, step] of value.steps.entries()) {
    object(step, `steps[${index}]`);
    if (step.stage !== value.allowedMutationStages[index]) throw new TypeError('work-order steps must follow allowedMutationStages');
    if (value.schemaVersion === 1) {
      if (step.status !== 'pending') throw new TypeError('legacy work-order steps must be ordered pending stage checkpoints');
      continue;
    }
    if (!STEP_STATUSES.has(step.status)) throw new TypeError('work-order step status is invalid');
    if (step.startedAt !== null && !Number.isFinite(Date.parse(step.startedAt))) throw new TypeError('step.startedAt must be null or a valid timestamp');
    if (step.completedAt !== null && !Number.isFinite(Date.parse(step.completedAt))) throw new TypeError('step.completedAt must be null or a valid timestamp');
    if (step.status === 'pending' && (step.startedAt !== null || step.completedAt !== null || step.checkpoint !== null)) {
      throw new TypeError('pending work-order step cannot have progress evidence');
    }
    if (step.status === 'in_progress' && (step.startedAt === null || step.completedAt !== null || step.checkpoint !== null)) {
      throw new TypeError('in-progress work-order step must have only startedAt');
    }
    if (step.status === 'completed') {
      if (step.startedAt === null || step.completedAt === null) throw new TypeError('completed work-order step requires timestamps');
      object(step.checkpoint, 'completed step checkpoint');
      text(step.checkpoint.note, 'completed step checkpoint.note');
      if (!Array.isArray(step.checkpoint.evidence) || step.checkpoint.evidence.length === 0) {
        throw new TypeError('completed work-order step requires evidence');
      }
      for (const evidence of step.checkpoint.evidence) {
        object(evidence, 'checkpoint evidence');
        safeId(evidence.kind, 'checkpoint evidence.kind');
        safeId(evidence.id, 'checkpoint evidence.id');
        sha256(evidence.sha256, 'checkpoint evidence.sha256');
        if (evidence.path !== null) text(evidence.path, 'checkpoint evidence.path');
      }
    }
  }
  text(value.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(value.createdAt))) throw new TypeError('createdAt must be a valid timestamp');
  if (value.schemaVersion === 2) {
    if (!Number.isInteger(value.progressRevision) || value.progressRevision < 0) throw new TypeError('progressRevision must be non-negative');
    text(value.updatedAt, 'updatedAt');
    if (!Number.isFinite(Date.parse(value.updatedAt))) throw new TypeError('updatedAt must be a valid timestamp');
    if (value.pause !== null) {
      object(value.pause, 'pause');
      text(value.pause.reason, 'pause.reason');
      text(value.pause.pausedAt, 'pause.pausedAt');
      if (!Number.isFinite(Date.parse(value.pause.pausedAt))) throw new TypeError('pause.pausedAt must be valid');
    }
    if ((value.status === 'PAUSED') !== (value.pause !== null)) throw new TypeError('PAUSED status must have exactly one active pause');
    const inProgressCount = value.steps.filter(step => step.status === 'in_progress').length;
    if (inProgressCount > 1) throw new TypeError('only one work-order step can be in progress');
    let progressState = 'completed';
    for (const step of value.steps) {
      if (step.status === 'completed') {
        if (progressState !== 'completed') throw new TypeError('completed steps must form an ordered prefix');
      } else if (step.status === 'in_progress') {
        if (progressState !== 'completed') throw new TypeError('in-progress step must immediately follow completed prefix');
        progressState = 'in_progress';
      } else {
        if (progressState === 'completed') progressState = 'pending';
      }
    }
    const allCompleted = value.steps.every(step => step.status === 'completed');
    const anyProgress = value.steps.some(step => step.status !== 'pending');
    if (value.status === 'COMPLETED' && !allCompleted) throw new TypeError('COMPLETED work order requires all steps completed');
    if (allCompleted && value.status !== 'COMPLETED') throw new TypeError('all completed steps require COMPLETED work order');
    if (value.status === 'READY' && anyProgress) throw new TypeError('READY work order cannot contain progress');
    if (value.status === 'IN_PROGRESS' && !anyProgress) throw new TypeError('IN_PROGRESS work order requires progress');
    if (value.lastTransition !== null) {
      object(value.lastTransition, 'lastTransition');
      if (!TRANSITION_ACTIONS.has(value.lastTransition.action)) throw new TypeError('lastTransition.action is invalid');
      if (value.lastTransition.stage !== null && !value.allowedMutationStages.includes(value.lastTransition.stage)) {
        throw new TypeError('lastTransition.stage is outside the work order');
      }
      sha256(value.lastTransition.requestSha256, 'lastTransition.requestSha256');
      text(value.lastTransition.occurredAt, 'lastTransition.occurredAt');
      if (!Number.isFinite(Date.parse(value.lastTransition.occurredAt))) throw new TypeError('lastTransition.occurredAt must be valid');
    }
  }
  return value;
}

export function upgradeGate5ReworkWorkOrder(value, now) {
  const workOrder = assertGate5ReworkWorkOrder(value);
  if (workOrder.schemaVersion === 2) return workOrder;
  const timestamp = now ?? workOrder.createdAt;
  return assertGate5ReworkWorkOrder({
    ...workOrder,
    schemaVersion: 2,
    status: 'READY',
    steps: workOrder.steps.map(step => ({
      stage: step.stage, status: 'pending', startedAt: null, completedAt: null, checkpoint: null
    })),
    progressRevision: 0,
    pause: null,
    lastTransition: null,
    updatedAt: timestamp
  });
}
