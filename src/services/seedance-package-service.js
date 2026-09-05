import { assertArtifact } from '../domain/artifact.js';
import { assertLockedAssetInputs } from './asset-service.js';
import { verifyLockedArtifact } from './artifact-file-service.js';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sha256File } from '../storage/checksum.js';
import { assertVideoResolutionContract } from '../domain/video-model-profile.js';

const SLOT_LIMITS = Object.freeze({ image: 9, video: 3, audio: 3 });
const MODEL_SLOT_LIMITS = Object.freeze({
  'Seedance 2.5': Object.freeze({ image: 30, video: 10, audio: 10 })
});

const REFERENCE_PRESENTATION_ORDER = Object.freeze({
  character_board: 10,
  character_front_face_closeup_v1: 11,
  character_identity_single_view: 11,
  identity_pair_board: 12,
  scene_multiview: 20,
  scene_overhead: 21,
  product_reference: 30,
  wardrobe_board: 31,
  initial_blocking: 40,
  handoff_blocking: 41,
  camera_blocking: 50,
  director_view_proxy: 55,
  spatial_control_animatic: 57,
  depth_video_reference: 58,
  dialogue_axis_board: 56,
  storyboard: 60,
  mannequin_grid: 62,
  keyframe: 61,
  character_product_state: 70,
  expression_board: 71,
  dialogue_audio_reference: 75,
  timing_audio_reference: 76,
  source_audio_candidate: 77,
  color_board: 80,
  story_prop: 90
});

const DECLARATIONS = Object.freeze({
  reference_video: ['camera_path', 'action_timing', 'blocking'],
  character_board: ['identity'],
  // Talking-head remakes may only have a licensed canonical opening frame.
  // A deterministic face-and-neckline crop is enough to anchor the visible
  // identity and the on-camera wardrobe, while the full opening frame keeps
  // blocking/camera authority. Do not force an invented full-body board.
  character_front_face_closeup_v1: ['identity', 'wardrobe'],
  character_identity_single_view: ['identity', 'body_shape', 'body_proportion', 'wardrobe'],
  // Deterministic two-person boards are a slot-compression format for
  // Seedance 2.0. Each board owns only the two explicitly mapped identities;
  // it must never donate its side-by-side layout to the generated shot.
  identity_pair_board: ['identity', 'body_shape', 'body_proportion', 'wardrobe'],
  // 产品参考图的职责必须覆盖其在资产合同中可见、可验收的外观字段。
  // `product_structure` 仍是唯一的排他控制权；其余字段只说明该图可锚定的
  // 外观，不会授予它镜头、人物或叙事控制权。
  product_reference: ['product_structure', 'product_color', 'product_material', 'product_surface'],
  scene_multiview: ['space_structure', 'light_direction'],
  scene_overhead: ['spatial_layout'],
  story_prop: ['prop_appearance'],
  initial_blocking: ['initial_blocking'],
  handoff_blocking: ['handoff_state'],
  camera_blocking: ['camera_path', 'character_paths'],
  director_view_proxy: ['shot_composition', 'subject_layout', 'occlusion'],
  spatial_control_animatic: ['camera_path', 'blocking', 'pose', 'contact_points', 'occlusion', 'action_timing', 'shot_transitions'],
  depth_video_reference: ['relative_depth', 'camera_path', 'subject_scale', 'occlusion', 'motion_timing'],
  dialogue_axis_board: ['speaker_listener_positions', 'eyelines', 'reaction_order', 'screen_direction_axis'],
  storyboard: ['framing', 'action_nodes'],
  mannequin_grid: ['pose_timing', 'blocking', 'contact_points', 'camera', 'occlusion'],
  keyframe: ['framing', 'action_nodes'],
  character_product_state: ['character_product_state'],
  expression_board: ['expression_state'],
  // A source-modification package can preserve cadence and speaking turns while
  // replacing the actual words in the text-led dialogue.  Giving the reference
  // audio ownership of `dialogue_words` makes those two requirements conflict.
  dialogue_audio_reference: ['dialogue_timing', 'voice_tone', 'speaker_timing'],
  timing_audio_reference: ['dialogue_timing', 'cadence', 'pauses', 'stress', 'speaker_timing', 'action_clock', 'trim_window'],
  source_audio_candidate: ['source_audio_waveform', 'dialogue_words', 'original_speaker_timbre', 'dialogue_timing', 'ambient_sound', 'dialogue_lipsync_clock', 'trim_window', 'final_mux_candidate'],
  wardrobe_board: ['wardrobe'],
  color_board: ['color_roles']
});

