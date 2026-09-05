const TRACE_STATUSES = new Set(['running', 'succeeded', 'failed', 'cancelled']);
const SPAN_KINDS = new Set(['project', 'gate', 'segment', 'task', 'external_call']);
const METRIC_FIELDS = [
  'queueMs',
  'activeComputeMs',
  'externalWaitMs',
  'humanWaitMs',
  'retryWaitMs'
];
import { assertProjectId } from './project-id.js';

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function id(value, field) {
  text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
}

function timestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  text(value, field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a date-time`);
  return parsed;
}

function nonNegative(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number${nullable ? ' or null' : ''}`);
  }
}

function validateSpan(span, index) {
  const prefix = `spans[${index}]`;
  object(span, prefix);
  id(span.id, `${prefix}.id`);
  if (!SPAN_KINDS.has(span.kind)) throw new TypeError(`${prefix}.kind is invalid`);
  text(span.name, `${prefix}.name`);
  if (span.parentSpanId !== null) id(span.parentSpanId, `${prefix}.parentSpanId`);
  const startedAt = timestamp(span.startedAt, `${prefix}.startedAt`);
  const endedAt = timestamp(span.endedAt, `${prefix}.endedAt`, { nullable: true });
  if (!TRACE_STATUSES.has(span.status)) throw new TypeError(`${prefix}.status is invalid`);
  if (span.status === 'running' && endedAt !== null) throw new Error(`${prefix}.endedAt must be null while running`);
  if (span.status !== 'running' && endedAt === null) throw new Error(`${prefix}.endedAt is required when finished`);
  if (endedAt !== null && endedAt < startedAt) throw new Error(`${prefix}.endedAt must not precede startedAt`);

  const expectedDuration = endedAt === null ? null : endedAt - startedAt;
  if (span.durationMs !== expectedDuration) throw new Error(`${prefix}.durationMs must match its timestamps`);
  for (const field of METRIC_FIELDS) nonNegative(span[field], `${prefix}.${field}`);
  nonNegative(span.ttftMs, `${prefix}.ttftMs`, { nullable: true });
  if (span.cacheHit !== null && typeof span.cacheHit !== 'boolean') {
    throw new TypeError(`${prefix}.cacheHit must be a boolean or null`);
  }
  if (span.errorClass !== null) text(span.errorClass, `${prefix}.errorClass`);
  if (typeof span.criticalPath !== 'boolean') throw new TypeError(`${prefix}.criticalPath must be a boolean`);
  if (span.attributes !== undefined) object(span.attributes, `${prefix}.attributes`);

  if (expectedDuration !== null) {
    const measured = METRIC_FIELDS.reduce((sum, field) => sum + span[field], 0);
    if (measured > expectedDuration) {
      throw new Error(`${prefix} measured timing exceeds its elapsed duration`);
    }
    if (span.ttftMs !== null && span.ttftMs > expectedDuration) {
      throw new Error(`${prefix}.ttftMs exceeds its elapsed duration`);
    }
  }
}

function waitComposition(spans) {
  const result = {
    queueMs: 0,
    externalWaitMs: 0,
    humanWaitMs: 0,
    retryWaitMs: 0,
    totalWaitMs: 0
  };
  for (const span of spans) {
    result.queueMs += span.queueMs;
    result.externalWaitMs += span.externalWaitMs;
    result.humanWaitMs += span.humanWaitMs;
    result.retryWaitMs += span.retryWaitMs;
  }
  result.totalWaitMs = result.queueMs + result.externalWaitMs + result.humanWaitMs + result.retryWaitMs;
  return result;
}

function unionDuration(spans) {
  const intervals = spans
    .filter(span => span.endedAt !== null)
    .map(span => [Date.parse(span.startedAt), Date.parse(span.endedAt)])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let current = null;
  for (const interval of intervals) {
    if (!current) {
      current = [...interval];
    } else if (interval[0] <= current[1]) {
      current[1] = Math.max(current[1], interval[1]);
    } else {
      total += current[1] - current[0];
      current = [...interval];
    }
  }
  return current ? total + current[1] - current[0] : 0;
}

