import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import {
  appendExecutionEvent,
  executionLedgerHeadPath,
  executionLedgerProjectionPath,
  prepareExecutionLedgerAppend,
  readExecutionLedgerStatus,
  readExecutionEvents,
  rebuildExecutionLedgerProjection
} from '../../src/services/execution-ledger-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import { recordExecutionObservation } from '../../src/services/execution-observation-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'execution-ledger-'));
  await initializeProject(root, { projectId: 'LEDGER-SERVICE-TEST' });
  return root;
}

function claimed() {
  return {
    type: 'generation.claimed',
    occurredAt: '2026-08-24T09:00:00.000Z',
    actor: { kind: 'system', id: null },
    segmentId: 'segment-001',
    correlationId: 'run-001',
    causationId: 'approval-001',
    idempotencyKey: 'generation.claimed:approval-001',
    references: [{ kind: 'generation_run', id: 'run-001', path: 'runs/run-001.json' }],
    facts: { runId: 'run-001', approvalId: 'approval-001' }
  };
}

test('first append creates an observation-only bootstrap, event, head and projection atomically', async () => {
  const root = await fixture();
  const result = await appendExecutionEvent(root, claimed());
  assert.equal(result.reused, false);
  const events = await readExecutionEvents(root);
  assert.deepEqual(events.map(event => event.type), ['ledger.bootstrap', 'generation.claimed']);
  assert.equal(events[0].facts.observationOnly, true);
  assert.equal(events[0].references[0].sha256, await sha256File(join(root, 'ledger/bootstrap/project-state.json')));
  assert.equal((await readJson(executionLedgerHeadPath(root))).lastSequence, 2);
  assert.equal((await readJson(executionLedgerProjectionPath(root))).counts.paidClaims, 1);
});

test('same idempotency key reuses the exact event and rejects changed facts', async () => {
  const root = await fixture();
  const first = await appendExecutionEvent(root, claimed());
  const second = await appendExecutionEvent(root, claimed());
  assert.equal(second.reused, true);
  assert.equal(second.event.id, first.event.id);
  assert.equal((await readExecutionEvents(root)).length, 2);
  await assert.rejects(appendExecutionEvent(root, {
    ...claimed(), facts: { runId: 'different', approvalId: 'approval-001' }
  }), /idempotency key was reused/);
});

test('prepared writes can join the caller business transaction and projection can be rebuilt', async () => {
  const root = await fixture();
  const prepared = await prepareExecutionLedgerAppend(root, claimed());
  assert.equal(prepared.writes.length, 5);
  await appendExecutionEvent(root, claimed());
  const rebuilt = await rebuildExecutionLedgerProjection(root);
  assert.equal(rebuilt.lastSequence, 2);
  assert.equal(rebuilt.bySegment['segment-001'].runId, 'run-001');
  assert.deepEqual(await rebuildExecutionLedgerProjection(root), rebuilt);
});

test('bootstrap supports a valid Chinese project id without weakening event ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-ledger-cn-'));
  await initializeProject(root, { projectId: '视频项目-01' });
  const result = await appendExecutionEvent(root, { ...claimed(), correlationId: 'run-cn' });
  assert.equal(result.event.projectId, '视频项目-01');
  assert.match(result.event.id, /^evt-[a-f0-9]{32}$/);
});

test('read-only status distinguishes an uninitialized ledger from a failure', async () => {
  const root = await fixture();
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.initialized, false);
  assert.equal(status.consistency, 'not_initialized');
  assert.equal(status.counts.events, 0);
  assert.ok(status.funnel.every(stage => stage.status === 'not_observed'));
});

test('read-only status derives the funnel and segment evidence from validated events', async () => {
  const root = await fixture();
  await appendExecutionEvent(root, claimed());
  await appendExecutionEvent(root, {
    type: 'generation.succeeded', occurredAt: '2026-08-24T09:03:00.000Z',
    actor: { kind: 'system', id: null }, segmentId: 'segment-001', correlationId: 'run-001', causationId: 'run-001',
    idempotencyKey: 'generation.succeeded:run-001', references: [], facts: { runId: 'run-001' }
  });
  await appendExecutionEvent(root, {
    type: 'quality_review.accepted', occurredAt: '2026-08-24T09:04:00.000Z',
    actor: { kind: 'human', id: 'reviewer-1' }, segmentId: 'segment-001', correlationId: 'review-001', causationId: 'run-001',
    idempotencyKey: 'quality_review.accepted:review-001', references: [],
    facts: { artifactType: 'video_segment', decision: 'accepted', qualityDecision: 'accepted' }
  });
  const status = await readExecutionLedgerStatus(root, { latestEventLimit: 2 });
  assert.equal(status.consistency, 'consistent');
  assert.equal(status.historyCoverage, 'since_observation_bootstrap');
  assert.equal(status.funnel.find(stage => stage.id === 'generation_output').status, 'observed');
  assert.equal(status.funnel.find(stage => stage.id === 'quality_review').status, 'observed');
  assert.equal(status.segments[0].segmentId, 'segment-001');
  assert.equal(status.latestEvents.length, 2);
});

