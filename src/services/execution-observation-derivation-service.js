import { join, resolve } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import {
  EXECUTION_OBSERVATION_SCOPES,
  EXECUTION_OBSERVATION_STAGES,
  assertExecutionObservation
} from '../domain/execution-ledger.js';
import { runProcess } from '../adapters/process-runner.js';
import { sha256Text } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { readExecutionTrace } from './execution-trace-service.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';
import { assertQualityReview } from '../domain/quality-review.js';

const SOURCE_TYPES = new Set([
  'execution_trace_timing', 'video_audit_media', 'final_delivery_media',
  'external_audit_cost', 'generation_failure', 'gate5_rejection'
]);
const TIMING_FIELDS = new Set(['machineExecutionMs', 'externalQueueMs', 'humanWaitMs']);
const SCOPES = new Set(EXECUTION_OBSERVATION_SCOPES);
const STAGES = new Set(EXECUTION_OBSERVATION_STAGES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const FINAL_DELIVERY_RECEIPT_PATH = 'deliveries/final-delivery-receipt.json';
const ALGORITHM_VERSION = 1;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function safeId(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function canonicalJsonSha(value) {
  return sha256Text(`${JSON.stringify(value, null, 2)}\n`);
}

function validateInput(input) {
  object(input, 'input');
  if (input.schemaVersion !== 1 || input.kind !== 'execution_observation_derivation') {
    throw new TypeError('input must be an execution_observation_derivation v1 request');
  }
  if (!SOURCE_TYPES.has(input.sourceType)) throw new TypeError('sourceType is invalid');
  const allowed = new Set(['schemaVersion', 'kind', 'sourceType',
    ...(input.sourceType === 'execution_trace_timing' ? ['traceId'] : []),
    ...(input.sourceType === 'video_audit_media' ? ['reportPath'] : []),
    ...(input.sourceType === 'external_audit_cost' ? ['runId'] : []),
    ...(input.sourceType === 'generation_failure' ? ['failureEventId'] : []),
    ...(input.sourceType === 'gate5_rejection' ? ['reviewId'] : [])]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`input.${key} is not supported for ${input.sourceType}`);
  }
  if (input.sourceType === 'execution_trace_timing') safeId(input.traceId, 'traceId');
  if (input.sourceType === 'video_audit_media') {
    if (typeof input.reportPath !== 'string' || input.reportPath.trim() === '') {
      throw new TypeError('reportPath is required for video_audit_media');
    }
  }
  if (input.sourceType === 'external_audit_cost') safeId(input.runId, 'runId');
  if (input.sourceType === 'generation_failure') safeId(input.failureEventId, 'failureEventId');
  if (input.sourceType === 'gate5_rejection') safeId(input.reviewId, 'reviewId');
  return input;
}

function validateTraceAuthority(trace) {
  const authority = trace.metadata.authoritativeObservation;
  object(authority, 'trace.metadata.authoritativeObservation');
  const allowed = new Set(['schemaVersion', 'basis', 'scope', 'stage', 'segmentId', 'fields', 'spanIds']);
  for (const key of Object.keys(authority)) {
    if (!allowed.has(key)) throw new TypeError(`trace authoritativeObservation.${key} is not supported`);
  }
  if (authority.schemaVersion !== 1 || !['leaf_spans', 'declared_spans'].includes(authority.basis)) {
    throw new Error('trace timing is not authoritative: expected authoritativeObservation v1 with leaf_spans or declared_spans basis');
  }
  if (!SCOPES.has(authority.scope)) throw new TypeError('trace authoritativeObservation.scope is invalid');
  if (!STAGES.has(authority.stage)) throw new TypeError('trace authoritativeObservation.stage is invalid');
  safeId(authority.segmentId, 'trace authoritativeObservation.segmentId', { nullable: true });
  if (!Array.isArray(authority.fields) || authority.fields.length === 0) {
    throw new TypeError('trace authoritativeObservation.fields must declare at least one covered metric');
  }
  const fields = [...new Set(authority.fields)];
  if (fields.length !== authority.fields.length || fields.some(field => !TIMING_FIELDS.has(field))) {
    throw new TypeError('trace authoritativeObservation.fields contains duplicate or unsupported metrics');
  }
  if (authority.scope === 'segment' && authority.segmentId === null) {
    throw new TypeError('segment timing observations require authoritativeObservation.segmentId');
  }
  if (authority.basis === 'leaf_spans' && authority.spanIds !== undefined) {
    throw new TypeError('leaf_spans authority must not declare spanIds');
  }
  let spanIds = null;
  if (authority.basis === 'declared_spans') {
    if (!Array.isArray(authority.spanIds) || authority.spanIds.length === 0) {
      throw new TypeError('declared_spans authority requires at least one spanId');
    }
    authority.spanIds.forEach((spanId, index) => safeId(spanId, `trace authoritativeObservation.spanIds[${index}]`));
    spanIds = [...new Set(authority.spanIds)];
    if (spanIds.length !== authority.spanIds.length) {
      throw new TypeError('trace authoritativeObservation.spanIds must be unique');
    }
  }
  return { ...authority, fields, spanIds };
}

function traceObservation(trace) {
  if (trace.status === 'running') throw new Error('cannot derive timing from a running execution trace');
  const authority = validateTraceAuthority(trace);
  const byId = new Map(trace.spans.map(span => [span.id, span]));
  let measuredSpans;
  if (authority.basis === 'leaf_spans') {
    const parents = new Set(trace.spans.map(span => span.parentSpanId).filter(Boolean));
    measuredSpans = trace.spans.filter(span => !parents.has(span.id));
  } else {
    measuredSpans = authority.spanIds.map(spanId => {
      const span = byId.get(spanId);
      if (!span) throw new Error(`authoritative observation span does not exist: ${spanId}`);
      return span;
    });
    const selected = new Set(authority.spanIds);
    for (const span of measuredSpans) {
      let parentId = span.parentSpanId;
      while (parentId !== null) {
        if (selected.has(parentId)) throw new Error('authoritative observation spans must not contain ancestor overlaps');
        parentId = byId.get(parentId)?.parentSpanId ?? null;
      }
    }
  }
  const timing = {};
  if (authority.fields.includes('machineExecutionMs')) {
    if (!measuredSpans.some(span => span.kind !== 'external_call')) {
      throw new Error('machineExecutionMs requires at least one non-external authoritative span');
    }
    timing.machineExecutionMs = measuredSpans
      .filter(span => span.kind !== 'external_call')
      .reduce((sum, span) => sum + span.activeComputeMs, 0);
  }
  if (authority.fields.includes('externalQueueMs')) {
    if (!measuredSpans.some(span => span.kind === 'external_call')) {
      throw new Error('externalQueueMs requires at least one external_call authoritative span');
    }
    timing.externalQueueMs = measuredSpans
      .filter(span => span.kind === 'external_call')
      .reduce((sum, span) => sum + span.queueMs, 0);
  }
  if (authority.fields.includes('humanWaitMs')) {
    timing.humanWaitMs = measuredSpans.reduce((sum, span) => sum + span.humanWaitMs, 0);
  }
  return {
    observation: assertExecutionObservation({
      subjectId: trace.id,
      scope: authority.scope,
      stage: authority.stage,
      timing
    }),
    segmentId: authority.segmentId
  };
}

function positiveDurationMs(seconds, field) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive duration`);
  return Math.round(value * 1000);
}

async function invokeFfprobe(root, videoPath, runner) {
  const result = await runner('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath
  ], { cwd: root });
  if (!result || result.code !== 0) throw new Error(`ffprobe failed: ${result?.stderr?.trim() || `exit ${result?.code}`}`);
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  if (!Array.isArray(metadata.streams) || !metadata.streams.some(stream => stream.codec_type === 'video')) {
    throw new Error('final delivery artifact has no video stream');
  }
  const duration = metadata.format?.duration
    ?? metadata.streams.find(stream => stream.codec_type === 'video')?.duration;
  return positiveDurationMs(duration, 'ffprobe duration');
}

function planFingerprint(sourceType, subjectId, observation, sourceReferences) {
  return sha256Text(JSON.stringify({
    algorithmVersion: ALGORITHM_VERSION,
    sourceType,
    subjectId,
    observation,
    sources: sourceReferences.map(reference => ({ id: reference.id, path: reference.path, sha256: reference.sha256 }))
  }));
}

function buildReceipt({ id, observedAt, segmentId, sourceReferences, observation }) {
  return {
    schemaVersion: 2,
    kind: 'execution_observation_evidence',
    id,
    evidencePath: `reviews/execution-observations/${id}.json`,
    observedAt,
    actor: { kind: 'system', id: null },
    segmentId,
    correlationId: observation.subjectId,
    causationId: null,
    sourceReferences,
    observation
  };
}

async function planTrace(root, input) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const trace = await readExecutionTrace(root, input.traceId);
  if (trace.projectId !== state.projectId) throw new Error('execution trace projectId mismatch');
  const tracePath = `traces/${trace.id}.json`;
  const inspected = await inspectArtifactFile(root, tracePath);
  const derived = traceObservation(trace);
  return {
    subjectId: trace.id,
    observedAt: trace.endedAt,
    segmentId: derived.segmentId,
    observation: derived.observation,
    sourceReferences: [{
      kind: 'execution_trace', id: trace.id,
      path: tracePath, sha256: inspected.sha256
    }],
    sourceSnapshots: [{ path: tracePath, sha256: inspected.sha256 }],
    sourceWrites: []
  };
}

async function planVideoAudit(root, input) {
  const inspectedReport = await inspectArtifactFile(root, input.reportPath);
  const report = await readJson(inspectedReport.path);
  if (report?.kind !== 'video_audit_package') throw new TypeError('reportPath must reference a video_audit_package');
  safeId(report.id, 'video audit id');
  safeId(report.videoRunId, 'video audit videoRunId');
  safeId(report.segmentId, 'video audit segmentId');
  if (typeof report.createdAt !== 'string' || !Number.isFinite(Date.parse(report.createdAt))) {
    throw new TypeError('video audit createdAt must be a date-time');
  }
  if (typeof report.videoSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(report.videoSha256)) {
    throw new TypeError('video audit videoSha256 is invalid');
  }
  const inspectedVideo = await inspectArtifactFile(root, report.videoPath);
  if (inspectedVideo.sha256 !== report.videoSha256) throw new Error('video audit output checksum changed');
  const runPath = `runs/${report.videoRunId}.json`;
  const inspectedRun = await inspectArtifactFile(root, runPath);
  const run = await readJson(inspectedRun.path);
  if (run?.id !== report.videoRunId || run.status !== 'SUCCESS' || run.segmentId !== report.segmentId) {
    throw new Error('video audit package is not bound to its successful generation run');
  }
  if (run.auditPackage?.id !== report.id || run.auditPackage.reportPath !== input.reportPath
    || run.auditPackage.reportSha256 !== inspectedReport.sha256) {
    throw new Error('generation run does not bind the exact video audit report SHA');
  }
  if (!Array.isArray(run.outputs) || !run.outputs.some(output => output.path === report.videoPath
    && output.sha256 === report.videoSha256)) {
    throw new Error('generation run does not bind the audited video output SHA');
  }
  const observation = assertExecutionObservation({
    subjectId: report.videoRunId,
    scope: 'generation_attempt',
    stage: 'technical_review',
    media: { kind: 'generated_output', durationMs: positiveDurationMs(report.metadata?.duration, 'video audit duration') }
  });
  return {
    subjectId: report.videoRunId,
    observedAt: report.createdAt,
    segmentId: report.segmentId,
    observation,
    sourceReferences: [{
      kind: 'video_audit_package', id: report.videoRunId,
      path: input.reportPath, sha256: inspectedReport.sha256
    }, {
      kind: 'generation_run', id: run.id, path: runPath, sha256: inspectedRun.sha256
    }],
    sourceSnapshots: [
      { path: input.reportPath, sha256: inspectedReport.sha256 },
      { path: runPath, sha256: inspectedRun.sha256 },
      { path: report.videoPath, sha256: inspectedVideo.sha256 }
    ],
    sourceWrites: []
  };
}

function finalDeliveryArtifact(receipt) {
  if (receipt.finalEdit) {
    return {
      id: receipt.finalEdit.artifactId ?? receipt.finalEdit.id,
      path: receipt.finalEdit.path,
      sha256: receipt.finalEdit.sha256
    };
  }
  if (!Array.isArray(receipt.deliverable) || receipt.deliverable.length !== 1) {
    throw new Error('final delivery duration requires one finalEdit or exactly one deliverable');
  }
  const deliverable = receipt.deliverable[0];
  return {
    id: deliverable.videoArtifactId ?? deliverable.artifactId ?? deliverable.id,
    path: deliverable.path,
    sha256: deliverable.sha256
  };
}

async function planFinalDelivery(root, options) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const inspectedReceipt = await inspectArtifactFile(root, FINAL_DELIVERY_RECEIPT_PATH);
  const receipt = await readJson(inspectedReceipt.path);
  if (receipt?.kind !== 'final_delivery_receipt' || receipt.status !== 'COMPLETE') {
    throw new Error('final delivery receipt must be COMPLETE');
  }
  if (receipt.projectId !== state.projectId) throw new Error('final delivery receipt projectId mismatch');
  safeId(receipt.id, 'final delivery receipt id');
  if (typeof receipt.completedAt !== 'string' || !Number.isFinite(Date.parse(receipt.completedAt))) {
    throw new TypeError('final delivery completedAt must be a date-time');
  }
  const artifact = finalDeliveryArtifact(receipt);
  safeId(artifact.id, 'final delivery artifact id');
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new TypeError('final delivery artifact sha256 is invalid');
  }
  const inspectedVideo = await inspectArtifactFile(root, artifact.path);
  if (inspectedVideo.sha256 !== artifact.sha256) throw new Error('final delivery artifact checksum changed');
  const durationMs = await invokeFfprobe(root, inspectedVideo.path, options.runner ?? runProcess);
  const probeFingerprint = sha256Text(JSON.stringify({
    algorithmVersion: ALGORITHM_VERSION,
    receiptSha256: inspectedReceipt.sha256,
    artifactId: artifact.id,
    artifactSha256: inspectedVideo.sha256,
    durationMs
  }));
  const probe = {
    schemaVersion: 1,
    kind: 'execution_media_probe',
    id: `media-probe-${probeFingerprint.slice(0, 24)}`,
    subjectId: artifact.id,
    sourceReceipt: {
      id: receipt.id, path: FINAL_DELIVERY_RECEIPT_PATH, sha256: inspectedReceipt.sha256
    },
    media: {
      path: artifact.path, sha256: inspectedVideo.sha256,
      durationMs, hasVideoStream: true
    },
    probedAt: options.now ?? receipt.completedAt,
    algorithm: { name: 'ffprobe-json-duration', version: ALGORITHM_VERSION }
  };
  const probePath = `traces/execution-observation-sources/${probe.id}.json`;
  const observation = assertExecutionObservation({
    subjectId: artifact.id,
    scope: 'delivery',
    stage: 'delivery',
    media: { kind: 'final_delivery', durationMs }
  });
  return {
    subjectId: artifact.id,
    observedAt: receipt.completedAt,
    segmentId: null,
    observation,
    sourceReferences: [
      { kind: 'execution_media_probe', id: artifact.id, path: probePath, sha256: canonicalJsonSha(probe) },
      { kind: 'final_delivery_receipt', id: receipt.id, path: FINAL_DELIVERY_RECEIPT_PATH, sha256: inspectedReceipt.sha256 }
    ],
    sourceSnapshots: [
      { path: FINAL_DELIVERY_RECEIPT_PATH, sha256: inspectedReceipt.sha256 },
      { path: artifact.path, sha256: inspectedVideo.sha256 }
    ],
    sourceWrites: [{ path: join(root, probePath), value: probe }]
  };
}

function externalAuditCost(run, approval) {
  if (!run.budget || run.budget.unit !== approval.budget?.unit) {
    throw new Error('external audit run budget does not match its approval');
  }
  if (run.budget.unit === 'USD') {
    if (approval.executionPolicy?.costEvidenceRequired !== 'actual_billed_usd'
      || run.costEvidence?.classification !== 'actual_billed_usd'
      || run.costEvidence.actualBilledUsd !== run.costUsd
      || run.costEvidence.amountUsd !== run.costUsd) {
      throw new Error('external audit run lacks exact actual billed USD evidence');
    }
    if (!Number.isFinite(run.costUsd) || run.costUsd < 0) throw new TypeError('external audit costUsd is invalid');
    return { amount: run.costUsd, unit: 'USD', evidenceLevel: 'actual_billed', purpose: 'external_audit' };
  }
  if (run.budget.unit !== 'CREDITS') throw new Error('external audit run budget unit is unsupported');
  const classification = run.costEvidence?.classification;
  const expected = approval.executionPolicy?.costEvidenceRequired;
  const evidenceLevel = classification === 'actual_consumed_credits'
    ? 'actual_consumed'
    : classification === 'usage_derived_consumed_credits' && run.costEvidence.receiptAvailable === false
      ? 'usage_derived'
      : null;
  if (classification !== expected || evidenceLevel === null
    || run.costEvidence.consumedCredits !== run.consumedCredits
    || run.costEvidence.amountCredits !== run.consumedCredits) {
    throw new Error('external audit run lacks the exact approved Credits evidence');
  }
  if (!Number.isFinite(run.consumedCredits) || run.consumedCredits < 0) {
    throw new TypeError('external audit consumedCredits is invalid');
  }
  return { amount: run.consumedCredits, unit: 'credits', evidenceLevel, purpose: 'external_audit' };
}

async function planExternalAuditCost(root, input) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const runPath = `runs/${encodeURIComponent(input.runId)}.json`;
  const inspectedRun = await inspectArtifactFile(root, runPath);
  const run = await readJson(inspectedRun.path);
  if (run?.kind !== 'independent_external_model_audit' || run.status !== 'SUCCESS' || run.id !== input.runId) {
    throw new Error('external audit cost requires its exact successful independent audit run');
  }
  if (run.projectId !== state.projectId) throw new Error('external audit run projectId mismatch');
  safeId(run.approvalId, 'external audit approvalId');
  safeId(run.segmentId, 'external audit segmentId');
  if (typeof run.updatedAt !== 'string' || !Number.isFinite(Date.parse(run.updatedAt))) {
    throw new TypeError('external audit updatedAt must be a date-time');
  }
  const approvalPath = `reviews/${encodeURIComponent(run.approvalId)}.json`;
  const inspectedApproval = await inspectArtifactFile(root, approvalPath);
  const approval = await readJson(inspectedApproval.path);
  if (approval?.kind !== 'external_audit_only_approval' || approval.decision !== 'approved'
    || approval.id !== run.approvalId || approval.projectId !== state.projectId
    || approval.segmentId !== run.segmentId) {
    throw new Error('external audit cost is not bound to its exact approved audit-only authorization');
  }
  const cost = externalAuditCost(run, approval);
  if (cost.amount > approval.budget.perCallLimit || cost.amount > approval.budget.totalLimit) {
    throw new Error('external audit cost exceeds its approved limit');
  }
  const inspectedProviderReport = await inspectArtifactFile(root, run.providerReportPath);
  if (inspectedProviderReport.sha256 !== run.providerReportSha256) {
    throw new Error('external audit provider report checksum changed');
  }
  return {
    subjectId: run.id,
    observedAt: run.updatedAt,
    segmentId: run.segmentId,
    observation: assertExecutionObservation({
      subjectId: run.id,
      scope: 'segment',
      stage: 'technical_review',
      cost
    }),
    sourceReferences: [{
      kind: 'external_audit_run', id: run.id, path: runPath, sha256: inspectedRun.sha256
    }, {
      kind: 'external_audit_approval', id: approval.id,
      path: approvalPath, sha256: inspectedApproval.sha256
    }, {
      kind: 'external_audit_provider_report', id: `${run.id}-provider-report`,
      path: run.providerReportPath, sha256: inspectedProviderReport.sha256
    }],
    sourceSnapshots: [
      { path: runPath, sha256: inspectedRun.sha256 },
      { path: approvalPath, sha256: inspectedApproval.sha256 },
      { path: run.providerReportPath, sha256: inspectedProviderReport.sha256 }
    ],
    sourceWrites: []
  };
}

async function planGenerationFailure(root, input) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const recordPath = `runs/generation-failures/${encodeURIComponent(input.failureEventId)}.json`;
  const inspected = await inspectArtifactFile(root, recordPath);
  const record = await readJson(inspected.path);
  if (record?.schemaVersion !== 1 || record.kind !== 'generation_failure_record'
    || record.id !== input.failureEventId) {
    throw new Error('generation failure source must be the exact immutable failure record');
  }
  if (record.projectId !== state.projectId) throw new Error('generation failure projectId mismatch');
  safeId(record.segmentId, 'generation failure segmentId');
  if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new TypeError('generation failure recordedAt must be a date-time');
  }
  if (!/^[a-f0-9]{64}$/.test(record.outputSha256 ?? '')) throw new TypeError('generation failure outputSha256 is invalid');
  const observation = assertExecutionObservation(record.observation);
  if (observation.subjectId !== record.id || observation.scope !== 'generation_attempt'
    || observation.stage !== 'technical_review' || !observation.failure
    || Object.keys(observation).some(key => ['timing', 'cost', 'media'].includes(key))) {
    throw new Error('generation failure record does not contain one normalized failure observation');
  }
  if (observation.failure.rootCauseKey !== record.rootCauseKey) {
    throw new Error('generation failure observation rootCauseKey mismatch');
  }
  return {
    subjectId: record.id,
    observedAt: record.recordedAt,
    segmentId: record.segmentId,
    observation,
    sourceReferences: [{
      kind: 'generation_failure_record', id: record.id,
      path: recordPath, sha256: inspected.sha256
    }],
    sourceSnapshots: [{ path: recordPath, sha256: inspected.sha256 }],
    sourceWrites: []
  };
}

async function planGate5Rejection(root, input) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const reviewPath = `reviews/${encodeURIComponent(input.reviewId)}.json`;
  const inspectedReview = await inspectArtifactFile(root, reviewPath);
  const review = assertQualityReview(await readJson(inspectedReview.path));
  if (review.id !== input.reviewId || review.decision !== 'rejected' || !review.failureObservation) {
    throw new Error('Gate 5 rejection source must be the exact structured rejected quality review');
  }
  const artifact = state.artifacts.find(item => item.id === review.artifactId);
  if (!artifact || !['video_segment', 'final_edit'].includes(artifact.type) || artifact.status !== 'rejected') {
    throw new Error('Gate 5 rejection review must bind a rejected video artifact');
  }
  if (artifact.rejectedByReviewId && artifact.rejectedByReviewId !== review.id) {
    throw new Error('Gate 5 rejected artifact binds a different review');
  }
  const inspectedArtifact = await inspectArtifactFile(root, artifact.path);
  if (inspectedArtifact.sha256 !== review.artifactSha256 || artifact.sha256 !== review.artifactSha256) {
    throw new Error('Gate 5 rejected artifact checksum changed');
  }
  if (artifact.type === 'video_segment') safeId(artifact.segmentId, 'Gate 5 rejected artifact segmentId');
  const observation = assertExecutionObservation({
    subjectId: review.id,
    scope: artifact.type === 'final_edit' ? 'project' : 'segment',
    stage: 'gate5',
    failure: review.failureObservation
  });
  return {
    subjectId: review.id,
    observedAt: review.createdAt,
    segmentId: artifact.type === 'final_edit' ? null : artifact.segmentId,
    observation,
    sourceReferences: [{
      kind: 'quality_review', id: review.id, path: reviewPath, sha256: inspectedReview.sha256
    }, {
      kind: 'reviewed_artifact', id: artifact.id, path: artifact.path, sha256: inspectedArtifact.sha256
    }],
    sourceSnapshots: [
      { path: reviewPath, sha256: inspectedReview.sha256 },
      { path: artifact.path, sha256: inspectedArtifact.sha256 }
    ],
    sourceWrites: []
  };
}

function publicPlan(plan) {
  return {
    schemaVersion: 1,
    kind: 'execution_observation_derivation_plan',
    status: 'READY',
    sourceType: plan.sourceType,
    algorithmVersion: ALGORITHM_VERSION,
    observationId: plan.receipt.id,
    subjectId: plan.subjectId,
    observation: plan.observation,
    evidencePath: plan.receipt.evidencePath,
    sourceReferences: plan.receipt.sourceReferences,
    wouldWriteLedger: true
  };
}

async function buildPlan(root, input, options) {
  validateInput(input);
  let source;
  if (input.sourceType === 'execution_trace_timing') source = await planTrace(root, input);
  else if (input.sourceType === 'video_audit_media') source = await planVideoAudit(root, input);
  else if (input.sourceType === 'final_delivery_media') source = await planFinalDelivery(root, options);
  else if (input.sourceType === 'external_audit_cost') source = await planExternalAuditCost(root, input);
  else if (input.sourceType === 'generation_failure') source = await planGenerationFailure(root, input);
  else source = await planGate5Rejection(root, input);
  const fingerprint = planFingerprint(input.sourceType, source.subjectId, source.observation, source.sourceReferences);
  const receiptId = `derived-${input.sourceType.replaceAll('_', '-')}-${fingerprint.slice(0, 24)}`;
  const receipt = buildReceipt({ id: receiptId, ...source });
  return { ...source, sourceType: input.sourceType, receipt, public: null };
}

function eventInput(plan) {
  return {
    type: 'execution_observation.recorded',
    occurredAt: plan.receipt.observedAt,
    actor: plan.receipt.actor,
    segmentId: plan.receipt.segmentId,
    correlationId: plan.receipt.correlationId,
    causationId: plan.receipt.causationId,
    idempotencyKey: `execution_observation.recorded:${plan.receipt.id}`,
    references: [{
      kind: 'execution_observation_evidence', id: plan.receipt.id,
      path: plan.receipt.evidencePath, sha256: canonicalJsonSha(plan.receipt)
    }, ...plan.receipt.sourceReferences],
    facts: {
      observationId: plan.receipt.id,
      derivationSourceType: plan.sourceType,
      derivationAlgorithmVersion: ALGORITHM_VERSION
    },
    observation: plan.observation
  };
}

async function verifySnapshots(root, snapshots) {
  for (const snapshot of snapshots) {
    const inspected = await inspectArtifactFile(root, snapshot.path);
    if (inspected.sha256 !== snapshot.sha256) throw new Error(`derivation source changed before commit: ${snapshot.path}`);
  }
}

async function verifyExistingOutput(path, expected, label) {
  const existing = await readJson(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing !== null && JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error(`${label} already exists with different contents`);
  }
  return existing !== null;
}

export async function planExecutionObservationDerivation(root, input, options = {}) {
  const projectRoot = resolve(root);
  const plan = await buildPlan(projectRoot, input, options);
  await prepareExecutionLedgerAppend(projectRoot, eventInput(plan));
  return publicPlan(plan);
}

export async function deriveExecutionObservation(root, input, options = {}) {
  const projectRoot = resolve(root);
  const plan = await buildPlan(projectRoot, input, options);
  return withProjectLock(projectRoot, async () => {
    await recoverJsonTransactions(projectRoot);
    await verifySnapshots(projectRoot, plan.sourceSnapshots);
    for (const write of plan.sourceWrites) await verifyExistingOutput(write.path, write.value, 'derived source evidence');
    const receiptPath = join(projectRoot, plan.receipt.evidencePath);
    await verifyExistingOutput(receiptPath, plan.receipt, 'derived observation receipt');
    const prepared = await prepareExecutionLedgerAppend(projectRoot, eventInput(plan));
    if (prepared.reused) {
      for (const write of plan.sourceWrites) {
        if (!(await verifyExistingOutput(write.path, write.value, 'derived source evidence'))) {
          throw new Error('reused observation is missing its derived source evidence');
        }
      }
      if (!(await verifyExistingOutput(receiptPath, plan.receipt, 'derived observation receipt'))) {
        throw new Error('reused observation is missing its evidence receipt');
      }
      return { ...publicPlan(plan), event: prepared.event, reused: true };
    }
    await commitJsonTransaction(
      projectRoot,
      options.transactionId ?? `derive-execution-observation-${plan.receipt.id}`,
      [...plan.sourceWrites, { path: receiptPath, value: plan.receipt }, ...prepared.writes],
      options.transactionOptions
    );
    return { ...publicPlan(plan), event: prepared.event, reused: false };
  });
}
