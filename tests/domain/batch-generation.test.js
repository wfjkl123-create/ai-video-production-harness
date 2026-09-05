import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBatchGenerationApproval, authorizeDerivedSegment } from '../../src/domain/batch-generation.js';
import { assertExternalAuditAttestation } from '../../src/domain/external-audit-attestation.js';

const digest = 'a'.repeat(64);
const batch = {
  id: 'batch-001', kind: 'batch_generation_approval', actor: 'human', decision: 'approved',
  projectId: 'project-001', executor: 'libtv', libtvProjectUuid: 'a'.repeat(32), externalAuditModel: 'claude-ocx-anthropic--claude-opus-4-8',
  segments: [
    { segmentId: 'segment-001', strategy: 'editorial_cut', maxPaidAttempts: 1 },
    { segmentId: 'segment-002', strategy: 'continuous_proxy_handoff', maxPaidAttempts: 1 }
  ],
  budget: { unit: 'tasks', limit: 2 }, externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 1.6 }, maxPaidSubmissions: 2,
  stopVetoes: ['blur', '穿模', '错嘴'], approvedAt: '2026-07-26T00:00:00.000Z'
};
const audit = {
  id: 'audit-001', kind: 'external_audit_attestation', provider: 'kimi', model: 'kimi-k2.7-code',
  segmentId: 'segment-001', auditStage: 'pre_generation',
  providerTaskId: 'task-001', auditRunId: 'audit-run-001', cleanZeroContext: true, decision: 'PASS',
  fingerprintSha256: digest, reportSha256: 'b'.repeat(64), reviewedAt: '2026-07-26T00:01:00.000Z'
};

test('accepts a bounded human batch approval', () => {
  assert.equal(assertBatchGenerationApproval(batch), batch);
  assert.throws(() => assertBatchGenerationApproval({
    ...batch, externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.8 }
  }), /reserve both pre- and post-generation/);
});

test('rejects GPT or inherited-context audit attestations', () => {
  assert.throws(() => assertExternalAuditAttestation({ ...audit, provider: 'anthropic', model: 'gpt-5' }), /GPT/);
  assert.throws(() => assertExternalAuditAttestation({ ...audit, cleanZeroContext: false }), /cleanZeroContext/);
});

test('derives one exact segment approval from a matching non-GPT PASS', () => {
  const derived = authorizeDerivedSegment({ batch, segmentId: 'segment-001', fingerprintSha256: digest, audit });
  assert.equal(derived.parentBatchApprovalId, batch.id);
  assert.equal(derived.actor, 'delegated_batch_policy');
});

test('stops on mismatch, repeat spend, budget exhaustion, or prior quality failure', () => {
  assert.throws(() => authorizeDerivedSegment({ batch, segmentId: 'segment-001', fingerprintSha256: 'c'.repeat(64), audit }), /fingerprint/);
  assert.throws(() => authorizeDerivedSegment({ batch, segmentId: 'segment-001', fingerprintSha256: digest, audit, priorRuns: [{ segmentId: 'segment-001', paid: true }] }), /already consumed/);
  assert.throws(() => authorizeDerivedSegment({ batch, segmentId: 'segment-001', fingerprintSha256: digest, audit, priorRuns: [{ segmentId: 'x', paid: true }, { segmentId: 'y', paid: true }] }), /limit/);
  assert.throws(() => authorizeDerivedSegment({ batch, segmentId: 'segment-001', fingerprintSha256: digest, audit, priorRuns: [{ segmentId: 'segment-x', qualityDecision: 'FAIL' }] }), /stopped/);
});

test('requires an external post-generation PASS before the next paid segment', () => {
  const secondAudit = { ...audit, id: 'audit-002', segmentId: 'segment-002' };
  assert.throws(() => authorizeDerivedSegment({ batch, segmentId: 'segment-002', fingerprintSha256: digest, audit: secondAudit }), /no external post-generation PASS/);
  assert.equal(authorizeDerivedSegment({
    batch, segmentId: 'segment-002', fingerprintSha256: digest, audit: secondAudit,
    priorRuns: [{ segmentId: 'segment-001', paid: true, qualityDecision: 'PASS' }]
  }).segmentId, 'segment-002');
});

test('an editorial or canonical segment does not inherit a false sequential dependency', () => {
  const independentBatch = {
    ...batch,
    segments: [
      batch.segments[0],
      { segmentId: 'segment-002', strategy: 'editorial_cut', maxPaidAttempts: 1 }
    ]
  };
  const secondAudit = { ...audit, id: 'audit-independent', segmentId: 'segment-002' };
  assert.equal(authorizeDerivedSegment({
    batch: independentBatch,
    segmentId: 'segment-002',
    fingerprintSha256: digest,
    audit: secondAudit
  }).segmentId, 'segment-002');
});