const EXCLUSIVE_CONTROLS = new Set(['identity', 'body_shape', 'body_proportion', 'product_structure', 'wardrobe']);
const TEXT_CONTROLS = Object.freeze([
  'time', 'causality', 'camera', 'physics', 'sound', 'end_state', 'negative_constraints'
]);

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function lockedSegment(project, segmentId) {
  const matches = (project.segments ?? []).filter(({ id }) => id === segmentId);
  if (matches.length !== 1) throw new Error(`locked segment ${segmentId} must appear exactly once`);
  const segment = matches[0];
  if (segment.status !== 'locked' || typeof segment.lockedByReviewId !== 'string' || segment.lockedByReviewId.trim() === '') {
    throw new Error(`segment ${segmentId} must be locked by human review`);
  }
  if (typeof segment.duration !== 'number' || segment.duration <= 0 || segment.duration > 15) {
    throw new Error(`segment duration must be greater than 0 and at most 15 seconds`);
  }
  return segment;
}

function lockedPrompt(project, segmentId) {
  const prompt = project.prompt;
  if (!prompt || prompt.type !== 'seedance_prompt' || prompt.segmentId !== segmentId || prompt.status !== 'locked') {
    throw new Error(`a locked Seedance prompt for ${segmentId} is required`);
  }
  assertArtifact(prompt);
  return prompt;
}

// 讲戏门（Shot Narration Gate）：seedance_prompt 必须声明其来源讲戏本，且该讲戏本已 locked，
// 且提示词记录的 narrationSha256 与讲戏本当前文件 SHA 一致（讲戏本一改，提示词绑定即失效，须重审）。
// 设计来源：docs/superpowers/specs/2026-07-21-shot-narration-director-gate-design.md
async function verifyNarrationBinding(project, prompt, segmentId) {
  const sourceId = prompt.narrationSourceId;
  const sourceSha = prompt.narrationSha256;
  if (typeof sourceId !== 'string' || sourceId.trim() === '' || typeof sourceSha !== 'string' || sourceSha.trim() === '') {
    throw new Error(`seedance_prompt ${prompt.id} must bind a locked shot_narration via narrationSourceId and narrationSha256`);
  }
  const artifacts = Array.isArray(project.artifacts) ? project.artifacts : [];
  const narration = artifacts.find(({ id }) => id === sourceId);
  if (!narration || narration.type !== 'shot_narration') throw new Error(`narrationSourceId must reference a shot_narration: ${sourceId}`);
  if (narration.segmentId !== segmentId) throw new Error(`shot_narration ${sourceId} does not belong to ${segmentId}`);
  if (narration.status !== 'locked' || typeof narration.lockedByReviewId !== 'string' || narration.lockedByReviewId.trim() === '') {
    throw new Error(`shot_narration ${sourceId} must be locked by human review before compiling the prompt`);
  }
  if (typeof project.root !== 'string' || project.root.trim() === '') throw new Error('project root is required to verify the shot_narration binding');
  if (isAbsolute(narration.path)) throw new Error(`shot_narration ${sourceId} path must be project-relative`);
  const projectRoot = await realpath(resolve(project.root));
  const narrationPath = resolve(projectRoot, narration.path);
  if (isOutside(projectRoot, narrationPath)) {
    throw new Error(`shot_narration ${sourceId} path escapes the project root`);
  }
  const digest = await sha256File(narrationPath);
  if (digest !== sourceSha.toLowerCase()) {
    throw new Error(`shot_narration binding is stale: ${sourceId} changed since the prompt was approved (re-review required)`);
  }
}

