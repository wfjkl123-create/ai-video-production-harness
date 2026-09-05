import { deriveExecutionObservation } from './execution-observation-derivation-service.js';
import { recordExecutionTrace } from './execution-trace-service.js';

function errorClass(error) {
  if (typeof error?.code === 'string' && error.code.trim() !== '') return error.code;
  if (typeof error?.name === 'string' && error.name.trim() !== '') return error.name;
  return 'UnknownAuthoritativeObservationError';
}

function observeError(options, error) {
  try {
    Promise.resolve(options.onError?.(error)).catch(() => {});
  } catch {
    // Observation errors must not change the production operation.
  }
}

export async function deriveExecutionObservationBestEffort(root, request, options = {}) {
  try {
    const result = await (options.deriveExecutionObservation ?? deriveExecutionObservation)(
      root,
      request,
      options.derivationOptions ?? {}
    );
    return { recorded: true, result };
  } catch (error) {
    observeError(options, error);
    return {
      recorded: false,
      reason: 'observation_derivation_failed',
      errorClass: errorClass(error)
    };
  }
}

export async function recordAuthoritativeExecutionObservation(root, trace, options = {}) {
  let traceResult;
  try {
    traceResult = await (options.recordExecutionTrace ?? recordExecutionTrace)(root, trace);
  } catch (error) {
    observeError(options, error);
    return {
      trace: { recorded: false, errorClass: errorClass(error) },
      observation: { recorded: false, reason: 'trace_recording_failed' }
    };
  }
  if (traceResult?.recorded !== true) {
    return {
      trace: traceResult ?? { recorded: false, errorClass: 'UnknownTraceResult' },
      observation: { recorded: false, reason: 'trace_not_recorded' }
    };
  }
  const observation = await deriveExecutionObservationBestEffort(root, {
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'execution_trace_timing',
    traceId: trace.id
  }, options);
  return { trace: traceResult, observation };
}
