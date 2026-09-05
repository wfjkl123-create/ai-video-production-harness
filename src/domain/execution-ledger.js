import { sha256Text } from '../storage/checksum.js';
import { assertProjectId } from './project-id.js';

export const EXECUTION_EVENT_TYPES = Object.freeze([
  'ledger.bootstrap',
  'preflight.ready',
  'paid_approval.granted',
  'generation.claimed',
  'generation.submitted',
  'generation.submission_uncertain',
  'generation.reconciled',
  'generation.succeeded',
  'generation.failed',
  'generation.interrupted',
  'generation.confirmed_not_submitted',
  'quality_review.accepted',
  'quality_review.rejected',
  'generation_output_failure.recorded',
  'generation_remediation.approved',
  'execution_observation.recorded',
  'delivery.finalized'
]);

export const EXECUTION_OBSERVATION_SCOPES = Object.freeze([
  'project', 'segment', 'generation_attempt', 'delivery'
]);
export const EXECUTION_OBSERVATION_STAGES = Object.freeze([
  'intake', 'source_analysis', 'creative', 'story', 'segmentation', 'storyboard',
  'assets', 'prompt', 'paid_approval', 'generation', 'editing', 'technical_review',
  'gate5', 'delivery'
]);
export const EXECUTION_FAILURE_CATEGORIES = Object.freeze([
  'prompt_fact_error', 'prompt_asset_reference_error', 'asset_missing', 'asset_wrong_binding',
  'asset_extra', 'asset_generation_error', 'unsupported_parameter', 'missing_shot',
  'wrong_shot_order', 'identity_drift', 'product_drift', 'scene_drift', 'continuity_break',
  'technical_output_failure', 'external_submission_unknown', 'user_creative_rejection', 'other'
]);
export const EXECUTION_COST_UNITS = Object.freeze(['CNY', 'USD', 'credits', 'tasks']);
export const EXECUTION_COST_EVIDENCE_LEVELS = Object.freeze([
  'actual_billed', 'actual_consumed', 'usage_derived', 'estimated'
]);
export const EXECUTION_COST_PURPOSES = Object.freeze([
  'initial_generation', 'paid_retry', 'external_audit', 'asset_generation', 'other'
]);

const OBSERVATION_EVENT_TYPE = 'execution_observation.recorded';
const TIMING_FIELDS = Object.freeze(['machineExecutionMs', 'externalQueueMs', 'humanWaitMs']);
const OBSERVATION_SCOPES = new Set(EXECUTION_OBSERVATION_SCOPES);
const OBSERVATION_STAGES = new Set(EXECUTION_OBSERVATION_STAGES);
const FAILURE_CATEGORIES = new Set(EXECUTION_FAILURE_CATEGORIES);
const COST_UNITS = new Set(EXECUTION_COST_UNITS);
const COST_EVIDENCE_LEVELS = new Set(EXECUTION_COST_EVIDENCE_LEVELS);
const COST_PURPOSES = new Set(EXECUTION_COST_PURPOSES);
const MEDIA_KINDS = new Set(['generated_output', 'final_delivery']);
const RETRY_KINDS = new Set(['none', 'free', 'paid']);
const AUTOMATIC_OBSERVATION_SOURCES = new Set([
  'execution_trace_timing', 'video_audit_media', 'final_delivery_media',
  'external_audit_cost', 'generation_failure', 'gate5_rejection'
]);

const EVENT_TYPES = new Set(EXECUTION_EVENT_TYPES);
const ACTOR_KINDS = new Set(['system', 'human', 'delegated_policy']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function safeId(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be a date-time`);
}

function nonNegative(value, field, { positive = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new TypeError(`${field} must be a ${positive ? 'positive' : 'non-negative'} finite number`);
  }
}

function onlyKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${field}.${key} is not supported`);
  }
}

function assertActor(actor) {
  object(actor, 'actor');
  if (!ACTOR_KINDS.has(actor.kind)) throw new TypeError('actor.kind is invalid');
  safeId(actor.id, 'actor.id', { nullable: true });
}

function assertReference(reference, index) {
  object(reference, `references[${index}]`);
  safeId(reference.kind, `references[${index}].kind`);
  safeId(reference.id, `references[${index}].id`);
  if (reference.path !== undefined && (typeof reference.path !== 'string' || reference.path.trim() === '')) {
    throw new TypeError(`references[${index}].path must be a non-empty string`);
  }
  if (reference.sha256 !== undefined && !SHA256.test(reference.sha256)) {
    throw new TypeError(`references[${index}].sha256 must be a lowercase SHA-256`);
  }
}