function validateManifest(project, segment) {
  const manifest = project.assetManifest;
  requireObject(manifest, 'asset manifest');
  if (manifest.status !== 'locked' || manifest.segmentId !== segment.id) {
    throw new Error(`a locked asset manifest for ${segment.id} is required`);
  }
  if (typeof manifest.lockedByReviewId !== 'string' || manifest.lockedByReviewId.trim() === '') {
    throw new Error(`asset manifest lockedByReviewId is required`);
  }
  assertLockedAssetInputs(manifest);
  const verifiedEvidence = project.verifiedAssetManifestEvidence;
  const reviewedManifestIsAuthoritative = Boolean(
    verifiedEvidence
    && verifiedEvidence.id === manifest.id
    && typeof verifiedEvidence.sha256 === 'string'
    && typeof verifiedEvidence.reviewId === 'string'
    && verifiedEvidence.reviewId === manifest.lockedByReviewId
  );
  for (const item of manifest.items) {
    assertArtifact({
      id: item.id,
      type: item.scope === 'project' ? 'project_asset' : 'segment_asset',
      revision: item.revision,
      status: item.status,
      path: item.outputPath ?? item.path,
      lockedByReviewId: item.lockedByReviewId,
      sha256: item.sha256
    });
    if (item.scope === 'segment' && item.segmentId !== segment.id) {
      throw new Error(`segment asset ${item.id} does not belong to ${segment.id}`);
    }
  }
  if (!reviewedManifestIsAuthoritative) {
    for (const type of segment.segmentAssetRequirements ?? []) {
      const found = manifest.items.find(item => item.type === type
        && ((item.scope === 'segment' && item.segmentId === segment.id)
          || (type === 'product_reference' && item.scope === 'project'))
        && item.status === 'locked');
      if (!found) throw new Error(`required current-segment asset is missing: ${type}`);
    }
    for (const id of segment.projectAssetIds ?? []) {
      const found = manifest.items.find(item => item.id === id && item.scope === 'project' && item.status === 'locked');
      if (!found) throw new Error(`required locked project asset is missing: ${id}`);
    }
  }
  return manifest;
}

/**
 * Mandatory asset completeness check: every segment must have character, scene,
 * and product before video generation. Called at the pre-generation gate
 * (generate-video --dry-run), not at compile-seedance, so that compilation
 * and testing can proceed without all three.
 */
export function assertMandatoryAssets(manifest, segmentId) {
  const lockedTypes = new Set((manifest.items ?? []).filter(item => item.status === 'locked').map(item => item.type));
  const hasCharacter = lockedTypes.has('character_board');
  const hasScene = lockedTypes.has('scene_multiview') || lockedTypes.has('scene_overhead');
  const hasProduct = lockedTypes.has('product_reference');
  const missingMandatory = [];
  if (!hasCharacter) missingMandatory.push('character_board');
  if (!hasScene) missingMandatory.push('scene_multiview or scene_overhead');
  if (!hasProduct) missingMandatory.push('product_reference');
  if (missingMandatory.length > 0) {
    throw new Error(`mandatory assets missing for ${segmentId}: ${missingMandatory.join(', ')}. Every segment requires character, scene, and product references before video generation.`);
  }
}

