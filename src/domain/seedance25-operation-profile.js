const OFFICIAL_MANUAL_URL = 'https://bytedance.larkoffice.com/wiki/RXh5ww6EqighMdkVTMccm2d4n7e';

const COMMON_REFERENCE_LIMITS = Object.freeze({
  imageCount: 30,
  videoCount: 10,
  audioCount: 10,
  videoItemDurationSec: Object.freeze({ min: 1.8, max: 30.2 }),
  audioItemDurationSec: Object.freeze({ min: 1.8, max: 30.2 }),
  videoTotalDurationSec: 30.2,
  audioTotalDurationSec: 30.2
});

const STABILITY_GUIDANCE = Object.freeze({
  preferredImageCount: 8,
  preferredVideoCount: 5,
  preferredAudioCount: 5,
  preferredSubjectMediaDurationSec: 10,
  preferredEditSourceDurationSec: 20,
  preferredEditReferenceImageCount: 5
});

const OPERATION_PROFILES = Object.freeze({
  standard_generation: Object.freeze({
    durationSec: Object.freeze({ min: 4, max: 30 }),
    referenceLimits: COMMON_REFERENCE_LIMITS,
    required: []
  }),
  native_extend: Object.freeze({
    extensionDurationSec: Object.freeze({ min: 4, max: 30 }),
    sourceDurationSec: Object.freeze({ min: 0.01, max: 30 }),
    resultDurationSec: Object.freeze({ max: 60 }),
    referenceLimits: COMMON_REFERENCE_LIMITS,
    required: ['sourceVideo']
  }),
  ultralong: Object.freeze({
    durationSec: Object.freeze({ min: 30, max: 180 }),
    referenceLimits: COMMON_REFERENCE_LIMITS,
    required: []
  }),
  smart_edit: Object.freeze({
    sourceDurationSec: Object.freeze({ min: 1.8, max: 30.2 }),
    referenceLimits: COMMON_REFERENCE_LIMITS,
    required: ['sourceVideo', 'editInstruction', 'keepList']
  }),
  advanced_edit: Object.freeze({
    sourceDurationSec: Object.freeze({ min: 1.8, max: 30.2 }),
    referenceLimits: COMMON_REFERENCE_LIMITS,
    required: ['sourceVideo', 'annotationBinding', 'editInstruction', 'keepList']
  }),
  video_edit: Object.freeze({
    sourceDurationSec: Object.freeze({ min: 1.8, max: 30.2 }),
    referenceLimits: COMMON_REFERENCE_LIMITS,
    required: ['sourceVideo', 'editInstruction', 'keepList']
  })
});

const FEATURE_ROUTES = Object.freeze({
  standard_generation: Object.freeze({ operation: 'standard_generation', capability: 'base_video_generation' }),
  multi_reference_30s: Object.freeze({ operation: 'standard_generation', capability: 'multimodal_reference' }),
  timestamp_control: Object.freeze({ operation: 'standard_generation', capability: 'seconds_level_timeline' }),
  multilingual_dialogue: Object.freeze({ operation: 'standard_generation', capability: 'multilingual_dialogue' }),
  clean_audio_visual_output: Object.freeze({ operation: 'standard_generation', capability: 'suppress_unrequested_subtitles_and_bgm' }),
  realistic_character: Object.freeze({ operation: 'standard_generation', capability: 'character_realism' }),
  native_extend: Object.freeze({ operation: 'native_extend', capability: 'continuation' }),
  ultralong: Object.freeze({ operation: 'ultralong', capability: 'long_sequence' }),
  smart_edit: Object.freeze({ operation: 'smart_edit', capability: 'text_directed_edit' }),
  advanced_edit: Object.freeze({ operation: 'advanced_edit', capability: 'annotation_directed_edit' }),
  video_edit: Object.freeze({ operation: 'video_edit', capability: 'generated_video_revision' }),
  object_add: Object.freeze({ operation: 'smart_edit', capability: 'object_addition' }),
  object_remove: Object.freeze({ operation: 'smart_edit', capability: 'object_removal' }),
  object_replace: Object.freeze({ operation: 'smart_edit', capability: 'object_replacement' }),
  attribute_modify: Object.freeze({ operation: 'smart_edit', capability: 'attribute_modification' }),
  local_remove_or_replace: Object.freeze({ operation: 'advanced_edit', capability: 'annotated_local_edit' }),
  green_screen: Object.freeze({ operation: 'smart_edit', capability: 'green_screen_composite' }),
  bgm_separation: Object.freeze({ operation: 'smart_edit', capability: 'bgm_remove_keep_voice' }),
  creative_transfer: Object.freeze({ operation: 'standard_generation', capability: 'creative_language_transfer' }),
  spatial_view_edit: Object.freeze({ operation: 'advanced_edit', capability: 'camera_view_outpaint' }),
  voice_reference: Object.freeze({ operation: 'standard_generation', capability: 'voice_identity' }),
  multi_person: Object.freeze({ operation: 'standard_generation', capability: 'multi_character_identity' }),
  white_model_coarse: Object.freeze({ operation: 'standard_generation', capability: 'motion_skeleton_reference' }),
  white_model_fine: Object.freeze({ operation: 'standard_generation', capability: 'material_and_lighting_render' }),
  transition_bridge: Object.freeze({ operation: 'standard_generation', capability: 'two_video_bridge' }),
  storyboard_multigrid: Object.freeze({ operation: 'standard_generation', capability: 'storyboard_sequence_reference' })
});

