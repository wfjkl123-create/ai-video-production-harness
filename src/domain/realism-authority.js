export const REALISM_AUTHORITY_KINDS = Object.freeze([
  'character_acting_master_v1',
  'character_story_state_v1',
  'voice_identity_v1',
  'scene_geometry_v2'
]);

export const AUTHORITY_ARTIFACT_TYPE_BY_KIND = Object.freeze({
  character_acting_master_v1: 'character_acting_master',
  character_story_state_v1: 'character_story_state',
  voice_identity_v1: 'voice_identity',
  scene_geometry_v2: 'scene_geometry'
});

const SHA256 = /^[a-f0-9]{64}$/;
const TIMER_LIKE = /(?:every|每隔|每)\s*\d+(?:\.\d+)?\s*(?:s|sec|second|秒|帧)|\d+(?:\.\d+)?\s*(?:s|sec|second|秒|帧)\s*(?:一次|眨眼|blink)/i;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function textList(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError(`${field} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  value.forEach((entry, index) => text(entry, `${field}[${index}]`));
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must contain unique values`);
  return value;
}

export function assertAuthorityBinding(value, field) {
  object(value, field);
  text(value.id, `${field}.id`);
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError(`${field}.revision must be a positive integer`);
  if (!SHA256.test(value.sha256 ?? '')) throw new TypeError(`${field}.sha256 must be a lowercase SHA-256`);
  return value;
}

function base(value, kind, version) {
  object(value, kind);
  if (value.kind !== kind) throw new TypeError(`kind must be ${kind}`);
  if (value.version !== version) throw new TypeError(`version must be ${version}`);
  for (const field of ['id', 'projectId']) text(value[field], field);
  return value;
}

function assertCue(value, field, { requireCueId = false } = {}) {
  object(value, field);
  if (requireCueId) text(value.cueId, `${field}.cueId`);
  text(value.cue, `${field}.cue`);
  text(value.observableResponse, `${field}.observableResponse`);
  if (value.doNotUseAsClock !== true) throw new TypeError(`${field}.doNotUseAsClock must be true`);
  if (TIMER_LIKE.test(`${value.cue} ${value.observableResponse}`)) {
    throw new Error(`${field} must be cue-driven, not a fixed-frequency animation schedule`);
  }
}

export function assertCharacterActingMaster(value) {
  base(value, 'character_acting_master_v1', 1);
  text(value.characterId, 'characterId');
  if (!Array.isArray(value.sourceBindings) || value.sourceBindings.length === 0) throw new TypeError('sourceBindings must be non-empty');
  value.sourceBindings.forEach((binding, index) => assertAuthorityBinding(binding, `sourceBindings[${index}]`));
  object(value.physicalBiography, 'physicalBiography');
  for (const field of ['ageAndPhysiology', 'baselineEnergy', 'posture', 'gait', 'breath', 'gazeBaseline', 'handBehavior']) {
    text(value.physicalBiography[field], `physicalBiography.${field}`);
  }
  object(value.psychologicalEngine, 'psychologicalEngine');
  for (const field of ['want', 'fear', 'protectiveMask', 'fracturePattern', 'recoveryPattern']) {
    text(value.psychologicalEngine[field], `psychologicalEngine.${field}`);
  }
  if (!Array.isArray(value.triggeredHabits) || value.triggeredHabits.length === 0 || value.triggeredHabits.length > 8) {
    throw new TypeError('triggeredHabits must contain 1 to 8 cue-driven habits');
  }
  value.triggeredHabits.forEach((habit, index) => assertCue(habit, `triggeredHabits[${index}]`, { requireCueId: true }));
  if (new Set(value.triggeredHabits.map(habit => habit.cueId)).size !== value.triggeredHabits.length) {
    throw new TypeError('triggeredHabits must contain unique cueId values');
  }
  textList(value.continuityLocks, 'continuityLocks');
  text(value.sceneAdaptationPolicy, 'sceneAdaptationPolicy');
  if (value.voiceIdentityBinding !== undefined) assertAuthorityBinding(value.voiceIdentityBinding, 'voiceIdentityBinding');
  if (value.responsibility !== 'long-term behavior identity that remains stable across scenes') throw new TypeError('character acting master responsibility is invalid');
  textList(value.mustNotControl, 'mustNotControl');
  return value;
}

export function assertCharacterStoryState(value) {
  base(value, 'character_story_state_v1', 1);
  for (const field of ['characterId', 'scopeKey', 'cause']) text(value[field], field);
  assertAuthorityBinding(value.identityPackBinding, 'identityPackBinding');
  assertAuthorityBinding(value.actingMasterBinding, 'actingMasterBinding');
  if (value.parentStateBinding !== undefined) assertAuthorityBinding(value.parentStateBinding, 'parentStateBinding');
  if (!Array.isArray(value.appearanceDeltas) || value.appearanceDeltas.length === 0) throw new TypeError('appearanceDeltas must be non-empty');
  value.appearanceDeltas.forEach((delta, index) => {
    object(delta, `appearanceDeltas[${index}]`);
    for (const field of ['region', 'observableChange', 'persistence']) text(delta[field], `appearanceDeltas[${index}].${field}`);
  });
  if (!Array.isArray(value.performanceDeltas)) throw new TypeError('performanceDeltas must be an array');
  value.performanceDeltas.forEach((delta, index) => assertCue(delta, `performanceDeltas[${index}]`));
  textList(value.preserve, 'preserve');
  if (value.responsibility !== 'story-caused appearance and behavior deltas for one character and one scope') throw new TypeError('character story state responsibility is invalid');
  textList(value.mustNotControl, 'mustNotControl');
  return value;
}