export function assertExecutionObservation(observation) {
  object(observation, 'observation');
  onlyKeys(observation, ['subjectId', 'scope', 'stage', 'timing', 'cost', 'media', 'failure'], 'observation');
  safeId(observation.subjectId, 'observation.subjectId');
  if (!OBSERVATION_SCOPES.has(observation.scope)) throw new TypeError('observation.scope is invalid');
  if (!OBSERVATION_STAGES.has(observation.stage)) throw new TypeError('observation.stage is invalid');
  const components = ['timing', 'cost', 'media', 'failure'].filter(field => observation[field] !== undefined);
  if (components.length === 0) throw new TypeError('observation must record timing, cost, media, or failure evidence');

  if (observation.timing !== undefined) {
    object(observation.timing, 'observation.timing');
    onlyKeys(observation.timing, TIMING_FIELDS, 'observation.timing');
    if (Object.keys(observation.timing).length === 0) throw new TypeError('observation.timing must not be empty');
    for (const field of TIMING_FIELDS) {
      if (observation.timing[field] !== undefined) nonNegative(observation.timing[field], `observation.timing.${field}`);
    }
  }
  if (observation.cost !== undefined) {
    object(observation.cost, 'observation.cost');
    onlyKeys(observation.cost, ['amount', 'unit', 'evidenceLevel', 'purpose'], 'observation.cost');
    nonNegative(observation.cost.amount, 'observation.cost.amount');
    if (!COST_UNITS.has(observation.cost.unit)) throw new TypeError('observation.cost.unit is invalid');
    if (observation.cost.unit === 'tasks' && !Number.isInteger(observation.cost.amount)) {
      throw new TypeError('observation.cost.amount must be an integer for tasks');
    }
    if (!COST_EVIDENCE_LEVELS.has(observation.cost.evidenceLevel)) throw new TypeError('observation.cost.evidenceLevel is invalid');
    if (!COST_PURPOSES.has(observation.cost.purpose)) throw new TypeError('observation.cost.purpose is invalid');
  }
  if (observation.media !== undefined) {
    object(observation.media, 'observation.media');
    onlyKeys(observation.media, ['kind', 'durationMs'], 'observation.media');
    if (!MEDIA_KINDS.has(observation.media.kind)) throw new TypeError('observation.media.kind is invalid');
    nonNegative(observation.media.durationMs, 'observation.media.durationMs', { positive: true });
  }
  if (observation.failure !== undefined) {
    object(observation.failure, 'observation.failure');
    onlyKeys(observation.failure, [
      'category', 'rootCauseKey', 'responsibilityStage', 'returnStage', 'retryKind'
    ], 'observation.failure');
    if (!FAILURE_CATEGORIES.has(observation.failure.category)) throw new TypeError('observation.failure.category is invalid');
    safeId(observation.failure.rootCauseKey, 'observation.failure.rootCauseKey');
    if (!OBSERVATION_STAGES.has(observation.failure.responsibilityStage)) {
      throw new TypeError('observation.failure.responsibilityStage is invalid');
    }
    if (!OBSERVATION_STAGES.has(observation.failure.returnStage)) throw new TypeError('observation.failure.returnStage is invalid');
    if (!RETRY_KINDS.has(observation.failure.retryKind)) throw new TypeError('observation.failure.retryKind is invalid');
  }
  return observation;
}

function canonicalEvent(event) {
  const { eventHash: _eventHash, ...value } = event;
  return value;
}

export function executionEventId(projectId, idempotencyKey) {
  assertProjectId(projectId);
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new TypeError('idempotencyKey must be a non-empty string');
  }
  return `evt-${sha256Text(`${projectId}\0${idempotencyKey}`).slice(0, 32)}`;
}