test('read-only status reports projection mismatch without repairing files', async () => {
  const root = await fixture();
  await appendExecutionEvent(root, claimed());
  const projectionPath = executionLedgerProjectionPath(root);
  const tampered = { ...(await readJson(projectionPath)), stage: 'generation.failed' };
  await writeJsonAtomic(projectionPath, tampered);
  const before = await readFile(projectionPath, 'utf8');
  const status = await readExecutionLedgerStatus(root);
  const after = await readFile(projectionPath, 'utf8');
  assert.equal(status.consistency, 'inconsistent');
  assert.ok(status.issueCodes.includes('projection_mismatch'));
  assert.equal(after, before, 'status reads must not rebuild or mutate the ledger');
});

test('read-only status surfaces pending recovery without replaying the transaction', async () => {
  const root = await fixture();
  const journalPath = join(root, '.transactions', 'pending-ledger-status.json');
  await writeJsonAtomic(journalPath, {
    id: 'pending-ledger-status', status: 'PENDING', writes: [], createdAt: '2026-08-24T09:00:00.000Z'
  });
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.consistency, 'pending_recovery');
  assert.equal(status.pendingTransactionCount, 1);
  assert.equal((await readJson(journalPath)).status, 'PENDING');
});

test('evidence-bound v2 observations are authoritative while absent v1 metrics remain unknown', async () => {
  const root = await fixture();
  await appendExecutionEvent(root, claimed());
  await mkdir(join(root, 'traces'), { recursive: true });
  const evidencePath = join(root, 'traces', 'generation-observation.json');
  await writeFile(evidencePath, '{"source":"measured"}\n');
  const observationInput = {
    schemaVersion: 2, kind: 'execution_observation_evidence',
    id: 'generation-observation-1', evidencePath: 'reviews/generation-observation-input.json',
    observedAt: '2026-08-24T09:10:00.000Z',
    actor: { kind: 'human', id: 'reviewer-1' }, segmentId: 'segment-001',
    correlationId: 'run-001', causationId: null,
    sourceReferences: [{
      kind: 'execution_trace', id: 'generation-observation', path: 'traces/generation-observation.json',
      sha256: await sha256File(evidencePath)
    }],
    observation: {
      subjectId: 'generation-observation', scope: 'generation_attempt', stage: 'generation',
      timing: { machineExecutionMs: 2_000, externalQueueMs: 8_000 },
      cost: { amount: 3, unit: 'credits', evidenceLevel: 'actual_consumed', purpose: 'initial_generation' },
      media: { kind: 'generated_output', durationMs: 15_000 }
    }
  };
  await writeFile(join(root, observationInput.evidencePath), `${JSON.stringify(observationInput, null, 2)}\n`);
  const result = await recordExecutionObservation(root, observationInput);
  assert.equal(result.event.schemaVersion, 2);
  assert.equal((await recordExecutionObservation(root, observationInput)).reused, true);
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.consistency, 'consistent');
  assert.equal(status.observations.eventCount, 1);
  assert.equal(status.observations.derivation.manualEventCount, 1);
  assert.equal(status.observations.timing.machineExecutionMs.totalMs, 2_000);
  assert.equal(status.observations.timing.humanWaitMs.sampleCount, 0);
  assert.equal(status.observations.cost.byUnit.credits.actual.amount, 3);
  assert.equal(status.observations.media.byKind.final_delivery.sampleCount, 0);
});

test('v2 observation recording fails closed when evidence bytes change', async () => {
  const root = await fixture();
  await mkdir(join(root, 'traces'), { recursive: true });
  const evidencePath = join(root, 'traces', 'changed.json');
  await writeFile(evidencePath, '{}\n');
  const observationInput = {
    schemaVersion: 2, kind: 'execution_observation_evidence',
    id: 'changed-observation', evidencePath: 'reviews/changed-observation-input.json',
    observedAt: '2026-08-24T09:10:00.000Z',
    actor: { kind: 'human', id: null }, segmentId: null, correlationId: null, causationId: null,
    sourceReferences: [{ kind: 'trace', id: 'changed', path: 'traces/changed.json', sha256: 'a'.repeat(64) }],
    observation: { subjectId: 'changed', scope: 'project', stage: 'generation', timing: { machineExecutionMs: 1 } }
  };
  await writeFile(join(root, observationInput.evidencePath), `${JSON.stringify(observationInput, null, 2)}\n`);
  await assert.rejects(recordExecutionObservation(root, observationInput), /checksum changed/);
  assert.equal((await readExecutionLedgerStatus(root)).initialized, false);
});
