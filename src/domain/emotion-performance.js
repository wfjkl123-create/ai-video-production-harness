const DLC_ID = 'emotion-performance-v1';
const TEMPLATE_SOURCE = 'knowledge/capabilities/dlc/emotion-performance.md';
const MODES = new Set(['none', 'basic', 'emotion_dlc']);
const REGISTERS = new Set(['restrained_realism', 'grounded_realism', 'heightened_drama', 'stylized_deadpan']);
const INTENSITIES = new Set(['micro', 'restrained', 'clear', 'explosive']);
const TRACKS = new Set(['eyes', 'face', 'head_shoulders', 'hands', 'body', 'breath_voice']);
const REQUIRED_SKILLS = Object.freeze(['seedance2-prompt', 'seedance-characters']);
const ACTING_CONTROL_VERSION = 2;
const STRONG_DIALOGUE_SIGNAL = /(说完|开口|回答|反问|喊|问道|说出|念出|低声道|耳语|脱口而出|吟唱|口型|台词原文|对白)/u;
const QUOTED_DIALOGUE_SIGNAL = /(?:说|讲|道|喊|问|答|念|唱|吟唱|低语|耳语|says?|asks?|answers?|whispers?|shouts?|speaks?|tells?)[^“”"'\n]{0,12}[“"'][^”"'\n]+[”"']/iu;
const FACS_AU_HINT = /^AU\s*\d{1,2}(?:[A-E])?$/u;

const ABSTRACT_EMOTIONS = Object.freeze([
  '开心', '高兴', '悲伤', '难过', '愤怒', '生气', '害怕', '恐惧', '绝望', '失望', '委屈', '尴尬',
  '疲惫', '欣慰', '兴奋', '焦虑', '平静', '感动', '幸福', '痛苦', '冷漠', '紧张'
]);

const OBSERVABLE_PARTS = Object.freeze([
  '眼', '视线', '目光', '眉', '嘴', '唇', '下颌', '喉', '呼吸', '鼻息', '肩', '头', '颈', '胸',
  '背', '手', '指', '臂', '腿', '脚', '膝', '腰', '身体', '重心', '衣', '发', '泪', '声音', '声线',
  '门', '窗', '杯', '钥匙', '手机', '道具', '票据', '纸样', '步', '位置', '距离'
]);

const OBSERVABLE_CHANGES = Object.freeze([
  '看', '眨', '抬', '低', '转', '移', '停', '收', '松', '紧', '握', '推', '拉', '拿', '放', '落',
  '靠', '退', '迈', '站', '坐', '起', '走', '吞咽', '颤', '笑', '哭', '响', '震动', '碰', '摩擦',
  '定住', '下沉', '绷', '皱', '张开', '闭合', '湿润', '发抖', '停顿', '短吸', '呼出', '压低',
  '保持', '维持', '继续', '接', '回稳', '恢复', '转移'
]);

const OFFSET_HINTS = Object.freeze(['松', '收', '移', '回稳', '恢复', '转移', '继续', '落', '放', '停留', '留下']);

function line(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  if (/\r|\n/.test(value)) throw new TypeError(`${field} must stay on one line`);
}

function lines(value, field, { min = 1, max = Infinity } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(`${field} must contain ${min}-${max === Infinity ? 'many' : max} entries`);
  }
  value.forEach((entry, index) => line(entry, `${field}[${index}]`));
}

function looksObservable(value) {
  const hasAbstractEmotion = ABSTRACT_EMOTIONS.some(word => value.includes(word));
  if (!hasAbstractEmotion) return true;
  const hasVisiblePart = OBSERVABLE_PARTS.some(word => value.includes(word));
  const hasVisibleChange = OBSERVABLE_CHANGES.some(word => value.includes(word));
  return hasVisiblePart && hasVisibleChange;
}

function looksLikeVisibleChange(value) {
  return OBSERVABLE_PARTS.some(word => value.includes(word))
    && OBSERVABLE_CHANGES.some(word => value.includes(word));
}

