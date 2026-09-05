// Workflow profiles: three project routes with different human-review depths.
//
// The harness keeps a single internal gate numbering (0-5) for evidence.
// A workflow profile only decides which of those gates require a HUMAN
// decision and which are machine-reviewed and auto-locked in the background.
//
// - simple_remake (简单复刻): a source video exists and the task is to
//   replicate it or replace specific content. Human gates: 1 (director),
//   4 (pre-generation), 5 (final video). Story/shots and assets are
//   machine-generated and machine-reviewed.
// - narrative (剧情类): a story, characters, or product narrative with a
//   reference but no frame-by-frame replication. Human gates: 1, 3, 4, 5.
//   The story plan is machine-reviewed; assets stay human-reviewed.
// - original (全新创意): no reference; the direction is developed through a
//   creative dialogue, then the full five human gates apply.
//
// Gate numbers are internal evidence coordinates; the user-visible flow only
// shows the gates that require a human decision (plus, for original, the
// creative dialogue step).

export const WORKFLOW_PROFILE_IDS = Object.freeze(['simple_remake', 'narrative', 'original']);
export const REMAKE_CONTROL_MODE_IDS = Object.freeze(['storyboard_control', 'depth_control', 'native_source', 'koc_remake']);

export const GATE_LABELS = Object.freeze({
  0: '创意对话',
  1: '导演确认',
  2: '故事与镜头',
  3: '资产确认',
  4: '生成前确认',
  5: '成片确认'
});

export const WORKFLOW_PROFILES = Object.freeze({
  simple_remake: Object.freeze({
    id: 'simple_remake',
    label: '简单复刻',
    summary: '有明确原片，要求复刻、替换产品或保留台词动作。',
    estimatedEffort: '最快路线；系统承担原片整理、故事与镜头草稿和资产机审。',
    humanGates: Object.freeze([1, 4, 5]),
    machineReviewedGates: Object.freeze([2, 3]),
    // Steps shown on the page, in order. Gate numbers are internal.
    visibleSteps: Object.freeze([
      Object.freeze({ gate: 1, label: '导演确认' }),
      Object.freeze({ gate: 4, label: '生成前确认' }),
      Object.freeze({ gate: 5, label: '成片确认' })
    ]),
    creativeDialogue: false
  }),
  narrative: Object.freeze({
    id: 'narrative',
    label: '剧情类',
    summary: '有明确故事、人物或产品参考方向，但不要求逐项复刻原片。',
    estimatedEffort: '平衡路线；故事与镜头由系统机审，资产仍由你确认。',
    humanGates: Object.freeze([1, 3, 4, 5]),
    machineReviewedGates: Object.freeze([2]),
    visibleSteps: Object.freeze([
      Object.freeze({ gate: 1, label: '导演确认' }),
      Object.freeze({ gate: 3, label: '资产确认' }),
      Object.freeze({ gate: 4, label: '生成前确认' }),
      Object.freeze({ gate: 5, label: '成片确认' })
    ]),
    creativeDialogue: false
  }),
  original: Object.freeze({
    id: 'original',
    label: '全新创意',
    summary: '只有想法或目标，需要先通过对话共同发散创意方向。',
    estimatedEffort: '完整路线；先用对话明确方向，之后保留全部人工审核。',
    humanGates: Object.freeze([1, 2, 3, 4, 5]),
    machineReviewedGates: Object.freeze([]),
    visibleSteps: Object.freeze([
      Object.freeze({ gate: 0, label: '创意对话' }),
      Object.freeze({ gate: 1, label: '导演确认' }),
      Object.freeze({ gate: 2, label: '故事与镜头' }),
      Object.freeze({ gate: 3, label: '资产确认' }),
      Object.freeze({ gate: 4, label: '生成前确认' }),
      Object.freeze({ gate: 5, label: '成片确认' })
    ]),
    creativeDialogue: true
  })
});

// The human-review gate each artifact type belongs to. Mirrors
// review-policy.js checkpoints; kept as numbers so profiles can delegate
// whole gates to machine review without touching artifact classification.
export const ARTIFACT_TYPE_GATE = Object.freeze({
  creative_brief: 1,
  story_plan: 2,
  spatial_control_model: 3,
  project_asset: 3,
  segment_asset: 3,
  human_visual_exception: 3,
  video_segment: 5,
  final_edit: 5
});

function text(value, field, maxLength = 2000) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(field + ' must be a non-empty string');
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(field + ' must not exceed ' + maxLength + ' characters');
  return normalized;
}

export function isWorkflowProfileId(value) {
  return typeof value === 'string' && WORKFLOW_PROFILE_IDS.includes(value);
}

export function requireWorkflowProfile(value) {
  if (!isWorkflowProfileId(value)) throw new TypeError('workflowProfile.id must be one of: ' + WORKFLOW_PROFILE_IDS.join(', '));
  return WORKFLOW_PROFILES[value];
}

