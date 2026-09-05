import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assertSurfaceCapabilitySnapshot } from '../../src/domain/surface-capability-snapshot.js';

const value = {
  kind: 'surface_capability_snapshot_v1', version: 1, id: 'snapshot-v1', surface: 'libtv',
  model: 'Seedance 2.0 VIP', operation: 'standard_generation',
  capturedAt: '2026-09-04T00:00:00Z', expiresAt: '2026-09-05T00:00:00Z',
  capabilities: {
    generatedAudio: true, disableGeneratedAudio: true, audioReference: true,
    sourceAudioPreservation: false, streamCopyRemux: true, multiShots: false
  },
  rawReadback: { artifactId: 'readback-v1', sha256: 'a'.repeat(64), observedFields: 'model, enableSound, media slots' }
};

test('requires complete capability booleans and current raw readback evidence', () => {
  assert.equal(assertSurfaceCapabilitySnapshot(value, { now: Date.parse('2026-09-04T12:00:00Z'), requireFresh: true }), value);
  assert.throws(() => assertSurfaceCapabilitySnapshot({ ...value, capabilities: { ...value.capabilities, multiShots: undefined } }), /multiShots/);
  assert.throws(() => assertSurfaceCapabilitySnapshot(value, { now: Date.parse('2026-09-06T00:00:00Z'), requireFresh: true }), /snapshot is stale/);
});

test('publishes audio and surface capability schemas', async () => {
  const audioSchema = JSON.parse(await readFile(new URL('../../schemas/audio-execution-plan.schema.json', import.meta.url), 'utf8'));
  const surfaceSchema = JSON.parse(await readFile(new URL('../../schemas/surface-capability-snapshot.schema.json', import.meta.url), 'utf8'));
  assert.ok(audioSchema.properties.strategy.enum.includes('preserve_source_audio_exact'));
  assert.ok(audioSchema.properties.strategy.enum.includes('silent_visual_test'));
  assert.ok(surfaceSchema.properties.capabilities.required.includes('multiShots'));
});