function normalizedDialogue(value) {
  return value.replace(/[\s“”"'，。！？、；：,.!?;:]/gu, '');
}

function assertBeatPlan(plan, field = 'performancePlan.beatPlan') {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 3) throw new TypeError(`${field} must contain 1-3 beats`);
  for (const [index, beat] of plan.entries()) {
    if (!beat || typeof beat !== 'object' || Array.isArray(beat)) throw new TypeError(`${field}[${index}] must be an object`);
    line(beat.tactic, `${field}[${index}].tactic`);
    line(beat.visibleChange, `${field}[${index}].visibleChange`);
  }
  return plan;
}

function assertPerformanceArc(arc, field = 'performancePlan.performanceArc') {
  if (!arc || typeof arc !== 'object' || Array.isArray(arc)) throw new TypeError(`${field} must be an object`);
  for (const name of ['protectiveStrategy', 'fractureTrigger', 'exposedState', 'chosenAction', 'externalFeedback', 'recoveryState']) line(arc[name], `${field}.${name}`);
}

function assertDialoguePerformance(entries, field = 'performancePlan.dialoguePerformance') {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 6) throw new TypeError(`${field} must contain 1-6 entries`);
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${field}[${index}] must be an object`);
    for (const name of ['speaker', 'respondingCharacter', 'lineText', 'triggerCue', 'stressPhrase', 'preSpeechState', 'visibleResponse', 'voiceBreathPause', 'postSpeechState']) {
      line(entry[name], `${field}[${index}].${name}`);
    }
    if (entry.speaker === entry.respondingCharacter) throw new TypeError(`${field}[${index}].respondingCharacter must differ from speaker`);
    if (!normalizedDialogue(entry.lineText).includes(normalizedDialogue(entry.stressPhrase))) {
      throw new TypeError(`${field}[${index}].stressPhrase must occur in lineText`);
    }
  }
}

function assertPerformanceEnvelope(envelope, field = 'performancePlan.performanceEnvelope') {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError(`${field} must be an object`);
  for (const name of ['onset', 'apex', 'offset']) line(envelope[name], `${field}.${name}`);
}

function assertFacialCalibration(calibration, field = 'performancePlan.facialCalibration') {
  if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) throw new TypeError(`${field} must be an object`);
  line(calibration.observableAction, `${field}.observableAction`);
  if (calibration.facsAuHints !== undefined) {
    lines(calibration.facsAuHints, `${field}.facsAuHints`, { min: 1, max: 6 });
    for (const hint of calibration.facsAuHints) {
      if (!FACS_AU_HINT.test(hint)) throw new TypeError(`${field}.facsAuHints must use AU plus a one- or two-digit code`);
    }
  }
}

function assertProhibitedEarlyReactions(entries, field = 'performancePlan.prohibitedEarlyReactions') {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 4) throw new TypeError(`${field} must contain 1-4 entries`);
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${field}[${index}] must be an object`);
    line(entry.respondingCharacter, `${field}[${index}].respondingCharacter`);
    line(entry.reaction, `${field}[${index}].reaction`);
    line(entry.stressPhrase, `${field}[${index}].stressPhrase`);
    line(entry.untilCue, `${field}[${index}].untilCue`);
  }
}

function hasV2Fields(plan) {
  return ['hasDialogue', 'performanceArc', 'dialoguePerformance', 'performanceEnvelope', 'facialCalibration', 'prohibitedEarlyReactions']
    .some(field => plan[field] !== undefined);
}