// Validates the optional project-state field:
//   workflowProfile: { id, selectedBy, reason, updatedAt }
export function assertWorkflowProfile(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('workflowProfile must be an object');
  requireWorkflowProfile(value.id);
  if (!['user', 'system_recommendation'].includes(value.selectedBy)) {
    throw new TypeError("workflowProfile.selectedBy must be 'user' or 'system_recommendation'");
  }
  text(value.reason, 'workflowProfile.reason');
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new TypeError('workflowProfile.updatedAt must be a parseable date-time string');
  }
  return value;
}

export function workflowProfileOf(state) {
  const value = state?.workflowProfile;
  if (value === undefined || value === null) return null;
  return assertWorkflowProfile(value);
}

export function workflowProfileIdOf(state) {
  return workflowProfileOf(state)?.id ?? null;
}

// Check writes without rejecting or silently migrating historical project files.
export function workflowProfileConflict(state, profileId) {
  requireWorkflowProfile(profileId);
  if (state?.routeDecision?.executionClass === 'mechanical_asset_prompt') {
    return '当前是原片素材与画布准备任务，无需选择创作路线；如需改变目标，请先修改项目需求。';
  }
  const role = state?.routeDecision?.referenceRoleStatus;
  if (role === 'authority' && profileId !== 'simple_remake') {
    return '当前要求保留原片内容，不能直接切换为原创；请先确认原片用途的变更。';
  }
  if (['inspiration', 'not_applicable'].includes(role) && profileId === 'simple_remake') {
    return '当前原片只供灵感或尚无原片，不能直接切换为复刻；请先确认原片与保留范围。';
  }
  if (['awaiting_reference_role', 'awaiting_source_video'].includes(role)) return '请先确认原视频是用于复刻，还是只提供灵感。';
  return null;
}

export function humanGatesForProfile(profileId) {
  if (profileId === null || profileId === undefined) return [1, 2, 3, 4, 5];
  return [...requireWorkflowProfile(profileId).humanGates];
}

export function isHumanGate(profileId, gate) {
  return humanGatesForProfile(profileId).includes(gate);
}

export function isMachineReviewedGate(profileId, gate) {
  if (profileId === null || profileId === undefined) return false;
  return requireWorkflowProfile(profileId).machineReviewedGates.includes(gate);
}

export function visibleStepsForProfile(profileId) {
  if (profileId === null || profileId === undefined) {
    return [0, 1, 2, 3, 4, 5].map(gate => ({ gate, label: GATE_LABELS[gate] }));
  }
  return requireWorkflowProfile(profileId).visibleSteps.map(step => ({ ...step }));
}

// Mechanical asset-and-prompt work deliberately has no director interview,
// creative brief, story plan, shot list, or semantic-review gate.  Project
// views must therefore not fall back to the six-gate creative profile merely
// because no workflowProfile has been selected.
export function visibleStepsForProject(state) {
  if (state?.routeDecision?.executionClass === 'mechanical_asset_prompt') {
    return [{ gate: 4, label: '资产、提示词与 LibTV 画布' }];
  }
  return visibleStepsForProfile(workflowProfileIdOf(state));
}

// Deterministic route recommendation from the intake description and the
// persisted reference intent. The returned reason is written for the user,
// in Chinese, and must only state what the inputs actually show.
export function recommendWorkflowProfile({ requestText = '', referenceIntent = 'idea_only', sourceVideoIds = [] } = {}) {
  const request = typeof requestText === 'string' ? requestText : '';
  const hasSource = Array.isArray(sourceVideoIds) && sourceVideoIds.length > 0;
  if (['faithful_remake', 'source_modification'].includes(referenceIntent) && hasSource) {
    return {
      id: 'simple_remake',
      reason: '你上传了原片并要求复刻或局部替换。系统会自动整理原片、生成故事与镜头草稿并完成资产机审；你只需确认导演方向、生成前结果和最终成片。'
    };
  }
  const narrativeSignals = /剧情|故事|人物|角色|冲突|短剧|情节|反转|产品故事|参考/.test(request);
  if (referenceIntent === 'inspiration_only' || (narrativeSignals && !/复刻|一比一|1:1|照搬/.test(request))) {
    return {
      id: 'narrative',
      reason: '需求包含故事、人物或参考方向，但不要求逐项复刻原片。系统机审故事与镜头，你确认导演方向、资产、生成前结果与成片。'
    };
  }
  if (referenceIntent === 'idea_only') {
    return {
      id: 'original',
      reason: '当前只有想法或目标，没有明确的参考片。先用创意对话把方向聊清楚，再进入完整的导演审核流程。'
    };
  }
  return {
    id: 'narrative',
    reason: '需求包含明确的故事方向。系统机审故事与镜头，你确认导演方向、资产、生成前结果与成片。'
  };
}

