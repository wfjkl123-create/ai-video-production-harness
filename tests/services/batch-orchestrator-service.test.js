import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { planBatchNext } from '../../src/services/batch-orchestrator-service.js';

const sha = 'a'.repeat(64);
const batch = {
  id: 'batch-1', kind: 'batch_generation_approval', actor: 'human', decision: 'approved', projectId: 'p1', executor: 'libtv', libtvProjectUuid: 'a'.repeat(32), externalAuditModel: 'claude-ocx-anthropic--claude-opus-4-8',
  segments: [{ segmentId: 'segment-001', strategy: 'editorial_cut', maxPaidAttempts: 1 }],
  budget: { unit: 'tasks', limit: 1 }, externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.8 }, maxPaidSubmissions: 1, stopVetoes: ['blur'], approvedAt: '2026-07-26T00:00:00Z'
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'batch-next-'));
  await mkdir(join(root, 'reviews')); await mkdir(join(root, 'runs'));
  await writeJsonAtomic(join(root, 'reviews', 'batch-1.json'), batch);
  return root;
}

test('plans preflight and external audit, then stops at the user canvas generation gate', async () => {
  const root = await fixture();
  assert.equal((await planBatchNext(root, batch.id)).action, 'CREATE_VIDEO_PREFLIGHT');
  await writeJsonAtomic(join(root, 'runs', 'preflight-1.json'), { id: 'preflight-1', kind: 'video_preflight', status: 'READY', segmentId: 'segment-001', fingerprint: { sha256: sha }, createdAt: '2026-07-26T00:01:00Z' });
  assert.equal((await planBatchNext(root, batch.id)).action, 'PREPARE_PRE_GENERATION_AUDIT_BRIEF');
  await writeJsonAtomic(join(root, 'runs', 'preflight-1.json'), {
    id: 'preflight-1', kind: 'video_preflight', status: 'READY', segmentId: 'segment-001', fingerprint: { sha256: sha },
    externalAuditBrief: { path: 'reviews/external-audit-briefs/segment-001.json', sha256: sha }, createdAt: '2026-07-26T00:01:00Z'
  });
  assert.equal((await planBatchNext(root, batch.id)).action, 'RUN_PRE_GENERATION_EXTERNAL_AUDIT');
  await writeJsonAtomic(join(root, 'reviews', 'audit-1.json'), {
    id: 'audit-1', kind: 'external_audit_attestation', segmentId: 'segment-001', auditStage: 'pre_generation', decision: 'PASS',
    fingerprintSha256: sha, auditRunId: 'audit-run-1', providerTaskId: 'session-1', model: batch.externalAuditModel, reviewedAt: '2026-07-26T00:02:00Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'audit-run-1.json'), {
    id: 'audit-run-1', kind: 'external_model_audit', status: 'SUCCESS', attestationId: 'audit-1', sessionId: 'session-1',
    model: batch.externalAuditModel, segmentId: 'segment-001', auditStage: 'pre_generation', fingerprintSha256: sha
  });
  const waiting = await planBatchNext(root, batch.id);
  assert.equal(waiting.status, 'WAITING');
  assert.equal(waiting.action, 'USER_CANVAS_GENERATION');
  assert.equal(waiting.reviewSurface, 'libtv_canvas');
  assert.equal(waiting.assistantMaySubmitByDefault, false);
  await writeJsonAtomic(join(root, 'reviews', 'paid-1.json'), { id: 'paid-1', kind: 'paid_generation_approval', segmentId: 'segment-001', parentBatchApprovalId: 'batch-1', consumedByRunId: null, createdAt: '2026-07-26T00:03:00Z' });
  const existingApproval = await planBatchNext(root, batch.id);
  assert.equal(existingApproval.status, 'WAITING');
  assert.equal(existingApproval.action, 'USER_CANVAS_GENERATION');
});

test('stops on FAIL and blocks an uncertain external audit without retry', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'reviews', 'post-fail.json'), { id: 'post-fail', kind: 'external_audit_attestation', segmentId: 'segment-001', auditStage: 'post_generation', decision: 'FAIL', auditRunId: 'post-run', providerTaskId: 'session-post', model: batch.externalAuditModel, fingerprintSha256: sha, reviewedAt: '2026-07-26T00:02:00Z' });
  await writeJsonAtomic(join(root, 'runs', 'post-run.json'), { id: 'post-run', kind: 'external_model_audit', status: 'SUCCESS', attestationId: 'post-fail', sessionId: 'session-post', model: batch.externalAuditModel, segmentId: 'segment-001', auditStage: 'post_generation', fingerprintSha256: sha });
  assert.equal((await planBatchNext(root, batch.id)).status, 'STOPPED');
  await writeJsonAtomic(join(root, 'runs', 'audit-run.json'), { id: 'audit-run', kind: 'external_model_audit', status: 'UNCERTAIN' });
  const blocked = await planBatchNext(root, batch.id);
  assert.equal(blocked.action, 'RECONCILE_EXTERNAL_AUDIT');
});

test('requires post-generation audit before completion', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'runs', 'video-1.json'), { id: 'video-1', segmentId: 'segment-001', status: 'SUCCESS', outputs: [{ path: 'video.mp4', sha256: sha }] });
  assert.equal((await planBatchNext(root, batch.id)).action, 'PREPARE_VIDEO_AUDIT_PACKAGE');
  await writeJsonAtomic(join(root, 'runs', 'video-1.json'), {
    id: 'video-1', segmentId: 'segment-001', status: 'SUCCESS', outputs: [{ path: 'video.mp4', sha256: sha }],
    auditPackage: { machineDecision: 'PASS', reportPath: 'reviews/video-audits/a/report.json', reportSha256: sha }
  });
  assert.equal((await planBatchNext(root, batch.id)).action, 'RUN_POST_GENERATION_EXTERNAL_AUDIT');
  await writeJsonAtomic(join(root, 'reviews', 'post-pass.json'), { id: 'post-pass', kind: 'external_audit_attestation', segmentId: 'segment-001', auditStage: 'post_generation', decision: 'PASS', auditRunId: 'post-run', providerTaskId: 'session-post', model: batch.externalAuditModel, fingerprintSha256: sha, reviewedAt: '2026-07-26T00:04:00Z' });
  await writeJsonAtomic(join(root, 'runs', 'post-run.json'), { id: 'post-run', kind: 'external_model_audit', status: 'SUCCESS', attestationId: 'post-pass', sessionId: 'session-post', model: batch.externalAuditModel, segmentId: 'segment-001', auditStage: 'post_generation', fingerprintSha256: sha });
  assert.equal((await planBatchNext(root, batch.id)).status, 'COMPLETE');
});

test('stops the batch when local video machine audit triggers a veto', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'runs', 'video-1.json'), {
    id: 'video-1', segmentId: 'segment-001', status: 'SUCCESS', outputs: [{ path: 'video.mp4', sha256: sha }],
    auditPackage: { machineDecision: 'FAIL', triggeredVetoes: ['missing_generated_audio'] }
  });
  const next = await planBatchNext(root, batch.id);
  assert.equal(next.status, 'STOPPED');
  assert.deepEqual(next.triggeredVetoes, ['missing_generated_audio']);
});
