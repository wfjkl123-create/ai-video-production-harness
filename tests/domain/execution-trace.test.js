import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendExecutionSpan,
  assertExecutionTrace,
  completeExecutionTrace,
  createExecutionTrace,
  summarizeExecutionTrace
} from '../../src/domain/execution-trace.js';

const at = second => `2026-08-08T00:00:${String(second).padStart(2, '0')}.000Z`;

function addSpan(trace, input) {
  return appendExecutionSpan(trace, {
    name: input.id,
    endedAt: at(input.end),
    status: 'succeeded',
    queueMs: 0,
    activeComputeMs: 0,
    externalWaitMs: 0,
    humanWaitMs: 0,
    retryWaitMs: 0,
    ttftMs: null,
    cacheHit: null,
    errorClass: null,
    criticalPath: false,
    ...input,
    startedAt: at(input.start)
  });
}

test('records a validated parent-child hierarchy across every Phase 0 span kind', () => {
  let trace = createExecutionTrace({ id: 'trace-001', projectId: 'project-001', startedAt: at(0) });
  trace = addSpan(trace, { id: 'project', kind: 'project', parentSpanId: null, start: 0, end: 20, criticalPath: true });
  trace = addSpan(trace, { id: 'gate-2', kind: 'gate', parentSpanId: 'project', start: 1, end: 19, humanWaitMs: 3000, criticalPath: true });
  trace = addSpan(trace, { id: 'segment-1', kind: 'segment', parentSpanId: 'gate-2', start: 4, end: 18, criticalPath: true });
  trace = addSpan(trace, { id: 'task-compile', kind: 'task', parentSpanId: 'segment-1', start: 5, end: 12, queueMs: 500, activeComputeMs: 1500 });
  trace = addSpan(trace, {
    id: 'call-audit', kind: 'external_call', parentSpanId: 'task-compile', start: 6, end: 11,
    externalWaitMs: 4000, ttftMs: 800, cacheHit: false, errorClass: 'UPSTREAM_TIMEOUT', criticalPath: true
  });
  trace = completeExecutionTrace(trace, { endedAt: at(20), status: 'succeeded' });

  assert.equal(assertExecutionTrace(trace), trace);
  assert.deepEqual(trace.spans.map(span => span.kind), ['project', 'gate', 'segment', 'task', 'external_call']);
  assert.equal(trace.spans[4].durationMs, 5000);
});

test('rejects orphan spans, duplicate IDs, invalid timing, and impossible metric values', () => {
  const trace = createExecutionTrace({ id: 'trace-002', projectId: 'project-002', startedAt: at(0) });
  assert.throws(() => addSpan(trace, { id: 'orphan', kind: 'task', parentSpanId: 'missing', start: 0, end: 1 }), /parentSpanId/);

  const withRoot = addSpan(trace, { id: 'root', kind: 'project', parentSpanId: null, start: 0, end: 5 });
  assert.throws(() => addSpan(withRoot, { id: 'root', kind: 'task', parentSpanId: 'root', start: 1, end: 2 }), /unique/);
  assert.throws(() => addSpan(withRoot, { id: 'backwards', kind: 'task', parentSpanId: 'root', start: 4, end: 2 }), /endedAt/);
  assert.throws(() => addSpan(withRoot, { id: 'negative', kind: 'task', parentSpanId: 'root', start: 1, end: 2, queueMs: -1 }), /queueMs/);
  assert.throws(() => addSpan(withRoot, { id: 'outside-parent', kind: 'task', parentSpanId: 'root', start: 1, end: 6 }), /parent span/);
});

test('summarizes the recorded critical path, wait composition, TTFT, cache use, and errors', () => {
  let trace = createExecutionTrace({ id: 'trace-003', projectId: 'project-003', startedAt: at(0) });
  trace = addSpan(trace, { id: 'root', kind: 'project', parentSpanId: null, start: 0, end: 10, criticalPath: true });
  trace = addSpan(trace, {
    id: 'critical-task', kind: 'task', parentSpanId: 'root', start: 1, end: 8,
    queueMs: 1000, activeComputeMs: 2000, externalWaitMs: 3000, retryWaitMs: 1000, criticalPath: true
  });
  trace = addSpan(trace, {
    id: 'parallel-cache', kind: 'external_call', parentSpanId: 'root', start: 2, end: 4,
    activeComputeMs: 500, humanWaitMs: 1500, ttftMs: 250, cacheHit: true
  });
  trace = addSpan(trace, {
    id: 'critical-call', kind: 'external_call', parentSpanId: 'critical-task', start: 3, end: 7,
    externalWaitMs: 3500, activeComputeMs: 500, ttftMs: 750, cacheHit: false,
    errorClass: 'RATE_LIMIT', criticalPath: true
  });
  trace = completeExecutionTrace(trace, { endedAt: at(10), status: 'succeeded' });

  const report = summarizeExecutionTrace(trace);
  assert.equal(report.spanCount, 4);
  assert.deepEqual(report.waitComposition, {
    queueMs: 1000,
    externalWaitMs: 6500,
    humanWaitMs: 1500,
    retryWaitMs: 1000,
    totalWaitMs: 10000
  });
  assert.deepEqual(report.ttft, { sampleCount: 2, averageMs: 500, maxMs: 750 });
  assert.deepEqual(report.cache, { sampled: 2, hits: 1, misses: 1, hitRate: 0.5 });
  assert.deepEqual(report.errors, { RATE_LIMIT: 1 });
  assert.equal(report.byKind.external_call.spanCount, 2);
  assert.equal(report.criticalPath.method, 'recorded');
  assert.deepEqual(report.criticalPath.spanIds, ['root', 'critical-task', 'critical-call']);
  assert.equal(report.criticalPath.wallClockMs, 10000);
  assert.equal(report.criticalPath.waitComposition.totalWaitMs, 8500);
});
