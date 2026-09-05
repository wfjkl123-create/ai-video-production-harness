export const INGRESS_POLICY_VERSION = 'ingress-route-v1';

const REQUEST_KINDS = new Set([
  'question_answering',
  'research',
  'explanation',
  'video_creation',
  'video_generation',
  'other'
]);
const INFORMATIONAL_KINDS = new Set(['question_answering', 'research', 'explanation']);
const VIDEO_KINDS = new Set(['video_creation', 'video_generation']);
const REFERENCE_INTENTS = new Set([
  'idea_only',
  'inspiration_only',
  'faithful_remake',
  'source_modification'
]);
const EXECUTION_CLASSES = new Set(['creative_production', 'mechanical_asset_prompt']);

const EXPLICIT_OPT_OUT = [
  /(?:明确)?不走\s*harness/i,
  /不要(?:进入|使用|走)\s*harness/i,
  /不用\s*harness/i,
  /绕过\s*harness/i
];
const INFORMATIONAL_SIGNALS = [
  /(?:只|仅)(?:需要)?(?:解释|分析|研究|总结|翻译|评估|审查|检查)/,
  /^(?:不要|无需)(?:创作|制作|生成|改写)(?:任何)?(?:图片|视频|内容)?[。！？.!?\s]*$/,
  /(?:研究|调研|解释)(?:一下|下)?(?:这个|该|这条|这个视频|ai\s*视频)/i,
  /(?:普通问答|纯研究|单独解释)/
];
const VIDEO_CREATION_SIGNALS = [
  /(?:生成|制作|创作|做)(?:一条|一个|个|这条|该条)?[^，。！？\n]{0,24}(?:ai\s*)?视频/i,
  /(?:ai\s*视频|视频)(?:生成|制作|创作)/i,
  /(?:文生视频|图生视频|视频生视频|ai\s*生成视频)/i
];
const INSPIRATION_SIGNALS = [
  /(?:只|仅)(?:提供|作为|用作)?(?:风格|氛围|创意|灵感)(?:参考|灵感)?/,
  /(?:风格|氛围|创意|灵感)参考/,
  /(?:不需要|不用|不要)复刻/
];
const AUTHORITY_SIGNALS = [
  /(?:一比一|1\s*:\s*1|复刻|还原原视频|照着原视频|按原视频|跟原视频一样|和原视频一样)/i,
  /(?:原视频|原片)(?:的)?(?:剧情|节奏|台词|动作|镜头|构图)/,
  /(?:保留原片|保留原视频|在原视频基础上|替换产品|替换人物|替换台词|替换场景)/
];
const SOURCE_WORKFLOW_SIGNALS = [
  /(?:一比一|1\s*:\s*1|复刻|还原原视频|照着原视频|按原视频|跟原视频一样|和原视频一样)/i,
  /(?:原视频|原片)(?:的)?(?:剧情|节奏|台词|动作|镜头|构图|基础上)/
];
const MECHANICAL_SCOPE_SIGNALS = [
  /(?:只|仅)(?:需要|做)?[^，。！？\n]{0,40}(?:切分|切片|分段|裁剪)/,
  /(?:简单|机械)(?:任务|处理|复刻)/,
  /不要(?:想得|搞得|弄得)?太复杂/,
  /(?:无需|不需要)审核/
];
const MECHANICAL_ASSET_SIGNALS = [/(?:切分|切片|分段|裁剪)/, /(?:上传|绑定|配上|连同)[^，。！？\n]{0,24}(?:图片|产品图|素材)/];
const MECHANICAL_PROMPT_SIGNALS = [/(?:撰写|编写|写好|写)(?:每段|对应)?提示词/, /提示词/];
const MECHANICAL_REPLACEMENT_SIGNALS = [/(?:替换|换掉)[^，。！？\n]{0,20}(?:产品|商品)/, /(?:产品|商品)[^，。！？\n]{0,20}(?:替换|换成)/];
const CREATIVE_COMPLEXITY_SIGNALS = [/(?:创作|设计|改写)(?:剧情|故事|角色|人物|分镜|镜头)/, /(?:反转|人物关系|情绪弧|原创短剧|建模|深度控制|一比一|1\s*:\s*1)/i];

