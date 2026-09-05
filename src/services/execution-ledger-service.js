import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import {
  assertExecutionEvent,
  createExecutionEvent,
  executionEventId,
  projectExecutionEvents,
  summarizeExecutionObservations
} from '../domain/execution-ledger.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { sha256Text } from '../storage/checksum.js';

function ledgerPath(root, ...parts) {
  return join(resolve(root), 'ledger', ...parts);
}

function relativePath(root, path) {
  return relative(resolve(root), path).split(sep).join('/');
}

export function executionEventPath(root, eventId) {
  return ledgerPath(root, 'events', `${encodeURIComponent(eventId)}.json`);
}

export function executionLedgerHeadPath(root) {
  return ledgerPath(root, 'head.json');
}

export function executionLedgerProjectionPath(root) {
  return ledgerPath(root, 'projection.json');
}

const FUNNEL_STAGES = Object.freeze([
  Object.freeze({ id: 'preflight', label: '生成前检查', eventTypes: Object.freeze(['preflight.ready']) }),
  Object.freeze({ id: 'paid_approval', label: '付费授权', eventTypes: Object.freeze(['paid_approval.granted']) }),
  Object.freeze({
    id: 'submission', label: '生成提交',
    eventTypes: Object.freeze([
      'generation.claimed', 'generation.submitted', 'generation.submission_uncertain',
      'generation.reconciled', 'generation.confirmed_not_submitted'
    ])
  }),
  Object.freeze({
    id: 'generation_output', label: '生成结果',
    eventTypes: Object.freeze(['generation.succeeded', 'generation.failed', 'generation.interrupted'])
  }),
  Object.freeze({
    id: 'quality_review', label: '成片审核',
    eventTypes: Object.freeze(['quality_review.accepted', 'quality_review.rejected'])
  }),
  Object.freeze({ id: 'delivery', label: '最终交付', eventTypes: Object.freeze(['delivery.finalized']) })
]);

const BLOCKED_EVENT_TYPES = new Set([
  'generation.submission_uncertain',
  'generation.confirmed_not_submitted',
  'generation.failed',
  'generation.interrupted',
  'quality_review.rejected',
  'generation_output_failure.recorded'
]);

function emptyLedgerStatus(projectId, pendingTransactionCount = 0) {
  return {
    schemaVersion: 1,
    kind: 'execution_ledger_status',
    projectId,
    initialized: false,
    consistency: pendingTransactionCount > 0 ? 'pending_recovery' : 'not_initialized',
    issueCodes: pendingTransactionCount > 0 ? ['pending_transactions'] : [],
    pendingTransactionCount,
    historyCoverage: 'not_recorded',
    head: { lastSequence: 0, lastEventId: null, updatedAt: null },
    currentStage: 'uninitialized',
    gate5: { status: 'not_reviewed', finalEditDecision: null, acceptedSegmentCount: 0, rejectedSegmentCount: 0 },
    failureGovernance: { status: 'clear', latestFailureEventId: null, latestRemediationId: null },
    delivery: { status: 'not_recorded' },
    observations: summarizeExecutionObservations([]),
    counts: {
      events: 0, paidClaims: 0, successes: 0, failures: 0, uncertainSubmissions: 0,
      qualityAccepted: 0, qualityRejected: 0, outputFailures: 0, remediations: 0, deliveries: 0
    },
    funnel: FUNNEL_STAGES.map(stage => ({
      id: stage.id,
      label: stage.label,
      status: 'not_observed',
      observedEventCount: 0,
      blockedEventCount: 0,
      segmentIds: [],
      latestEventId: null,
      latestEventAt: null
    })),
    segments: [],
    latestEvents: []
  };
}

async function inspectPendingTransactions(root) {
  const directory = join(resolve(root), '.transactions');
  const entries = await readdir(directory, { withFileTypes: true })
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  let count = 0;
  let invalidCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('._')) continue;
    const journal = await readJson(join(directory, entry.name)).catch(() => null);
    if (journal === null) {
      invalidCount += 1;
      continue;
    }
    if (journal?.status === 'PENDING') count += 1;
  }
  return { count, invalidCount };
}

async function ledgerJsonForStatus(path) {
  try {
    return { value: await readJson(path), invalid: false };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: null, invalid: false };
    return { value: null, invalid: true };
  }
}

function stageStatus(stageId, events) {
  if (events.length === 0) return 'not_observed';
  const latest = events.at(-1);
  if (BLOCKED_EVENT_TYPES.has(latest.type)) return 'blocked';
  if (stageId === 'submission' && latest.type === 'generation.claimed') return 'in_progress';
  return stageId === 'delivery' ? 'finalized' : 'observed';
}

