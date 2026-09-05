import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { rebindAssetManifest } from '../../src/services/asset-manifest-rebind-service.js';

function lockedManifest() {
  return {
    id: 'segment-001-asset-manifest', segmentId: 'segment-001', status: 'locked', lockedByReviewId: 'review-old',
    sourceArtifactIds: { script: 'story-1', shotlist: 'story-1' }, observedHandoffId: null, canonicalHdRestorationHandoffId: null,
    items: [{ id: 'audio-v1', type: 'source_audio_candidate', scope: 'segment', status: 'locked', path: 'assets/old.m4a', sha256: 'a'.repeat(64), lockedByReviewId: 'review-a' }]
  };
}

test('rebind preserves the old locked manifest and stages only new locked inputs for review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-manifest-rebind-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  const previous = lockedManifest();
  await writeJsonAtomic(join(root, 'assets', 'segment-001-asset-manifest.json'), previous);
  const event = await rebindAssetManifest(root, 'segment-001', 'human approved WAV compatibility rebind', {
    compileManifest: async () => ({
      ...previous,
      status: 'awaiting_review',
      lockedByReviewId: undefined,
      items: [{ ...previous.items[0], id: 'audio-v2', path: 'assets/new.wav', sha256: 'b'.repeat(64), lockedByReviewId: 'review-b' }]
    })
  });
  const staged = await readJson(join(root, 'assets', 'segment-001-asset-manifest.json'));
  const snapshot = await readJson(join(root, event.previousSnapshotPath));
  assert.equal(staged.status, 'awaiting_review');
  assert.equal(staged.items[0].id, 'audio-v2');
  assert.deepEqual(snapshot, previous);
  assert.deepEqual(event.previousItemIds, ['audio-v1']);
  assert.deepEqual(event.nextItemIds, ['audio-v2']);
});

test('rebind refuses a manifest with no input change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-manifest-rebind-noop-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  const previous = lockedManifest();
  await writeJsonAtomic(join(root, 'assets', 'segment-001-asset-manifest.json'), previous);
  await assert.rejects(
    rebindAssetManifest(root, 'segment-001', 'no-op', {
      compileManifest: async () => ({ ...previous, status: 'awaiting_review', lockedByReviewId: undefined })
    }),
    /no input change/
  );
});

test('rebind treats a responsibility-contract correction as a material change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-manifest-rebind-responsibility-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  const previous = {
    ...lockedManifest(),
    items: [{ ...lockedManifest().items[0], responsibility: 'old role', mustNotControl: ['camera'] }]
  };
  await writeJsonAtomic(join(root, 'assets', 'segment-001-asset-manifest.json'), previous);
  const event = await rebindAssetManifest(root, 'segment-001', 'correct bounded responsibility', {
    compileManifest: async () => ({
      ...previous,
      status: 'awaiting_review',
      lockedByReviewId: undefined,
      items: [{ ...previous.items[0], responsibility: 'new bounded role', mustNotControl: ['camera path', 'crop'] }]
    })
  });
  assert.deepEqual(event.previousItemIds, ['audio-v1']);
  assert.deepEqual(event.nextItemIds, ['audio-v1']);
});