function nonEmptyText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeRequestText(value) {
  return nonEmptyText(value, 'requestText');
}

function normalizeRequestKind(value) {
  if (value === undefined) return undefined;
  if (!REQUEST_KINDS.has(value)) {
    throw new TypeError('requestKind must be question_answering, research, explanation, video_creation, video_generation, or other');
  }
  return value;
}

function normalizeReferenceIntent(value) {
  if (value === undefined) return undefined;
  if (!REFERENCE_INTENTS.has(value)) {
    throw new TypeError('explicitReferenceIntent must be idea_only, inspiration_only, faithful_remake, or source_modification');
  }
  return value;
}

function normalizeExecutionClass(value) {
  if (value === undefined) return undefined;
  if (!EXECUTION_CLASSES.has(value)) {
    throw new TypeError('explicitExecutionClass must be creative_production or mechanical_asset_prompt');
  }
  return value;
}

function mechanicalAssetPromptIntent({ requestText, inputTypes, referenceStatus, explicitExecutionClass }) {
  const eligibleInputs = inputTypes.includes('video') && inputTypes.includes('image') && referenceStatus === 'authority';
  if (explicitExecutionClass === 'mechanical_asset_prompt') {
    if (!eligibleInputs) throw new TypeError('mechanical_asset_prompt requires an authority source video and an existing image asset');
    return true;
  }
  if (explicitExecutionClass === 'creative_production' || !eligibleInputs) return false;
  return matchesAny(requestText, MECHANICAL_SCOPE_SIGNALS)
    && MECHANICAL_ASSET_SIGNALS.every(expressions => expressions.test(requestText))
    && matchesAny(requestText, MECHANICAL_PROMPT_SIGNALS)
    && matchesAny(requestText, MECHANICAL_REPLACEMENT_SIGNALS)
    && !matchesAny(requestText, CREATIVE_COMPLEXITY_SIGNALS);
}

function inputType(mimeType) {
  const topLevel = mimeType.split('/', 1)[0].toLowerCase();
  return ['video', 'image', 'audio', 'text'].includes(topLevel) ? topLevel : 'binary';
}

function optionalMechanicalImageMetadata(input, index, mimeType) {
  if (!mimeType.toLowerCase().startsWith('image/')) return {};
  if (input.assetType === undefined && input.characterId === undefined) return {};
  if (input.assetType !== 'character_identity_single_view') {
    throw new TypeError(`inputs[${index}].assetType must be character_identity_single_view when mechanical image metadata is provided`);
  }
  if (input.characterId !== undefined && (typeof input.characterId !== 'string' || input.characterId.trim() === '')) {
    throw new TypeError(`inputs[${index}].characterId must be a non-empty string when provided`);
  }
  return {
    assetType: input.assetType,
    ...(input.characterId === undefined ? {} : { characterId: input.characterId.trim() })
  };
}

export function normalizeIngressInputs(value = []) {
  if (!Array.isArray(value)) throw new TypeError('inputs must be an array of explicit descriptors');
  const ids = new Set();
  return value.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError(`inputs[${index}] must be an object descriptor`);
    }
    const id = nonEmptyText(input.id, `inputs[${index}].id`);
    const mimeType = nonEmptyText(input.mimeType, `inputs[${index}].mimeType`).toLowerCase();
    const path = nonEmptyText(input.path, `inputs[${index}].path`);
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)) {
      throw new TypeError(`inputs[${index}].mimeType must be a valid MIME type`);
    }
    if (ids.has(id)) throw new TypeError('input descriptor IDs must be unique');
    ids.add(id);
    return Object.freeze({ id, mimeType, path, inputType: inputType(mimeType), ...optionalMechanicalImageMetadata(input, index, mimeType) });
  });
}

function matchesAny(value, expressions) {
  return expressions.some(expression => expression.test(value));
}

function explicitOptOut({ requestText, explicitOptOut }) {
  if (explicitOptOut !== undefined && typeof explicitOptOut !== 'boolean') {
    throw new TypeError('explicitOptOut must be a boolean');
  }
  return explicitOptOut === true || matchesAny(requestText, EXPLICIT_OPT_OUT);
}