export function assertEmotionPerformancePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('performancePlan must be an object');
  if (plan.dlcId !== DLC_ID) throw new TypeError(`performancePlan.dlcId must be ${DLC_ID}`);
  if (plan.templateSource !== TEMPLATE_SOURCE) throw new TypeError(`performancePlan.templateSource must be ${TEMPLATE_SOURCE}`);
  for (const field of ['focusedCharacter', 'objective', 'subtext', 'trigger', 'startBehavior', 'primaryAction', 'voiceBreath', 'endBehavior']) {
    line(plan[field], `performancePlan.${field}`);
  }
  const hasPerformanceBeats = plan.obstacle !== undefined || plan.tactic !== undefined || plan.beatPlan !== undefined;
  if (hasPerformanceBeats) {
    for (const field of ['obstacle', 'tactic']) line(plan[field], `performancePlan.${field}`);
    assertBeatPlan(plan.beatPlan);
  }
  const isV2 = plan.actingControlVersion === ACTING_CONTROL_VERSION;
  if (plan.actingControlVersion !== undefined && !isV2) throw new TypeError(`performancePlan.actingControlVersion must be ${ACTING_CONTROL_VERSION}`);
  if (!isV2 && hasV2Fields(plan)) throw new TypeError(`performancePlan v2 fields require actingControlVersion ${ACTING_CONTROL_VERSION}`);
  if (isV2) {
    if (typeof plan.hasDialogue !== 'boolean') throw new TypeError('performancePlan.hasDialogue must be a boolean for actingControlVersion 2');
    for (const field of ['obstacle', 'tactic']) line(plan[field], `performancePlan.${field}`);
    assertBeatPlan(plan.beatPlan);
    assertPerformanceArc(plan.performanceArc);
    assertProhibitedEarlyReactions(plan.prohibitedEarlyReactions);
    if (plan.hasDialogue && plan.dialoguePerformance === undefined) throw new TypeError('performancePlan.dialoguePerformance is required when hasDialogue is true');
    if (!plan.hasDialogue && plan.dialoguePerformance !== undefined) throw new TypeError('performancePlan.dialoguePerformance requires hasDialogue true');
    if (!plan.hasDialogue && (STRONG_DIALOGUE_SIGNAL.test(plan.voiceBreath) || QUOTED_DIALOGUE_SIGNAL.test(plan.voiceBreath))) {
      throw new TypeError('performancePlan.hasDialogue cannot be false when voiceBreath contains dialogue signals');
    }
  }
  if (plan.dialoguePerformance !== undefined) assertDialoguePerformance(plan.dialoguePerformance);
  if (isV2 && plan.dialoguePerformance) {
    for (const [index, entry] of plan.dialoguePerformance.entries()) {
      if (!plan.prohibitedEarlyReactions.some(guard => guard.respondingCharacter === entry.respondingCharacter
        && normalizedDialogue(guard.stressPhrase) === normalizedDialogue(entry.stressPhrase))) {
        throw new TypeError(`performancePlan.dialoguePerformance[${index}] has no prohibitedEarlyReactions guard bound to respondingCharacter and stressPhrase`);
      }
    }
  }
  if (plan.performanceEnvelope !== undefined) assertPerformanceEnvelope(plan.performanceEnvelope);
  const needsEnvelope = plan.intensity === 'explosive'
    || (plan.intensity === 'clear'
      && (plan.dominantTrack === 'face' || plan.facialCalibration !== undefined));
  if (needsEnvelope && isV2 && plan.performanceEnvelope === undefined) {
    throw new TypeError('performancePlan.performanceEnvelope is required for v2 explosive or clear face-dominant acting');
  }
  if (plan.facialCalibration !== undefined) assertFacialCalibration(plan.facialCalibration);
  if (!REGISTERS.has(plan.performanceRegister)) throw new TypeError('performancePlan.performanceRegister is invalid');
  if (!INTENSITIES.has(plan.intensity)) throw new TypeError('performancePlan.intensity is invalid');
  if (!TRACKS.has(plan.dominantTrack)) throw new TypeError('performancePlan.dominantTrack is invalid');
  lines(plan.supportingCues, 'performancePlan.supportingCues', { min: 1, max: 2 });
  lines(plan.continuityCarry, 'performancePlan.continuityCarry', { min: 1, max: 3 });
  lines(plan.skillsApplied, 'performancePlan.skillsApplied', { min: 2, max: 6 });
  for (const skill of REQUIRED_SKILLS) {
    if (!plan.skillsApplied.includes(skill)) throw new TypeError(`performancePlan.skillsApplied must include ${skill}`);
  }
  if (new Set(plan.skillsApplied).size !== plan.skillsApplied.length) throw new TypeError('performancePlan.skillsApplied must be unique');
  if (!Array.isArray(plan.backgroundCharacters)) throw new TypeError('performancePlan.backgroundCharacters must be an array');
  const tags = new Set([plan.focusedCharacter]);
  for (const [index, character] of plan.backgroundCharacters.entries()) {
    if (!character || typeof character !== 'object' || Array.isArray(character)) throw new TypeError(`backgroundCharacters[${index}] must be an object`);
    line(character.characterTag, `backgroundCharacters[${index}].characterTag`);
    line(character.persistentMicroMotion, `backgroundCharacters[${index}].persistentMicroMotion`);
    if (tags.has(character.characterTag)) throw new TypeError(`duplicate performance character tag: ${character.characterTag}`);
    tags.add(character.characterTag);
  }
  return plan;
}