export function createExecutionEvent(input) {
  assertProjectId(input?.projectId);
  if (!Number.isInteger(input.sequence) || input.sequence < 1) throw new TypeError('sequence must be a positive integer');
  if (!EVENT_TYPES.has(input.type)) throw new TypeError('type is invalid');
  timestamp(input.occurredAt, 'occurredAt');
  assertActor(input.actor);
  safeId(input.segmentId, 'segmentId', { nullable: true });
  safeId(input.correlationId, 'correlationId', { nullable: true });
  safeId(input.causationId, 'causationId', { nullable: true });
  if (!Array.isArray(input.references)) throw new TypeError('references must be an array');
  input.references.forEach(assertReference);
  object(input.facts, 'facts');
  const observationEvent = input.type === OBSERVATION_EVENT_TYPE;
  if (observationEvent) {
    assertExecutionObservation(input.observation);
    if (!input.references.some(reference => reference.path && reference.sha256)) {
      throw new TypeError('execution observations require at least one path and SHA-bound evidence reference');
    }
    if (!input.references.some(reference => reference.kind !== 'execution_observation_evidence'
      && reference.id === input.observation.subjectId)) {
      throw new TypeError('observation.subjectId must identify one non-receipt evidence reference');
    }
  } else if (input.observation !== undefined) {
    throw new TypeError('observation is only allowed on execution_observation.recorded events');
  }

  const event = {
    schemaVersion: observationEvent ? 2 : 1,
    id: executionEventId(input.projectId, input.idempotencyKey),
    kind: 'execution_event',
    projectId: input.projectId,
    sequence: input.sequence,
    type: input.type,
    occurredAt: input.occurredAt,
    actor: structuredClone(input.actor),
    segmentId: input.segmentId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: input.idempotencyKey,
    references: structuredClone(input.references),
    facts: structuredClone(input.facts),
    ...(observationEvent ? { observation: structuredClone(input.observation) } : {})
  };
  return { ...event, eventHash: sha256Text(`${JSON.stringify(event)}\n`) };
}

