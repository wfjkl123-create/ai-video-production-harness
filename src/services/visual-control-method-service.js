const METHODS = Object.freeze({
  storyboard: Object.freeze({ id: 'storyboard', label: '分镜图', controlAsset: 'storyboard', replaceLegacyStoryboard: false }),
  depth: Object.freeze({ id: 'depth', label: '深度图', controlAsset: 'monocular_depth', replaceLegacyStoryboard: true }),
  modeling: Object.freeze({ id: 'modeling', label: '建模', controlAsset: 'spatial_control_model', replaceLegacyStoryboard: true })
});

const REMAKE_MODES = Object.freeze({
  storyboard_control: Object.freeze({
    id: 'storyboard_control', label: '分镜图', controlAsset: 'storyboard',
    responsibility: '构图、景别、动作节点、切镜顺序',
    transfer: Object.freeze(['构图', '景别', '主体位置', '动作节点', '切镜顺序']),
    ignore: Object.freeze(['人物身份', '产品结构', '精确材质', '原片音频'])
  }),
  depth_control: Object.freeze({
    id: 'depth_control', label: '深度视频', controlAsset: 'depth_video',
    responsibility: '人物动作、空间层次、遮挡与镜头运动',
    transfer: Object.freeze(['动作轨迹', '前后关系', '遮挡', '人物尺度', '镜头运动']),
    ignore: Object.freeze(['人物身份', '面部表情', '产品细节', '颜色材质', '精细手物接触'])
  }),
  native_source: Object.freeze({
    id: 'native_source', label: '原视频', controlAsset: 'reference_video',
    responsibility: '官方原生视频替换所需的全片时序与动态参考',
    transfer: Object.freeze(['全片时序', '动作', '运镜', '场景动态', '原始剪辑节奏']),
    ignore: Object.freeze(['未明确要求保留的旧商品身份', '未明确要求保留的旧人物身份'])
  }),
  koc_remake: Object.freeze({
    id: 'koc_remake', label: 'KOC 复刻', controlAsset: 'koc_aroll_control',
    responsibility: '只处理说话主角 A-roll：精确整头匿名、保留原动作与原声时间轴，生成后回插原片',
    transfer: Object.freeze(['A-roll 原始时序', '身体动作', '口型节拍', '构图', '运镜', '字幕位置', '服装', '背景']),
    ignore: Object.freeze(['原人物身份', '原脸五官与骨相', 'B-roll 重绘', '未被当前台词触发的产品身份'])
  })
});

export const KOC_FIRST_FRAME_POLICIES = Object.freeze(['none', 'all_segments', 'selected_segments']);

const CHOICE_TRIGGERS = ['一比一', '1:1', '复刻', '视频复现', '镜头还原'];
const EXPLICIT_DEPTH = ['深度图', '深度视频', '单目深度', 'depth map', 'depth video'];
const EXPLICIT_MODELING = ['建模', 'blender', '白模', '灰模', '强控制', '三维代理'];
const EXPLICIT_STORYBOARD = ['分镜图', '分镜宫格', 'storyboard'];
const EXPLICIT_KOC = ['koc复刻', 'koc 复刻', 'koc remake'];

function normalized(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('requestText must be a non-empty string');
  return value.trim().toLowerCase();
}

function includesAny(value, terms) {
  return terms.some(term => value.includes(term.toLowerCase()));
}

export const VISUAL_CONTROL_METHODS = METHODS;
export const REMAKE_CONTROL_MODES = REMAKE_MODES;

export function detectVisualControlChoice(requestText) {
  const request = normalized(requestText);
  if (includesAny(request, EXPLICIT_DEPTH) || includesAny(request, EXPLICIT_MODELING)
    || includesAny(request, EXPLICIT_STORYBOARD) || includesAny(request, EXPLICIT_KOC)) return false;
  return includesAny(request, CHOICE_TRIGGERS);
}

export function buildVisualControlChoiceQuestion() {
  return {
    status: 'awaiting_user_choice',
    question: '这次复刻要用哪种控制方式？分镜图 / 深度视频 / 原视频可组合；KOC 复刻是独立流程。',
    options: [
      { id: 'storyboard_control', label: '分镜图', description: '省钱地控制构图、景别、动作节点和切镜顺序。' },
      { id: 'depth_control', label: '深度视频', description: '重点控制动作、空间遮挡和连续运镜，不负责脸和商品细节。' },
      { id: 'native_source', label: '原视频', description: '把原片直接交给官方原生替换能力；单独使用时不需要反推提示词。' },
      { id: 'koc_remake', label: 'KOC 复刻', description: '抽取全部 A-roll、精确匿名整头、保留原声与 B-roll，再把通过审查的换脸片段回插原片。' }
    ],
    firstFrameChoice: {
      appliesTo: 'koc_remake',
      question: 'KOC 复刻是否需要首帧图？',
      options: [
        { id: 'none', label: '不需要（默认）', description: '多数片段只使用匿名 A-roll 与人物身份图。' },
        { id: 'all_segments', label: '每段都需要', description: '为每个 A-roll 包制作替换好人物的首帧。' },
        { id: 'selected_segments', label: '只做指定片段', description: 'Gate 2 锁定分段后，由用户点选确实需要首帧的片段。' }
      ]
    },
    multiple: true
  };
}

