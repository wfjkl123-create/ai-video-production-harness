import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveExecutionObservationBestEffort,
  recordAuthoritativeExecutionObservation
} from '../../src/services/authoritative-trace-observation-service.js';

const trace = { id: 'trace-authoritative-helper' };

test('authoritative trace observation derives only after a confirmed trace write', async () => {
  const calls = [];
  const result = await recordAuthoritativeExecutionObservation('/project', trace, {
    recordExecutionTrace: async (...args) => {
      calls.push(['trace', ...args]);
      return { recorded: true, path: '/project/traces/trace-authoritative-helper.json' };
    },
    deriveExecutionObservation: async (...args) => {
      calls.push(['derive', ...args]);
      return { reused: false };
    }
  });
  assert.equal(result.observation.recorded, true);
  assert.deepEqual(calls.map(call => call[0]), ['trace', 'derive']);
  assert.deepEqual(calls[1][2], {
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'execution_trace_timing',
    traceId: trace.id
  });
});

test('trace or derivation failures remain observable but never reject the production caller', async () => {
  let deriveCalls = 0;
  const traceFailure = await recordAuthoritativeExecutionObservation('/project', trace, {
    recordExecutionTrace: async () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); },
    deriveExecutionObservation: async () => { deriveCalls += 1; }
  });
  assert.equal(traceFailure.trace.errorClass, 'ENOSPC');
  assert.equal(traceFailure.observation.reason, 'trace_recording_failed');
  assert.equal(deriveCalls, 0);

  const derivationFailure = await recordAuthoritativeExecutionObservation('/project', trace, {
    recordExecutionTrace: async () => ({ recorded: true, path: '/project/traces/a.json' }),
    deriveExecutionObservation: async () => { throw new Error('ledger unavailable'); }
  });
  assert.equal(derivationFailure.trace.recorded, true);
  assert.equal(derivationFailure.observation.reason, 'observation_derivation_failed');
  assert.equal(derivationFailure.observation.errorClass, 'Error');
});

test('generic best-effort observation forwarding is fail-open and preserves derivation options', async () => {
  const request = {
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'final_delivery_media'
  };
  const result = await deriveExecutionObservationBestEffort('/project', request, {
    derivationOptions: { runner: 'probe-runner' },
    deriveExecutionObservation: async (root, input, derivationOptions) => ({ root, input, derivationOptions })
  });
  assert.equal(result.recorded, true);
  assert.deepEqual(result.result, {
    root: '/project', input: request, derivationOptions: { runner: 'probe-runner' }
  });

  const errors = [];
  const failed = await deriveExecutionObservationBestEffort('/project', request, {
    deriveExecutionObservation: async () => { throw Object.assign(new Error('probe failed'), { code: 'EPROBE' }); },
    onError: error => errors.push(error.message)
  });
  assert.deepEqual(failed, {
    recorded: false, reason: 'observation_derivation_failed', errorClass: 'EPROBE'
  });
  assert.deepEqual(errors, ['probe failed']);
});
