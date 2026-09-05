import test from 'node:test';
import assert from 'node:assert/strict';
import {
  humanGatesForProfile,
  isMachineReviewedGate,
  visibleStepsForProfile,
  visibleStepsForProject,
  recommendWorkflowProfile,
  assetDefaultsForProfile,
  assertWorkflowProfile,
  assertAssetSelection,
  estimatePaidImageTasks
} from '../../src/domain/workflow-profile.js';

test('three routes expose the approved human-gate counts', () => {
  assert.deepEqual(humanGatesForProfile('simple_remake'), [1, 4, 5]);
  assert.deepEqual(humanGatesForProfile('narrative'), [1, 3, 4, 5]);
  assert.deepEqual(humanGatesForProfile('original'), [1, 2, 3, 4, 5]);
  assert.deepEqual(humanGatesForProfile(null), [1, 2, 3, 4, 5]);
});

test('machine-reviewed gates are the complement delegated by each route', () => {
  assert.equal(isMachineReviewedGate('simple_remake', 2), true);
  assert.equal(isMachineReviewedGate('simple_remake', 3), true);
  assert.equal(isMachineReviewedGate('simple_remake', 1), false);
  assert.equal(isMachineReviewedGate('narrative', 2), true);
  assert.equal(isMachineReviewedGate('narrative', 3), false);
  assert.equal(isMachineReviewedGate('original', 2), false);
  assert.equal(isMachineReviewedGate(null, 2), false);
});

test('visible steps hide delegated gates and keep order', () => {
  assert.deepEqual(visibleStepsForProfile('simple_remake').map(step => step.gate), [1, 4, 5]);
  assert.deepEqual(visibleStepsForProfile('narrative').map(step => step.gate), [1, 3, 4, 5]);
  assert.deepEqual(visibleStepsForProfile('original').map(step => step.gate), [0, 1, 2, 3, 4, 5]);
});

test('mechanical asset-and-prompt work exposes only its real user-visible step', () => {
  assert.deepEqual(visibleStepsForProject({
    routeDecision: { executionClass: 'mechanical_asset_prompt' }
  }), [{ gate: 4, label: '资产、提示词与 LibTV 画布' }]);
  assert.deepEqual(visibleStepsForProject({
    workflowProfile: {
      id: 'simple_remake', selectedBy: 'user', reason: 'test', updatedAt: new Date().toISOString()
    }
  }).map(step => step.gate), [1, 4, 5]);
});

test('recommendation routes source-authority remakes to simple_remake', () => {
  const rec = recommendWorkflowProfile({ requestText: '复刻这个视频，台词动作不变', referenceIntent: 'faithful_remake', sourceVideoIds: ['reference-video-001'] });
  assert.equal(rec.id, 'simple_remake');
});

test('recommendation routes story references to narrative and bare ideas to original', () => {
  assert.equal(recommendWorkflowProfile({ requestText: '做一个有冲突的产品短剧', referenceIntent: 'inspiration_only', sourceVideoIds: ['v1'] }).id, 'narrative');
  assert.equal(recommendWorkflowProfile({ requestText: '我想做一个不一样的视频', referenceIntent: 'idea_only', sourceVideoIds: [] }).id, 'original');
});

test('simple_remake keeps first-frame selection optional until the user chooses a control route', () => {
  const defaults = assetDefaultsForProfile('simple_remake', { requestText: '替换产品' });
  assert.deepEqual(defaults.required, ['product_image']);
  assert.ok(defaults.recommended.includes('depth_video'));
  assert.ok(!defaults.recommended.includes('first_frame'));
  assert.ok(defaults.optional.includes('first_frame'));
});

test('original work starts with one identity reference instead of a fixed four-view board', () => {
  const defaults = assetDefaultsForProfile('original', { requestText: '原创人物短剧' });
  assert.ok(defaults.recommended.includes('character_reference'));
  assert.ok(!defaults.recommended.includes('character_board'));
});

test('assertWorkflowProfile and assertAssetSelection validate shapes', () => {
  assert.throws(() => assertWorkflowProfile({ id: 'nope', selectedBy: 'user', reason: 'r', updatedAt: new Date().toISOString() }), TypeError);
  assert.equal(assertWorkflowProfile({ id: 'simple_remake', selectedBy: 'user', reason: 'r', updatedAt: new Date().toISOString() }).id, 'simple_remake');
  assert.throws(() => assertAssetSelection({ profileId: 'simple_remake', selected: ['unknown'], estimatedPaidImageTasks: 0, updatedAt: new Date().toISOString() }), TypeError);
  assert.equal(estimatePaidImageTasks(['character_board', 'depth_video']), 1);
});