export function resolveRemakeControlModes(modes, { firstFramePolicy } = {}) {
  if (!Array.isArray(modes) || modes.length === 0) {
    throw new TypeError('modes must contain at least one remake control mode');
  }
  const selected = [...new Set(modes.map(item => typeof item === 'string' ? item.trim() : item))];
  if (selected.length !== modes.length) throw new TypeError('modes must not contain duplicates');
  for (const mode of selected) {
    if (!REMAKE_MODES[mode]) throw new TypeError('mode must be storyboard_control, depth_control, native_source, or koc_remake');
  }
  const canonical = Object.keys(REMAKE_MODES).filter(id => selected.includes(id));
  const kocSelected = canonical.includes('koc_remake');
  if (kocSelected && canonical.length !== 1) {
    throw new TypeError('koc_remake is an exclusive end-to-end route and cannot be combined with other control modes');
  }
  if (kocSelected && !KOC_FIRST_FRAME_POLICIES.includes(firstFramePolicy)) {
    throw new TypeError('koc_remake requires firstFramePolicy: none, all_segments, or selected_segments');
  }
  if (!kocSelected && firstFramePolicy !== undefined && firstFramePolicy !== null) {
    throw new TypeError('firstFramePolicy only applies to koc_remake');
  }
  const requiresReversePrompt = canonical.some(id => id !== 'native_source');
  return {
    selectedModes: canonical,
    requiresReversePrompt,
    promptPolicy: kocSelected
      ? 'koc_source_bound_identity_replacement'
      : requiresReversePrompt
        ? 'reverse_source_prompt_then_compile_with_asset_bindings'
        : 'native_source_replacement_instruction_only',
    firstFramePolicy: kocSelected ? firstFramePolicy : null,
    controls: canonical.map(id => ({ ...REMAKE_MODES[id], transfer: [...REMAKE_MODES[id].transfer], ignore: [...REMAKE_MODES[id].ignore] }))
  };
}

export function buildKocRemakeExecutionContract(firstFramePolicy) {
  if (!KOC_FIRST_FRAME_POLICIES.includes(firstFramePolicy)) {
    throw new TypeError('firstFramePolicy must be none, all_segments, or selected_segments');
  }
  return {
    schemaVersion: 1,
    kind: 'koc_remake_execution_contract',
    segmentPolicy: {
      include: 'speaking_lead_aroll_only',
      exclude: 'broll_never_generate',
      maxDurationSec: 15,
      boundaryRule: 'preserve_continuous_aroll_take_even_when_shorter_than_15_seconds'
    },
    controlPolicy: {
      allowedChange: 'head_identity_suppression_above_neck_only',
      forbiddenChanges: ['timeline', 'frame_count', 'crop', 'speed', 'freeze', 'subtitle', 'body', 'clothing', 'product', 'background', 'camera_motion', 'audio'],
      firstFramePolicy
    },
    preparationBarrier: [
      'source_aroll_inventory_locked',
      'source_aligned_segments_locked',
      'identity_reference_locked',
      'head_anonymization_audit_passed',
      'first_frame_policy_resolved'
    ],
    parallelStages: ['segment_prompt_compile', 'segment_asset_bind', 'segment_preflight_review', 'segment_canvas_prepare'],
    serialStages: ['source_inventory', 'final_reinsertion_audit', 'final_audio_and_delivery_verification'],
    agentTopology: {
      orchestrator: 'koc_remake_orchestrator',
      preparationAgents: ['source_fact_auditor', 'aroll_segmenter', 'head_anonymizer', 'first_frame_builder'],
      perSegmentSubagents: ['prompt_compiler', 'asset_binding_auditor', 'preflight_reviewer'],
      completionAgents: ['source_comparator', 'reinsertion_auditor']
    },
    reviewLanes: [
      'source_fidelity_and_timing',
      'identity_replacement_and_liveness',
      'delivery_completeness_and_authorization'
    ],
    memoryPolicy: {
      authority: 'project_artifacts_and_sha_bound_checkpoints',
      neverAuthority: 'conversation_summary_or_agent_recollection',
      perSegmentFields: ['sourceRange', 'sourceSha256', 'controlSha256', 'firstFrameSha256', 'promptFingerprintSha256', 'providerTaskId', 'usableSubranges', 'finalDisposition', 'rootCauseKeys']
    },
    generationPolicy: {
      defaultResolution: '480p',
      assistantMaySubmitByDefault: false,
      requiresCurrentNodeReadbackAndExplicitApproval: true
    }
  };
}

export function resolveVisualControlMethod(method) {
  if (typeof method !== 'string' || !METHODS[method.trim()]) throw new TypeError('method must be storyboard, depth, or modeling');
  const value = METHODS[method.trim()];
  return {
    method: value.id,
    label: value.label,
    controlAsset: value.controlAsset,
    replaceLegacyStoryboard: value.replaceLegacyStoryboard,
    routingRule: value.id === 'storyboard'
      ? 'use_storyboard_assets_only_when_storyboard_is_selected'
      : value.id === 'depth'
        ? 'replace_default_storyboard_with_monocular_depth_assets'
        : 'replace_storyboard_and_mannequin_with_modeling_control_assets'
  };
}
