import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAudioExecutionPlan } from '../../src/services/audio-execution-plan-service.js';

const now = Date.parse('2026-09-04T10:00:00Z');
const audio = {
  artifactId: 'source-audio-v1', sha256: 'a'.repeat(64), elementaryStreamSha256: 'b'.repeat(64),
  codec: 'aac', timeBase: '1/48000', startPts: 0, durationSec: 12
};

function snapshot(capabilities = {}, overrides = {}) {
  return {
    kind: 'surface_capability_snapshot_v1', version: 1, id: 'libtv-seedance20-v1',
    surface: 'libtv', model: 'Seedance 2.0 VIP', operation: 'source_modification',
    capturedAt: '2026-09-04T09:00:00Z', expiresAt: '2026-09-05T09:00:00Z',
    capabilities: {
      generatedAudio: true, disableGeneratedAudio: true, audioReference: true,
      sourceAudioPreservation: false, streamCopyRemux: true, multiShots: false,
      ...capabilities
    },
    rawReadback: { artifactId: 'surface-readback-v1', sha256: 'c'.repeat(64), observedFields: 'enableSound, media slots, model and operation' },
    ...overrides
  };
}

test('source authority with approved audio resolves to exact preservation and stream-copy remux', () => {
  const plan = resolveAudioExecutionPlan({
    operation: 'source_modification', sourceRole: 'authority', approvedSourceAudio: audio,
    surfaceCapabilitySnapshot: snapshot()
  }, { now });
  assert.equal(plan.strategy, 'preserve_source_audio_exact');
  assert.equal(plan.generateAudio, false);
  assert.deepEqual(plan.remux, { required: true, mode: 'stream_copy', verifyElementaryStreamSha: true });
  assert.match(plan.syncAuthority, /source-audio-v1/);
});

test('explicit native generation wins when capability proves it, while silent tests stay silent', () => {
  const native = resolveAudioExecutionPlan({
    operation: 'source_modification', sourceRole: 'authority', approvedSourceAudio: audio,
    userRequirement: 'generate_native', surfaceCapabilitySnapshot: snapshot()
  }, { now });
  assert.equal(native.strategy, 'native_generate');
  assert.equal(native.enableSound, true);
  const silent = resolveAudioExecutionPlan({
    operation: 'source_modification', sourceRole: 'none', userRequirement: 'silent',
    surfaceCapabilitySnapshot: snapshot()
  }, { now });
  assert.equal(silent.strategy, 'silent_visual_test');
  assert.equal(silent.enableSound, false);
  assert.deepEqual(silent.promptPolicy.allowedAudibleFacts, []);
});

test('fails closed on stale capability, missing exact audio evidence or unsupported strategy', () => {
  assert.throws(() => resolveAudioExecutionPlan({
    operation: 'source_modification', sourceRole: 'authority', approvedSourceAudio: audio,
    surfaceCapabilitySnapshot: snapshot({}, { expiresAt: '2026-09-04T09:30:00Z' })
  }, { now }), /snapshot is stale/);
  assert.throws(() => resolveAudioExecutionPlan({
    operation: 'source_modification', sourceRole: 'authority', requestedStrategy: 'preserve_source_audio_exact',
    surfaceCapabilitySnapshot: snapshot()
  }, { now }), /approvedSourceAudio/);
  assert.throws(() => resolveAudioExecutionPlan({
    operation: 'source_modification', sourceRole: 'none', userRequirement: 'reference_guided', approvedSourceAudio: audio,
    surfaceCapabilitySnapshot: snapshot({ audioReference: false })
  }, { now }), /does not support reference-guided audio/);
});