function declaredResponsibilities(items) {
  const map = {};
  const owners = new Map();
  const hasSourceVideo = items.some(({ type }) => type === 'reference_video');
  const hasWardrobeBoard = items.some(({ type }) => type === 'wardrobe_board');
  for (const item of items) {
    const declared = DECLARATIONS[item.type];
    if (!declared) throw new Error(`unsupported Seedance reference type: ${item.type ?? ''}`);
    const controls = item.type === 'character_identity_single_view'
      && item.responsibility === 'talking-head inner-face identity and stable facial feature proportions only'
      ? ['inner_face_identity', 'stable_inner_face_feature_proportions']
      : item.type === 'character_board' && !hasWardrobeBoard
        ? [...declared, 'wardrobe']
        : item.type === 'director_view_proxy'
        && item.mustNotControl?.length === 1
        && item.mustNotControl[0] === 'the replacement inner-face identity only'
        ? ['source_visible_pixels', 'action_timing', 'expression_timing', 'lip_shape', 'gaze', 'blink', 'head_and_hand_movement', 'hair', 'wardrobe', 'body', 'product', 'subtitle', 'b_roll', 'transition', 'composition', 'camera', 'lighting']
        : declared;
    if (item.type === 'identity_pair_board') {
      const sourceIds = item.sourceAssetIds;
      const bindings = item.identitySlotBindings;
      if (!Array.isArray(sourceIds) || sourceIds.length !== 2 || new Set(sourceIds).size !== 2) {
        throw new Error(`identity_pair_board ${item.id} requires exactly two distinct sourceAssetIds`);
      }
      if (!Array.isArray(bindings) || bindings.length !== 2
        || new Set(bindings.map(binding => binding.side)).size !== 2
        || !bindings.some(binding => binding.side === 'left')
        || !bindings.some(binding => binding.side === 'right')
        || new Set(bindings.map(binding => binding.identityAssetId)).size !== 2
        || bindings.some(binding => !sourceIds.includes(binding.identityAssetId))) {
        throw new Error(`identity_pair_board ${item.id} requires one left and one right binding matching sourceAssetIds`);
      }
    }
    const stated = item.responsibility.toLowerCase();
    if ((item.type === 'storyboard' || item.type === 'keyframe') && /\bidentity\b/.test(stated)) {
      throw new Error(`${item.type} ${item.id} must not control identity`);
    }
    for (const control of controls) {
      if (hasSourceVideo && item.type === 'camera_blocking' && control === 'camera_path') continue;
      if (!EXCLUSIVE_CONTROLS.has(control)) continue;
      const ownerScopes = ['identity', 'body_shape', 'body_proportion'].includes(control)
        ? item.type === 'identity_pair_board'
          ? item.sourceAssetIds
          : [item.characterId ?? item.id]
        : control === 'product_structure'
          ? [item.productId ?? item.id]
          : [item.characterId ?? item.id];
      for (const ownerScope of ownerScopes) {
        const ownerKey = `${control}:${ownerScope}`;
        if (owners.has(ownerKey)) throw new Error(`responsibility conflict: ${control} for ${ownerScope} is controlled by ${owners.get(ownerKey)} and ${item.id}`);
        owners.set(ownerKey, item.id);
      }
    }
    map[item.id] = { controls: [...controls], mustNotControl: [...item.mustNotControl] };
  }
  map.text = { controls: [...TEXT_CONTROLS], mustNotControl: ['reference appearance'] };
  return map;
}

function medium(item) {
  const value = item.mediaKind ?? 'image';
  if (!Object.hasOwn(SLOT_LIMITS, value)) throw new Error(`unsupported media kind for ${item.id}: ${value}`);
  return value;
}

function relevance(item, segment) {
  let score = item.scope === 'segment' ? 100 : 50;
  const currentShots = new Set(segment.shotIds ?? []);
  if ((item.shotIds ?? []).some(id => currentShots.has(id))) score += 25;
  if (item.segmentId === segment.id) score += 10;
  return score;
}

function selectInputs(items, segment, limits) {
  const selected = { image: [], video: [], audio: [] };
  const excludedInputs = items
    .filter(item => item.excludeFromGeneration === true)
    .map(item => {
      if (item.required !== false) throw new Error(`generation-excluded input ${item.id} must be optional`);
      return {
        id: item.id,
        reason: 'excluded: locked gate evidence that the current segment contract forbids from controlling generated pixels'
      };
    });
  for (const kind of Object.keys(selected)) {
    const candidates = items
      .filter(item => medium(item) === kind && item.excludeFromGeneration !== true)
      .map(item => ({ item, score: relevance(item, segment) }))
      .sort((left, right) => {
        const requiredOrder = Number(right.item.required !== false) - Number(left.item.required !== false);
        return requiredOrder || right.score - left.score || left.item.id.localeCompare(right.item.id);
      });
    const required = candidates.filter(({ item }) => item.required !== false);
    if (required.length > limits[kind]) throw new Error(`required ${kind} inputs exceed ${limits[kind]} slots`);
    const optional = candidates.filter(({ item }) => item.required === false);
    const chosen = [...required, ...optional.slice(0, limits[kind] - required.length)]
      .sort((left, right) => {
        const leftOrder = REFERENCE_PRESENTATION_ORDER[left.item.type] ?? 999;
        const rightOrder = REFERENCE_PRESENTATION_ORDER[right.item.type] ?? 999;
        return leftOrder - rightOrder || right.score - left.score || left.item.id.localeCompare(right.item.id);
      });
    selected[kind] = chosen.map(({ item, score }) => {
      const path = item.outputPath ?? item.path;
      if (typeof path !== 'string' || path.trim() === '') throw new Error(`locked input ${item.id} requires a local path`);
      return {
        id: item.id,
        path,
        status: item.status,
        reason: item.required === false
          ? `included: relevance score ${score} filled an available ${kind} slot`
          : `included: required locked ${item.scope} reference for ${segment.id}`
      };
    });
    for (const { item } of optional.slice(limits[kind] - required.length)) {
      excludedInputs.push({
        id: item.id,
        reason: `excluded: lower relevance after all ${limits[kind]} ${kind} slots were filled`
      });
    }
  }
  return { selected, excludedInputs };
}

