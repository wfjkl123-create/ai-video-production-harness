import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertBatchGenerationApproval } from '../domain/batch-generation.js';
import { readJson } from '../storage/json-store.js';

async function records(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  return Promise.all(entries
    .filter(entry => entry.isFile() && !entry.name.startsWith('._') && entry.name.endsWith('.json'))
    .map(entry => readJson(join(root, directory, entry.name))));
}

function newest(values) {
  return values.sort((left, right) => String(right.createdAt ?? right.reviewedAt ?? '')
    .localeCompare(String(left.createdAt ?? left.reviewedAt ?? '')))[0] ?? null;
}

function verifiedExternalReviews(reviews, runs) {
  const runById = new Map(runs.map(run => [run?.id, run]));
  return reviews.filter(review => review?.kind === 'external_audit_attestation' && review.auditRunId
    && (() => {
      const run = runById.get(review.auditRunId);
      return run?.kind === 'external_model_audit' && run.status === 'SUCCESS'
      && run.attestationId === review.id && run.sessionId === review.providerTaskId && run.model === review.model
      && run.segmentId === review.segmentId && run.auditStage === review.auditStage
      && run.fingerprintSha256 === review.fingerprintSha256;
    })());
}

function keepNewest(map, key, value) {
  const previous = map.get(key);
  if (!previous || String(value.createdAt ?? value.reviewedAt ?? '')
    .localeCompare(String(previous.createdAt ?? previous.reviewedAt ?? '')) > 0) map.set(key, value);
}

function buildIndexes(batch, reviews, runs, externalReviews) {
  const postAuditBySegment = new Map();
  const preAuditBySegmentFingerprint = new Map();
  const successfulVideoRunBySegment = new Map();
  const paidApprovalBySegment = new Map();
  const readyPreflightBySegment = new Map();
  const segmentIndex = new Map(batch.segments.map((segment, index) => [segment.segmentId, index]));
  for (const review of externalReviews) {
    if (review.auditStage === 'post_generation') keepNewest(postAuditBySegment, review.segmentId, review);
    if (review.auditStage === 'pre_generation') {
      keepNewest(preAuditBySegmentFingerprint, `${review.segmentId}:${review.fingerprintSha256}`, review);
    }
  }
  for (const review of reviews) {
    if (review?.kind === 'paid_generation_approval' && review.parentBatchApprovalId === batch.id) {
      keepNewest(paidApprovalBySegment, review.segmentId, review);
    }
  }
  for (const run of runs) {
    if (run?.status === 'SUCCESS' && Array.isArray(run.outputs) && run.outputs.length > 0) {
      keepNewest(successfulVideoRunBySegment, run.segmentId, run);
    }
    if (run?.kind === 'video_preflight' && run.status === 'READY') {
      keepNewest(readyPreflightBySegment, run.segmentId, run);
    }
  }
  return {
    postAuditBySegment,
    preAuditBySegmentFingerprint,
    successfulVideoRunBySegment,
    paidApprovalBySegment,
    readyPreflightBySegment,
    segmentIndex
  };
}

function canvasWait(segmentId, preflight, reason) {
  return {
    status: 'WAITING', action: 'USER_CANVAS_GENERATION', lane: 'user_canvas', segmentId,
    preflightId: preflight?.id ?? null,
    fingerprintSha256: preflight?.fingerprint?.sha256 ?? null,
    reviewSurface: 'libtv_canvas', assistantMaySubmitByDefault: false, reason
  };
}

