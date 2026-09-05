import test from 'node:test';
import assert from 'node:assert/strict';
import { isAutoLockType, isHumanReviewType, checkpointForType, AUTO_LOCK_TYPES, HUMAN_REVIEW_TYPES, CHECKPOINTS } from '../../src/domain/review-policy.js';
import { ARTIFACT_TYPES } from '../../src/domain/artifact.js';

test('auto-lock types and human-review types are disjoint', () => {
  for (const type of AUTO_LOCK_TYPES) {
    assert.equal(isHumanReviewType(type), false, `${type} should not be in both sets`);
  }
  for (const type of HUMAN_REVIEW_TYPES) {
    assert.equal(isAutoLockType(type), false, `${type} should not be in both sets`);
  }
});

test('every artifact type is classified as either auto-lock or human-review', () => {
  for (const type of ARTIFACT_TYPES) {
    const classified = isAutoLockType(type) || isHumanReviewType(type);
    assert.equal(classified, true, `${type} must be classified`);
  }
});

test('checkpoint covers types match human-review types', () => {
  const covered = new Set();
  for (const cp of Object.values(CHECKPOINTS)) {
    for (const type of cp.coversTypes) covered.add(type);
  }
  // video_segment and final_edit are covered by CHECKPOINT_VIDEO
  assert.ok(covered.has('video_segment'));
  assert.ok(covered.has('final_edit'));
  // project_asset and segment_asset are covered by CHECKPOINT_ASSETS
  assert.ok(covered.has('project_asset'));
  assert.ok(covered.has('segment_asset'));
  assert.ok(covered.has('human_visual_exception'));
  assert.ok(covered.has('spatial_control_model'));
  assert.ok(covered.has('creative_brief'));
  assert.ok(covered.has('story_plan'));
});

test('checkpointForType returns null for auto-lock types', () => {
  assert.equal(checkpointForType('script'), null);
  assert.equal(checkpointForType('shot_narration'), null);
  assert.equal(checkpointForType('seedance_prompt'), null);
});

test('checkpointForType returns correct checkpoint for human-review types', () => {
  assert.equal(checkpointForType('creative_brief').id, 'checkpoint_creative');
  assert.equal(checkpointForType('story_plan').id, 'checkpoint_story');
  assert.equal(checkpointForType('project_asset').id, 'checkpoint_assets');
  assert.equal(checkpointForType('segment_asset').id, 'checkpoint_assets');
  assert.equal(checkpointForType('spatial_control_model').id, 'checkpoint_assets');
  assert.equal(checkpointForType('video_segment').id, 'checkpoint_video');
  assert.equal(checkpointForType('final_edit').id, 'checkpoint_video');
});
