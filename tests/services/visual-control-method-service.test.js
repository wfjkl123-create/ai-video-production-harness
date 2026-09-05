import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKocRemakeExecutionContract, buildVisualControlChoiceQuestion, detectVisualControlChoice, resolveRemakeControlModes, resolveVisualControlMethod } from '../../src/services/visual-control-method-service.js';

test('asks for the four remake control methods when a video remake request omits the method', () => {
  assert.equal(detectVisualControlChoice('我要做一个一比一的口播视频'), true);
  const question = buildVisualControlChoiceQuestion();
  assert.equal(question.status, 'awaiting_user_choice');
  assert.deepEqual(question.options.map(item => item.id), ['storyboard_control', 'depth_control', 'native_source', 'koc_remake']);
  assert.deepEqual(question.firstFrameChoice.options.map(item => item.id), ['none', 'all_segments', 'selected_segments']);
  assert.equal(question.multiple, true);
});

test('does not ask again when the request explicitly selects depth, modeling, or storyboard', () => {
  assert.equal(detectVisualControlChoice('把这段视频转成深度视频'), false);
  assert.equal(detectVisualControlChoice('用 Blender 建模做一比一复刻'), false);
  assert.equal(detectVisualControlChoice('制作分镜图控制构图'), false);
  assert.equal(detectVisualControlChoice('这次用 KOC 复刻'), false);
});

test('does not treat every pure-idea video request as a remake-control request', () => {
  assert.equal(detectVisualControlChoice('我有一个萌娃和奶奶对话促销的视频想法'), false);
  assert.equal(detectVisualControlChoice('把这段口播文案拍成原创自拍视频'), false);
});

test('depth and modeling replace the legacy default storyboard route', () => {
  assert.equal(resolveVisualControlMethod('storyboard').replaceLegacyStoryboard, false);
  assert.equal(resolveVisualControlMethod('depth').controlAsset, 'monocular_depth');
  assert.equal(resolveVisualControlMethod('depth').replaceLegacyStoryboard, true);
  assert.equal(resolveVisualControlMethod('modeling').controlAsset, 'spatial_control_model');
});

test('native source alone skips reverse prompting while storyboard and depth require it', () => {
  const native = resolveRemakeControlModes(['native_source']);
  assert.equal(native.requiresReversePrompt, false);
  assert.equal(native.promptPolicy, 'native_source_replacement_instruction_only');
  const combined = resolveRemakeControlModes(['native_source', 'depth_control', 'storyboard_control']);
  assert.deepEqual(combined.selectedModes, ['storyboard_control', 'depth_control', 'native_source']);
  assert.equal(combined.requiresReversePrompt, true);
  assert.equal(combined.controls[1].ignore.includes('面部表情'), true);
});

test('remake controls reject empty, unknown, and duplicate selections', () => {
  assert.throws(() => resolveRemakeControlModes([]), /at least one/);
  assert.throws(() => resolveRemakeControlModes(['modeling']), /mode must be/);
  assert.throws(() => resolveRemakeControlModes(['native_source', 'native_source']), /duplicates/);
});

test('KOC remake is exclusive and requires an explicit first-frame policy', () => {
  assert.throws(() => resolveRemakeControlModes(['koc_remake']), /firstFramePolicy/);
  assert.throws(() => resolveRemakeControlModes(['koc_remake', 'native_source'], { firstFramePolicy: 'none' }), /exclusive/);
  const route = resolveRemakeControlModes(['koc_remake'], { firstFramePolicy: 'selected_segments' });
  assert.equal(route.promptPolicy, 'koc_source_bound_identity_replacement');
  assert.equal(route.firstFramePolicy, 'selected_segments');
  const contract = buildKocRemakeExecutionContract('selected_segments');
  assert.equal(contract.segmentPolicy.maxDurationSec, 15);
  assert.equal(contract.segmentPolicy.exclude, 'broll_never_generate');
  assert.equal(contract.generationPolicy.defaultResolution, '480p');
  assert.equal(contract.memoryPolicy.neverAuthority, 'conversation_summary_or_agent_recollection');
  assert.ok(contract.parallelStages.includes('segment_canvas_prepare'));
});
