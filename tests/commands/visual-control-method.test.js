import test from 'node:test';
import assert from 'node:assert/strict';
import { runVisualControlMethod } from '../../src/commands/visual-control-method.js';

test('CLI command returns the default four-way question', () => {
  const result = runVisualControlMethod(['--request', '一比一复刻这段口播视频']);
  assert.equal(result.status, 'awaiting_user_choice');
  assert.match(result.question, /分镜图.*深度视频.*原视频.*KOC/);
  assert.equal(result.multiple, true);
});

test('CLI command resolves the KOC route only with a first-frame policy', () => {
  const result = runVisualControlMethod([
    '--request', 'KOC 复刻这段口播', '--method', 'koc_remake', '--first-frame-policy', 'none'
  ]);
  assert.equal(result.status, 'selected');
  assert.deepEqual(result.selectedModes, ['koc_remake']);
  assert.equal(result.firstFramePolicy, 'none');
});

test('CLI command returns a selected depth route', () => {
  const result = runVisualControlMethod(['--request', '一比一复刻这段口播视频', '--method', 'depth']);
  assert.equal(result.status, 'selected');
  assert.equal(result.controlAsset, 'monocular_depth');
  assert.equal(result.replaceLegacyStoryboard, true);
});
