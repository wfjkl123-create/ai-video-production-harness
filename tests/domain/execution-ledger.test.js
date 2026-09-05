import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExecutionEvent,
  combineExecutionObservationSummaries,
  createExecutionEvent,
  executionEventId,
  projectExecutionEvents,
  summarizeExecutionObservations
} from '../../src/domain/execution-ledger.js';

function event(overrides = {}) {
  return createExecutionEvent({
    projectId: 'LEDGER-TEST',
    sequence: 1,
    type: 'generation.claimed',
    occurredAt: '2026-08-24T09:00:00.000Z',
    actor: { kind: 'system', id: null },
    segmentId: 'segment-001',
    correlationId: 'run-001',
    causationId: 'approval-001',
    idempotencyKey: 'generation.claimed:approval-001',
    references: [{ kind: 'generation_run', id: 'run-001', path: 'runs/run-001.json' }],
    facts: { runId: 'run-001', approvalId: 'approval-001' },
    ...overrides
  });
}

test('event id is deterministic and the content hash detects tampering', () => {
  const first = event();
  const second = event();
  assert.equal(first.id, executionEventId('LEDGER-TEST', 'generation.claimed:approval-001'));
  assert.deepEqual(first, second);
  assert.equal(assertExecutionEvent(first), first);
  assert.throws(() => assertExecutionEvent({ ...first, facts: { runId: 'changed' } }), /hash/);
});

test('projection requires a contiguous sequence and summarizes paid execution state', () => {
  const bootstrap = event({
    sequence: 1, type: 'ledger.bootstrap', segmentId: null, correlationId: null, causationId: null,
    idempotencyKey: 'ledger.bootstrap.v1', references: [], facts: { observationOnly: true }
  });
  const claimed = event({ sequence: 2 });
  const success = event({
    sequence: 3, type: 'generation.succeeded', occurredAt: '2026-08-24T09:10:00.000Z',
    idempotencyKey: 'generation.succeeded:run-001', facts: { runId: 'run-001', outputCount: 1 }
  });
  const projection = projectExecutionEvents('LEDGER-TEST', [success, bootstrap, claimed]);
  assert.equal(projection.lastSequence, 3);
  assert.equal(projection.bySegment['segment-001'].stage, 'generation.succeeded');
  assert.equal(projection.updatedAt, '2026-08-24T09:10:00.000Z');
  assert.equal(projection.counts.paidClaims, 1);
  assert.equal(projection.counts.successes, 1);
  assert.throws(() => projectExecutionEvents('LEDGER-TEST', [bootstrap, success]), /contiguous/);
});

test('projection exposes Gate 5 acceptance and final delivery without treating them as generation success', () => {
  const bootstrap = event({
    sequence: 1, type: 'ledger.bootstrap', segmentId: null, correlationId: null, causationId: null,
    idempotencyKey: 'ledger.bootstrap.v1', references: [], facts: { observationOnly: true }
  });
  const quality = event({
    sequence: 2, type: 'quality_review.accepted', idempotencyKey: 'quality_review.accepted:review-1',
    facts: { artifactType: 'video_segment', qualityDecision: 'accepted', decision: 'accepted' }
  });
  const delivery = event({
    sequence: 3, type: 'delivery.finalized', segmentId: null, correlationId: 'delivery-1', causationId: 'retro-1',
    idempotencyKey: 'delivery.finalized:delivery-1',
    facts: { receiptId: 'delivery-1', receiptStatus: 'COMPLETE', segmentCount: 1, gate5EvidenceVerified: true }
  });
  const projection = projectExecutionEvents('LEDGER-TEST', [bootstrap, quality, delivery]);
  assert.equal(projection.gate5.status, 'delivery_finalized');
  assert.equal(projection.gate5.acceptedSegmentCount, 1);
  assert.equal(projection.delivery.receiptStatus, 'COMPLETE');
  assert.equal(projection.counts.qualityAccepted, 1);
  assert.equal(projection.counts.deliveries, 1);
  assert.equal(projection.counts.successes, 0);
});

test('a Gate 5 rejection takes precedence over partial acceptance until final delivery', () => {
  const bootstrap = event({
    sequence: 1, type: 'ledger.bootstrap', segmentId: null, correlationId: null, causationId: null,
    idempotencyKey: 'ledger.bootstrap.v1', references: [], facts: { observationOnly: true }
  });
  const accepted = event({
    sequence: 2, type: 'quality_review.accepted', idempotencyKey: 'quality_review.accepted:review-1',
    facts: { artifactType: 'video_segment', qualityDecision: 'accepted', decision: 'accepted' }
  });
  const rejected = event({
    sequence: 3, type: 'quality_review.rejected', segmentId: 'segment-002',
    idempotencyKey: 'quality_review.rejected:review-2',
    facts: { artifactType: 'video_segment', qualityDecision: 'rejected', decision: 'rejected' }
  });
  const projection = projectExecutionEvents('LEDGER-TEST', [bootstrap, accepted, rejected]);
  assert.equal(projection.gate5.acceptedSegmentCount, 1);
  assert.equal(projection.gate5.rejectedSegmentCount, 1);
  assert.equal(projection.gate5.status, 'rejected');
});

