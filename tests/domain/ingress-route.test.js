import test from 'node:test';
import assert from 'node:assert/strict';
import { decideIngressRoute } from '../../src/domain/ingress-route.js';

const video = (id = 'video-001') => ({
  id,
  mimeType: 'video/mp4',
  path: `inputs/${id}.mp4`
});

test('explicit opt-out wins over both video input and creation language', () => {
  const decision = decideIngressRoute({
    requestText: '用这个素材生成一条 AI 视频，但明确不走 Harness',
    inputs: [video()]
  });

  assert.deepEqual(decision, {
    policyVersion: 'ingress-route-v1',
    harnessRequired: false,
    reason: 'explicit_opt_out',
    inputTypes: ['video'],
    sourceVideoIds: ['video-001'],
    assetInputIds: [],
    referenceRoleStatus: 'not_applicable',
    executionClass: 'bypass'
  });
});

test('an explicit simple asset-and-prompt task enters the mechanical fast path', () => {
  const result = decideIngressRoute({
    requestText: '这是简单任务，只需要把原视频切分成每15秒一段，上传并配上产品图片，撰写提示词，把视频里的产品替换掉，不要想得太复杂',
    explicitReferenceIntent: 'source_modification',
    inputs: [
      { id: 'video-001', mimeType: 'video/mp4', path: '/tmp/source.mp4' },
      { id: 'product-001', mimeType: 'image/png', path: '/tmp/product.png' }
    ]
  });
  assert.equal(result.executionClass, 'mechanical_asset_prompt');
  assert.equal(result.referenceRoleStatus, 'authority');
  assert.deepEqual(result.assetInputIds, ['product-001']);
});

test('simple wording cannot downgrade creative or incomplete work into the mechanical fast path', () => {
  const descriptors = [
    { id: 'video-001', mimeType: 'video/mp4', path: '/tmp/source.mp4' },
    { id: 'product-001', mimeType: 'image/png', path: '/tmp/product.png' }
  ];
  for (const requestText of [
    '简单处理一下这个视频并替换产品',
    '简单做个有反转的短剧，设计剧情、角色和分镜，再替换产品',
    '一比一复刻所有镜头并用建模控制，然后替换产品、写提示词'
  ]) {
    const result = decideIngressRoute({ requestText, explicitReferenceIntent: 'source_modification', inputs: descriptors });
    assert.equal(result.executionClass, 'creative_production');
  }
});

test('an explicit mechanical class requires both authority video and an existing image', () => {
  assert.throws(() => decideIngressRoute({
    requestText: '按步骤切分并写提示词',
    explicitReferenceIntent: 'source_modification',
    explicitExecutionClass: 'mechanical_asset_prompt',
    inputs: [{ id: 'video-001', mimeType: 'video/mp4', path: '/tmp/source.mp4' }]
  }), /requires an authority source video and an existing image asset/);
});

test('an explicit explanation intent wins over an attached video', () => {
  const decision = decideIngressRoute({
    requestText: '只解释这个视频里的运镜，不要创作或生成',
    requestKind: 'explanation',
    inputs: [video()]
  });

  assert.equal(decision.harnessRequired, false);
  assert.equal(decision.reason, 'informational_intent');
  assert.deepEqual(decision.sourceVideoIds, ['video-001']);
  assert.equal(decision.referenceRoleStatus, 'not_applicable');
});

test('a negative production constraint inside a video request does not turn the whole request into explanation', () => {
  const decision = decideIngressRoute({
    requestText: '帮我做一个视频，不要生成字幕',
    inputs: []
  });

  assert.equal(decision.harnessRequired, true);
  assert.equal(decision.reason, 'video_creation_intent');
});

test('video creation without an attachment still enters Harness', () => {
  const decision = decideIngressRoute({
    requestText: '帮我生成一条 15 秒 AI 视频',
    inputs: []
  });

  assert.equal(decision.harnessRequired, true);
  assert.equal(decision.reason, 'video_creation_intent');
  assert.deepEqual(decision.sourceVideoIds, []);
  assert.equal(decision.referenceRoleStatus, 'not_applicable');
});

test('a source-free product text replacement is not mistaken for a video workflow', () => {
  const decision = decideIngressRoute({
    requestText: '把文案里的产品替换成收腹裤',
    inputs: []
  });

  assert.equal(decision.harnessRequired, false);
  assert.equal(decision.reason, 'non_video_request');
});

test('an unexplained video attachment enters Harness without becoming authority', () => {
  const decision = decideIngressRoute({
    requestText: '看看这个视频，我想做个广告',
    inputs: [video()]
  });

  assert.equal(decision.harnessRequired, true);
  assert.equal(decision.referenceRoleStatus, 'awaiting_reference_role');
});

test('reference role can be explicitly resolved as inspiration or authority', () => {
  const inspiration = decideIngressRoute({
    requestText: '这个视频只提供风格灵感，不复刻',
    inputs: [video()],
    explicitReferenceIntent: 'inspiration_only'
  });
  assert.equal(inspiration.referenceRoleStatus, 'inspiration');

  const authority = decideIngressRoute({
    requestText: '一比一复刻这个视频',
    inputs: [video()],
    explicitReferenceIntent: 'faithful_remake'
  });
  assert.equal(authority.referenceRoleStatus, 'authority');
});

test('routing consumes explicit descriptors and never guesses video state from text paths', () => {
  const noDescriptor = decideIngressRoute({ requestText: '请解释 /tmp/example.mp4 的编码信息' });
  assert.deepEqual(noDescriptor.sourceVideoIds, []);
  assert.deepEqual(noDescriptor.inputTypes, []);

  assert.throws(
    () => decideIngressRoute({ requestText: '看看附件', inputs: [{ id: 'v1', mimeType: 'video/mp4' }] }),
    /inputs\[0\]\.path/
  );
  assert.throws(
    () => decideIngressRoute({ requestText: '看看附件', inputs: [video('same'), video('same')] }),
    /unique/
  );
});
