import { join } from 'node:path';
import { assertExecutionTrace, summarizeExecutionTrace } from '../domain/execution-trace.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';

function safeTraceId(traceId) {
  if (typeof traceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(traceId)) {
    throw new TypeError('traceId must be a safe identifier');
  }
  return traceId;
}

function errorClass(error) {
  if (typeof error?.code === 'string' && error.code.trim() !== '') return error.code;
  if (typeof error?.name === 'string' && error.name.trim() !== '') return error.name;
  return 'UnknownTraceWriteError';
}

export function executionTracePath(root, traceId) {
  return join(root, 'traces', `${safeTraceId(traceId)}.json`);
}

/**
 * Best-effort telemetry persistence. Every failure, including validation and
 * observer failures, is converted into a result so instrumentation cannot
 * change the production operation's success or failure.
 */
export async function recordExecutionTrace(root, trace, options = {}) {
  let path = null;
  try {
    assertExecutionTrace(trace);
    path = executionTracePath(root, trace.id);
    await (options.write ?? writeJsonAtomic)(path, trace);
    return { recorded: true, path };
  } catch (error) {
    try {
      const observation = options.onError?.(error);
      Promise.resolve(observation).catch(() => {});
    } catch {
      // A telemetry observer is telemetry too: it must remain fail-open.
    }
    return {
      recorded: false,
      path,
      errorClass: errorClass(error)
    };
  }
}

export async function readExecutionTrace(root, traceId, options = {}) {
  const trace = await (options.read ?? readJson)(executionTracePath(root, traceId));
  return assertExecutionTrace(trace);
}

export async function reportExecutionTrace(root, traceId, options = {}) {
  return summarizeExecutionTrace(await readExecutionTrace(root, traceId, options));
}