function applicableRuleIds(rules) {
  if (!Array.isArray(rules)) throw new TypeError('applicableHardRules must be an array');
  return rules.map(rule => {
    if (!rule || rule.status !== 'hard') throw new Error(`applicable rule ${rule?.id ?? ''} must have hard status`);
    const hasEvidence = (Array.isArray(rule.evidence) && rule.evidence.length > 0)
      || (typeof rule.evidence === 'string' && rule.evidence.trim() !== '');
    if (typeof rule.verificationReviewId !== 'string' || rule.verificationReviewId.trim() === '' || !hasEvidence) {
      throw new Error(`applicable hard rule ${rule.id ?? ''} requires verification evidence`);
    }
    if (typeof rule.id !== 'string' || rule.id.trim() === '') throw new Error('applicable hard rule requires an id');
    return rule.id;
  });
}

function isOutside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function verifySelectedMedia(selected, items, root) {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('project root is required to verify selected media');
  const projectRoot = await realpath(resolve(root));
  for (const inputs of Object.values(selected)) {
    for (const input of inputs) {
      const source = items.find(({ id }) => id === input.id);
      const recordedPath = source.outputPath ?? source.path;
      if (isAbsolute(recordedPath) || isOutside(projectRoot, resolve(projectRoot, recordedPath))) {
        throw new Error(`selected media ${input.id} must stay inside project root`);
      }
      const candidate = resolve(projectRoot, recordedPath);
      let actual;
      let metadata;
      try {
        actual = await realpath(candidate);
        if (isOutside(projectRoot, actual)) throw new Error(`selected media symlink for ${input.id} escapes project root`);
        metadata = await stat(actual);
        await access(actual, constants.R_OK);
      } catch (error) {
        if (/escapes project root/.test(error.message)) throw error;
        throw new Error(`selected media ${input.id} must be a readable regular file`);
      }
      if (!metadata.isFile()) throw new Error(`selected media ${input.id} must be a readable regular file`);
      const digest = await sha256File(actual);
      if (digest !== source.sha256.toLowerCase()) throw new Error(`selected media checksum mismatch for ${input.id}`);
      input.path = relative(projectRoot, actual).split(sep).join('/');
      input.sha256 = digest;
    }
  }
}

export function assertUniqueSelectedMediaSha(selected) {
  const owners = new Map();
  for (const [mediaKind, inputs] of Object.entries(selected)) {
    if (!Array.isArray(inputs)) throw new TypeError(`selected ${mediaKind} inputs must be an array`);
    for (const input of inputs) {
      if (!/^[a-f0-9]{64}$/.test(input.sha256 ?? '')) throw new Error(`selected media ${input.id ?? ''} requires a persisted sha256`);
      const prior = owners.get(input.sha256);
      if (prior) {
        const error = new Error(`duplicate selected media bytes: ${prior.id} (${prior.mediaKind}) and ${input.id} (${mediaKind}) share SHA-256 ${input.sha256}; bind one canonical asset with one explicit responsibility contract`);
        error.code = 'DUPLICATE_SELECTED_MEDIA_SHA';
        throw error;
      }
      owners.set(input.sha256, { id: input.id, mediaKind });
    }
  }
}

