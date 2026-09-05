import test from 'node:test';
import assert from 'node:assert/strict';
import { currentArtifactOf, resolveCurrentArtifacts } from '../../src/domain/current-artifact.js';

function artifact(id, type, revision, extra = {}) {
  return { id, type, revision, status: 'draft', path: `${id}.json`, ...extra };
}

test('latest singleton revision becomes current and stale pending work no longer blocks', () => {
  const artifacts = [
    artifact('segmentation-v7', 'segmentation', 7, { status: 'awaiting_review' }),
    artifact('segmentation-v8', 'segmentation', 8, { status: 'locked', lockedByReviewId: 'review-v8' })
  ];
  const resolved = resolveCurrentArtifacts(artifacts);
  assert.deepEqual(resolved.current.map(item => item.id), ['segmentation-v8']);
  assert.deepEqual(resolved.supersededIds, ['segmentation-v7']);
});

test('singleton scope is separated by segment', () => {
  const artifacts = [
    artifact('prompt-001-v2', 'seedance_prompt', 2, { segmentId: 'segment-001' }),
    artifact('prompt-002-v1', 'seedance_prompt', 1, { segmentId: 'segment-002' })
  ];
  assert.equal(resolveCurrentArtifacts(artifacts).current.length, 2);
});

test('legacy unscoped Seedance source prompts and execution packages keep separate revision lineages', () => {
  const artifacts = [
    artifact('prompt-unit-v7', 'seedance_prompt', 7, { executionUnitId: 'unit-v7' }),
    artifact('prompt-unit-v7-package', 'seedance_prompt', 7, { executionUnitId: 'unit-v7', sourcePromptId: 'prompt-unit-v7' }),
    artifact('prompt-unit-v8', 'seedance_prompt', 8, { executionUnitId: 'unit-v8', supersedesArtifactId: 'prompt-unit-v7' }),
    artifact('prompt-unit-v8-package', 'seedance_prompt', 8, { executionUnitId: 'unit-v8', sourcePromptId: 'prompt-unit-v8', supersedesArtifactId: 'prompt-unit-v7-package' }),
    artifact('prompt-segment-001-v8', 'seedance_prompt', 8, { segmentId: 'segment-001' })
  ];
  const resolved = resolveCurrentArtifacts(artifacts);
  assert.deepEqual(resolved.current.map(item => item.id), [
    'prompt-segment-001-v8', 'prompt-unit-v8', 'prompt-unit-v8-package'
  ]);
  assert.deepEqual(resolved.supersededIds, ['prompt-unit-v7', 'prompt-unit-v7-package']);
});

test('non-singleton project assets remain independently current without an explicit pointer', () => {
  const artifacts = [
    artifact('character-a', 'project_asset', 1, { assetType: 'character_board' }),
    artifact('character-b', 'project_asset', 1, { assetType: 'character_board' })
  ];
  assert.deepEqual(resolveCurrentArtifacts(artifacts).current.map(item => item.id), ['character-a', 'character-b']);
});

test('explicit supersedes pointer retires a non-singleton asset without deleting evidence', () => {
  const artifacts = [
    artifact('character-a-v1', 'project_asset', 1),
    artifact('character-a-v2', 'project_asset', 2, { supersedesArtifactId: 'character-a-v1' })
  ];
  const resolved = resolveCurrentArtifacts(artifacts);
  assert.deepEqual(resolved.current.map(item => item.id), ['character-a-v2']);
  assert.deepEqual(resolved.supersededIds, ['character-a-v1']);
});

test('byte-identical duplicate singleton registrations collapse without inventing a content conflict', () => {
  const sha256 = 'a'.repeat(64);
  const resolved = resolveCurrentArtifacts([
    artifact('rubric-canonical', 'quality_rubric', 1, { status: 'locked', sha256 }),
    artifact('rubric-duplicate', 'quality_rubric', 1, { status: 'locked', sha256 })
  ]);
  assert.equal(resolved.current.length, 1);
  assert.equal(resolved.supersededIds.length, 1);
});

test('same-segment locked video registrations with identical bytes collapse to one current take', () => {
  const sha256 = 'b'.repeat(64);
  const resolved = resolveCurrentArtifacts([
    artifact('video-v1', 'video_segment', 1, { segmentId: 'segment-001', status: 'locked', sha256 }),
    artifact('video-adopted-v2', 'video_segment', 2, { segmentId: 'segment-001', status: 'locked', sha256 })
  ]);
  assert.deepEqual(resolved.current.map(item => item.id), ['video-adopted-v2']);
  assert.deepEqual(resolved.supersededIds, ['video-v1']);
});

test('different video bytes remain separate takes until an explicit selection exists', () => {
  const resolved = resolveCurrentArtifacts([
    artifact('take-a', 'video_segment', 1, { segmentId: 'segment-001', status: 'locked', sha256: 'a'.repeat(64) }),
    artifact('take-b', 'video_segment', 2, { segmentId: 'segment-001', status: 'locked', sha256: 'b'.repeat(64) })
  ]);
  assert.equal(resolved.current.length, 2);
});

test('rejects broken, cross-type and ambiguous lineage', () => {
  assert.throws(() => resolveCurrentArtifacts([
    artifact('v2', 'story_plan', 2, { supersedesArtifactId: 'missing' })
  ]), /does not exist/);
  assert.throws(() => resolveCurrentArtifacts([
    artifact('v1', 'story_plan', 1), artifact('v2', 'segmentation', 2, { supersedesArtifactId: 'v1' })
  ]), /different type/);
  assert.throws(() => resolveCurrentArtifacts([
    artifact('prompt-a', 'seedance_prompt', 1, { segmentId: 'segment-001' }),
    artifact('prompt-b', 'seedance_prompt', 2, { segmentId: 'segment-002', supersedesArtifactId: 'prompt-a' })
  ]), /different scope/);
  assert.throws(() => resolveCurrentArtifacts([
    artifact('v1-a', 'story_plan', 1), artifact('v1-b', 'story_plan', 1)
  ]), /ambiguous current/);
});

test('currentArtifactOf returns one canonical match', () => {
  const artifacts = [artifact('contract-v1', 'segment_contract', 1, { segmentId: 'segment-001' })];
  assert.equal(currentArtifactOf(artifacts, item => item.type === 'segment_contract').id, 'contract-v1');
});
