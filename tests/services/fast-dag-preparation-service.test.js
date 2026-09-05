import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { runFastDagFreePreparation } from '../../src/services/fast-dag-preparation-service.js';
import { initializeProject } from '../../src/services/project-service.js';
import { readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';
import { readExecutionTrace } from '../../src/services/execution-trace-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fast-free-prep-'));
  await initializeProject(root, { projectId: 'free' });
  const batch = {
    id: 'batch-free', kind: 'batch_generation_approval', actor: 'human', decision: 'approved', projectId: 'free',
    executor: 'libtv', libtvProjectUuid: 'a'.repeat(32), externalAuditModel: 'claude-ocx-anthropic--claude-opus-4-8',
    segments: ['001', '002', '003'].map(id => ({ segmentId: `segment-${id}`, strategy: 'editorial_cut', maxPaidAttempts: 1 })),
    budget: { unit: 'tasks', limit: 3 }, maxPaidSubmissions: 3,
    externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 2.5 },
    stopVetoes: ['blur'], approvedAt: '2026-08-08T00:00:00Z'
  };
  await writeJsonAtomic(join(root, 'reviews', `${batch.id}.json`), batch);
  return { root, batch };
}

test('executes only local preparation with bounded concurrency and stops before external work', async () => {
  const { root, batch } = await fixture();
  let planCall = 0;
  let active = 0;
  let peak = 0;
  const result = await runFastDagFreePreparation(root, batch.id, {
    useCheckpoints: false,
    maxConcurrency: 2,
    planner: async () => {
      planCall += 1;
      return planCall === 1 ? {
        status: 'READY', readyActions: batch.segments.map(segment => ({
          status: 'READY', action: 'CREATE_VIDEO_PREFLIGHT', lane: 'local_preparation', segmentId: segment.segmentId
        }))
      } : {
        status: 'READY', readyActions: batch.segments.map(segment => ({
          status: 'READY', action: 'RUN_PRE_GENERATION_EXTERNAL_AUDIT', lane: 'external_audit', segmentId: segment.segmentId
        }))
      };
    },
    operations: {
      createPreflight: async (_root, _batch, action) => {
        active += 1; peak = Math.max(peak, active);
        await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
        active -= 1;
        return { preflightId: `preflight-${action.segmentId}` };
      }
    }
  });
  assert.equal(peak, 2);
  assert.equal(result.status, 'WAITING_FREE_BOUNDARY');
  assert.equal(result.completedActions.length, 3);
  assert.equal(planCall, 2);
  const trace = await readExecutionTrace(root, result.traceId);
  assert.equal(trace.metadata.authoritativeObservation.basis, 'declared_spans');
  assert.equal(trace.metadata.authoritativeObservation.stage, 'generation');
  const ledger = await readExecutionLedgerStatus(root);
  assert.equal(ledger.observations.derivation.automaticEventCount, 1);
  assert.equal(ledger.observations.derivation.bySourceType.execution_trace_timing, 1);
  assert.equal(ledger.observations.timing.machineExecutionMs.sampleCount, 1);
});

test('a free preparation failure stops new waves without touching external lanes', async () => {
  const { root, batch } = await fixture();
  let externalCalls = 0;
  const result = await runFastDagFreePreparation(root, batch.id, {
    useCheckpoints: false,
    maxConcurrency: 1,
    planner: async () => ({
      status: 'READY',
      readyActions: [
        { action: 'CREATE_VIDEO_PREFLIGHT', lane: 'local_preparation', segmentId: 'segment-001' },
        { action: 'RUN_PRE_GENERATION_EXTERNAL_AUDIT', lane: 'external_audit', segmentId: 'segment-002' }
      ]
    }),
    operations: {
      createPreflight: async () => { throw new Error('local fingerprint invalid'); },
      runExternalAudit: async () => { externalCalls += 1; }
    }
  });
  assert.equal(result.status, 'FAILED');
  assert.match(result.error, /fingerprint invalid/);
  assert.equal(externalCalls, 0);
});

test('durable checkpoint reuse skips a previously succeeded free action', async () => {
  const { root, batch } = await fixture();
  let operationCalls = 0;
  const identity = {
    taskType: 'create_video_preflight', inputs: { segmentId: 'segment-001', fingerprint: 'stable' },
    dependencyKeys: [], sourceFact: null, storyPlan: null, template: null, skill: null,
    model: null, params: {}, codeVersion: 'test-v1', policy: { paid: false, idempotent: true }
  };
  const options = () => {
    let planCall = 0;
    return {
      maxConcurrency: 1,
      planner: async () => {
        planCall += 1;
        return planCall === 1
          ? { status: 'READY', readyActions: [{ action: 'CREATE_VIDEO_PREFLIGHT', lane: 'local_preparation', segmentId: 'segment-001' }] }
          : { status: 'READY', readyActions: [{ action: 'RUN_PRE_GENERATION_EXTERNAL_AUDIT', lane: 'external_audit', segmentId: 'segment-001' }] };
      },
      checkpointIdentityForAction: async () => identity,
      checkpointOutputs: async () => [{ id: 'preflight', sha256: 'a'.repeat(64) }],
      operations: {
        createPreflight: async () => {
          operationCalls += 1;
          return { preflightId: 'preflight-1' };
        }
      }
    };
  };

  const first = await runFastDagFreePreparation(root, batch.id, options());
  const second = await runFastDagFreePreparation(root, batch.id, options());
  assert.equal(first.completedActions[0].result.reused, false);
  assert.equal(second.completedActions[0].result.reused, true);
  assert.equal(operationCalls, 1);
});
