import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { runBatchAutonomously } from '../../src/services/batch-autonomous-runner-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'batch-auto-'));
  await mkdir(join(root, 'reviews'));
  await writeJsonAtomic(join(root, 'reviews', 'batch-1.json'), {
    id: 'batch-1', kind: 'batch_generation_approval', actor: 'human', decision: 'approved', projectId: 'p1', executor: 'libtv',
    libtvProjectUuid: 'a'.repeat(32), externalAuditModel: 'claude-ocx-anthropic--claude-opus-4-8',
    segments: [{ segmentId: 'segment-001', strategy: 'editorial_cut', maxPaidAttempts: 1 }],
    budget: { unit: 'tasks', limit: 1 }, externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.8 },
    maxPaidSubmissions: 1, stopVetoes: ['blur'], approvedAt: '2026-07-26T00:00:00Z'
  });
  return root;
}

test('stops at the user canvas generation gate without submitting video', async () => {
  const root = await fixture();
  const actions = [
    { status: 'READY', action: 'CREATE_VIDEO_PREFLIGHT', segmentId: 'segment-001' },
    { status: 'READY', action: 'PREPARE_PRE_GENERATION_AUDIT_BRIEF', segmentId: 'segment-001', preflightId: 'p1' },
    { status: 'READY', action: 'RUN_PRE_GENERATION_EXTERNAL_AUDIT', segmentId: 'segment-001', preflightId: 'p1', promptPath: 'brief.json' },
    { status: 'WAITING', action: 'USER_CANVAS_GENERATION', segmentId: 'segment-001', preflightId: 'p1', reviewSurface: 'libtv_canvas' }
  ];
  const called = [];
  const operation = name => async () => { called.push(name); };
  const result = await runBatchAutonomously(root, 'batch-1', {
    planner: async () => actions.shift(),
    operations: {
      createPreflight: operation('preflight'), preparePreAuditBrief: operation('brief'), runExternalAudit: operation('audit'),
      deriveApproval: operation('derive'), runLibTvVideo: operation('video'), prepareVideoAudit: operation('machine')
    }
  });
  assert.equal(result.status, 'WAITING');
  assert.deepEqual(called, ['preflight', 'brief', 'audit']);
});

test('requires explicit authorization before a custom planner can submit video', async () => {
  const root = await fixture();
  const called = [];
  const operation = name => async () => { called.push(name); };
  const result = await runBatchAutonomously(root, 'batch-1', {
    planner: async () => ({ status: 'READY', action: 'RUN_LIBTV_VIDEO_ONCE', segmentId: 'segment-001', paidApprovalId: 'paid1' }),
    operations: { runLibTvVideo: operation('video') }
  });
  assert.equal(result.status, 'WAITING');
  assert.deepEqual(called, []);
});

test('returns immediately on FAIL or uncertainty and performs no later operation', async () => {
  const root = await fixture();
  let called = false;
  const result = await runBatchAutonomously(root, 'batch-1', {
    planner: async () => ({ status: 'STOPPED', action: 'HUMAN_REVIEW_REQUIRED', reason: 'quality fail' }),
    operations: { createPreflight: async () => { called = true; } }
  });
  assert.equal(result.status, 'STOPPED');
  assert.equal(called, false);
});