// ---------------------------------------------------------------------------
// Asset catalogue for the visual asset selector.
//
// Each entry is a user-facing card. assetType is the internal canonical
// asset type used downstream; paidImageTasks is the estimated number of
// paid image generations if the asset has to be produced rather than
// uploaded or derived locally. Estimates are planning hints only.
// ---------------------------------------------------------------------------

export const ASSET_CATALOG = Object.freeze([
  Object.freeze({
    id: 'depth_video', label: '深度视频', assetType: 'depth_video_reference', paidImageTasks: 0,
    summary: '从原片自动转换的深度序列，锁定人物动作、空间遮挡与镜头运动。',
    role: '控制动作与空间', derived: '系统从原片自动转换'
  }),
  Object.freeze({
    id: 'first_frame', label: '首帧画面', assetType: 'initial_blocking', paidImageTasks: 0,
    summary: '原片的第一帧，锁定开场构图、人物位置与画面方向。',
    role: '锁定开场构图', derived: '系统从原片自动提取'
  }),
  Object.freeze({
    id: 'product_image', label: '产品图', assetType: 'product_reference', paidImageTasks: 0,
    summary: '产品的身份基准：结构、材质、颜色与比例。替换类产品视频通常必须提供。',
    role: '锁定产品身份', derived: '你上传产品照片，或由系统生成'
  }),
  Object.freeze({
    id: 'character_reference', label: '人物参考图', assetType: 'character_identity_single_view', paidImageTasks: 1,
    summary: '单张人物身份图。当画面里的人物必须与参考保持一致时推荐加入。',
    role: '锁定人物身份', derived: '系统生成或你上传'
  }),
  Object.freeze({
    id: 'character_board', label: '人物四视图', assetType: 'character_board', paidImageTasks: 1,
    summary: '人物的正、侧、背等多角度基准。人物特写多、动作复杂时成功率更高。',
    role: '锁定人物多视角', derived: '系统生成'
  }),
  Object.freeze({
    id: 'scene_image', label: '场景图', assetType: 'scene_multiview', paidImageTasks: 1,
    summary: '场景的空间基准。原片场景容易被模型改动，或需要换新场景时使用。',
    role: '锁定场景空间', derived: '系统生成或你上传'
  }),
  Object.freeze({
    id: 'prop_image', label: '道具图', assetType: 'story_prop', paidImageTasks: 1,
    summary: '关键道具的结构基准。道具会被拿起、操作或特写时推荐加入。',
    role: '锁定关键道具', derived: '系统生成或你上传'
  }),
  Object.freeze({
    id: 'storyboard', label: '分镜图', assetType: 'storyboard', paidImageTasks: 1,
    summary: '每个镜头的构图草图。镜头多、调度复杂时帮助模型理解画面安排。',
    role: '锁定镜头构图', derived: '系统生成'
  }),
  Object.freeze({
    id: 'voice_reference', label: '声音参考', assetType: 'source_audio_candidate', paidImageTasks: 0,
    summary: '原片音频或口播录音。台词不变时优先复用原片音频，不要求你听写台词。',
    role: '锁定台词与节奏', derived: '系统从原片自动提取或你上传'
  }),
  Object.freeze({
    id: 'koc_aroll_control', label: 'KOC 匿名 A-roll', assetType: 'identity_suppressed_aroll', paidImageTasks: 0,
    summary: '从原片抽取的说话主角 A-roll，仅在脖子以上精确抑制旧身份；原时序、原动作、字幕、身体、背景和音频不变。',
    role: '锁定原片动作并移除旧人物身份', derived: '系统从原片 A-roll 确定性派生并逐段审查'
  })
]);

export const ASSET_CATALOG_IDS = Object.freeze(ASSET_CATALOG.map(item => item.id));

const PRODUCT_HINT = /产品|商品|带货|电商|替换|卖点/;

// Default asset grouping per profile. required cannot be deselected;
// recommended is pre-selected but can be removed; everything else in the
// catalogue is optional.
export function assetDefaultsForProfile(profileId, { requestText = '' } = {}) {
  const productExpected = PRODUCT_HINT.test(requestText);
  if (profileId === 'simple_remake') {
    return {
      required: productExpected ? ['product_image'] : [],
      recommended: ['depth_video', ...(productExpected ? [] : ['product_image'])],
      optional: ASSET_CATALOG_IDS.filter(id => !['depth_video', 'product_image'].includes(id))
    };
  }
  if (profileId === 'narrative') {
    const recommended = ['character_reference', 'scene_image', ...(productExpected ? [] : ['product_image'])];
    return {
      required: productExpected ? ['product_image'] : [],
      recommended,
      optional: ASSET_CATALOG_IDS.filter(id => !recommended.includes(id) && !(productExpected && id === 'product_image'))
    };
  }
  // Original work still needs an identity anchor, but a fixed four-view board
  // is no longer the default. Gate 2 Shot coverage may upgrade the single
  // reference into only the additional angles actually visible on screen.
  const recommended = ['character_reference', 'scene_image', ...(productExpected ? [] : ['product_image'])];
  return {
    required: productExpected ? ['product_image'] : [],
    recommended,
    optional: ASSET_CATALOG_IDS.filter(id => !recommended.includes(id) && !(productExpected && id === 'product_image'))
  };
}

