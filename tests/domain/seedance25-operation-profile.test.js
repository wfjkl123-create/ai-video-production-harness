import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSeedance25FeaturePlan,
  createSeedance25OperationPlan,
  resolveSeedance25Feature
} from '../../src/domain/seedance25-operation-profile.js';

test('routes every documented Seedance 2.5 feature to an explicit operation', () => {
  const documentedFeatures = [
    'standard_generation', 'multi_reference_30s', 'timestamp_control',
    'multilingual_dialogue', 'clean_audio_visual_output', 'realistic_character',
    'native_extend', 'ultralong', 'smart_edit', 'advanced_edit', 'video_edit',
    'object_add', 'object_remove', 'object_replace', 'attribute_modify',
    'local_remove_or_replace', 'green_screen', 'bgm_separation',
    'creative_transfer', 'spatial_view_edit', 'voice_reference', 'multi_person',
    'white_model_coarse', 'white_model_fine', 'transition_bridge',
    'storyboard_multigrid'
  ];
  for (const feature of documentedFeatures) {
    const route = resolveSeedance25Feature(feature);
    assert.equal(typeof route.operation, 'string');
    assert.equal(typeof route.capability, 'string');
  }
  assert.deepEqual(resolveSeedance25Feature('multi_reference_30s'), {
    operation: 'standard_generation', capability: 'multimodal_reference'
  });
  assert.deepEqual(resolveSeedance25Feature('transition_bridge'), {
    operation: 'standard_generation', capability: 'two_video_bridge'
  });
  assert.deepEqual(resolveSeedance25Feature('local_remove_or_replace'), {
    operation: 'advanced_edit', capability: 'annotated_local_edit'
  });
});

test('feature plans keep special-purpose inputs explicit', () => {
  const bridge = createSeedance25FeaturePlan('transition_bridge', {
    durationSec: 10, videoCount: 2, imageCount: 0, audioCount: 0,
    videoDurationsSec: [10, 10], audioDurationsSec: [], videoTotalDurationSec: 20, audioTotalDurationSec: 0
  });
  assert.equal(bridge.capability, 'two_video_bridge');
  assert.throws(() => createSeedance25FeaturePlan('storyboard_multigrid', {
    durationSec: 15, imageCount: 1, videoCount: 0, audioCount: 0,
    videoDurationsSec: [], audioDurationsSec: [], videoTotalDurationSec: 0, audioTotalDurationSec: 0
  }), /requires storyboardBinding/);
  assert.throws(() => createSeedance25FeaturePlan('bgm_separation', {
    sourceDurationSec: 10, sourceVideo: 'source.mp4', editInstruction: 'remove BGM', keepList: ['speech'],
    imageCount: 0, videoCount: 1, audioCount: 0, videoDurationsSec: [10], audioDurationsSec: [], videoTotalDurationSec: 10, audioTotalDurationSec: 0
  }), /requires audioKeepList/);
  assert.throws(() => createSeedance25FeaturePlan('multilingual_dialogue', {
    durationSec: 8, imageCount: 0, videoCount: 0, audioCount: 0,
    videoDurationsSec: [], audioDurationsSec: [], videoTotalDurationSec: 0, audioTotalDurationSec: 0
  }), /requires dialogueLanguages/);
});

test('accepts documented 30 second multimodal limits but keeps execution planning-only', () => {
  const plan = createSeedance25OperationPlan({
    operation: 'standard_generation', durationSec: 30, outputResolution: '720p',
    imageCount: 30, videoCount: 10, audioCount: 10,
    videoDurationsSec: Array(10).fill(3.02), audioDurationsSec: Array(10).fill(3.02),
    videoTotalDurationSec: 30.2, audioTotalDurationSec: 30.2,
    maxSubjectMediaDurationSec: 12
  });
  assert.equal(plan.executionStatus, 'PLANNING_ONLY');
  assert.equal(plan.submissionAllowed, false);
  assert.equal(plan.submissionBlocker, 'UNRESOLVED_LIBTV_MODEL_ALIAS');
  assert.ok(plan.stabilityWarnings.includes('IMAGE_COUNT_ABOVE_PREFERRED_8'));
  assert.ok(plan.stabilityWarnings.includes('VIDEO_COUNT_ABOVE_PREFERRED_5'));
  assert.ok(plan.stabilityWarnings.includes('AUDIO_COUNT_ABOVE_PREFERRED_5'));
  assert.ok(plan.stabilityWarnings.includes('SUBJECT_MEDIA_ABOVE_PREFERRED_10S'));
});

test('validates native extension and its 60 second result ceiling', () => {
  const plan = createSeedance25OperationPlan({
    operation: 'native_extend', sourceVideo: 'segment-001.mp4', sourceDurationSec: 30,
    extensionDurationSec: 30, imageCount: 0, videoCount: 1, audioCount: 0,
    videoDurationsSec: [30], audioDurationsSec: [],
    videoTotalDurationSec: 30, audioTotalDurationSec: 0
  });
  assert.equal(plan.requested.extensionDurationSec, 30);
  assert.throws(() => createSeedance25OperationPlan({
    operation: 'native_extend', sourceVideo: 'segment-001.mp4', sourceDurationSec: 30,
    extensionDurationSec: 31, imageCount: 0, videoCount: 1, audioCount: 0,
    videoDurationsSec: [30], audioDurationsSec: [],
    videoTotalDurationSec: 30, audioTotalDurationSec: 0
  }), /between 4 and 30/);
});

test('validates ultralong, edit requirements, media caps and confirmed output resolution', () => {
  assert.equal(createSeedance25OperationPlan({
    operation: 'ultralong', durationSec: 180, imageCount: 0, videoCount: 0,
    audioCount: 0, videoDurationsSec: [], audioDurationsSec: [], videoTotalDurationSec: 0, audioTotalDurationSec: 0
  }).requested.durationSec, 180);
  assert.throws(() => createSeedance25OperationPlan({
    operation: 'smart_edit', sourceDurationSec: 15, sourceVideo: 'source.mp4', editInstruction: 'replace object',
    imageCount: 0, videoCount: 1, audioCount: 0, videoDurationsSec: [15], audioDurationsSec: [], videoTotalDurationSec: 15, audioTotalDurationSec: 0
  }), /requires keepList/);
  assert.throws(() => createSeedance25OperationPlan({
    operation: 'standard_generation', durationSec: 15, outputResolution: '1080p',
    imageCount: 0, videoCount: 0, audioCount: 0, videoDurationsSec: [], audioDurationsSec: [], videoTotalDurationSec: 0, audioTotalDurationSec: 0
  }), /only 480p and 720p output/);
});
