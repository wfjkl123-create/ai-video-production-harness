// Shot narration ("讲戏本") domain: structure validation + deterministic machine lint.
// Design source: docs/superpowers/specs/2026-07-21-shot-narration-director-gate-design.md
// Machine lint is intentionally LENIENT ("初版从宽"): it only blocks structural gaps and
// pure-emotion-without-action entries. Full craft/semantic judgement stays with the human reviewer.
import { assertShotPerformanceRouting, lintEmotionPerformancePlan } from './emotion-performance.js';
import { assertDirectorNarrationShot, assertSpatialContract } from './director-narration.js';
import { assertAuthorityBinding } from './realism-authority.js';
import { AUDIO_STRATEGIES } from './audio-execution-plan.js';

// 情绪形容词黑名单（初版从宽：仅在"整条只有情绪词、无任何动作动词"时判失败）。
const EMOTION_WORDS = Object.freeze([
  '难过', '悲伤', '开心', '高兴', '快乐', '疲惫', '紧张', '欣慰', '生气', '愤怒',
  '害怕', '恐惧', '焦虑', '兴奋', '失望', '绝望', '喜悦', '忧郁', '烦躁', '平静',
  '感动', '尴尬', '骄傲', '羞愧', '委屈', '幸福', '痛苦'
]);