function inferredCriticalPath(spans) {
  if (spans.length === 0) return [];
  const children = new Set(spans.map(span => span.parentSpanId).filter(Boolean));
  const candidates = spans
    .filter(span => span.endedAt !== null && !children.has(span.id))
    .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt)
      || right.durationMs - left.durationMs);
  const leaf = candidates[0];
  if (!leaf) return [];
  const byId = new Map(spans.map(span => [span.id, span]));
  const path = [];
  let current = leaf;
  while (current) {
    path.push(current);
    current = current.parentSpanId === null ? null : byId.get(current.parentSpanId);
  }
  return path.reverse();
}

export function createExecutionTrace({ id: traceId, projectId, startedAt, metadata = {} }) {
  id(traceId, 'id');
  assertProjectId(projectId);
  timestamp(startedAt, 'startedAt');
  object(metadata, 'metadata');
  return {
    schemaVersion: 1,
    id: traceId,
    kind: 'execution_trace',
    projectId,
    startedAt,
    endedAt: null,
    status: 'running',
    metadata: { ...metadata },
    spans: []
  };
}

export function assertExecutionTrace(trace) {
  object(trace, 'execution trace');
  if (trace.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1');
  id(trace.id, 'id');
  if (trace.kind !== 'execution_trace') throw new TypeError('kind must be execution_trace');
  assertProjectId(trace.projectId);
  const traceStartedAt = timestamp(trace.startedAt, 'startedAt');
  const traceEndedAt = timestamp(trace.endedAt, 'endedAt', { nullable: true });
  if (!TRACE_STATUSES.has(trace.status)) throw new TypeError('status is invalid');
  if (trace.status === 'running' && traceEndedAt !== null) throw new Error('endedAt must be null while trace is running');
  if (trace.status !== 'running' && traceEndedAt === null) throw new Error('endedAt is required for a finished trace');
  if (traceEndedAt !== null && traceEndedAt < traceStartedAt) throw new Error('endedAt must not precede startedAt');
  object(trace.metadata, 'metadata');
  if (!Array.isArray(trace.spans)) throw new TypeError('spans must be an array');

  const byId = new Map();
  trace.spans.forEach((span, index) => {
    validateSpan(span, index);
    if (byId.has(span.id)) throw new Error('span IDs must be unique');
    byId.set(span.id, span);
  });

  for (const span of trace.spans) {
    const spanStartedAt = Date.parse(span.startedAt);
    const spanEndedAt = span.endedAt === null ? null : Date.parse(span.endedAt);
    if (spanStartedAt < traceStartedAt || (traceEndedAt !== null && spanEndedAt !== null && spanEndedAt > traceEndedAt)) {
      throw new Error(`span ${span.id} falls outside the trace interval`);
    }
    if (span.parentSpanId === null) continue;
    const parent = byId.get(span.parentSpanId);
    if (!parent) throw new Error(`span ${span.id}.parentSpanId does not identify a trace span`);
    const parentStartedAt = Date.parse(parent.startedAt);
    const parentEndedAt = parent.endedAt === null ? null : Date.parse(parent.endedAt);
    if (spanStartedAt < parentStartedAt || (parentEndedAt !== null && spanEndedAt !== null && spanEndedAt > parentEndedAt)) {
      throw new Error(`span ${span.id} falls outside its parent span`);
    }
  }

  const roots = trace.spans.filter(span => span.parentSpanId === null);
  if (trace.spans.length > 0 && (roots.length !== 1 || roots[0].kind !== 'project')) {
    throw new Error('a trace with spans must contain exactly one project root span');
  }

  for (const span of trace.spans) {
    const visited = new Set([span.id]);
    let parentId = span.parentSpanId;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error(`span ${span.id} contains a parent cycle`);
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentSpanId ?? null;
    }
  }
  return trace;
}

export function appendExecutionSpan(trace, input) {
  assertExecutionTrace(trace);
  if (trace.status !== 'running') throw new Error('cannot append a span to a finished trace');
  object(input, 'span input');
  const startedAt = timestamp(input.startedAt, 'span.startedAt');
  const endedAt = timestamp(input.endedAt ?? null, 'span.endedAt', { nullable: true });
  const span = {
    id: input.id,
    kind: input.kind,
    name: input.name,
    parentSpanId: input.parentSpanId ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    durationMs: endedAt === null ? null : endedAt - startedAt,
    status: input.status ?? (endedAt === null ? 'running' : 'succeeded'),
    queueMs: input.queueMs ?? 0,
    activeComputeMs: input.activeComputeMs ?? 0,
    externalWaitMs: input.externalWaitMs ?? 0,
    humanWaitMs: input.humanWaitMs ?? 0,
    retryWaitMs: input.retryWaitMs ?? 0,
    ttftMs: input.ttftMs ?? null,
    cacheHit: input.cacheHit ?? null,
    errorClass: input.errorClass ?? null,
    criticalPath: input.criticalPath ?? false,
    ...(input.attributes === undefined ? {} : { attributes: { ...input.attributes } })
  };
  const updated = { ...trace, spans: [...trace.spans, span] };
  assertExecutionTrace(updated);
  return updated;
}