function funnelFor(events) {
  return FUNNEL_STAGES.map(stage => {
    const matching = events.filter(event => stage.eventTypes.includes(event.type));
    const latest = matching.at(-1) ?? null;
    return {
      id: stage.id,
      label: stage.label,
      status: stageStatus(stage.id, matching),
      observedEventCount: matching.length,
      blockedEventCount: matching.filter(event => BLOCKED_EVENT_TYPES.has(event.type)).length,
      segmentIds: [...new Set(matching.map(event => event.segmentId).filter(Boolean))].sort(),
      latestEventId: latest?.id ?? null,
      latestEventAt: latest?.occurredAt ?? null
    };
  });
}

function segmentStatuses(events) {
  const segmentIds = [...new Set(events.map(event => event.segmentId).filter(Boolean))].sort();
  return segmentIds.map(segmentId => {
    const segmentEvents = events.filter(event => event.segmentId === segmentId);
    const latest = segmentEvents.at(-1);
    return {
      segmentId,
      stage: latest.type,
      status: BLOCKED_EVENT_TYPES.has(latest.type) ? 'blocked' : 'observed',
      eventCount: segmentEvents.length,
      firstEventAt: segmentEvents[0].occurredAt,
      latestEventId: latest.id,
      latestEventAt: latest.occurredAt,
      funnel: funnelFor(segmentEvents).filter(stage => stage.id !== 'delivery')
    };
  });
}

function latestEventSummaries(events, limit) {
  return events.slice(-limit).reverse().map(event => ({
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurredAt,
    segmentId: event.segmentId,
    referenceCount: event.references.length
  }));
}

async function optionalJson(path) {
  return readJson(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
}

export async function readExecutionEvents(root) {
  const entries = await readdir(ledgerPath(root, 'events'), { withFileTypes: true })
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const events = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('._'))
    .map(entry => readJson(ledgerPath(root, 'events', entry.name))));
  return events.map(assertExecutionEvent).sort((left, right) => left.sequence - right.sequence);
}

export async function readExecutionLedgerStatus(root, options = {}) {
  const projectRoot = resolve(root);
  const state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
  const pendingTransactions = await inspectPendingTransactions(projectRoot);
  const pendingCount = pendingTransactions.count;
  const base = emptyLedgerStatus(state.projectId, pendingCount);
  if (pendingTransactions.invalidCount > 0) {
    base.issueCodes.push('invalid_transaction_journal');
    if (base.consistency !== 'pending_recovery') base.consistency = 'inconsistent';
  }
  let events;
  try {
    events = await readExecutionEvents(projectRoot);
  } catch {
    return {
      ...base,
      consistency: pendingCount > 0 ? 'pending_recovery' : 'inconsistent',
      issueCodes: [...new Set([...base.issueCodes, 'invalid_event'])]
    };
  }

  const [headRead, projectionRead] = await Promise.all([
    ledgerJsonForStatus(executionLedgerHeadPath(projectRoot)),
    ledgerJsonForStatus(executionLedgerProjectionPath(projectRoot))
  ]);
  const storedHead = headRead.value;
  const storedProjection = projectionRead.value;
  if (events.length === 0 && storedHead === null && storedProjection === null) return base;

  const issueCodes = [...base.issueCodes];
  if (headRead.invalid) issueCodes.push('invalid_head');
  if (projectionRead.invalid) issueCodes.push('invalid_projection');
  const expectedHead = headFor(state.projectId, events);
  let computedProjection;
  try {
    computedProjection = projectExecutionEvents(state.projectId, events);
  } catch {
    issueCodes.push('invalid_event_sequence');
    return {
      ...base,
      initialized: events.length > 0,
      consistency: pendingCount > 0 ? 'pending_recovery' : 'inconsistent',
      issueCodes: [...new Set(issueCodes)],
      head: expectedHead,
      latestEvents: latestEventSummaries(events, 20)
    };
  }

  if (storedHead === null) issueCodes.push('missing_head');
  else if (JSON.stringify(storedHead) !== JSON.stringify(expectedHead)) issueCodes.push('head_mismatch');
  if (storedProjection === null) issueCodes.push('missing_projection');
  else if (JSON.stringify(storedProjection) !== JSON.stringify(computedProjection)) issueCodes.push('projection_mismatch');

  const consistency = pendingCount > 0
    ? 'pending_recovery'
    : issueCodes.length > 0 ? 'inconsistent' : 'consistent';
  const requestedLimit = Number(options.latestEventLimit ?? 20);
  const eventLimit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
  return {
    schemaVersion: 1,
    kind: 'execution_ledger_status',
    projectId: state.projectId,
    initialized: events.length > 0,
    consistency,
    issueCodes: [...new Set(issueCodes)],
    pendingTransactionCount: pendingCount,
    historyCoverage: events.some(event => event.type === 'ledger.bootstrap') ? 'since_observation_bootstrap' : 'from_first_event',
    head: expectedHead,
    currentStage: computedProjection.stage,
    gate5: computedProjection.gate5,
    failureGovernance: computedProjection.failureGovernance,
    delivery: computedProjection.delivery,
    observations: summarizeExecutionObservations(events),
    counts: computedProjection.counts,
    funnel: funnelFor(events),
    segments: segmentStatuses(events),
    latestEvents: latestEventSummaries(events, eventLimit)
  };
}

