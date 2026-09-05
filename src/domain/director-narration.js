import { routedShotsForSegment } from './director-capability.js';

const GENERIC_GESTURES = Object.freeze(['无动机挥手', '呆滞凝视', '标准笑容', '机械重复']);
const CAPSULE_ID = 'director-capability-v1';
const SCREEN_CONSTRAINT_ID = 'director-constraints-v1';
const SPATIAL_FIRST_FRAME_POLICIES = new Set(['all_required_visible', 'deliberate_reveal']);
const SPATIAL_SHOT_MODES = new Set(['single_continuous_take', 'controlled_multi_shot']);
const SPATIAL_DEPTH_LAYERS = new Set(['foreground', 'midground', 'background']);
const SPATIAL_CUT_TYPES = new Set(['hard_cut', 'smash_cut', 'match_cut', 'insert_cut', 'reverse_cut', 'whip_cut']);
const OBSERVABLE_HINTS = Object.freeze([
  '眼', '视线', '眉', '嘴', '唇', '下颌', '呼吸', '肩', '头', '手', '指', '身体', '重心',
  '看', '眨', '抬', '低', '转', '停', '收', '松', '握', '推', '拉', '拿', '放', '退', '迈',
  '站', '坐', '走', '吞咽', '碰', '摩擦', '对方', '桌', '门', '产品'
]);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function textList(value, field, { min = 1, max = Infinity } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${field} must contain ${min}-${max === Infinity ? 'many' : max} entries`);
  value.forEach((entry, index) => text(entry, `${field}[${index}]`));
}

function observable(value) {
  return OBSERVABLE_HINTS.some(hint => value.includes(hint));
}

export function assertRealismPlan(plan, field = 'realismPlan') {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError(`${field} must be an object`);
  for (const name of ['focusedCharacter', 'motivatedAction', 'physicalEndpoint', 'naturalVariation']) text(plan[name], `${field}.${name}`);
  if (!observable(plan.motivatedAction)) throw new TypeError(`${field}.motivatedAction must be camera-observable`);
  if (!observable(plan.physicalEndpoint)) throw new TypeError(`${field}.physicalEndpoint must be camera-observable`);
  textList(plan.forbiddenGenericActions, `${field}.forbiddenGenericActions`, { min: GENERIC_GESTURES.length, max: 8 });
  for (const required of GENERIC_GESTURES) {
    if (!plan.forbiddenGenericActions.some(item => item.includes(required))) throw new TypeError(`${field}.forbiddenGenericActions must include ${required}`);
  }
  if (!Array.isArray(plan.persistentMicroMotions)) throw new TypeError(`${field}.persistentMicroMotions must be an array`);
  const tags = new Set();
  for (const [index, item] of plan.persistentMicroMotions.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`${field}.persistentMicroMotions[${index}] must be an object`);
    text(item.characterId, `${field}.persistentMicroMotions[${index}].characterId`);
    text(item.action, `${field}.persistentMicroMotions[${index}].action`);
    if (!observable(item.action)) throw new TypeError(`${field}.persistentMicroMotions[${index}].action must be camera-observable`);
    if (tags.has(item.characterId)) throw new TypeError(`${field}.persistentMicroMotions contains duplicate ${item.characterId}`);
    tags.add(item.characterId);
  }
  return plan;
}

export function assertInteractionPlan(plan, field = 'interactionPlan') {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError(`${field} must be an object`);
  textList(plan.participants, `${field}.participants`, { min: 2, max: 8 });
  for (const name of ['focusedCharacter', 'partnerCharacter', 'trigger', 'gazeTarget', 'eyeLineAction', 'partnerReaction', 'axisConstraint', 'endState']) text(plan[name], `${field}.${name}`);
  if (plan.focusedCharacter === plan.partnerCharacter) throw new TypeError(`${field} requires two different focused and partner characters`);
  if (!plan.participants.includes(plan.focusedCharacter) || !plan.participants.includes(plan.partnerCharacter)) throw new TypeError(`${field} participants must contain focused and partner characters`);
  if (!plan.gazeTarget.includes(plan.partnerCharacter) && !plan.gazeTarget.includes('产品') && !plan.gazeTarget.includes('道具')) {
    throw new TypeError(`${field}.gazeTarget must name the partner or a motivated object`);
  }
  for (const name of ['eyeLineAction', 'partnerReaction', 'endState']) if (!observable(plan[name])) throw new TypeError(`${field}.${name} must be camera-observable`);
  return plan;
}

// This is intentionally a camera-observable contract, not a second prompt grammar.
// It records the minimum facts that commonly drift in multi-person, landmark-sensitive
// and controlled-cut shots; the canonical Seedance skill remains responsible for prose.
export function assertSpatialContract(plan, field = 'spatialContract') {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError(`${field} must be an object`);
  if (!SPATIAL_FIRST_FRAME_POLICIES.has(plan.firstFramePolicy)) throw new TypeError(`${field}.firstFramePolicy is invalid`);
  textList(plan.requiredSubjects, `${field}.requiredSubjects`, { min: 1, max: 12 });
  text(plan.cameraSide, `${field}.cameraSide`);
  if (!SPATIAL_SHOT_MODES.has(plan.shotMode)) throw new TypeError(`${field}.shotMode is invalid`);
  if (!Array.isArray(plan.subjects) || plan.subjects.length === 0 || plan.subjects.length > 12) {
    throw new TypeError(`${field}.subjects must contain 1-12 entries`);
  }
  const subjectIds = new Set();
  for (const [index, subject] of plan.subjects.entries()) {
    if (!subject || typeof subject !== 'object' || Array.isArray(subject)) throw new TypeError(`${field}.subjects[${index}] must be an object`);
    for (const name of ['subjectId', 'screenPosition', 'worldPosition', 'bodyFacing', 'gazeTarget', 'movementDirection']) {
      text(subject[name], `${field}.subjects[${index}].${name}`);
    }
    if (!SPATIAL_DEPTH_LAYERS.has(subject.depthLayer)) throw new TypeError(`${field}.subjects[${index}].depthLayer is invalid`);
    if (subject.landmarkAnchor !== undefined) text(subject.landmarkAnchor, `${field}.subjects[${index}].landmarkAnchor`);
    if (subjectIds.has(subject.subjectId)) throw new TypeError(`${field}.subjects subjectId values must be unique`);
    subjectIds.add(subject.subjectId);
  }
  for (const subjectId of plan.requiredSubjects) {
    if (!subjectIds.has(subjectId)) throw new TypeError(`${field}.requiredSubjects must be declared in subjects`);
  }
  if (plan.firstFramePolicy === 'deliberate_reveal') text(plan.revealAction, `${field}.revealAction`);
  else if (plan.revealAction !== undefined) throw new TypeError(`${field}.revealAction is allowed only for deliberate_reveal`);
  if (plan.shotMode === 'controlled_multi_shot') {
    if (!Array.isArray(plan.cutPlan) || plan.cutPlan.length === 0 || plan.cutPlan.length > 6) throw new TypeError(`${field}.cutPlan must contain 1-6 entries for controlled_multi_shot`);
    for (const [index, cut] of plan.cutPlan.entries()) {
      if (!cut || typeof cut !== 'object' || Array.isArray(cut)) throw new TypeError(`${field}.cutPlan[${index}] must be an object`);
      if (!SPATIAL_CUT_TYPES.has(cut.type)) throw new TypeError(`${field}.cutPlan[${index}].type is invalid`);
      text(cut.afterBeat, `${field}.cutPlan[${index}].afterBeat`);
      text(cut.reason, `${field}.cutPlan[${index}].reason`);
    }
  } else if (plan.cutPlan !== undefined) {
    throw new TypeError(`${field}.cutPlan is allowed only for controlled_multi_shot`);
  }
  return plan;
}

export function assertDirectorNarrationShot(shot) {
  if (shot.skillsApplied !== undefined) textList(shot.skillsApplied, 'shot.skillsApplied', { min: 1, max: 12 });
  if (shot.realismPlan !== undefined) assertRealismPlan(shot.realismPlan);
  if (shot.interactionPlan !== undefined) assertInteractionPlan(shot.interactionPlan);
  if (shot.spatialContract !== undefined) assertSpatialContract(shot.spatialContract);
  return shot;
}

// Earlier director plans used a unit id for the complete narrated beat (u01_unit),
// while their route contract names that same one-shot unit u01.  This is a
// presentation-only bridge: it is deliberately bijective and only strips one
// terminal `_unit`.  The persisted narration and route stay byte-for-byte intact.
function reconcileNarrationShotIds(narration, routes) {
  const routeIds = new Set(routes.map(route => route.shotId));
  const usedRouteIds = new Set();
  const shots = narration.shots.map(shot => {
    const candidates = [shot.shotId];
    if (typeof shot.shotId === 'string' && shot.shotId.endsWith('_unit')) {
      candidates.push(shot.shotId.slice(0, -'_unit'.length));
    }
    const routeId = candidates.find(candidate => routeIds.has(candidate));
    if (!routeId || usedRouteIds.has(routeId)) {
      throw new Error(`shot narration contains unrouted shot ${shot.shotId}`);
    }
    usedRouteIds.add(routeId);
    return routeId === shot.shotId ? shot : { ...shot, shotId: routeId };
  });
  if (usedRouteIds.size !== routeIds.size) {
    const missing = [...routeIds].find(id => !usedRouteIds.has(id));
    throw new Error(`shot narration is missing routed shot ${missing}`);
  }
  return { ...narration, shots };
}

function resolveNarrationRoutes(narration, manifest, manifestSha256) {
  if (narration.capabilityManifestId !== manifest.id || narration.capabilityManifestSha256 !== manifestSha256) {
    throw new Error(`shot narration must bind exact capability manifest ${manifest.id} and SHA`);
  }
  const routes = routedShotsForSegment(manifest, narration.segmentId);
  return { routes, narration: reconcileNarrationShotIds(narration, routes) };
}

export function assertNarrationMatchesCapabilityManifest(narration, manifest, manifestSha256) {
  const resolved = resolveNarrationRoutes(narration, manifest, manifestSha256);
  const { routes } = resolved;
  const byShot = new Map(resolved.narration.shots.map(shot => [shot.shotId, shot]));
  for (const route of routes) {
    const shot = byShot.get(route.shotId);
    if (!shot) throw new Error(`shot narration is missing routed shot ${route.shotId}`);
    textList(shot.skillsApplied, `shot ${shot.shotId}.skillsApplied`, { min: 1, max: 12 });
    for (const skill of route.requiredSkillIds) {
      if (!shot.skillsApplied.includes(skill)) throw new Error(`shot ${shot.shotId} must apply routed skill ${skill}`);
    }
    const capabilityIds = new Set(route.capabilities.map(item => item.id));
    if (capabilityIds.has('character-performance-v1')) {
      assertRealismPlan(shot.realismPlan, `shot ${shot.shotId}.realismPlan`);
      if (!route.characterIds.includes(shot.realismPlan.focusedCharacter)) throw new Error(`shot ${shot.shotId} realism focus is not a routed character`);
      const requiredBackground = route.characterIds.filter(id => id !== shot.realismPlan.focusedCharacter);
      for (const id of requiredBackground) {
        if (!shot.realismPlan.persistentMicroMotions.some(item => item.characterId === id)) throw new Error(`shot ${shot.shotId} requires persistent micro-motion for ${id}`);
      }
    }
    if (capabilityIds.has('relationship-eyeline-v1')) {
      assertInteractionPlan(shot.interactionPlan, `shot ${shot.shotId}.interactionPlan`);
      // Revision 2 upgrades new relationship shots to explicit spatial evidence.
      // Revision 1 remains readable/compilable so locked historical packages are not invalidated.
      if (resolved.narration.revision >= 2) assertSpatialContract(shot.spatialContract, `shot ${shot.shotId}.spatialContract`);
      for (const participant of shot.interactionPlan.participants) {
        if (!route.characterIds.includes(participant)) throw new Error(`shot ${shot.shotId} interaction participant ${participant} is not routed for the shot`);
        if (resolved.narration.revision >= 2 && !shot.spatialContract.subjects.some(subject => subject.subjectId === participant)) {
          throw new Error(`shot ${shot.shotId} interaction participant ${participant} is missing from spatialContract`);
        }
      }
    }
    if (capabilityIds.has('emotion-performance-v1') && shot.performanceMode !== 'emotion_dlc') {
      throw new Error(`shot ${shot.shotId} must use performanceMode emotion_dlc`);
    }
  }
  return true;
}

function renderRoute(route, shot) {
  const carriers = route.resultContract.intentCarriers.map(item => `${item.channel}：${item.instruction}；验收=${item.visibleEvidence}`).join('；');
  const realism = shot.realismPlan
    ? [
      `真人感主动作：${shot.realismPlan.motivatedAction}`,
      `动作终点：${shot.realismPlan.physicalEndpoint}`,
      `自然变化：${shot.realismPlan.naturalVariation}`,
      `非焦点人物微动作：${shot.realismPlan.persistentMicroMotions.map(item => `${item.characterId}=${item.action}`).join('；') || '无'}`,
      `禁止样板动作：${shot.realismPlan.forbiddenGenericActions.join('；')}`
    ].join('\n')
    : '真人感计划：本镜无人物。';
  const interaction = shot.interactionPlan
    ? [
      `互动触发：${shot.interactionPlan.trigger}`,
      `视线动作：${shot.interactionPlan.focusedCharacter} ${shot.interactionPlan.eyeLineAction}；目标=${shot.interactionPlan.gazeTarget}`,
      `对方反应：${shot.interactionPlan.partnerCharacter} ${shot.interactionPlan.partnerReaction}`,
      `轴线约束：${shot.interactionPlan.axisConstraint}`,
      `互动终点：${shot.interactionPlan.endState}`
    ].join('\n')
    : '互动计划：本镜不需要双人视线反应链。';
  return [
    `【director-capability-v1｜${route.shotId}】`,
    `必用能力：${route.capabilities.map(item => item.id).join('、')}`,
    `实际技能：${shot.skillsApplied.join('、')}`,
    `叙事工作：${route.resultContract.narrativeFunction}`,
    `价值变化：${route.resultContract.valueTurn}`,
    `观众感受：${route.resultContract.feltIntent}`,
    `镜头理由：${route.resultContract.whyThisShot}`,
    `观看顺序：${route.resultContract.audienceAttention}`,
    `表达细节：${route.resultContract.expressiveDetail}`,
    `表达载体：${carriers}`,
    realism,
    interaction,
    `【/director-capability-v1｜${route.shotId}】`
  ].join('\n');
}

export function renderDirectorCapabilityCapsules(narration, manifest, manifestSha256) {
  assertNarrationMatchesCapabilityManifest(narration, manifest, manifestSha256);
  const resolved = resolveNarrationRoutes(narration, manifest, manifestSha256);
  const byShot = new Map(resolved.narration.shots.map(shot => [shot.shotId, shot]));
  return resolved.routes.map(route => renderRoute(route, byShot.get(route.shotId))).join('\n\n');
}

function renderShotScreenConstraints(route, shot) {
  const lines = [];
  if (shot.spatialContract) {
    const spatial = shot.spatialContract;
    const opening = spatial.firstFramePolicy === 'all_required_visible'
      ? `首帧：${spatial.requiredSubjects.join('、')} 已全部在画面中，空间关系立刻可读。`
      : `首帧揭示：${spatial.revealAction}`;
    lines.push(opening);
    lines.push(`机位侧：${spatial.cameraSide}`);
    for (const subject of spatial.subjects) {
      lines.push(`空间：${subject.subjectId} 位于${subject.screenPosition}、${subject.depthLayer}；世界位置=${subject.worldPosition}；身体朝向=${subject.bodyFacing}；视线目标=${subject.gazeTarget}；运动方向=${subject.movementDirection}${subject.landmarkAnchor ? `；地标锚点=${subject.landmarkAnchor}` : ''}`);
    }
    if (spatial.cutPlan) lines.push(`切镜纪律：${spatial.cutPlan.map(cut => `${cut.type} 在${cut.afterBeat}后，仅因${cut.reason}`).join('；')}`);
  }
  if (shot.interactionPlan) {
    // `gazeTarget` also proves the technical relationship partner for routing, but that
    // partner can intentionally remain offscreen.  The model-facing constraint must use
    // the director's camera-observable eye-line action so an offscreen bookkeeping role
    // is never pulled back into frame or mistaken for the visible target.
    const eyeLine = shot.interactionPlan.eyeLineAction.replace(/^视线动作[：:]\s*/, '');
    lines.push(`视线目标：${shot.interactionPlan.focusedCharacter} ${eyeLine}`);
    lines.push(`轴线约束：${shot.interactionPlan.axisConstraint}`);
  }
  if (shot.realismPlan) {
    lines.push(`动作终点：${shot.realismPlan.physicalEndpoint}`);
    lines.push(`禁止动作：${shot.realismPlan.forbiddenGenericActions.join('；')}`);
  }
  if (lines.length === 0) return '';
  return [
    `【${SCREEN_CONSTRAINT_ID}｜${route.shotId}】`,
    ...lines,
    `【/${SCREEN_CONSTRAINT_ID}｜${route.shotId}】`
  ].join('\n');
}

// Only camera-observable constraints reach the model. Narrative rationale, capability ids and
// acceptance evidence stay in the archived capsule so they cannot re-weight the generated shot.
export function renderDirectorScreenConstraints(narration, manifest, manifestSha256) {
  assertNarrationMatchesCapabilityManifest(narration, manifest, manifestSha256);
  const resolved = resolveNarrationRoutes(narration, manifest, manifestSha256);
  const byShot = new Map(resolved.narration.shots.map(shot => [shot.shotId, shot]));
  return resolved.routes
    .map(route => renderShotScreenConstraints(route, byShot.get(route.shotId)))
    .filter(Boolean)
    .join('\n\n');
}

export function assertPromptContainsDirectorScreenConstraints(promptText, narration, manifest, manifestSha256) {
  text(promptText, 'promptText');
  const block = renderDirectorScreenConstraints(narration, manifest, manifestSha256);
  if (block && !promptText.replace(/\r\n/g, '\n').includes(block)) {
    throw new Error('Seedance prompt is missing the exact director screen-constraint block; run director-capsule and paste the constraint block without rewriting');
  }
  return true;
}

export function assertPromptExcludesDirectorCapsuleMetadata(promptText) {
  text(promptText, 'promptText');
  if (promptText.includes(`【${CAPSULE_ID}｜`)) {
    throw new Error(`Seedance prompt must not embed the ${CAPSULE_ID} capsule; capsules are archived audit metadata and repeating them degrades the shot`);
  }
  return true;
}

export const REQUIRED_GENERIC_PERFORMANCE_BANS = GENERIC_GESTURES;
export const DIRECTOR_SCREEN_CONSTRAINT_ID = SCREEN_CONSTRAINT_ID;
export const DIRECTOR_CAPSULE_ID = CAPSULE_ID;
