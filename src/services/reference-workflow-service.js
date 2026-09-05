import { resolveReferenceWorkflow } from '../domain/reference-workflow.js';

const SOURCE_AUTHORITY_SIGNALS = [
  '一比一', '1:1', '复刻', '还原原视频', '照着原视频', '按原视频', '原视频基础上',
  '参考原视频做修改', '参考原视频的剧情', '参考原视频的节奏', '照原视频的剧情', '照原视频的节奏',
  '跟原视频一样', '和原视频一样', '原视频台词', '原片台词', '保留原片', '保留原视频'
];
const SOURCE_MODIFICATION_SIGNALS = [
  '替换产品', '替换人物', '替换台词', '替换场景',
  '把产品替换成', '产品替换成', '只替换成', '替换成我们的', '替换为我们的',
  '产品换成', '换成我们的', '只换产品', '只改产品', '换掉原产品'
];
const INSPIRATION_SIGNALS = [
  '只参考风格', '仅参考风格', '只参考氛围', '仅参考氛围', '只参考创意', '仅参考创意',
  '风格参考', '氛围参考', '灵感参考', '只借鉴', '不需要复刻', '不用复刻'
];

function request(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('requestText must be a non-empty string');
  return value.trim().toLowerCase();
}

function includesAny(value, terms) {
  return terms.some(term => value.includes(term.toLowerCase()));
}

export function detectReferenceWorkflow({ requestText, sourceVideoIds = [], explicitIntent }) {
  const normalizedRequest = request(requestText);
  if (!Array.isArray(sourceVideoIds)) throw new TypeError('sourceVideoIds must be an array');
  sourceVideoIds.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') throw new TypeError(`sourceVideoIds[${index}] must be a non-empty string`);
  });
  if (new Set(sourceVideoIds).size !== sourceVideoIds.length) throw new TypeError('sourceVideoIds must not contain duplicates');
  if (explicitIntent) {
    return { status: 'routed', ...resolveReferenceWorkflow({ referenceIntent: explicitIntent, sourceVideoIds }) };
  }

  const hasSourceVideo = Array.isArray(sourceVideoIds) && sourceVideoIds.length > 0;
  const inspirationOnly = includesAny(normalizedRequest, INSPIRATION_SIGNALS);
  const authorityRequest = normalizedRequest.replaceAll('不需要复刻', '').replaceAll('不用复刻', '');
  const sourceModification = hasSourceVideo && includesAny(normalizedRequest, SOURCE_MODIFICATION_SIGNALS);
  const sourceIsAuthority = includesAny(authorityRequest, SOURCE_AUTHORITY_SIGNALS) || sourceModification;

  if (hasSourceVideo && inspirationOnly && sourceIsAuthority) {
    return {
      status: 'awaiting_reference_role',
      workflowRoute: null,
      question: '你的要求同时包含“不复刻”和“按原片保留或修改”。请明确：原视频是事实权威，还是只提供风格与灵感？'
    };
  }

  if (hasSourceVideo && inspirationOnly) {
    return { status: 'routed', ...resolveReferenceWorkflow({ referenceIntent: 'inspiration_only', sourceVideoIds }) };
  }
  if (hasSourceVideo && sourceIsAuthority) {
    const referenceIntent = sourceModification || normalizedRequest.includes('修改') || normalizedRequest.includes('基础上')
      ? 'source_modification'
      : 'faithful_remake';
    return { status: 'routed', ...resolveReferenceWorkflow({ referenceIntent, sourceVideoIds }) };
  }
  if (!hasSourceVideo && sourceIsAuthority) {
    return {
      status: 'awaiting_source_video',
      workflowRoute: null,
      question: '你要求按原视频复刻或修改，但当前没有已绑定的原视频。请先提供或指定原视频。'
    };
  }
  if (hasSourceVideo) {
    return {
      status: 'awaiting_reference_role',
      workflowRoute: null,
      question: '这条原视频是事实权威（需要复刻/在原片上修改），还是只提供风格与灵感参考？'
    };
  }

  return { status: 'routed', ...resolveReferenceWorkflow({ referenceIntent: 'idea_only', sourceVideoIds: [] }) };
}
