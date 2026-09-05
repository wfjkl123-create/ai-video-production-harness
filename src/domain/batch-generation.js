import { assertExternalAuditAttestation } from './external-audit-attestation.js';

const STRATEGIES = new Set(['canonical_open', 'editorial_cut', 'continuous_proxy_handoff']);
const EXECUTORS = new Set(['libtv', 'runninghub']);
const BUDGET_UNITS = new Set(['CNY', 'credits', 'tasks']);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function positive(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive finite number`);
}

export function assertBatchGenerationApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('batch generation approval must be an object');
  text(value.id, 'id');
  if (value.kind !== 'batch_generation_approval') throw new TypeError('kind must be batch_generation_approval');
  if (value.actor !== 'human' || value.decision !== 'approved') throw new Error('batch generation approval requires an explicit human approval');
  text(value.projectId, 'projectId');
  if (!EXECUTORS.has(value.executor)) throw new TypeError('executor must be libtv or runninghub');
  if (value.executor === 'libtv' && (typeof value.libtvProjectUuid !== 'string' || !/^[a-f0-9]{32}$/.test(value.libtvProjectUuid))) {
    throw new TypeError('libtvProjectUuid must be a 32-character lowercase hexadecimal UUID');
  }
  text(value.externalAuditModel, 'externalAuditModel');
  const isNonGpt = /^(?:claude-ocx-(?:anthropic|kimi|qwen)--|(?:anthropic|kimi|qwen)\/)[A-Za-z0-9._-]+$/.test(value.externalAuditModel)
    && !/gpt|openai/i.test(value.externalAuditModel);
  if (!isNonGpt) {
    // GPT fallback is allowed when explicitly flagged; the audit report must record fallback: true and fallbackReason.
    if (value.auditFallback !== true) {
      throw new Error('externalAuditModel must be a non-GPT model, or set auditFallback: true with auditFallbackReason to use GPT as fallback');
    }
    text(value.auditFallbackReason, 'auditFallbackReason');
  }
  if (!Array.isArray(value.segments) || value.segments.length === 0) throw new TypeError('segments must be a non-empty array');
  const ids = new Set();
  for (const [index, segment] of value.segments.entries()) {
    text(segment.segmentId, `segments[${index}].segmentId`);
    if (ids.has(segment.segmentId)) throw new Error('batch segment IDs must be unique');
    ids.add(segment.segmentId);
    if (!STRATEGIES.has(segment.strategy)) throw new TypeError(`segments[${index}].strategy is invalid`);
    if (segment.maxPaidAttempts !== 1) throw new Error('each batch segment must allow exactly one paid attempt');
  }
  if (!value.budget || typeof value.budget !== 'object' || Array.isArray(value.budget)) throw new TypeError('budget must be an object');
  if (!BUDGET_UNITS.has(value.budget.unit)) throw new TypeError('budget.unit must be CNY, credits, or tasks');
  positive(value.budget.limit, 'budget.limit');
  if (!Number.isInteger(value.maxPaidSubmissions) || value.maxPaidSubmissions < 1 || value.maxPaidSubmissions > value.segments.length) {
    throw new Error('maxPaidSubmissions must be between 1 and the number of approved segments');
  }
  if (value.maxPaidSubmissions > value.budget.limit && value.budget.unit === 'tasks') {
    throw new Error('task budget must cover maxPaidSubmissions');
  }
  if (!value.externalAuditBudget || value.externalAuditBudget.unit !== 'USD') throw new TypeError('externalAuditBudget.unit must be USD');
  positive(value.externalAuditBudget.perCallLimit, 'externalAuditBudget.perCallLimit');
  positive(value.externalAuditBudget.totalLimit, 'externalAuditBudget.totalLimit');
  if (value.externalAuditBudget.perCallLimit > value.externalAuditBudget.totalLimit) throw new Error('external audit per-call limit cannot exceed total limit');
  const requiredAuditReserve = value.maxPaidSubmissions * 2 * value.externalAuditBudget.perCallLimit;
  if (value.externalAuditBudget.totalLimit < requiredAuditReserve) {
    throw new Error('external audit total limit must reserve both pre- and post-generation audits for every paid submission');
  }
  if (!Array.isArray(value.stopVetoes) || value.stopVetoes.length === 0) throw new TypeError('stopVetoes must be a non-empty array');
  value.stopVetoes.forEach((item, index) => text(item, `stopVetoes[${index}]`));
  text(value.approvedAt, 'approvedAt');
  if (Number.isNaN(Date.parse(value.approvedAt))) throw new TypeError('approvedAt must be a date-time');
  return value;
}

export function authorizeDerivedSegment({ batch, segmentId, fingerprintSha256, audit, priorRuns = [] }) {
  assertBatchGenerationApproval(batch);
  assertExternalAuditAttestation(audit);
  const segment = batch.segments.find((candidate) => candidate.segmentId === segmentId);
  if (!segment) throw new Error(`segment ${segmentId} is outside the batch approval`);
  if (audit.segmentId !== segmentId || audit.auditStage !== 'pre_generation') throw new Error('derived approval requires a pre-generation audit for the same segment');
  if (audit.decision !== 'PASS') throw new Error('derived segment approval requires an external audit PASS');
  if (audit.fingerprintSha256 !== fingerprintSha256) throw new Error('external audit fingerprint does not match the current segment fingerprint');
  const paidRuns = priorRuns.filter((run) => run?.paid === true || run?.paidApprovalId);
  if (paidRuns.length >= batch.maxPaidSubmissions) throw new Error('batch paid submission limit is exhausted');
  if (paidRuns.some((run) => run.segmentId === segmentId)) throw new Error(`segment ${segmentId} already consumed its one paid attempt`);
  const failed = priorRuns.find((run) => run?.qualityDecision === 'FAIL' || (run?.triggeredVetoes?.length ?? 0) > 0);
  if (failed) throw new Error(`batch is stopped by failed segment ${failed.segmentId ?? 'unknown'}`);
  const segmentIndex = batch.segments.findIndex((candidate) => candidate.segmentId === segmentId);
  if (segment.strategy === 'continuous_proxy_handoff' && segmentIndex > 0) {
    const previous = batch.segments[segmentIndex - 1];
    const completed = priorRuns.some((run) => run?.segmentId === previous.segmentId && run?.qualityDecision === 'PASS');
    if (!completed) throw new Error(`previous segment ${previous.segmentId} has no external post-generation PASS`);
  }
  return {
    kind: 'derived_segment_generation_approval',
    actor: 'delegated_batch_policy',
    parentBatchApprovalId: batch.id,
    segmentId,
    fingerprintSha256,
    externalAuditAttestationId: audit.id,
    maxPaidAttempts: 1,
    executor: batch.executor
  };
}