export async function compileSeedancePackage(project, segmentId, options = {}) {
  requireObject(project, 'project');
  const segment = lockedSegment(project, segmentId);
  const prompt = lockedPrompt(project, segmentId);
  await verifyNarrationBinding(project, prompt, segmentId);
  const manifest = validateManifest(project, segment);
  let inputItems = manifest.items;
  if (options.includeReferenceVideo && !manifest.items.some(item => medium(item) === 'video' && item.status === 'locked')) {
    const lockedReferences = (project.artifacts ?? [])
      .filter(item => item.type === 'reference_video' && item.status === 'locked');
    const segmentReferences = lockedReferences.filter(item => item.segmentId === segmentId);
    const reference = (segmentReferences.length > 0 ? segmentReferences : lockedReferences.filter(item => !item.segmentId))
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0) || String(a.id).localeCompare(String(b.id)))[0];
    if (!reference) throw new Error('a locked reference video is required when includeReferenceVideo is enabled');
    await verifyLockedArtifact(project.root, reference);
    inputItems = [...manifest.items, {
      id: reference.id, type: 'reference_video', scope: 'project', status: 'locked', revision: reference.revision,
      path: reference.path, sha256: reference.sha256, responsibility: 'only camera path, blocking, action timing and original motion rhythm',
      mediaKind: 'video', required: true,
      mustNotControl: ['product appearance', 'final identity', 'final wardrobe', 'subtitles', 'watermark']
    }];
  }
  const allowVideoInputs = options.allowVideoInputs === true;
  const requiredVideoInputs = inputItems.filter(item => medium(item) === 'video' && item.excludeFromGeneration !== true && item.required !== false);
  if (!allowVideoInputs && requiredVideoInputs.length > 0) {
    throw new Error(`video inputs are disabled by default because they increase credit consumption; explicit user confirmation is required before uploading: ${requiredVideoInputs.map(item => item.id).join(', ')}`);
  }
  const generationItems = allowVideoInputs
    ? inputItems
    : inputItems.map(item => medium(item) === 'video'
      ? { ...item, required: false, excludeFromGeneration: true }
      : item);
  const modelLimits = MODEL_SLOT_LIMITS[options.resolutionContract?.model] ?? SLOT_LIMITS;
  const limits = {
    image: options.imageSlots ?? modelLimits.image,
    video: options.videoSlots ?? modelLimits.video,
    audio: options.audioSlots ?? modelLimits.audio
  };
  const { selected, excludedInputs } = selectInputs(generationItems, segment, limits);
  const selectedIds = new Set(Object.values(selected).flat().map(({ id }) => id));
  const responsibilityMap = declaredResponsibilities(inputItems.filter(({ id }) => selectedIds.has(id)));
  await verifySelectedMedia(selected, inputItems, project.root);
  assertUniqueSelectedMediaSha(selected);
  const resolutionContract = options.resolutionContract ?? null;
  let resolution = options.resolution ?? '480p';
  if (resolutionContract) {
    assertVideoResolutionContract(resolutionContract);
    if (options.resolution !== undefined && options.resolution !== resolutionContract.resolution) throw new Error('package resolution conflicts with the verified video resolution contract');
    resolution = resolutionContract.resolution;
  } else if (!['480p', '720p'].includes(resolution)) {
    throw new Error('1080p or 4k requires a verified video resolution contract');
  }

  return {
    promptPath: prompt.path,
    duration: segment.duration,
    ratio: '9:16',
    resolution,
    generateAudio: options.generateAudio ?? true,
    ...(resolutionContract ? {
      videoModelProfileId: resolutionContract.profileId,
      videoExecutor: resolutionContract.executor,
      videoModel: resolutionContract.model,
      sourceResolutionBaseline: resolutionContract.sourceBaseline
    } : {}),
    imageInputs: selected.image,
    videoInputs: selected.video,
    audioInputs: selected.audio,
    responsibilityMap,
    excludedInputs,
    hardRuleIds: applicableRuleIds(options.applicableHardRules ?? [])
  };
}