function headFor(projectId, events) {
  const latest = events.at(-1) ?? null;
  return {
    schemaVersion: 1,
    kind: 'execution_ledger_head',
    projectId,
    lastSequence: latest?.sequence ?? 0,
    lastEventId: latest?.id ?? null,
    updatedAt: latest?.occurredAt ?? null
  };
}

function sameEvent(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function prepareExecutionLedgerAppend(root, input) {
  const projectRoot = resolve(root);
  const state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
  const events = await readExecutionEvents(projectRoot);
  const storedHead = await optionalJson(executionLedgerHeadPath(projectRoot));
  if (storedHead) {
    const expected = headFor(state.projectId, events);
    if (JSON.stringify(storedHead) !== JSON.stringify(expected)) throw new Error('execution ledger head does not match stored events');
  } else if (events.length > 0) {
    throw new Error('execution ledger events exist without a head');
  }

  const writes = [];
  const appended = [...events];
  if (appended.length === 0) {
    const bootstrapStatePath = ledgerPath(projectRoot, 'bootstrap', 'project-state.json');
    const bootstrapStateSha256 = sha256Text(`${JSON.stringify(state, null, 2)}\n`);
    const bootstrap = createExecutionEvent({
      projectId: state.projectId,
      sequence: 1,
      type: 'ledger.bootstrap',
      occurredAt: state.updatedAt,
      actor: { kind: 'system', id: null },
      segmentId: null,
      correlationId: null,
      causationId: null,
      idempotencyKey: 'ledger.bootstrap.v1',
      references: [{
        kind: 'project_state', id: 'project-state-bootstrap',
        path: 'ledger/bootstrap/project-state.json', sha256: bootstrapStateSha256
      }],
      facts: { observationOnly: true, phase: state.phase, artifactCount: state.artifacts.length, stateUpdatedAt: state.updatedAt }
    });
    appended.push(bootstrap);
    writes.push(
      { path: bootstrapStatePath, value: state },
      { path: executionEventPath(projectRoot, bootstrap.id), value: bootstrap }
    );
  }

  const eventId = executionEventId(state.projectId, input.idempotencyKey);
  const existing = appended.find(event => event.id === eventId) ?? await optionalJson(executionEventPath(projectRoot, eventId));
  if (existing) {
    const candidate = createExecutionEvent({ ...input, projectId: state.projectId, sequence: existing.sequence });
    if (!sameEvent(assertExecutionEvent(existing), candidate)) throw new Error('execution ledger idempotency key was reused with different facts');
    return { event: existing, reused: true, writes: [] };
  }

  const event = createExecutionEvent({ ...input, projectId: state.projectId, sequence: appended.length + 1 });
  appended.push(event);
  const head = headFor(state.projectId, appended);
  const projection = projectExecutionEvents(state.projectId, appended);
  writes.push(
    { path: executionEventPath(projectRoot, event.id), value: event },
    { path: executionLedgerHeadPath(projectRoot), value: head },
    { path: executionLedgerProjectionPath(projectRoot), value: projection }
  );
  return { event, head, projection, reused: false, writes };
}

export async function appendExecutionEvent(root, input, options = {}) {
  const projectRoot = resolve(root);
  return withProjectLock(projectRoot, async () => {
    await recoverJsonTransactions(projectRoot);
    const prepared = await prepareExecutionLedgerAppend(projectRoot, input);
    if (prepared.reused) return prepared;
    await commitJsonTransaction(
      projectRoot,
      options.transactionId ?? `execution-ledger-${prepared.event.id}`,
      prepared.writes,
      options.transactionOptions
    );
    return prepared;
  });
}

export async function rebuildExecutionLedgerProjection(root) {
  const projectRoot = resolve(root);
  return withProjectLock(projectRoot, async () => {
    await recoverJsonTransactions(projectRoot);
    const state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
    const events = await readExecutionEvents(projectRoot);
    const head = headFor(state.projectId, events);
    const projection = projectExecutionEvents(state.projectId, events);
    const existingHead = await optionalJson(executionLedgerHeadPath(projectRoot));
    const existingProjection = await optionalJson(executionLedgerProjectionPath(projectRoot));
    if (JSON.stringify(existingHead) === JSON.stringify(head)
      && JSON.stringify(existingProjection) === JSON.stringify(projection)) return projection;
    await commitJsonTransaction(projectRoot, `execution-ledger-rebuild-${randomUUID()}`, [
      { path: executionLedgerHeadPath(projectRoot), value: head },
      { path: executionLedgerProjectionPath(projectRoot), value: projection }
    ]);
    return projection;
  });
}

export function ledgerWritesRelativeTo(root, prepared) {
  return prepared.writes.map(write => ({ path: relativePath(root, write.path), value: write.value }));
}