export function assertShotPerformanceRouting(shot) {
  if (shot.performanceMode === undefined && shot.performancePlan === undefined) return shot;
  if (!MODES.has(shot.performanceMode)) throw new TypeError('shot.performanceMode is invalid');
  if (shot.performanceMode === 'emotion_dlc') {
    assertEmotionPerformancePlan(shot.performancePlan);
  } else if (shot.performancePlan !== undefined) {
    throw new TypeError('performancePlan is allowed only when performanceMode is emotion_dlc');
  }
  return shot;
}

export function lintEmotionPerformancePlan(plan, options = {}) {
  assertEmotionPerformancePlan(plan);
  const errors = [];
  const warnings = [];
  for (const [field, value] of [
    ['trigger', plan.trigger], ['startBehavior', plan.startBehavior], ['primaryAction', plan.primaryAction],
    ['voiceBreath', plan.voiceBreath], ['endBehavior', plan.endBehavior],
    ...plan.supportingCues.map((value, index) => [`supportingCues[${index}]`, value]),
    ...plan.backgroundCharacters.map((value, index) => [`backgroundCharacters[${index}].persistentMicroMotion`, value.persistentMicroMotion])
  ]) {
    if (!looksObservable(value)) errors.push(`performancePlan.${field} is an abstract emotion without an observable cue`);
  }
  if (plan.intensity === 'explosive' && plan.backgroundCharacters.length > 0) {
    warnings.push('explosive focused performance with background characters is fragile; keep every background character on persistent micro-motion only');
  }
  if (plan.obstacle === undefined || plan.tactic === undefined || plan.beatPlan === undefined) {
    warnings.push('performancePlan is missing obstacle/tactic/beatPlan; new dialogue or emotional-turn shots should record a playable pressure-and-response chain');
  } else {
    for (const [index, beat] of plan.beatPlan.entries()) {
      if (!looksObservable(beat.visibleChange)) errors.push(`performancePlan.beatPlan[${index}].visibleChange is not camera-observable`);
    }
  }
  if (plan.actingControlVersion !== ACTING_CONTROL_VERSION) {
    const message = 'legacy emotion-performance-v1 plan is readable but current workflow writes must upgrade to actingControlVersion 2';
    if (options.requireActingControlV2) errors.push(message);
    else warnings.push(message);
  }
  if (plan.actingControlVersion === ACTING_CONTROL_VERSION) {
    for (const [field, value] of [
      ['performanceArc.exposedState', plan.performanceArc.exposedState],
      ['performanceArc.chosenAction', plan.performanceArc.chosenAction],
      ['performanceArc.externalFeedback', plan.performanceArc.externalFeedback],
      ['performanceArc.recoveryState', plan.performanceArc.recoveryState],
      ...(plan.dialoguePerformance ?? []).flatMap((entry, index) => [
        [`dialoguePerformance[${index}].preSpeechState`, entry.preSpeechState],
        [`dialoguePerformance[${index}].visibleResponse`, entry.visibleResponse],
        [`dialoguePerformance[${index}].postSpeechState`, entry.postSpeechState]
      ]),
      ...(plan.performanceEnvelope ? [
        ['performanceEnvelope.onset', plan.performanceEnvelope.onset],
        ['performanceEnvelope.apex', plan.performanceEnvelope.apex],
        ['performanceEnvelope.offset', plan.performanceEnvelope.offset]
      ] : []),
      ...(plan.facialCalibration ? [['facialCalibration.observableAction', plan.facialCalibration.observableAction]] : []),
      ...plan.prohibitedEarlyReactions.map((entry, index) => [`prohibitedEarlyReactions[${index}].reaction`, entry.reaction])
    ]) {
      if (!looksLikeVisibleChange(value)) errors.push(`performancePlan.${field} must name a visible body/object and a concrete change`);
    }
    if (plan.performanceEnvelope && !OFFSET_HINTS.some(word => plan.performanceEnvelope.offset.includes(word))) {
      errors.push('performancePlan.performanceEnvelope.offset must release, transfer, continue, or preserve the peak instead of freezing it');
    }
  }
  return { passed: errors.length === 0, errors, warnings };
}