// Validates the optional project-state field:
//   assetSelection: { profileId, selected: [...], userProvided: [...], estimatedPaidImageTasks, updatedAt }
export function assertAssetSelection(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('assetSelection must be an object');
  requireWorkflowProfile(value.profileId);
  if (!Array.isArray(value.selected)) throw new TypeError('assetSelection.selected must be an array');
  const seen = new Set();
  for (const [index, item] of value.selected.entries()) {
    if (!ASSET_CATALOG_IDS.includes(item)) throw new TypeError('assetSelection.selected[' + index + '] is not a known asset: ' + item);
    if (seen.has(item)) throw new TypeError('assetSelection.selected must not contain duplicates');
    seen.add(item);
  }
  if (value.userProvided !== undefined) {
    if (!Array.isArray(value.userProvided)) throw new TypeError('assetSelection.userProvided must be an array');
    const provided = new Set();
    for (const [index, item] of value.userProvided.entries()) {
      if (!seen.has(item)) throw new TypeError('assetSelection.userProvided[' + index + '] must also be selected');
      if (provided.has(item)) throw new TypeError('assetSelection.userProvided must not contain duplicates');
      provided.add(item);
    }
  }
  if (!Number.isInteger(value.estimatedPaidImageTasks) || value.estimatedPaidImageTasks < 0) {
    throw new TypeError('assetSelection.estimatedPaidImageTasks must be a non-negative integer');
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new TypeError('assetSelection.updatedAt must be a parseable date-time string');
  }
  return value;
}

// Persisted user decision for the remake route. The detailed asset plan is
// derived so it cannot drift away from these three authoritative choices.
export function assertRemakeControlSelection(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('remakeControlSelection must be an object');
  if (value.profileId !== 'simple_remake') throw new TypeError("remakeControlSelection.profileId must be 'simple_remake'");
  if (!Array.isArray(value.selectedModes) || value.selectedModes.length === 0) {
    throw new TypeError('remakeControlSelection.selectedModes must contain at least one mode');
  }
  const seen = new Set();
  for (const [index, mode] of value.selectedModes.entries()) {
    if (!REMAKE_CONTROL_MODE_IDS.includes(mode)) throw new TypeError(`remakeControlSelection.selectedModes[${index}] is invalid`);
    if (seen.has(mode)) throw new TypeError('remakeControlSelection.selectedModes must not contain duplicates');
    seen.add(mode);
  }
  if (typeof value.requiresReversePrompt !== 'boolean') throw new TypeError('remakeControlSelection.requiresReversePrompt must be boolean');
  const expected = value.selectedModes.some(mode => mode !== 'native_source');
  if (value.requiresReversePrompt !== expected) throw new TypeError('remakeControlSelection.requiresReversePrompt does not match selectedModes');
  const kocSelected = value.selectedModes.includes('koc_remake');
  if (kocSelected && value.selectedModes.length !== 1) throw new TypeError('koc_remake must be selected alone');
  if (kocSelected && !['none', 'all_segments', 'selected_segments'].includes(value.firstFramePolicy)) {
    throw new TypeError('koc_remake requires a valid firstFramePolicy');
  }
  if (!kocSelected && value.firstFramePolicy !== undefined && value.firstFramePolicy !== null) {
    throw new TypeError('firstFramePolicy only applies to koc_remake');
  }
  if (!['reverse_source_prompt_then_compile_with_asset_bindings', 'native_source_replacement_instruction_only', 'koc_source_bound_identity_replacement'].includes(value.promptPolicy)) {
    throw new TypeError('remakeControlSelection.promptPolicy is invalid');
  }
  if (kocSelected !== (value.promptPolicy === 'koc_source_bound_identity_replacement')) {
    throw new TypeError('remakeControlSelection.promptPolicy does not match selectedModes');
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new TypeError('remakeControlSelection.updatedAt must be a parseable date-time string');
  }
  return value;
}

export function estimatePaidImageTasks(selectedIds, userProvidedIds = []) {
  const userProvided = new Set(userProvidedIds);
  return selectedIds.reduce((total, id) => {
    const entry = ASSET_CATALOG.find(item => item.id === id);
    return total + (userProvided.has(id) ? 0 : (entry?.paidImageTasks ?? 0));
  }, 0);
}