test('v2 observation events preserve v1 projection semantics and summarize only explicit evidence', () => {
  const claimed = event();
  const observation = event({
    sequence: 2,
    type: 'execution_observation.recorded',
    occurredAt: '2026-08-24T09:05:00.000Z',
    idempotencyKey: 'execution_observation.recorded:observation-1',
    references: [{
      kind: 'execution_trace', id: 'trace-1', path: 'traces/trace-1.json', sha256: 'a'.repeat(64)
    }],
    facts: { observationId: 'observation-1' },
    observation: {
      subjectId: 'trace-1', scope: 'generation_attempt', stage: 'generation',
      timing: { machineExecutionMs: 1200, externalQueueMs: 5000, humanWaitMs: 300 },
      cost: { amount: 4.5, unit: 'CNY', evidenceLevel: 'actual_billed', purpose: 'paid_retry' },
      media: { kind: 'final_delivery', durationMs: 30_000 },
      failure: {
        category: 'identity_drift', rootCauseKey: 'identity-drift-1',
        responsibilityStage: 'assets', returnStage: 'assets', retryKind: 'paid'
      }
    }
  });
  assert.equal(observation.schemaVersion, 2);
  assert.equal(assertExecutionEvent(observation), observation);
  const projection = projectExecutionEvents('LEDGER-TEST', [claimed, observation]);
  assert.equal(projection.stage, 'generation.claimed');
  assert.equal(projection.bySegment['segment-001'].stage, 'generation.claimed');
  assert.equal(projection.counts.events, 2);

  const summary = summarizeExecutionObservations([claimed, observation]);
  assert.equal(summary.eventCount, 1);
  assert.equal(summary.derivation.manualEventCount, 1);
  assert.equal(summary.derivation.automaticEventCount, 0);
  assert.equal(summary.timing.externalQueueMs.medianMs, 5000);
  assert.equal(summary.timingByStage.generation.externalQueueMs.medianMs, 5000);
  assert.equal(summary.timingByStage.intake, undefined);
  assert.equal(summary.cost.byUnit.CNY.actualPaidRetry.amount, 4.5);
  assert.equal(summary.media.byKind.final_delivery.totalDurationMs, 30_000);
  assert.equal(summary.failures.byCategory.identity_drift, 1);
  const combined = combineExecutionObservationSummaries([summary, summary]);
  assert.equal(combined.timing.machineExecutionMs.medianMs, 1200);
  assert.equal(combined.timingByStage.generation.machineExecutionMs.medianMs, 1200);
  assert.equal(combined.cost.byUnit.CNY.actual.amount, 9);
  assert.equal(combined.failures.byReturnStage.assets, 2);
});

test('v2 observation events reject unbound evidence and unsupported inferred fields', () => {
  assert.throws(() => event({
    type: 'execution_observation.recorded',
    idempotencyKey: 'execution_observation.recorded:invalid-1', references: [],
    observation: { subjectId: 'trace-1', scope: 'project', stage: 'generation', timing: { machineExecutionMs: 1 } }
  }), /path and SHA-bound/);
  assert.throws(() => event({
    type: 'execution_observation.recorded',
    idempotencyKey: 'execution_observation.recorded:invalid-2',
    references: [{ kind: 'trace', id: 'trace-1', path: 'traces/a.json', sha256: 'a'.repeat(64) }],
    observation: { subjectId: 'trace-1', scope: 'project', stage: 'generation', timing: { inferredWaitMs: 1 } }
  }), /not supported/);
  assert.throws(() => event({
    type: 'execution_observation.recorded',
    idempotencyKey: 'execution_observation.recorded:invalid-3',
    references: [{
      kind: 'execution_observation_evidence', id: 'receipt-1',
      path: 'reviews/receipt.json', sha256: 'a'.repeat(64)
    }],
    observation: { subjectId: 'receipt-1', scope: 'project', stage: 'generation', timing: { machineExecutionMs: 1 } }
  }), /identify one non-receipt evidence reference/);
});

test('the same subject and observation component cannot be counted twice', () => {
  const claimed = event();
  const first = event({
    sequence: 2, type: 'execution_observation.recorded',
    idempotencyKey: 'execution_observation.recorded:duplicate-1',
    references: [{ kind: 'trace', id: 'trace-duplicate', path: 'traces/one.json', sha256: 'a'.repeat(64) }],
    facts: { observationId: 'duplicate-1' },
    observation: {
      subjectId: 'trace-duplicate', scope: 'generation_attempt', stage: 'generation',
      timing: { machineExecutionMs: 100 }
    }
  });
  const second = event({
    sequence: 3, type: 'execution_observation.recorded',
    idempotencyKey: 'execution_observation.recorded:duplicate-2',
    references: [{ kind: 'trace', id: 'trace-duplicate', path: 'traces/two.json', sha256: 'b'.repeat(64) }],
    facts: { observationId: 'duplicate-2' },
    observation: {
      subjectId: 'trace-duplicate', scope: 'generation_attempt', stage: 'generation',
      timing: { machineExecutionMs: 200 }
    }
  });
  assert.throws(() => projectExecutionEvents('LEDGER-TEST', [claimed, first, second]), /duplicate execution observation component/);
});
