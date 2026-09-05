import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertBatchGenerationApproval } from '../domain/batch-generation.js';
import { readJson } from '../storage/json-store.js';

async function records(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const values = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
    values.push(await readJson(join(root, directory, entry.name)));
  }
  return values;
}

function newest(values) {
  return values.sort((a, b) => String(b.createdAt ?? b.reviewedAt ?? '').localeCompare(String(a.createdAt ?? a.reviewedAt ?? '')))[0] ?? null;
}

function verifiedExternalReviews(reviews, runs) {
  return reviews.filter(review => {
    if (review?.kind !== 'external_audit_attestation' || !review.auditRunId) return false;
    return runs.some(run => run?.id === review.auditRunId && run.kind === 'external_model_audit' && run.status === 'SUCCESS'
      && run.attestationId === review.id && run.sessionId === review.providerTaskId && run.model === review.model
      && run.segmentId === review.segmentId && run.auditStage === review.auditStage && run.fingerprintSha256 === review.fingerprintSha256);
  });
}

function userCanvasGenerationWait(segmentId, preflight, reason = 'generation-ready') {
  return {
    status: 'WAITING',
    action: 'USER_CANVAS_GENERATION',
    segmentId,
    preflightId: preflight?.id ?? null,
    fingerprintSha256: preflight?.fingerprint?.sha256 ?? null,
    reviewSurface: 'libtv_canvas',
    assistantMaySubmitByDefault: false,
    reason,
    instruction: '在 LibTV/立布 TV 画布内审核当前视频节点并由用户点击“生成视频”；系统不自动提交。'
  };
}

export async function planBatchNext(root, batchApprovalId) {
  const batch = assertBatchGenerationApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(batchApprovalId)}.json`)));
  const failureLedger = await readJson(join(root, 'runs', 'generation-failure-ledger.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (failureLedger?.status === 'TERMINATED_FAILURE_LIMIT_EXCEEDED') return {
    status: 'STOPPED', action: 'FAILURE_LIMIT_REACHED', reason: 'four generated outputs failed third-party or machine audit; no fifth failure may be risked',
    failedOutputCount: failureLedger.events.length, remainingFailureTolerance: 0
  };
  if (failureLedger?.status === 'AWAITING_HUMAN_REVIEW_AFTER_REWORK') return {
    status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED_AFTER_REWORK',
    failedOutputCount: failureLedger.events.length,
    remainingFailureTolerance: Math.max(0, failureLedger.maxFailedGeneratedOutputs - failureLedger.events.length),
    latestFailureId: failureLedger.events.at(-1)?.id
  };
  const reviews = await records(root, 'reviews');
  const runs = await records(root, 'runs');
  const externalReviews = verifiedExternalReviews(reviews, runs);
  const uncertainAudit = runs.find(run => run?.kind === 'external_model_audit' && ['SUBMITTING', 'UNCERTAIN'].includes(run.status));
  if (uncertainAudit) return { status: 'BLOCKED', action: 'RECONCILE_EXTERNAL_AUDIT', runId: uncertainAudit.id, reason: 'external audit outcome is uncertain; automatic retry is forbidden' };

  for (const segment of batch.segments) {
    const post = newest(externalReviews.filter(review => review.segmentId === segment.segmentId && review.auditStage === 'post_generation'));
    if (post?.decision === 'FAIL') return { status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED', segmentId: segment.segmentId, reason: 'post-generation external audit failed' };
    if (post?.decision === 'PASS') continue;

    const successfulRun = newest(runs.filter(run => run?.segmentId === segment.segmentId && run.status === 'SUCCESS' && Array.isArray(run.outputs) && run.outputs.length > 0));
    if (successfulRun) {
      if (!successfulRun.auditPackage) return { status: 'READY', action: 'PREPARE_VIDEO_AUDIT_PACKAGE', segmentId: segment.segmentId, runId: successfulRun.id };
      if (successfulRun.auditPackage.machineDecision !== 'PASS') return {
        status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED', segmentId: segment.segmentId,
        reason: 'local video machine audit failed', triggeredVetoes: successfulRun.auditPackage.triggeredVetoes
      };
      return {
        status: 'READY', action: 'RUN_POST_GENERATION_EXTERNAL_AUDIT', segmentId: segment.segmentId,
        runId: successfulRun.id, promptPath: successfulRun.auditPackage.reportPath
      };
    }

    const approval = newest(reviews.filter(review => review?.kind === 'paid_generation_approval' && review.segmentId === segment.segmentId && review.parentBatchApprovalId === batch.id));
    if (approval) {
      return approval.consumedByRunId
        ? { status: 'WAITING', action: 'WAIT_FOR_VIDEO_TERMINAL', segmentId: segment.segmentId, runId: approval.consumedByRunId }
        : userCanvasGenerationWait(segment.segmentId, {
          id: approval.preflightId,
          fingerprint: { sha256: approval.fingerprint?.sha256 ?? approval.fingerprintSha256 ?? null }
        }, 'paid approval exists but assistant submission is disabled; use the LibTV canvas');
    }

    const preflights = runs.filter(run => run?.kind === 'video_preflight' && run.segmentId === segment.segmentId && run.status === 'READY');
    const preflight = newest(preflights);
    if (!preflight) return { status: 'READY', action: 'CREATE_VIDEO_PREFLIGHT', segmentId: segment.segmentId };
    const preAudit = newest(externalReviews.filter(review => review.segmentId === segment.segmentId
      && review.auditStage === 'pre_generation' && review.fingerprintSha256 === preflight.fingerprint?.sha256));
    if (!preAudit && !preflight.externalAuditBrief) return { status: 'READY', action: 'PREPARE_PRE_GENERATION_AUDIT_BRIEF', segmentId: segment.segmentId, preflightId: preflight.id };
    if (!preAudit) return {
      status: 'READY', action: 'RUN_PRE_GENERATION_EXTERNAL_AUDIT', segmentId: segment.segmentId,
      preflightId: preflight.id, fingerprintSha256: preflight.fingerprint.sha256, promptPath: preflight.externalAuditBrief.path
    };
    if (preAudit.decision === 'FAIL') return { status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED', segmentId: segment.segmentId, reason: 'pre-generation external audit failed' };
    return userCanvasGenerationWait(segment.segmentId, preflight, 'pre-generation audit passed; awaiting user canvas review and click');
  }
  return { status: 'COMPLETE', action: 'PREPARE_FINAL_FILM', batchApprovalId: batch.id };
}