// 方位词表（供 lightSources 的方位校验；初版从宽：缺方位只警告不阻断，见 lintShotNarration）。
const DIRECTION_WORDS = Object.freeze([
  '左', '右', '前', '后', '上', '下', '侧', '顶', '底', '背', '正面', '侧面', '斜'
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function text(value, field) {
  if (!isNonEmptyString(value)) throw new TypeError(`${field} must be a non-empty string`);
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  value.forEach((entry, index) => text(entry, `${field}[${index}]`));
}

const CLOCK_LIKE_PERFORMANCE = /(?:every|每隔|每)\s*\d+(?:\.\d+)?\s*(?:s|sec|second|秒|帧)|\d+(?:\.\d+)?\s*(?:s|sec|second|秒|帧)\s*(?:一次|眨眼|blink)/i;

function assertShotAuthorityAdaptation(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  if (value.version !== 1) throw new TypeError(`${field}.version must be 1`);
  if (!Array.isArray(value.characters) || value.characters.length === 0) throw new TypeError(`${field}.characters must be non-empty`);
  const characterIds = new Set();
  for (const [index, character] of value.characters.entries()) {
    const itemField = `${field}.characters[${index}]`;
    if (!character || typeof character !== 'object' || Array.isArray(character)) throw new TypeError(`${itemField} must be an object`);
    text(character.characterId, `${itemField}.characterId`);
    if (characterIds.has(character.characterId)) throw new TypeError(`${field} must not repeat characterId ${character.characterId}`);
    characterIds.add(character.characterId);
    assertAuthorityBinding(character.actingMasterBinding, `${itemField}.actingMasterBinding`);
    if (character.identityPackBinding !== undefined) assertAuthorityBinding(character.identityPackBinding, `${itemField}.identityPackBinding`);
    if (character.storyStateBinding !== undefined) assertAuthorityBinding(character.storyStateBinding, `${itemField}.storyStateBinding`);
    if (character.voiceIdentityBinding !== undefined) assertAuthorityBinding(character.voiceIdentityBinding, `${itemField}.voiceIdentityBinding`);
    if (!Array.isArray(character.selectedMasterCues) || character.selectedMasterCues.length === 0 || character.selectedMasterCues.length > 3) {
      throw new TypeError(`${itemField}.selectedMasterCues must contain 1 to 3 causally selected cues`);
    }
    for (const [cueIndex, cue] of character.selectedMasterCues.entries()) {
      const cueField = `${itemField}.selectedMasterCues[${cueIndex}]`;
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) throw new TypeError(`${cueField} must be an object`);
      for (const cueName of ['masterCueId', 'masterCue', 'triggerInShot', 'cameraVisibleAction']) text(cue[cueName], `${cueField}.${cueName}`);
      if (CLOCK_LIKE_PERFORMANCE.test(`${cue.triggerInShot} ${cue.cameraVisibleAction}`)) {
        throw new Error(`${cueField} must be causally triggered, not a fixed-frequency animation schedule`);
      }
    }
    if (character.voiceIdentityBinding !== undefined) {
      if (!character.voiceStateDelta || typeof character.voiceStateDelta !== 'object' || Array.isArray(character.voiceStateDelta)) {
        throw new TypeError(`${itemField}.voiceStateDelta is required when voiceIdentityBinding is present`);
      }
      for (const name of ['voiceDeltaId', 'triggerInShot', 'audibleChange', 'stableCore']) {
        text(character.voiceStateDelta[name], `${itemField}.voiceStateDelta.${name}`);
      }
    } else if (character.voiceStateDelta !== undefined) {
      throw new TypeError(`${itemField}.voiceStateDelta requires voiceIdentityBinding`);
    }
    for (const name of ['activeStillness', 'gazeTarget', 'breathVoice', 'endCarry']) text(character[name], `${itemField}.${name}`);
  }
  if (!value.sceneGeometry || !['required', 'not_applicable'].includes(value.sceneGeometry.applicability)) {
    throw new TypeError(`${field}.sceneGeometry must declare required or not_applicable`);
  }
  if (value.sceneGeometry.applicability === 'required') {
    assertAuthorityBinding(value.sceneGeometry.binding, `${field}.sceneGeometry.binding`);
    if (value.sceneGeometry.directorLabel !== '1/4') throw new TypeError(`${field}.sceneGeometry.directorLabel must be 1/4`);
    text(value.sceneGeometry.visibleGeometry, `${field}.sceneGeometry.visibleGeometry`);
  } else {
    text(value.sceneGeometry.reason, `${field}.sceneGeometry.reason`);
    if (value.sceneGeometry.binding !== undefined) throw new TypeError(`${field}.sceneGeometry not_applicable must not bind an artifact`);
  }
  if (!value.audioStrategy || !AUDIO_STRATEGIES.includes(value.audioStrategy.strategy)) throw new TypeError(`${field}.audioStrategy.strategy is invalid`);
  if (typeof value.audioStrategy.generateAudio !== 'boolean') throw new TypeError(`${field}.audioStrategy.generateAudio must be boolean`);
  return value;
}

export function assertShotNarration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('shot narration must be an object');
  for (const field of ['id', 'segmentId', 'sourceSegmentId']) text(value[field], field);
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError('revision must be a positive integer');
  if (!['draft', 'awaiting_review', 'locked', 'rejected', 'rework', 'blocked'].includes(value.status)) {
    throw new TypeError('status must be a valid artifact status');
  }
  if (!Array.isArray(value.shots) || value.shots.length === 0) throw new TypeError('shots must be a non-empty array');
  const shotIds = new Set();
  for (const shot of value.shots) {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) throw new TypeError('each shot must be an object');
    text(shot.shotId, 'shot.shotId');
    if (shotIds.has(shot.shotId)) throw new TypeError(`duplicate shotId: ${shot.shotId}`);
    shotIds.add(shot.shotId);
    stringArray(shot.physicalActions, `shot ${shot.shotId} physicalActions`);
    text(shot.cameraMove, `shot ${shot.shotId} cameraMove`);
    stringArray(shot.lightSources, `shot ${shot.shotId} lightSources`);
    text(shot.emotionThroughAction, `shot ${shot.shotId} emotionThroughAction`);
    if (shot.authorityAdaptation !== undefined) assertShotAuthorityAdaptation(shot.authorityAdaptation, `shot ${shot.shotId}.authorityAdaptation`);
    assertShotPerformanceRouting(shot);
    assertDirectorNarrationShot(shot);
  }
  return value;
}

// 判断一条文本是否"含具体动作"（启发式，从宽）：只要包含常见动作动词或身体部位动词短语即算通过。
// 我们不追求语言学精确，只拦截"整条都是情绪形容词、一个动作都没有"的明显违纪条目。
function looksLikeAction(entryText) {
  const trimmed = entryText.trim();
  // 含有情绪词，且去掉情绪词后基本没剩下具体内容 → 视为"纯情绪无动作"。
  const hasEmotion = EMOTION_WORDS.some(word => trimmed.includes(word));
  if (!hasEmotion) return true; // 不含情绪词的条目一律放行（从宽）。
  // 含情绪词时，要求同一条里还出现具体身体部位/动作线索，否则判为纯情绪。
  const ACTION_HINTS = [
    '手', '指', '臂', '肩', '头', '脸', '眼', '眉', '嘴', '唇', '颈', '腿', '脚', '膝', '腰', '胸', '背', '身',
    '走', '跑', '转', '抬', '压', '握', '推', '拉', '揉', '按', '扶', '靠', '低', '仰', '俯', '迈', '踏', '蹲',
    '起', '坐', '站', '躺', '拿', '放', '举', '甩', '晃', '颤', '呼', '吸', '咽', '眨', '睁', '闭', '皱', '牵', '扯', '捂', '摸'
  ];
  return ACTION_HINTS.some(hint => trimmed.includes(hint));
}