export function assertVoiceIdentity(value) {
  base(value, 'voice_identity_v1', 1);
  text(value.characterId, 'characterId');
  if (!['recorded_reference', 'casting_spec'].includes(value.sourceBasis)) throw new TypeError('sourceBasis must be recorded_reference or casting_spec');
  if (!Array.isArray(value.sourceBindings)) throw new TypeError('sourceBindings must be an array');
  value.sourceBindings.forEach((binding, index) => assertAuthorityBinding(binding, `sourceBindings[${index}]`));
  if (value.sourceBasis === 'recorded_reference' && value.sourceBindings.length === 0) throw new Error('recorded_reference voice identity requires sourceBindings');
  object(value.vocalCore, 'vocalCore');
  for (const field of ['pitchRange', 'timbre', 'resonance', 'baselinePace', 'articulation', 'breathPattern']) text(value.vocalCore[field], `vocalCore.${field}`);
  if (!Array.isArray(value.allowedStateDeltas) || value.allowedStateDeltas.length === 0) throw new TypeError('allowedStateDeltas must be non-empty');
  value.allowedStateDeltas.forEach((delta, index) => {
    object(delta, `allowedStateDeltas[${index}]`);
    for (const field of ['deltaId', 'trigger', 'allowedChange', 'stableCore']) text(delta[field], `allowedStateDeltas[${index}].${field}`);
  });
  if (new Set(value.allowedStateDeltas.map(delta => delta.deltaId)).size !== value.allowedStateDeltas.length) {
    throw new TypeError('allowedStateDeltas must contain unique deltaId values');
  }
  if (value.responsibility !== 'stable speaker identity and the permitted state-dependent vocal range') throw new TypeError('voice identity responsibility is invalid');
  textList(value.mustNotControl, 'mustNotControl');
  return value;
}

function assertRequiredGeometry(value) {
  if (value.directorLabel !== '1/4') throw new TypeError('required scene geometry must preserve the director label 1/4');
  object(value.observableAnchor, 'observableAnchor');
  for (const field of ['openingDirection', 'entranceExitRelation', 'pathToDepthPlane', 'wallReveal', 'depthRead']) {
    text(value.observableAnchor[field], `observableAnchor.${field}`);
  }
  if (!Array.isArray(value.landmarks) || value.landmarks.length < 2) throw new TypeError('landmarks must contain at least two observable anchors');
  value.landmarks.forEach((landmark, index) => {
    object(landmark, `landmarks[${index}]`);
    for (const field of ['id', 'worldRelation', 'screenRelation']) text(landmark[field], `landmarks[${index}].${field}`);
  });
  object(value.screenDirectionAxes, 'screenDirectionAxes');
  for (const field of ['characterTravel', 'cameraSide', 'eyelineAxis']) text(value.screenDirectionAxes[field], `screenDirectionAxes.${field}`);
  if (!Array.isArray(value.reverseShotMap)) throw new TypeError('reverseShotMap must be an array');
  value.reverseShotMap.forEach((entry, index) => {
    object(entry, `reverseShotMap[${index}]`);
    for (const field of ['shotId', 'cameraSide', 'preservedScreenDirection']) text(entry[field], `reverseShotMap[${index}].${field}`);
  });
}

export function assertSceneGeometry(value) {
  base(value, 'scene_geometry_v2', 2);
  text(value.sceneId, 'sceneId');
  if (!['required', 'not_applicable'].includes(value.applicability)) throw new TypeError('applicability must be required or not_applicable');
  if (value.applicability === 'required') {
    assertRequiredGeometry(value);
    if (value.notApplicableReason !== undefined) throw new TypeError('required scene geometry must not include notApplicableReason');
  } else {
    text(value.notApplicableReason, 'notApplicableReason');
    for (const field of ['directorLabel', 'observableAnchor', 'landmarks', 'screenDirectionAxes', 'reverseShotMap']) {
      if (value[field] !== undefined) throw new TypeError(`not_applicable scene geometry must not include ${field}`);
    }
  }
  if (value.responsibility !== 'observable space geometry, landmarks and screen-direction continuity only') throw new TypeError('scene geometry responsibility is invalid');
  textList(value.mustNotControl, 'mustNotControl');
  return value;
}

export function assertRealismAuthority(value) {
  if (!value || !REALISM_AUTHORITY_KINDS.includes(value.kind)) throw new TypeError('unsupported realism authority kind');
  if (value.kind === 'character_acting_master_v1') return assertCharacterActingMaster(value);
  if (value.kind === 'character_story_state_v1') return assertCharacterStoryState(value);
  if (value.kind === 'voice_identity_v1') return assertVoiceIdentity(value);
  return assertSceneGeometry(value);
}

export function realismAuthoritySourceBindings(value) {
  assertRealismAuthority(value);
  if (value.kind === 'character_story_state_v1') {
    return [value.identityPackBinding, value.actingMasterBinding, ...(value.parentStateBinding ? [value.parentStateBinding] : [])];
  }
  return [...(value.sourceBindings ?? []), ...(value.voiceIdentityBinding ? [value.voiceIdentityBinding] : [])];
}