const REGISTER_LABELS = Object.freeze({
  restrained_realism: '克制写实', grounded_realism: '生活化写实', heightened_drama: '有控制的强戏剧表演', stylized_deadpan: '风格化冷面表演'
});
const INTENSITY_LABELS = Object.freeze({ micro: '轻微', restrained: '克制', clear: '清晰但不过火', explosive: '单次爆发后必须收束' });
const TRACK_LABELS = Object.freeze({ eyes: '眼神', face: '面部', head_shoulders: '头肩', hands: '手部', body: '身体重心', breath_voice: '呼吸与声线' });

export function renderEmotionPerformanceCapsule(shot) {
  assertShotPerformanceRouting(shot);
  if (shot.performanceMode !== 'emotion_dlc') return '';
  const plan = shot.performancePlan;
  const background = plan.backgroundCharacters.length === 0
    ? '无；画面只保留焦点人物的表演。'
    : plan.backgroundCharacters.map(item => `${item.characterTag}：${item.persistentMicroMotion}`).join('；');
  const v2Lines = plan.actingControlVersion === ACTING_CONTROL_VERSION ? [
    `保护策略与裂缝：${plan.performanceArc.protectiveStrategy} → ${plan.performanceArc.fractureTrigger} → ${plan.performanceArc.exposedState} → ${plan.performanceArc.chosenAction} → ${plan.performanceArc.externalFeedback} → ${plan.performanceArc.recoveryState}`,
    ...(plan.dialoguePerformance ? [`对白表演时钟：${plan.dialoguePerformance.map((entry, index) => `${index + 1}.${entry.speaker}说“${entry.lineText}”｜反应人=${entry.respondingCharacter}｜触发=${entry.triggerCue}｜重音=${entry.stressPhrase}｜说前=${entry.preSpeechState}｜可见反应=${entry.visibleResponse}｜声音呼吸停顿=${entry.voiceBreathPause}｜说后=${entry.postSpeechState}`).join('；')}`] : []),
    ...(plan.performanceEnvelope ? [`表演包络：进入=${plan.performanceEnvelope.onset}｜峰值=${plan.performanceEnvelope.apex}｜退出=${plan.performanceEnvelope.offset}`] : []),
    ...(plan.facialCalibration ? [`面部内部校准：自然语言=${plan.facialCalibration.observableAction}${plan.facialCalibration.facsAuHints ? `｜AU审计线索=${plan.facialCalibration.facsAuHints.join('、')}` : ''}`] : []),
    `禁止提前反应：${plan.prohibitedEarlyReactions.map(item => `反应观察者=${item.respondingCharacter}；画内动作禁令=${item.reaction}（重音=${item.stressPhrase}；直到${item.untilCue}）`).join('；')}`
  ] : [];
  return [
    `【${DLC_ID}｜${shot.shotId}｜${plan.focusedCharacter}】`,
    `表演质感：${REGISTER_LABELS[plan.performanceRegister]}；强度：${INTENSITY_LABELS[plan.intensity]}；主导轨：${TRACK_LABELS[plan.dominantTrack]}。`,
    `触发：${plan.trigger}`,
    ...(plan.obstacle ? [`阻碍：${plan.obstacle}`, `策略：${plan.tactic}`, `可见节拍：${plan.beatPlan.map((beat, index) => `${index + 1}.${beat.tactic} → ${beat.visibleChange}`).join('；')}`] : []),
    ...v2Lines,
    `起始可见状态：${plan.startBehavior}`,
    `主表演动作：${plan.primaryAction}`,
    `辅助细节：${plan.supportingCues.join('；')}`,
    `呼吸与声线：${plan.voiceBreath}`,
    `结束状态：${plan.endBehavior}`,
    `连续保留：${plan.continuityCarry.join('；')}`,
    `其他人物：${background}`,
    '表演纪律：动作必须由触发引起；每个节拍只保留一个主动作和一到两个辅助细节；保留自然停顿、不对称或未完成动作；人物身份、五官、发型和服装保持不变；禁止无原因摆拍、标准表情包、多人同步大动作和机械重复。',
    `【/${DLC_ID}｜${shot.shotId}】`
  ].join('\n');
}