// 确定性机审（narration-lint）。从宽策略：
// - errors（阻断）：结构层已由 assertShotNarration 保证；这里再挡"物理动作纯情绪无动作"。
// - warnings（不阻断）：光源缺方位词等，仅提示，交人审判断。
// options.segmentShotIds：若对应锁定 segment 声明了 shotIds，则校验讲戏本 shotId 为其子集。
export function lintShotNarration(narration, options = {}) {
  assertShotNarration(narration);
  const errors = [];
  const warnings = [];

  const segmentShotIds = options.segmentShotIds;
  if (Array.isArray(segmentShotIds) && segmentShotIds.length > 0) {
    const allowed = new Set(segmentShotIds);
    for (const shot of narration.shots) {
      if (!allowed.has(shot.shotId)) errors.push(`shotId ${shot.shotId} is not in the locked segment shot set`);
    }
  }

  for (const shot of narration.shots) {
    const pureEmotion = shot.physicalActions.filter(entry => !looksLikeAction(entry));
    for (const entry of pureEmotion) {
      errors.push(`shot ${shot.shotId}: physicalAction is emotion-only without a concrete action: "${entry}"`);
    }
    const hasDirection = shot.lightSources.some(src => DIRECTION_WORDS.some(word => src.includes(word)));
    if (!hasDirection) warnings.push(`shot ${shot.shotId}: lightSources has no explicit direction word (review manually)`);
    if (!looksLikeAction(shot.emotionThroughAction)) {
      warnings.push(`shot ${shot.shotId}: emotionThroughAction reads as emotion words without a concrete body/action cue`);
    }
    if (shot.performanceMode === 'emotion_dlc') {
      const performance = lintEmotionPerformancePlan(shot.performancePlan, {
        requireActingControlV2: options.requireActingControlV2 === true
      });
      errors.push(...performance.errors.map(error => `shot ${shot.shotId}: ${error}`));
      warnings.push(...performance.warnings.map(warning => `shot ${shot.shotId}: ${warning}`));
    }
    if (options.requireRealismAuthorityV2 === true
      && (shot.performanceMode === 'emotion_dlc' || shot.realismPlan || shot.interactionPlan)
      && !shot.authorityAdaptation) {
      errors.push(`shot ${shot.shotId}: realism contracts v2 require authorityAdaptation before prompt authoring`);
    }
    if (shot.interactionPlan && !shot.spatialContract) {
      warnings.push(`shot ${shot.shotId}: interactionPlan has no spatialContract; relationship and eyeline shots need first-frame and blocking evidence before final compilation`);
    }
    if (shot.spatialContract) {
      assertSpatialContract(shot.spatialContract, `shot ${shot.shotId}.spatialContract`);
    }
  }

  return { passed: errors.length === 0, errors, warnings };
}

export const NARRATION_EMOTION_WORDS = EMOTION_WORDS;
export const NARRATION_DIRECTION_WORDS = DIRECTION_WORDS;

export function shotAuthorityBindings(narration) {
  assertShotNarration(narration);
  const bindings = [];
  const add = (binding, expectedType, characterId = null) => {
    if (!binding) return;
    bindings.push({ ...structuredClone(binding), expectedType, ...(characterId ? { characterId } : {}) });
  };
  for (const shot of narration.shots) {
    for (const character of shot.authorityAdaptation?.characters ?? []) {
      add(character.identityPackBinding, 'project_asset', character.characterId);
      add(character.actingMasterBinding, 'character_acting_master', character.characterId);
      add(character.storyStateBinding, 'character_story_state', character.characterId);
      add(character.voiceIdentityBinding, 'voice_identity', character.characterId);
    }
    if (shot.authorityAdaptation?.sceneGeometry?.applicability === 'required') {
      add(shot.authorityAdaptation.sceneGeometry.binding, 'scene_geometry');
    }
  }
  return bindings;
}
