import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTraceReport } from '../../src/commands/trace-report.js';
import {
  appendExecutionSpan,
  completeExecutionTrace,
  createExecutionTrace
} from '../../src/domain/execution-trace.js';
import {
  executionTracePath,
  readExecutionTrace,
  recordExecutionTrace,
  reportExecutionTrace
} from '../../src/services/execution-trace-service.js';

function completedTrace() {
  let trace = createExecutionTrace({
    id: 'trace-service-001',
    projectId: 'project-service-001',
    startedAt: '2026-08-08T00:00:00.000Z'
  });
  trace = appendExecutionSpan(trace, {
    id: 'project-root',
    kind: 'project',
    name: 'Project run',
    parentSpanId: null,
    startedAt: '2026-08-08T00:00:00.000Z',
    endedAt: '2026-08-08T00:00:02.000Z',
    status: 'succeeded',
    queueMs: 100,
    activeComputeMs: 900,
    externalWaitMs: 500,
    humanWaitMs: 500,
    retryWaitMs: 0,
    ttftMs: null,
    cacheHit: null,
    errorClass: null,
    criticalPath: true
  });
  return completeExecutionTrace(trace, {
    endedAt: '2026-08-08T00:00:02.000Z',
    status: 'succeeded'
  });
}

test('persists a trace atomically and produces a report from the stored trace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-trace-'));
  const trace = completedTrace();

  const result = await recordExecutionTrace(root, trace);
  assert.deepEqual(result, {
    recorded: true,
    path: executionTracePath(root, trace.id)
  });
  assert.deepEqual(await readExecutionTrace(root, trace.id), trace);
  assert.equal(JSON.parse(await readFile(result.path, 'utf8')).id, trace.id);

  const report = await reportExecutionTrace(root, trace.id);
  assert.equal(report.traceId, trace.id);
  assert.equal(report.criticalPath.wallClockMs, 2000);
  assert.equal(report.waitComposition.totalWaitMs, 1100);
});

test('a trace write failure is observable but never rejects the production caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-trace-fail-open-'));
  const observed = [];
  const result = await recordExecutionTrace(root, completedTrace(), {
    write: async () => { throw Object.assign(new Error('disk unavailable'), { code: 'ENOSPC' }); },
    onError: error => observed.push(error.code)
  });

  assert.equal(result.recorded, false);
  assert.equal(result.errorClass, 'ENOSPC');
  assert.deepEqual(observed, ['ENOSPC']);
});

test('a failing telemetry error hook is also isolated from production', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-trace-hook-fail-open-'));
  const result = await recordExecutionTrace(root, completedTrace(), {
    write: async () => { throw new Error('write failed'); },
    onError: async () => { throw new Error('observer failed'); }
  });

  assert.equal(result.recorded, false);
  assert.equal(result.errorClass, 'Error');
});

test('trace-report resolves the project root and delegates a read-only report', async () => {
  const calls = [];
  const report = await runTraceReport(
    ['--project', 'project-a', '--trace', 'trace-a'],
    {
      cwd: '/workspace',
      reportExecutionTrace: async (...args) => {
        calls.push(args);
        return { traceId: args[1], spanCount: 0 };
      }
    }
  );

  assert.deepEqual(calls, [['/workspace/project-a', 'trace-a']]);
  assert.deepEqual(report, { traceId: 'trace-a', spanCount: 0 });
});