export function completeExecutionTrace(trace, { endedAt, status = 'succeeded' }) {
  assertExecutionTrace(trace);
  if (trace.status !== 'running') throw new Error('trace is already finished');
  if (status === 'running' || !TRACE_STATUSES.has(status)) throw new TypeError('finished trace status is invalid');
  if (trace.spans.some(span => span.status === 'running')) throw new Error('cannot finish a trace with running spans');
  const updated = { ...trace, endedAt, status };
  assertExecutionTrace(updated);
  return updated;
}

export function summarizeExecutionTrace(trace) {
  assertExecutionTrace(trace);
  const waits = waitComposition(trace.spans);
  const ttftSamples = trace.spans.map(span => span.ttftMs).filter(value => value !== null);
  const cacheSamples = trace.spans.map(span => span.cacheHit).filter(value => value !== null);
  const errorCounts = new Map();
  const byKind = {};

  for (const span of trace.spans) {
    if (span.errorClass !== null) errorCounts.set(span.errorClass, (errorCounts.get(span.errorClass) ?? 0) + 1);
    const bucket = byKind[span.kind] ?? {
      spanCount: 0,
      activeComputeMs: 0,
      waitComposition: { queueMs: 0, externalWaitMs: 0, humanWaitMs: 0, retryWaitMs: 0, totalWaitMs: 0 }
    };
    bucket.spanCount += 1;
    bucket.activeComputeMs += span.activeComputeMs;
    bucket.waitComposition.queueMs += span.queueMs;
    bucket.waitComposition.externalWaitMs += span.externalWaitMs;
    bucket.waitComposition.humanWaitMs += span.humanWaitMs;
    bucket.waitComposition.retryWaitMs += span.retryWaitMs;
    bucket.waitComposition.totalWaitMs += span.queueMs + span.externalWaitMs + span.humanWaitMs + span.retryWaitMs;
    byKind[span.kind] = bucket;
  }

  const recorded = trace.spans.filter(span => span.criticalPath);
  const criticalSpans = recorded.length > 0 ? recorded : inferredCriticalPath(trace.spans);
  const criticalWaits = waitComposition(criticalSpans);
  const criticalActiveComputeMs = criticalSpans.reduce((sum, span) => sum + span.activeComputeMs, 0);
  const traceEndedAt = trace.endedAt ?? trace.spans
    .map(span => span.endedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    traceId: trace.id,
    projectId: trace.projectId,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    wallClockMs: traceEndedAt === null ? null : Date.parse(traceEndedAt) - Date.parse(trace.startedAt),
    spanCount: trace.spans.length,
    activeComputeMs: trace.spans.reduce((sum, span) => sum + span.activeComputeMs, 0),
    waitComposition: waits,
    ttft: {
      sampleCount: ttftSamples.length,
      averageMs: ttftSamples.length === 0 ? null : ttftSamples.reduce((sum, value) => sum + value, 0) / ttftSamples.length,
      maxMs: ttftSamples.length === 0 ? null : Math.max(...ttftSamples)
    },
    cache: {
      sampled: cacheSamples.length,
      hits: cacheSamples.filter(Boolean).length,
      misses: cacheSamples.filter(value => !value).length,
      hitRate: cacheSamples.length === 0 ? null : cacheSamples.filter(Boolean).length / cacheSamples.length
    },
    errors: Object.fromEntries(errorCounts),
    byKind,
    criticalPath: {
      method: recorded.length > 0 ? 'recorded' : 'inferred_latest_leaf',
      spanIds: criticalSpans.map(span => span.id),
      wallClockMs: unionDuration(criticalSpans),
      activeComputeMs: criticalActiveComputeMs,
      waitComposition: criticalWaits
    }
  };
}

export const executionTraceSpanKinds = Object.freeze([...SPAN_KINDS]);