function number(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}

function count(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function inside(value, range, name) {
  number(value, name);
  if (value < range.min || value > range.max) {
    throw new Error(`${name} must be between ${range.min} and ${range.max} seconds`);
  }
}

function validateReferenceLimits(input, profile) {
  const limits = profile.referenceLimits;
  const imageCount = count(input.imageCount ?? 0, 'imageCount');
  const videoCount = count(input.videoCount ?? 0, 'videoCount');
  const audioCount = count(input.audioCount ?? 0, 'audioCount');
  if (imageCount > limits.imageCount) throw new Error(`imageCount exceeds official Seedance 2.5 limit ${limits.imageCount}`);
  if (videoCount > limits.videoCount) throw new Error(`videoCount exceeds official Seedance 2.5 limit ${limits.videoCount}`);
  if (audioCount > limits.audioCount) throw new Error(`audioCount exceeds official Seedance 2.5 limit ${limits.audioCount}`);
  const videoDurationsSec = input.videoDurationsSec ?? [];
  const audioDurationsSec = input.audioDurationsSec ?? [];
  if (!Array.isArray(videoDurationsSec) || videoDurationsSec.length !== videoCount) throw new Error('videoDurationsSec must list every reference video');
  if (!Array.isArray(audioDurationsSec) || audioDurationsSec.length !== audioCount) throw new Error('audioDurationsSec must list every reference audio');
  videoDurationsSec.forEach((value, index) => inside(value, limits.videoItemDurationSec, `videoDurationsSec[${index}]`));
  audioDurationsSec.forEach((value, index) => inside(value, limits.audioItemDurationSec, `audioDurationsSec[${index}]`));
  const videoTotalDurationSec = number(input.videoTotalDurationSec ?? 0, 'videoTotalDurationSec');
  const audioTotalDurationSec = number(input.audioTotalDurationSec ?? 0, 'audioTotalDurationSec');
  const computedVideoTotal = videoDurationsSec.reduce((sum, value) => sum + value, 0);
  const computedAudioTotal = audioDurationsSec.reduce((sum, value) => sum + value, 0);
  if (Math.abs(computedVideoTotal - videoTotalDurationSec) > 0.05) throw new Error('videoTotalDurationSec does not match videoDurationsSec');
  if (Math.abs(computedAudioTotal - audioTotalDurationSec) > 0.05) throw new Error('audioTotalDurationSec does not match audioDurationsSec');
  if (videoTotalDurationSec > limits.videoTotalDurationSec) throw new Error('reference video total duration exceeds 30.2 seconds');
  if (audioTotalDurationSec > limits.audioTotalDurationSec) throw new Error('reference audio total duration exceeds 30.2 seconds');
  return { imageCount, videoCount, audioCount, videoDurationsSec: [...videoDurationsSec], audioDurationsSec: [...audioDurationsSec], videoTotalDurationSec, audioTotalDurationSec };
}

function stabilityWarnings(input, counts) {
  const warnings = [];
  if (counts.imageCount > STABILITY_GUIDANCE.preferredImageCount) warnings.push('IMAGE_COUNT_ABOVE_PREFERRED_8');
  if (counts.videoCount > STABILITY_GUIDANCE.preferredVideoCount) warnings.push('VIDEO_COUNT_ABOVE_PREFERRED_5');
  if (counts.audioCount > STABILITY_GUIDANCE.preferredAudioCount) warnings.push('AUDIO_COUNT_ABOVE_PREFERRED_5');
  if ((input.maxSubjectMediaDurationSec ?? 0) > STABILITY_GUIDANCE.preferredSubjectMediaDurationSec) warnings.push('SUBJECT_MEDIA_ABOVE_PREFERRED_10S');
  if (['smart_edit', 'advanced_edit', 'video_edit'].includes(input.operation)
    && input.sourceDurationSec > STABILITY_GUIDANCE.preferredEditSourceDurationSec) warnings.push('EDIT_SOURCE_ABOVE_PREFERRED_20S');
  if (['smart_edit', 'advanced_edit', 'video_edit'].includes(input.operation)
    && counts.imageCount > STABILITY_GUIDANCE.preferredEditReferenceImageCount) warnings.push('EDIT_REFERENCE_IMAGES_ABOVE_PREFERRED_5');
  return warnings;
}

export function resolveSeedance25Feature(feature) {
  const route = FEATURE_ROUTES[feature];
  if (!route) throw new Error(`unknown Seedance 2.5 feature: ${feature ?? ''}`);
  return route;
}

function requireFeatureInput(condition, feature, field) {
  if (!condition) throw new Error(`${feature} requires ${field}`);
}

export function createSeedance25FeaturePlan(feature, input = {}) {
  const route = resolveSeedance25Feature(feature);
  const merged = { ...input, ...route };
  if (feature === 'transition_bridge') requireFeatureInput(input.videoCount === 2, feature, 'exactly two endpoint videos');
  if (feature === 'storyboard_multigrid') requireFeatureInput(Boolean(input.storyboardBinding), feature, 'storyboardBinding');
  if (feature === 'white_model_coarse' || feature === 'white_model_fine') {
    requireFeatureInput(Boolean(input.whiteModelVideoBinding), feature, 'whiteModelVideoBinding');
  }
  if (feature === 'local_remove_or_replace' || feature === 'spatial_view_edit') {
    requireFeatureInput(Boolean(input.annotationBinding), feature, 'annotationBinding');
  }
  if (feature === 'green_screen') requireFeatureInput(Boolean(input.greenScreenSource), feature, 'greenScreenSource');
  if (feature === 'bgm_separation') requireFeatureInput(Array.isArray(input.audioKeepList) && input.audioKeepList.length > 0, feature, 'audioKeepList');
  if (feature === 'voice_reference') requireFeatureInput((input.audioCount ?? 0) > 0, feature, 'at least one reference audio');
  if (feature === 'multi_person') requireFeatureInput(Array.isArray(input.characterBindings) && input.characterBindings.length >= 2, feature, 'at least two characterBindings');
  if (feature === 'creative_transfer') requireFeatureInput(Array.isArray(input.transferDimensions) && input.transferDimensions.length > 0, feature, 'transferDimensions');
  if (feature === 'multilingual_dialogue') requireFeatureInput(Array.isArray(input.dialogueLanguages) && input.dialogueLanguages.length > 0, feature, 'dialogueLanguages');
  if (feature === 'clean_audio_visual_output') requireFeatureInput(Array.isArray(input.allowedTextAndAudio), feature, 'allowedTextAndAudio keep-list');
  return createSeedance25OperationPlan(merged);
}

export function createSeedance25OperationPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Seedance 2.5 operation input must be an object');
  const operation = input.operation;
  const profile = OPERATION_PROFILES[operation];
  if (!profile) throw new Error(`unknown Seedance 2.5 operation: ${operation ?? ''}`);
  const counts = validateReferenceLimits(input, profile);
  if (profile.durationSec) inside(input.durationSec, profile.durationSec, 'durationSec');
  if (profile.sourceDurationSec) inside(input.sourceDurationSec, profile.sourceDurationSec, 'sourceDurationSec');
  if (profile.extensionDurationSec) inside(input.extensionDurationSec, profile.extensionDurationSec, 'extensionDurationSec');
  if (operation === 'native_extend' && input.sourceDurationSec + input.extensionDurationSec > profile.resultDurationSec.max) {
    throw new Error('native extension result exceeds the documented 60 second maximum');
  }
  if (input.outputResolution !== undefined && !['480p', '720p'].includes(input.outputResolution)) {
    throw new Error('the official Seedance 2.5 manual currently verifies only 480p and 720p output');
  }
  for (const requirement of profile.required) {
    if (input[requirement] === undefined || input[requirement] === null || input[requirement] === '') {
      throw new Error(`${operation} requires ${requirement}`);
    }
  }
  return Object.freeze({
    version: 1,
    modelFamily: 'Seedance 2.5',
    operation,
    capability: input.capability ?? null,
    officialManual: OFFICIAL_MANUAL_URL,
    evidenceStatus: 'OFFICIAL_MANUAL_REVIEWED_RUNTIME_ALIAS_UNRESOLVED',
    executionStatus: 'PLANNING_ONLY',
    submissionAllowed: false,
    submissionBlocker: 'UNRESOLVED_LIBTV_MODEL_ALIAS',
    requested: Object.freeze({
      durationSec: input.durationSec ?? null,
      sourceDurationSec: input.sourceDurationSec ?? null,
      extensionDurationSec: input.extensionDurationSec ?? null,
      outputResolution: input.outputResolution ?? '720p',
      ...counts
    }),
    stabilityWarnings: Object.freeze(stabilityWarnings(input, counts)),
    paidBoundary: Object.freeze({
      requiresFreshFingerprint: true,
      requiresPricingSnapshot: true,
      automaticRetryAllowed: false,
      reusePriorApprovalAllowed: false
    })
  });
}

export const SEEDANCE25_OPERATION_PROFILES = OPERATION_PROFILES;
export const SEEDANCE25_FEATURE_ROUTES = FEATURE_ROUTES;
export const SEEDANCE25_STABILITY_GUIDANCE = STABILITY_GUIDANCE;