export function renderEmotionPerformanceCapsules(narration) {
  const capsules = (narration.shots ?? []).map(renderEmotionPerformanceCapsule).filter(Boolean);
  return capsules.join('\n\n');
}

const CONTINUITY_ID = 'performance-continuity-v1';

// The shot body prose already carries the performance as written by the director. Only the
// compact timing guard plus continuity contract are repeated to the model; register labels,
// subtext, AU calibration and full trigger chains stay archived as audit metadata.
export function renderEmotionPerformanceContinuity(shot) {
  assertShotPerformanceRouting(shot);
  if (shot.performanceMode !== 'emotion_dlc') return '';
  const plan = shot.performancePlan;
  return [
    `【${CONTINUITY_ID}｜${shot.shotId}｜${plan.focusedCharacter}】`,
    ...(plan.actingControlVersion === ACTING_CONTROL_VERSION ? [`禁止提前反应：${plan.prohibitedEarlyReactions.map(item => `反应观察者=${item.respondingCharacter}；画内动作禁令=${item.reaction}（重音=${item.stressPhrase}；直到${item.untilCue}）`).join('；')}`] : []),
    `结束状态：${plan.endBehavior}`,
    `连续保留：${plan.continuityCarry.join('；')}`,
    `【/${CONTINUITY_ID}｜${shot.shotId}】`
  ].join('\n');
}

export function renderEmotionPerformanceContinuityBlocks(narration) {
  return (narration.shots ?? []).map(renderEmotionPerformanceContinuity).filter(Boolean).join('\n\n');
}

export function assertPromptContainsEmotionPerformanceContinuity(promptText, narration) {
  if (typeof promptText !== 'string' || promptText.trim() === '') throw new TypeError('Seedance prompt text must be non-empty');
  const normalizedPrompt = promptText.replace(/\r\n/g, '\n');
  for (const shot of narration.shots ?? []) {
    const block = renderEmotionPerformanceContinuity(shot);
    if (block && !normalizedPrompt.includes(block)) {
      throw new Error(`Seedance prompt is missing the exact ${CONTINUITY_ID} block for ${shot.shotId}; run performance-capsule and paste the continuity block without rewriting`);
    }
  }
  return true;
}

export function assertPromptExcludesEmotionPerformanceCapsule(promptText) {
  if (typeof promptText !== 'string' || promptText.trim() === '') throw new TypeError('Seedance prompt text must be non-empty');
  if (promptText.includes(`【${DLC_ID}｜`)) {
    throw new Error(`Seedance prompt must not embed the ${DLC_ID} capsule; capsules are archived audit metadata and repeating them degrades the shot`);
  }
  return true;
}

export const EMOTION_PERFORMANCE_DLC_ID = DLC_ID;
export const EMOTION_PERFORMANCE_TEMPLATE_SOURCE = TEMPLATE_SOURCE;
export const EMOTION_PERFORMANCE_CONTINUITY_ID = CONTINUITY_ID;
export const EMOTION_PERFORMANCE_ACTING_CONTROL_VERSION = ACTING_CONTROL_VERSION;