function segmentAction(segment, context) {
  const { batch, indexes, completedSegments } = context;
  const segmentId = segment.segmentId;
  const post = indexes.postAuditBySegment.get(segmentId);
  if (post?.decision === 'FAIL') return {
    status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED', lane: 'quality_gate', segmentId,
    reason: 'post-generation external audit failed'
  };
  if (post?.decision === 'PASS') return { status: 'COMPLETE', action: 'SEGMENT_COMPLETE', segmentId };

  if (segment.strategy === 'continuous_proxy_handoff') {
    const index = indexes.segmentIndex.get(segmentId);
    const predecessor = batch.segments[index - 1];
    if (predecessor && !completedSegments.has(predecessor.segmentId)) return {
      status: 'BLOCKED', action: 'WAIT_FOR_CONTINUITY_PREDECESSOR', lane: 'continuity', segmentId,
      blockedBySegmentId: predecessor.segmentId,
      reason: 'continuous proxy handoff requires the immediately preceding segment to pass Gate 5'
    };
  }

  const successfulRun = indexes.successfulVideoRunBySegment.get(segmentId);
  if (successfulRun) {
    if (!successfulRun.auditPackage) return {
      status: 'READY', action: 'PREPARE_VIDEO_AUDIT_PACKAGE', lane: 'local_preparation', segmentId, runId: successfulRun.id
    };
    if (successfulRun.auditPackage.machineDecision !== 'PASS') return {
      status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED', lane: 'quality_gate', segmentId,
      reason: 'local video machine audit failed', triggeredVetoes: successfulRun.auditPackage.triggeredVetoes
    };
    return {
      status: 'READY', action: 'RUN_POST_GENERATION_EXTERNAL_AUDIT', lane: 'external_audit', segmentId,
      runId: successfulRun.id, promptPath: successfulRun.auditPackage.reportPath
    };
  }

  const approval = indexes.paidApprovalBySegment.get(segmentId);
  if (approval) {
    if (approval.consumedByRunId) return {
      status: 'WAITING', action: 'WAIT_FOR_VIDEO_TERMINAL', lane: 'video_reconcile', segmentId,
      runId: approval.consumedByRunId
    };
    return canvasWait(segmentId, {
      id: approval.preflightId,
      fingerprint: { sha256: approval.fingerprint?.sha256 ?? approval.fingerprintSha256 ?? null }
    }, 'paid approval exists but assistant submission remains disabled');
  }

  const preflight = indexes.readyPreflightBySegment.get(segmentId);
  if (!preflight) return { status: 'READY', action: 'CREATE_VIDEO_PREFLIGHT', lane: 'local_preparation', segmentId };
  const preAudit = indexes.preAuditBySegmentFingerprint.get(`${segmentId}:${preflight.fingerprint?.sha256}`);
  if (!preAudit && !preflight.externalAuditBrief) return {
    status: 'READY', action: 'PREPARE_PRE_GENERATION_AUDIT_BRIEF', lane: 'local_preparation',
    segmentId, preflightId: preflight.id
  };
  if (!preAudit) return {
    status: 'READY', action: 'RUN_PRE_GENERATION_EXTERNAL_AUDIT', lane: 'external_audit', segmentId,
    preflightId: preflight.id, fingerprintSha256: preflight.fingerprint.sha256,
    promptPath: preflight.externalAuditBrief.path
  };
  if (preAudit.decision === 'FAIL') return {
    status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED', lane: 'quality_gate', segmentId,
    reason: 'pre-generation external audit failed'
  };
  return canvasWait(segmentId, preflight, 'pre-generation audit passed; awaiting Gate 4 user canvas review');
}

export async function planFastDagNext(root, batchApprovalId) {
  const batch = assertBatchGenerationApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(batchApprovalId)}.json`)));
  const [reviews, runs, failureLedger] = await Promise.all([
    records(root, 'reviews'),
    records(root, 'runs'),
    readJson(join(root, 'runs', 'generation-failure-ledger.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  ]);
  if (failureLedger?.status === 'TERMINATED_FAILURE_LIMIT_EXCEEDED') return {
    featureFlag: 'fast_dag_v1', shadowOnly: true, status: 'STOPPED', action: 'FAILURE_LIMIT_REACHED',
    failedOutputCount: failureLedger.events.length
  };
  if (failureLedger?.status === 'AWAITING_HUMAN_REVIEW_AFTER_REWORK') return {
    featureFlag: 'fast_dag_v1', shadowOnly: true, status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED_AFTER_REWORK',
    latestFailureId: failureLedger.events.at(-1)?.id
  };
  const uncertainAudit = runs.find(run => run?.kind === 'external_model_audit' && ['SUBMITTING', 'UNCERTAIN'].includes(run.status));
  if (uncertainAudit) return {
    featureFlag: 'fast_dag_v1', shadowOnly: true, status: 'BLOCKED', action: 'RECONCILE_EXTERNAL_AUDIT',
    runId: uncertainAudit.id, reason: 'external audit outcome is uncertain; fan-out is fail-closed'
  };

  const externalReviews = verifiedExternalReviews(reviews, runs);
  const indexes = buildIndexes(batch, reviews, runs, externalReviews);
  const completedSegments = new Set(batch.segments
    .filter(segment => indexes.postAuditBySegment.get(segment.segmentId)?.decision === 'PASS')
    .map(segment => segment.segmentId));
  const actions = batch.segments.map(segment => segmentAction(segment, {
    batch, indexes, completedSegments
  }));
  const stopped = actions.find(action => action.status === 'STOPPED');
  if (stopped) return { featureFlag: 'fast_dag_v1', shadowOnly: true, ...stopped };

  const readyActions = actions.filter(action => action.status === 'READY');
  const waitingActions = actions.filter(action => action.status === 'WAITING');
  const blockedActions = actions.filter(action => action.status === 'BLOCKED');
  const completedSegmentIds = actions.filter(action => action.status === 'COMPLETE').map(action => action.segmentId);
  const status = readyActions.length > 0 ? 'READY'
    : waitingActions.length > 0 ? 'WAITING'
      : blockedActions.length > 0 ? 'BLOCKED'
        : 'COMPLETE';
  return {
    featureFlag: 'fast_dag_v1', shadowOnly: true, status,
    action: status === 'COMPLETE' ? 'PREPARE_FINAL_FILM' : 'READY_ACTION_SET',
    batchApprovalId: batch.id,
    indexStats: { reviewRecords: reviews.length, runRecords: runs.length, segmentRecords: batch.segments.length },
    concurrencyBudget: { local_preparation: 4, external_audit: 1, user_canvas: 0, video_reconcile: 1 },
    readyActions,
    waitingActions,
    blockedActions,
    completedSegmentIds
  };
}