export function assertExecutionEvent(event) {
  object(event, 'execution event');
  if (![1, 2].includes(event.schemaVersion) || event.kind !== 'execution_event') throw new TypeError('execution event schema is invalid');
  const rebuilt = createExecutionEvent(event);
  if (event.schemaVersion !== rebuilt.schemaVersion) throw new TypeError('execution event schema does not match its event type');
  if (event.id !== rebuilt.id) throw new Error('execution event id does not match its idempotency key');
  if (event.eventHash !== sha256Text(`${JSON.stringify(canonicalEvent(event))}\n`)) {
    throw new Error('execution event hash does not match its contents');
  }
  return event;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function emptyObservationSummary() {
  return {
    schemaVersion: 2,
    eventCount: 0,
    derivation: { automaticEventCount: 0, manualEventCount: 0, bySourceType: {} },
    timing: emptyTimingSummary(),
    timingByStage: {},
    cost: { observationCount: 0, paidRetryObservationCount: 0, byUnit: {} },
    media: {
      observationCount: 0,
      byKind: {
        generated_output: { sampleCount: 0, totalDurationMs: 0 },
        final_delivery: { sampleCount: 0, totalDurationMs: 0 }
      }
    },
    failures: { observationCount: 0, byCategory: {}, byResponsibilityStage: {}, byReturnStage: {} }
  };
}

function emptyTimingSummary() {
  return Object.fromEntries(TIMING_FIELDS.map(field => [field, {
    sampleCount: 0, totalMs: 0, medianMs: null, samplesMs: []
  }]));
}

function costEvidenceBucket(level) {
  if (['actual_billed', 'actual_consumed'].includes(level)) return 'actual';
  return level === 'usage_derived' ? 'derived' : 'estimated';
}

function increment(objectValue, key, amount = 1) {
  objectValue[key] = (objectValue[key] ?? 0) + amount;
}

function finalizeObservationSummary(summary) {
  for (const timing of [summary.timing, ...Object.values(summary.timingByStage)]) {
    for (const field of TIMING_FIELDS) {
      timing[field].sampleCount = timing[field].samplesMs.length;
      timing[field].totalMs = timing[field].samplesMs.reduce((sum, value) => sum + value, 0);
      timing[field].medianMs = median(timing[field].samplesMs);
    }
  }
  return summary;
}

export function summarizeExecutionObservations(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const summary = emptyObservationSummary();
  const components = new Set();
  for (const event of events.map(assertExecutionEvent).filter(item => item.type === OBSERVATION_EVENT_TYPE)) {
    const observation = event.observation;
    for (const component of ['timing', 'cost', 'media', 'failure']) {
      if (observation[component] === undefined) continue;
      const key = [observation.scope, observation.stage, observation.subjectId, component].join(':');
      if (components.has(key)) throw new Error(`duplicate execution observation component: ${key}`);
      components.add(key);
    }
    summary.eventCount += 1;
    const sourceType = typeof event.facts.derivationSourceType === 'string'
      ? event.facts.derivationSourceType : 'manual_evidence_receipt';
    increment(summary.derivation.bySourceType, sourceType);
    if (AUTOMATIC_OBSERVATION_SOURCES.has(sourceType)) summary.derivation.automaticEventCount += 1;
    else summary.derivation.manualEventCount += 1;
    if (observation.timing) {
      const stageTiming = summary.timingByStage[observation.stage] ?? emptyTimingSummary();
      for (const field of TIMING_FIELDS) {
        if (observation.timing[field] !== undefined) {
          summary.timing[field].samplesMs.push(observation.timing[field]);
          stageTiming[field].samplesMs.push(observation.timing[field]);
        }
      }
      summary.timingByStage[observation.stage] = stageTiming;
    }
    if (observation.cost) {
      summary.cost.observationCount += 1;
      if (observation.cost.purpose === 'paid_retry') summary.cost.paidRetryObservationCount += 1;
      const unit = summary.cost.byUnit[observation.cost.unit] ?? {
        actual: { amount: 0, eventCount: 0 },
        derived: { amount: 0, eventCount: 0 },
        estimated: { amount: 0, eventCount: 0 },
        actualPaidRetry: { amount: 0, eventCount: 0 }
      };
      const bucket = costEvidenceBucket(observation.cost.evidenceLevel);
      unit[bucket].amount += observation.cost.amount;
      unit[bucket].eventCount += 1;
      if (bucket === 'actual' && observation.cost.purpose === 'paid_retry') {
        unit.actualPaidRetry.amount += observation.cost.amount;
        unit.actualPaidRetry.eventCount += 1;
      }
      summary.cost.byUnit[observation.cost.unit] = unit;
    }
    if (observation.media) {
      summary.media.observationCount += 1;
      const bucket = summary.media.byKind[observation.media.kind];
      bucket.sampleCount += 1;
      bucket.totalDurationMs += observation.media.durationMs;
    }
    if (observation.failure) {
      summary.failures.observationCount += 1;
      increment(summary.failures.byCategory, observation.failure.category);
      increment(summary.failures.byResponsibilityStage, observation.failure.responsibilityStage);
      increment(summary.failures.byReturnStage, observation.failure.returnStage);
    }
  }
  return finalizeObservationSummary(summary);
}

export function combineExecutionObservationSummaries(summaries) {
  if (!Array.isArray(summaries)) throw new TypeError('summaries must be an array');
  const combined = emptyObservationSummary();
  for (const summary of summaries) {
    if (summary?.schemaVersion !== 2) throw new TypeError('observation summary schema must be 2');
    combined.eventCount += summary.eventCount;
    combined.derivation.automaticEventCount += summary.derivation?.automaticEventCount ?? 0;
    combined.derivation.manualEventCount += summary.derivation?.manualEventCount ?? summary.eventCount;
    for (const [sourceType, count] of Object.entries(summary.derivation?.bySourceType ?? {})) {
      increment(combined.derivation.bySourceType, sourceType, count);
    }
    for (const field of TIMING_FIELDS) combined.timing[field].samplesMs.push(...summary.timing[field].samplesMs);
    for (const [stage, source] of Object.entries(summary.timingByStage ?? {})) {
      const target = combined.timingByStage[stage] ?? emptyTimingSummary();
      for (const field of TIMING_FIELDS) target[field].samplesMs.push(...source[field].samplesMs);
      combined.timingByStage[stage] = target;
    }
    combined.cost.observationCount += summary.cost.observationCount;
    combined.cost.paidRetryObservationCount += summary.cost.paidRetryObservationCount;
    for (const [unitName, source] of Object.entries(summary.cost.byUnit)) {
      const target = combined.cost.byUnit[unitName] ?? {
        actual: { amount: 0, eventCount: 0 }, derived: { amount: 0, eventCount: 0 },
        estimated: { amount: 0, eventCount: 0 }, actualPaidRetry: { amount: 0, eventCount: 0 }
      };
      for (const bucket of ['actual', 'derived', 'estimated', 'actualPaidRetry']) {
        target[bucket].amount += source[bucket].amount;
        target[bucket].eventCount += source[bucket].eventCount;
      }
      combined.cost.byUnit[unitName] = target;
    }
    combined.media.observationCount += summary.media.observationCount;
    for (const kind of MEDIA_KINDS) {
      combined.media.byKind[kind].sampleCount += summary.media.byKind[kind].sampleCount;
      combined.media.byKind[kind].totalDurationMs += summary.media.byKind[kind].totalDurationMs;
    }
    combined.failures.observationCount += summary.failures.observationCount;
    for (const field of ['byCategory', 'byResponsibilityStage', 'byReturnStage']) {
      for (const [key, value] of Object.entries(summary.failures[field])) increment(combined.failures[field], key, value);
    }
  }
  return finalizeObservationSummary(combined);
}

function emptyProjection(projectId) {
  return {
    schemaVersion: 1,
    kind: 'execution_ledger_projection',
    projectId,
    lastSequence: 0,
    lastEventId: null,
    updatedAt: null,
    stage: 'uninitialized',
    bySegment: {},
    gate5: { status: 'not_reviewed', finalEditDecision: null, acceptedSegmentCount: 0, rejectedSegmentCount: 0 },
    failureGovernance: { status: 'clear', latestFailureEventId: null, latestRemediationId: null },
    delivery: { status: 'not_recorded' },
    counts: {
      events: 0, paidClaims: 0, successes: 0, failures: 0, uncertainSubmissions: 0,
      qualityAccepted: 0, qualityRejected: 0, outputFailures: 0, remediations: 0, deliveries: 0
    }
  };
}

export function projectExecutionEvents(projectId, events) {
  assertProjectId(projectId);
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const ordered = events.map(assertExecutionEvent).sort((left, right) => left.sequence - right.sequence);
  const projection = emptyProjection(projectId);
  const observationComponents = new Set();
  for (const [index, event] of ordered.entries()) {
    if (event.projectId !== projectId) throw new Error('execution event projectId mismatch');
    if (event.sequence !== index + 1) throw new Error('execution event sequence must be contiguous');
    projection.lastSequence = event.sequence;
    projection.lastEventId = event.id;
    projection.updatedAt = projection.updatedAt === null
      ? event.occurredAt
      : new Date(Math.max(Date.parse(projection.updatedAt), Date.parse(event.occurredAt))).toISOString();
    if (event.type === OBSERVATION_EVENT_TYPE) {
      for (const component of ['timing', 'cost', 'media', 'failure']) {
        if (event.observation[component] === undefined) continue;
        const key = [event.observation.scope, event.observation.stage, event.observation.subjectId, component].join(':');
        if (observationComponents.has(key)) throw new Error(`duplicate execution observation component: ${key}`);
        observationComponents.add(key);
      }
    }
    if (event.type !== OBSERVATION_EVENT_TYPE) projection.stage = event.type;
    projection.counts.events += 1;
    if (event.segmentId !== null && event.type !== OBSERVATION_EVENT_TYPE) {
      const current = projection.bySegment[event.segmentId] ?? { stage: 'uninitialized' };
      const updatedAt = current.updatedAt === undefined
        ? event.occurredAt
        : new Date(Math.max(Date.parse(current.updatedAt), Date.parse(event.occurredAt))).toISOString();
      projection.bySegment[event.segmentId] = { ...current, ...event.facts, stage: event.type, updatedAt };
    }
    if (event.type === 'generation.claimed') projection.counts.paidClaims += 1;
    if (event.type === 'generation.succeeded') projection.counts.successes += 1;
    if (event.type === 'generation.submission_uncertain') projection.counts.uncertainSubmissions += 1;
    if (['generation.failed', 'generation.interrupted'].includes(event.type)) projection.counts.failures += 1;
    if (event.type === 'quality_review.accepted') projection.counts.qualityAccepted += 1;
    if (event.type === 'quality_review.rejected') projection.counts.qualityRejected += 1;
    if (event.type === 'generation_output_failure.recorded') {
      projection.counts.outputFailures += 1;
      projection.failureGovernance = {
        status: event.facts.workflowStatus,
        latestFailureEventId: event.facts.failureEventId,
        latestRemediationId: null,
        rootCauseKey: event.facts.rootCauseKey ?? null,
        updatedAt: event.occurredAt
      };
    }
    if (event.type === 'generation_remediation.approved') {
      projection.counts.remediations += 1;
      projection.failureGovernance = {
        ...projection.failureGovernance,
        status: 'remediated',
        latestRemediationId: event.facts.remediationId,
        rootCauseKey: event.facts.rootCauseKey,
        updatedAt: event.occurredAt
      };
    }
    if (event.type === 'delivery.finalized') {
      projection.counts.deliveries += 1;
      projection.delivery = { ...event.facts, status: 'finalized', eventId: event.id, updatedAt: event.occurredAt };
    }
    if (event.type.startsWith('quality_review.') && event.facts.artifactType === 'final_edit') {
      projection.gate5.finalEditDecision = event.facts.decision;
    }
  }
  const segmentStates = Object.values(projection.bySegment);
  projection.gate5.acceptedSegmentCount = segmentStates.filter(item => item.qualityDecision === 'accepted').length;
  projection.gate5.rejectedSegmentCount = segmentStates.filter(item => item.qualityDecision === 'rejected').length;
  projection.gate5.status = projection.delivery.status === 'finalized'
    ? 'delivery_finalized'
    : projection.gate5.rejectedSegmentCount > 0 || projection.gate5.finalEditDecision === 'rejected'
      ? 'rejected'
      : projection.gate5.finalEditDecision === 'accepted' || projection.gate5.acceptedSegmentCount > 0
        ? 'partially_accepted'
        : 'not_reviewed';
  return projection;
}