function informationalIntent({ requestText, requestKind }) {
  return INFORMATIONAL_KINDS.has(requestKind) || matchesAny(requestText, INFORMATIONAL_SIGNALS);
}

function videoCreationIntent({ requestText, requestKind }) {
  return VIDEO_KINDS.has(requestKind) || matchesAny(requestText, VIDEO_CREATION_SIGNALS);
}

function referenceRoleStatus({ requestText, sourceVideoIds, explicitReferenceIntent }) {
  if (sourceVideoIds.length === 0) return 'not_applicable';
  if (explicitReferenceIntent === 'idea_only') {
    throw new TypeError('idea_only cannot bind video input; use inspiration_only or omit explicitReferenceIntent');
  }
  if (explicitReferenceIntent === 'inspiration_only') return 'inspiration';
  if (explicitReferenceIntent === 'faithful_remake' || explicitReferenceIntent === 'source_modification') return 'authority';

  const inspiration = matchesAny(requestText, INSPIRATION_SIGNALS);
  const authorityText = requestText.replaceAll('不需要复刻', '').replaceAll('不用复刻', '').replaceAll('不要复刻', '');
  const authority = matchesAny(authorityText, AUTHORITY_SIGNALS);
  if (inspiration && !authority) return 'inspiration';
  if (authority && !inspiration) return 'authority';
  return 'awaiting_reference_role';
}

export function decideIngressRoute({
  requestText,
  inputs = [],
  explicitOptOut: optOut,
  requestKind: inputRequestKind,
  explicitReferenceIntent: inputReferenceIntent,
  explicitExecutionClass: inputExecutionClass
}) {
  const normalizedRequest = normalizeRequestText(requestText);
  const requestKind = normalizeRequestKind(inputRequestKind);
  const explicitReferenceIntent = normalizeReferenceIntent(inputReferenceIntent);
  const explicitExecutionClass = normalizeExecutionClass(inputExecutionClass);
  const normalizedInputs = normalizeIngressInputs(inputs);
  const sourceVideoIds = normalizedInputs.filter(input => input.inputType === 'video').map(input => input.id);
  const inputTypes = [...new Set(normalizedInputs.map(input => input.inputType))];
  const optedOut = explicitOptOut({ requestText: normalizedRequest, explicitOptOut: optOut });
  const informational = informationalIntent({ requestText: normalizedRequest, requestKind });
  const declaresReferenceWorkflow = explicitReferenceIntent !== undefined && explicitReferenceIntent !== 'idea_only';
  const createsVideo = videoCreationIntent({ requestText: normalizedRequest, requestKind })
    || declaresReferenceWorkflow
    || matchesAny(normalizedRequest, SOURCE_WORKFLOW_SIGNALS);

  let harnessRequired;
  let reason;
  if (optedOut) {
    harnessRequired = false;
    reason = 'explicit_opt_out';
  } else if (informational) {
    harnessRequired = false;
    reason = 'informational_intent';
  } else if (sourceVideoIds.length > 0) {
    harnessRequired = true;
    reason = createsVideo ? 'video_input_and_creation_intent' : 'video_input';
  } else if (createsVideo) {
    harnessRequired = true;
    reason = 'video_creation_intent';
  } else {
    harnessRequired = false;
    reason = 'non_video_request';
  }

  const resolvedReferenceRoleStatus = harnessRequired
    ? referenceRoleStatus({ requestText: normalizedRequest, sourceVideoIds, explicitReferenceIntent })
    : 'not_applicable';
  const executionClass = harnessRequired && mechanicalAssetPromptIntent({
    requestText: normalizedRequest,
    inputTypes,
    referenceStatus: resolvedReferenceRoleStatus,
    explicitExecutionClass
  }) ? 'mechanical_asset_prompt' : harnessRequired ? 'creative_production' : 'bypass';

  return Object.freeze({
    policyVersion: INGRESS_POLICY_VERSION,
    harnessRequired,
    reason,
    inputTypes,
    sourceVideoIds,
    assetInputIds: normalizedInputs.filter(input => input.inputType === 'image').map(input => input.id),
    referenceRoleStatus: resolvedReferenceRoleStatus,
    executionClass
  });
}
