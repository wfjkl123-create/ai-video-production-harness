import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { planFastDagNext } from '../../src/services/fast-dag-planner-service.js';

const sha = 'a'.repeat(64);
const batch = {
  id: 'batch-fast', kind: 'batch_generation_approval', actor: 'human', decision: 'approved', projectId: 'p-fast',
  executor: 'libtv', libtvProjectUuid: 'a'.repeat(32), externalAuditModel: 'claude-ocx-anthropic--claude-opus-4-8',
  segments: [
    { segmentId: 'segment-001', strategy: 'editorial_cut', maxPaidAttempts: 1 },
    { segmentId: 'segment-002', strategy: 'canonical_open', maxPaidAttempts: 1 },
    { segmentId: 'segment-003', strategy: 'continuous_proxy_handoff', maxPaidAttempts: 1 }
  ],
  budget: { unit: 'tasks', limit: 3 }, maxPaidSubmissions: 3,
  externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 2.5 },
  stopVetoes: ['blur'], approvedAt: '2026-08-08T00:00:00Z'
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fast-dag-'));
  await mkdir(join(root, 'reviews')); await mkdir(join(root, 'runs'));
  await writeJsonAtomic(join(root, 'reviews', `${batch.id}.json`), batch);
  return root;
}

test('wavefront keeps independent segments moving while one waits at Gate 4', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'runs', 'preflight-1.json'), {
    id: 'preflight-1', kind: 'video_preflight', status: 'READY', segmentId: 'segment-001',
    fingerprint: { sha256: sha }, externalAuditBrief: { path: 'brief-1.json' }, createdAt: '2026-08-08T00:01:00Z'
  });
  await writeJsonAtomic(join(root, 'reviews', 'audit-1.json'), {
    id: 'audit-1', kind: 'external_audit_attestation', segmentId: 'segment-001', auditStage: 'pre_generation',
    decision: 'PASS', fingerprintSha256: sha, auditRunId: 'audit-run-1', providerTaskId: 'session-1',
    model: batch.externalAuditModel, reviewedAt: '2026-08-08T00:02:00Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'audit-run-1.json'), {
    id: 'audit-run-1', kind: 'external_model_audit', status: 'SUCCESS', attestationId: 'audit-1', sessionId: 'session-1',
    model: batch.externalAuditModel, segmentId: 'segment-001', auditStage: 'pre_generation', fingerprintSha256: sha
  });

  const plan = await planFastDagNext(root, batch.id);
  assert.equal(plan.featureFlag, 'fast_dag_v1');
  assert.equal(plan.shadowOnly, true);
  assert.deepEqual(plan.readyActions.map(action => [action.segmentId, action.action]), [
    ['segment-002', 'CREATE_VIDEO_PREFLIGHT']
  ]);
  assert.deepEqual(plan.waitingActions.map(action => action.segmentId), ['segment-001']);
  assert.deepEqual(plan.blockedActions.map(action => [action.segmentId, action.blockedBySegmentId]), [
    ['segment-003', 'segment-002']
  ]);
});

test('all independent segments can enter the same free preparation wave', async () => {
  const root = await fixture();
  const plan = await planFastDagNext(root, batch.id);
  assert.deepEqual(plan.readyActions.map(action => action.segmentId), ['segment-001', 'segment-002']);
  assert.equal(plan.readyActions.every(action => action.lane === 'local_preparation'), true);
  assert.equal(plan.concurrencyBudget.local_preparation, 4);
});

test('a quality failure stops every branch before new work is scheduled', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'reviews', 'post-fail.json'), {
    id: 'post-fail', kind: 'external_audit_attestation', segmentId: 'segment-002', auditStage: 'post_generation',
    decision: 'FAIL', fingerprintSha256: sha, auditRunId: 'post-run', providerTaskId: 'session-post',
    model: batch.externalAuditModel, reviewedAt: '2026-08-08T00:03:00Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'post-run.json'), {
    id: 'post-run', kind: 'external_model_audit', status: 'SUCCESS', attestationId: 'post-fail', sessionId: 'session-post',
    model: batch.externalAuditModel, segmentId: 'segment-002', auditStage: 'post_generation', fingerprintSha256: sha
  });
  const plan = await planFastDagNext(root, batch.id);
  assert.equal(plan.status, 'STOPPED');
  assert.equal(plan.segmentId, 'segment-002');
});

test('indexed planning stays linear in output size at 4, 40, and 240 independent segments', async () => {
  for (const size of [4, 40, 240]) {
    const root = await mkdtemp(join(tmpdir(), `fast-dag-scale-${size}-`));
    await mkdir(join(root, 'reviews')); await mkdir(join(root, 'runs'));
    const scaled = {
      ...batch,
      id: `batch-scale-${size}`,
      segments: Array.from({ length: size }, (_, index) => ({
        segmentId: `segment-${String(index + 1).padStart(3, '0')}`,
        strategy: index % 2 === 0 ? 'editorial_cut' : 'canonical_open',
        maxPaidAttempts: 1
      })),
      budget: { unit: 'tasks', limit: size },
      maxPaidSubmissions: size,
      externalAuditBudget: { unit: 'USD', perCallLimit: 0.1, totalLimit: size }
    };
    await writeJsonAtomic(join(root, 'reviews', `${scaled.id}.json`), scaled);
    const started = performance.now();
    const plan = await planFastDagNext(root, scaled.id);
    const elapsedMs = performance.now() - started;
    assert.equal(plan.readyActions.length, size);
    assert.deepEqual(plan.indexStats, { reviewRecords: 1, runRecords: 0, segmentRecords: size });
    assert.ok(elapsedMs < 1000, `${size}-segment planning took ${elapsedMs}ms`);
  }
});
