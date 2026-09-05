import { createHash } from 'node:crypto';
import { EXECUTION_OBSERVATION_STAGES, assertExecutionObservation } from './execution-ledger.js';
import { assertProjectId } from './project-id.js';

const STAGES = [...EXECUTION_OBSERVATION_STAGES];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

export function createGate5FailureReturn(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('failure return input must be an object');
  const projectId = assertProjectId(input.projectId);
  if (!input.review || typeof input.review !== 'object') throw new TypeError('review must be an object');
  if (!input.artifact || typeof input.artifact !== 'object') throw new TypeError('artifact must be an object');
  safeId(input.review.id, 'review.id');
  safeId(input.artifact.id, 'artifact.id');
  text(input.artifact.type, 'artifact.type');
  if (!['video_segment', 'final_edit'].includes(input.artifact.type)) throw new TypeError('failure return artifact must be a Gate 5 video');
  if (!Number.isInteger(input.artifact.revision) || input.artifact.revision < 1) throw new TypeError('artifact.revision must be positive');
  if (!/^[a-f0-9]{64}$/.test(input.artifact.sha256 ?? '')) throw new TypeError('artifact.sha256 must be a lowercase SHA-256');
  if (input.artifact.type === 'video_segment') safeId(input.artifact.segmentId, 'artifact.segmentId');
  text(input.review.createdAt, 'review.createdAt');
  if (!Number.isFinite(Date.parse(input.review.createdAt))) throw new TypeError('review.createdAt must be a valid timestamp');
  text(input.review.correction, 'review.correction');
  const failure = assertExecutionObservation({
    subjectId: input.review.id,
    scope: input.artifact.type === 'final_edit' ? 'project' : 'segment',
    stage: 'gate5',
    failure: input.review.failureObservation
  }).failure;
  if (failure.retryKind !== 'none') throw new TypeError('an open failure return must not claim a retry');
  const returnIndex = STAGES.indexOf(failure.returnStage);
  const responsibilityIndex = STAGES.indexOf(failure.responsibilityStage);
  const gate5Index = STAGES.indexOf('gate5');
  if (returnIndex < 0 || returnIndex > gate5Index) throw new TypeError('Gate 5 returnStage must not be after gate5');
  if (responsibilityIndex < 0 || responsibilityIndex > gate5Index) throw new TypeError('Gate 5 responsibilityStage must not be after gate5');
  if (returnIndex > responsibilityIndex) throw new TypeError('Gate 5 returnStage must not skip past the responsibilityStage');
  const generationIndex = STAGES.indexOf('generation');
  return {
    schemaVersion: 1,
    kind: 'gate5_failure_return',
    id: `gate5-return-${createHash('sha256').update(`${projectId}\0${input.review.id}`).digest('hex').slice(0, 32)}`,
    status: 'OPEN',
    projectId,
    scope: input.artifact.type === 'final_edit' ? 'project' : 'segment',
    segmentId: input.artifact.type === 'final_edit' ? null : input.artifact.segmentId,
    rejection: {
      reviewId: input.review.id,
      artifactId: input.artifact.id,
      artifactType: input.artifact.type,
      artifactRevision: input.artifact.revision,
      artifactSha256: input.artifact.sha256,
      rejectedAt: input.review.createdAt
    },
    failure: structuredClone(failure),
    correction: input.review.correction,
    routing: {
      returnStage: failure.returnStage,
      responsibilityStage: failure.responsibilityStage,
      preserveStages: STAGES.slice(0, returnIndex),
      reworkStages: STAGES.slice(returnIndex, gate5Index + 1),
      forbidWholeChainRestart: returnIndex > 0,
      preserveLockedEvidence: true,
      requiresReplacementArtifact: true,
      replacementMustSupersedeArtifactId: input.artifact.id,
      minimumReplacementRevision: input.artifact.revision + 1,
      automaticPaidRetryAllowed: false,
      newPaidAuthorizationRequired: returnIndex <= generationIndex
    }
  };
}
