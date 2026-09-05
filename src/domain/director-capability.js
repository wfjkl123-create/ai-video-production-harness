import { createHash } from 'node:crypto';
import { assessStoryPlanExecutability, assertControlProfile, inferTransformMode } from './production-readiness.js';
import { assertProjectId } from './project-id.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;
// v7 also keeps an explicitly skipped camera-blocking asset authoritative.
// Complex-blocking inference must not silently expand a reviewed Gate 2 scope.
export const DIRECTOR_ROUTE_VERSION = 'director-route-v7';
const PROJECT_TYPES = new Set(['narrative', 'viral_remake', 'product_demo', 'interview', 'montage', 'other', 'local_edit', 'faithful_remake', 'story_creation']);
const PRODUCT_INTERACTIONS = new Set(['none', 'display', 'scale_sensitive', 'wearing']);
const INTENT_CHANNELS = new Set(['camera', 'blocking', 'performance', 'lighting', 'sound', 'edit', 'prop_environment']);
const ROUTABLE_ASSET_TYPES = new Set([
  'character_board', 'character_identity_single_view', 'scene_multiview', 'scene_overhead', 'product_reference',
  'story_prop', 'wardrobe_board', 'color_board', 'initial_blocking', 'handoff_blocking', 'camera_blocking',
  'director_view_proxy', 'dialogue_axis_board', 'storyboard', 'mannequin_grid', 'character_product_state',
  'spatial_control_animatic', 'depth_video_reference', 'expression_board', 'dialogue_audio_reference', 'timing_audio_reference',
  'source_audio_candidate'
]);
const PROJECT_ASSET_TYPES = new Set([
  'character_board', 'character_identity_single_view', 'scene_multiview', 'scene_overhead',
  'product_reference', 'story_prop', 'wardrobe_board', 'color_board'
]);
const PRODUCT_PROOF_ASSET_TYPES = new Set([
  'product_reference', 'story_prop', 'wardrobe_board', 'character_product_state'
]);
const EMPTY_DIRECTION = /(推进剧情|讲完故事|展示人物|人物做动作|电影感|高级感|专业感|生动自然|情绪饱满|更有感觉|dramatic|cinematic|dynamic|professional)$/i;
const CAMERA_REASON = /(景别|机位|镜头|构图|前景|后景|近景|特写|中景|全景|固定|推近|拉远|摇|移|跟拍|俯拍|仰拍|轴线|视线|camera|shot|close|wide|dolly|track|locked)/i;
const VALUE_CHANGE = /(从.+到|由.+变|转向|变为|成为|不再|开始|失去|获得|确认|拒绝|接受|相信|怀疑|->|→)/i;

const CAPABILITY_DEFINITIONS = Object.freeze({
  'director-intent-v1': Object.freeze({
    source: 'seedance2-prompt + seedance-camera',
    skillIds: ['seedance2-prompt', 'seedance-camera'],
    requiredAssets: [],
    resultChecks: ['shot changes a visible value or proves a specific claim', 'camera choice and endpoint serve the felt intent', 'at least two observable craft carriers express the same intention']
  }),
  'character-performance-v1': Object.freeze({
    source: 'seedance-characters + seedance-antislop',
    skillIds: ['seedance2-prompt', 'seedance-characters', 'seedance-antislop'],
    requiredAssets: ['character_board'],
    resultChecks: ['every visible character has a named motivated action or persistent micro-motion', 'focused action has a physical endpoint', 'natural pause asymmetry or incomplete motion replaces template gestures', 'no unmotivated waving pointing smiling or frozen idle performance']
  }),
  'relationship-eyeline-v1': Object.freeze({
    source: 'seedance-characters + seedance-camera',
    skillIds: ['seedance2-prompt', 'seedance-characters', 'seedance-camera'],
    requiredAssets: [],
    resultChecks: ['gaze target is a named scene partner or motivated object', 'partner reaction follows the trigger instead of occurring simultaneously', 'screen direction and eyeline remain coherent', 'relationship change is visible without relying only on dialogue']
  }),
  'emotion-performance-v1': Object.freeze({
    source: 'knowledge/capabilities/dlc/emotion-performance.md',
    skillIds: ['seedance2-prompt', 'seedance-characters'],
    requiredAssets: [],
    resultChecks: ['emotion has a visible trigger objective and subtext', 'one dominant performance track carries the beat', 'start and end behavior are visibly different', 'background characters stay on persistent micro-motion']
  }),
  'sequence-continuity-v1': Object.freeze({
    source: 'seedance-sequence + seedance-camera',
    skillIds: ['seedance2-prompt', 'seedance-sequence', 'seedance-camera'],
    requiredAssets: [],
    resultChecks: ['shot or phase starts from the accepted state', 'screen geography and reserved future beats remain intact', 'the current beat reaches one explicit endpoint']
  }),
  'storyboard-control-v1': Object.freeze({
    source: 'storyboard_sheet_15s_v1',
    skillIds: ['seedance-sequence', 'seedance-camera'],
    requiredAssets: ['storyboard'],
    resultChecks: ['complete 15-second board is generated as one first-pass sheet', 'panel timing action endpoints and screen direction remain coherent', 'only failed panels are repaired']
  }),
  'mannequin-grid-v1': Object.freeze({
    source: 'knowledge/capabilities/mannequin-grid-prompt.md',
    skillIds: ['seedance2-prompt', 'seedance-sequence', 'seedance-camera', 'seedance-characters'],
    requiredAssets: ['mannequin_grid'],
    resultChecks: ['each panel derives from the matching source-video time point', 'single-person mannequin is light gray-white and multi-person IDs use distinct low-saturation gray tones', 'real scene volume contact shadows pose and camera are preserved', 'no paper cutout or whole-grid model rewrite']
  }),
  'modeling-control-v1': Object.freeze({
    source: 'knowledge/capabilities/modeling-strong-control.md',
    skillIds: ['seedance2-prompt', 'seedance-camera', 'seedance-sequence'],
    requiredAssets: [],
    resultChecks: [
      'one locked Blender scene is the spatial authority for camera blocking pose contact occlusion and timing',
      'every exported proxy frame or animatic frame is derived from the same scene and camera rather than independently generated',
      'source-to-model comparison passes shot scale screen position camera path contact state and action endpoint checks',
      'canonical character wardrobe product scene texture and color assets remain the appearance authority',
      'gray model material rig controls guides axes labels and camera cones never transfer to final pixels'
    ]
  }),
  'overhead-blocking-v1': Object.freeze({
    source: 'knowledge/capabilities/overhead-blocking-diagram.md',
    skillIds: ['seedance-camera'],
    requiredAssets: ['camera_blocking'],
    resultChecks: ['character paths camera path entrances exits and contact points are unambiguous']
  }),
  'product-proof-v1': Object.freeze({
    source: 'asset-prompt-templates + seedance-camera',
    skillIds: ['seedance2-prompt', 'seedance-camera'],
    requiredAssets: ['product_reference'],
    resultChecks: ['product structure material scale and held-versus-worn state remain explicit', 'proof action is visible and ends on the claimed result']
  })
});

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function id(value, field) {
  text(value, field);
  if (!SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
}

function unique(values) {
  return [...new Set(values)];
}

function executionSourceContract(plan) {
  const contract = plan.sourceFactContract;
  if (!contract?.executionSafeActionLedger) return null;
  const payload = {
    version: 1,
    authority: 'executionSafeActionLedger_only',
    replacementMap: structuredClone(contract.executionReplacementMap),
    safeActionLedger: structuredClone(contract.executionSafeActionLedger)
  };
  return {
    ...payload,
    fingerprintSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
}

function assertExecutionSourceContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('executionSourceContract must be an object');
  if (value.version !== 1 || value.authority !== 'executionSafeActionLedger_only') {
    throw new TypeError('executionSourceContract must declare executionSafeActionLedger_only authority');
  }
  if (!Array.isArray(value.replacementMap) || value.replacementMap.length === 0
    || !Array.isArray(value.safeActionLedger) || value.safeActionLedger.length === 0) {
    throw new TypeError('executionSourceContract must retain a replacement map and safe action ledger');
  }
  if (!SHA256.test(value.fingerprintSha256 ?? '')) throw new TypeError('executionSourceContract.fingerprintSha256 must be a lowercase SHA-256');
  const { fingerprintSha256, ...payload } = value;
  const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (fingerprintSha256 !== expected) throw new TypeError('executionSourceContract fingerprint does not match its safe execution payload');
}

function requiredAssetPlanTypes(plan) {
  return (plan.assetPlan ?? []).filter(item => item.decision === 'required').map(item => item.assetType);
}

function skippedAssetPlanTypes(plan) {
  return (plan.assetPlan ?? []).filter(item => item.decision === 'skipped').map(item => item.assetType);
}

function containsAny(value, words) {
  const normalized = String(value ?? '').toLowerCase();
  return words.some(word => normalized.includes(word));
}

function legacyShotContexts(plan) {
  let cursor = 0;
  return (plan.shotPlanning.shots ?? []).map(shot => {
    const start = cursor;
    cursor += shot.durationSec;
    const segment = (plan.videoSegments ?? []).find(item => start >= item.startSec - 0.001 && start < item.endSec - 0.001)
      ?? plan.videoSegments?.at(-1);
    const scene = (plan.script?.scenes ?? []).find(item => segment?.sceneIds?.includes(item.sceneId)) ?? plan.script?.scenes?.[0];
    const combined = [shot.purpose, shot.subjectAction, shot.shotContract, shot.blocking, shot.audio, scene?.subtext, scene?.powerShift].join(' ');
    const characterIds = (plan.characters ?? []).map(item => item.characterId);
    const hasDialogue = (scene?.dialogue?.length ?? 0) > 0 || containsAny(combined, ['对白', '台词', '口型', '说话', 'dialogue', 'voice']);
    const relationshipBeat = characterIds.length > 1;
    const closePerformance = containsAny(shot.shotContract, ['近景', '特写', 'close-up', 'close up', 'tight']);
    return {
      shotId: shot.shotId,
      segmentId: segment?.segmentId ?? 'segment-001',
      sceneId: scene?.sceneId ?? 'scene-001',
      characterIds,
      directorIntent: {
        narrativeFunction: shot.purpose,
        valueTurn: `${shot.startState} -> ${shot.endState}`,
        povCharacter: scene?.pov ?? characterIds[0] ?? 'scene observer',
        powerShift: scene?.powerShift ?? 'no explicit power shift recorded',
        subtext: scene?.subtext ?? 'no explicit subtext recorded',
        feltIntent: plan.story?.storyPromise ?? shot.purpose,
        whyThisShot: shot.shotContract,
        audienceAttention: shot.subjectAction,
        expressiveDetail: shot.blocking,
        intentCarriers: [
          { channel: 'camera', instruction: shot.shotContract, visibleEvidence: shot.endState },
          { channel: 'blocking', instruction: shot.blocking, visibleEvidence: shot.subjectAction }
        ],
        signals: {
          hasDialogue,
          emotionalTurn: relationshipBeat || closePerformance || containsAny(combined, ['情绪', '反应', '怀疑', '拒绝', '接受', '失望', '愤怒', '尴尬', '犹豫']),
          relationshipBeat,
          closePerformance,
          requiresMutualEyeLine: relationshipBeat && (hasDialogue || containsAny(combined, ['视线', '看向', '对视', '反应'])),
          complexBlocking: containsAny(shot.blocking, ['追逐', '打斗', '交叉', '绕过', '前后景', '多人', '进出', '路径']),
          complexPhysicalAction: containsAny(shot.subjectAction, ['追逐', '打斗', '摔', '穿', '脱', '跳', '翻', '多人接触']),
          viralRemake: requiredAssetPlanTypes(plan).includes('mannequin_grid'),
          productInteraction: requiredAssetPlanTypes(plan).includes('product_reference') || containsAny(combined, ['产品', '商品', '穿着', '展示']) ? 'display' : 'none'
        }
      },
      legacyInference: true
    };
  });
}

function validateIntent(intent, field) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new TypeError(`${field} must be an object`);
  for (const name of ['narrativeFunction', 'valueTurn', 'povCharacter', 'powerShift', 'subtext', 'feltIntent', 'whyThisShot', 'audienceAttention', 'expressiveDetail']) {
    text(intent[name], `${field}.${name}`);
  }
  for (const name of ['narrativeFunction', 'feltIntent', 'whyThisShot', 'expressiveDetail']) {
    if (EMPTY_DIRECTION.test(intent[name].trim())) throw new TypeError(`${field}.${name} is coverage-only or vague; replace it with an observable directing decision`);
  }
  if (!CAMERA_REASON.test(intent.whyThisShot)) throw new TypeError(`${field}.whyThisShot must explain a concrete camera, framing or blocking choice`);
  if (!VALUE_CHANGE.test(intent.valueTurn)) throw new TypeError(`${field}.valueTurn must state a visible before-to-after change`);
  if (!Array.isArray(intent.intentCarriers) || intent.intentCarriers.length < 2) throw new TypeError(`${field}.intentCarriers requires at least two entries`);
  const channels = new Set();
  for (const [index, carrier] of intent.intentCarriers.entries()) {
    if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)) throw new TypeError(`${field}.intentCarriers[${index}] must be an object`);
    if (!INTENT_CHANNELS.has(carrier.channel)) throw new TypeError(`${field}.intentCarriers[${index}].channel is invalid`);
    text(carrier.instruction, `${field}.intentCarriers[${index}].instruction`);
    text(carrier.visibleEvidence, `${field}.intentCarriers[${index}].visibleEvidence`);
    if (EMPTY_DIRECTION.test(carrier.instruction.trim()) || EMPTY_DIRECTION.test(carrier.visibleEvidence.trim())) {
      throw new TypeError(`${field}.intentCarriers[${index}] is vague instead of observable`);
    }
    channels.add(carrier.channel);
  }
  if (channels.size < 2) throw new TypeError(`${field}.intentCarriers must use at least two distinct channels`);
  const signals = intent.signals;
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) throw new TypeError(`${field}.signals must be an object`);
  for (const name of ['hasDialogue', 'emotionalTurn', 'relationshipBeat', 'closePerformance', 'requiresMutualEyeLine', 'complexBlocking', 'complexPhysicalAction', 'viralRemake']) {
    bool(signals[name], `${field}.signals.${name}`);
  }
  if (signals.localDeterministic !== undefined) {
    bool(signals.localDeterministic, `${field}.signals.localDeterministic`);
    if (signals.localDeterministic && signals.productInteraction === 'none') {
      throw new TypeError(`${field}.signals.localDeterministic requires a productInteraction`);
    }
  }
  if (!PRODUCT_INTERACTIONS.has(signals.productInteraction)) throw new TypeError(`${field}.signals.productInteraction is invalid`);
  if (signals.requiredAssetTypes !== undefined) {
    if (!Array.isArray(signals.requiredAssetTypes)) throw new TypeError(`${field}.signals.requiredAssetTypes must be an array`);
    const assetTypes = new Set();
    for (const [index, assetType] of signals.requiredAssetTypes.entries()) {
      id(assetType, `${field}.signals.requiredAssetTypes[${index}]`);
      if (!ROUTABLE_ASSET_TYPES.has(assetType)) throw new TypeError(`${field}.signals.requiredAssetTypes contains unsupported canonical asset type: ${assetType}`);
      if (assetTypes.has(assetType)) throw new TypeError(`${field}.signals.requiredAssetTypes must be unique`);
      assetTypes.add(assetType);
    }
  }
  return intent;
}

function explicitShotContexts(plan) {
  const segmentIds = new Set((plan.videoSegments ?? []).map(item => item.segmentId));
  const sceneIds = new Set((plan.script?.scenes ?? []).map(item => item.sceneId));
  const characterIds = new Set((plan.characters ?? []).map(item => item.characterId));
  return (plan.shotPlanning.shots ?? []).map((shot, index) => {
    id(shot.segmentId, `shotPlanning.shots[${index}].segmentId`);
    id(shot.sceneId, `shotPlanning.shots[${index}].sceneId`);
    if (!Array.isArray(shot.characterIds)) throw new TypeError(`shotPlanning.shots[${index}].characterIds must be an array`);
    shot.characterIds.forEach((value, characterIndex) => id(value, `shotPlanning.shots[${index}].characterIds[${characterIndex}]`));
    if (!segmentIds.has(shot.segmentId)) throw new TypeError(`shotPlanning.shots[${index}].segmentId is not in videoSegments`);
    if (!sceneIds.has(shot.sceneId)) throw new TypeError(`shotPlanning.shots[${index}].sceneId is not in script.scenes`);
    for (const characterId of shot.characterIds) if (!characterIds.has(characterId)) throw new TypeError(`shotPlanning.shots[${index}] references unknown characterId ${characterId}`);
    const sceneCharacterIds = unique(shot.characterIds);
    const visibleCharacterIds = shot.visibleCharacterIds === undefined ? sceneCharacterIds : unique(shot.visibleCharacterIds);
    const offscreenCharacterIds = shot.offscreenCharacterIds === undefined ? [] : unique(shot.offscreenCharacterIds);
    const visibleSpeakerIds = shot.visibleSpeakerIds === undefined ? [] : unique(shot.visibleSpeakerIds);
    for (const [field, values] of [
      ['visibleCharacterIds', visibleCharacterIds],
      ['offscreenCharacterIds', offscreenCharacterIds],
      ['visibleSpeakerIds', visibleSpeakerIds]
    ]) {
      if (!Array.isArray(values)) throw new TypeError(`shotPlanning.shots[${index}].${field} must be an array`);
      for (const [characterIndex, characterId] of values.entries()) {
        id(characterId, `shotPlanning.shots[${index}].${field}[${characterIndex}]`);
        if (!sceneCharacterIds.includes(characterId)) throw new TypeError(`shotPlanning.shots[${index}].${field} must be a subset of characterIds`);
      }
    }
    if (offscreenCharacterIds.some(characterId => visibleCharacterIds.includes(characterId))) {
      throw new TypeError(`shotPlanning.shots[${index}] cannot bind the same character as visible and offscreen`);
    }
    if (visibleSpeakerIds.some(characterId => !visibleCharacterIds.includes(characterId))) {
      throw new TypeError(`shotPlanning.shots[${index}].visibleSpeakerIds must be visible in the same shot`);
    }
    validateIntent(shot.directorIntent, `shotPlanning.shots[${index}].directorIntent`);
    return {
      shotId: shot.shotId,
      segmentId: shot.segmentId,
      sceneId: shot.sceneId,
      // `characterIds` retains the broader scene context. Only the visible
      // list is allowed to route identity/performance controls downstream.
      characterIds: visibleCharacterIds,
      sceneCharacterIds,
      offscreenCharacterIds,
      visibleSpeakerIds,
      directorIntent: structuredClone(shot.directorIntent),
      legacyInference: false
    };
  });
}

function singleTakeContexts(plan) {
  const take = plan.shotPlanning.continuousTakePlan;
  const intent = take?.directorIntent;
  if (plan.schemaVersion >= 2) validateIntent(intent, 'shotPlanning.continuousTakePlan.directorIntent');
  const characterIds = Array.isArray(take?.characterIds) ? unique(take.characterIds) : (plan.characters ?? []).map(item => item.characterId);
  return (plan.videoSegments ?? []).map(segment => ({
    shotId: `${segment.segmentId}:continuous_take`,
    segmentId: segment.segmentId,
    sceneId: segment.sceneIds?.[0] ?? plan.script?.scenes?.[0]?.sceneId ?? 'scene-001',
    characterIds,
    directorIntent: intent ?? legacyShotContexts({ ...plan, shotPlanning: { shots: [{
      shotId: `${segment.segmentId}:continuous_take`, durationSec: segment.endSec - segment.startSec,
      purpose: segment.storyBeat, subjectAction: take?.phases?.join('；') ?? segment.storyBeat,
      shotContract: take?.cameraPath ?? 'continuous camera path', blocking: take?.blocking ?? 'continuous blocking',
      startState: take?.geography ?? 'accepted opening state', endState: take?.endState ?? segment.storyBeat,
      audio: 'follow locked script and audio plan'
    }] }, videoSegments: [{ ...segment, startSec: 0, endSec: segment.endSec - segment.startSec }] })[0].directorIntent,
    legacyInference: plan.schemaVersion < 2
  }));
}

function addCapability(target, idValue, reason, { requiredAssets } = {}) {
  if (target.some(item => item.id === idValue)) return;
  const definition = CAPABILITY_DEFINITIONS[idValue];
  const capability = { id: idValue, required: true, reason, ...structuredClone(definition) };
  if (requiredAssets !== undefined) capability.requiredAssets = structuredClone(requiredAssets);
  target.push(capability);
}

function productProofAssets(signals) {
  if (!Array.isArray(signals.requiredAssetTypes)) {
    return CAPABILITY_DEFINITIONS['product-proof-v1'].requiredAssets;
  }
  return signals.requiredAssetTypes.filter(type => PRODUCT_PROOF_ASSET_TYPES.has(type));
}

function routeShot(context, plan) {
  const { signals } = context.directorIntent;
  const capabilities = [];
  const simpleRemake = plan.sourceFactDelegation?.workflowProfileId === 'simple_remake';
  const hasMultipleVisibleCharacters = context.characterIds.length >= 2;
  const localDeterministic = signals.localDeterministic === true;
  const controlProfile = assertControlProfile(plan.directorPlan);
  const modelingControlled = !localDeterministic && controlProfile.controlMode === 'modeling_strong_control';
  const projectType = plan.directorPlan?.projectType ?? (signals.viralRemake ? 'viral_remake' : 'narrative');
  const replicationMode = ['viral_remake', 'faithful_remake'].includes(projectType) || signals.viralRemake;
  const explicitlySkippedAssets = skippedAssetPlanTypes(plan);
  const mannequinControlled = !modelingControlled && !localDeterministic && !explicitlySkippedAssets.includes('mannequin_grid') && replicationMode
    && (signals.complexPhysicalAction || signals.complexBlocking);
  const shotsInSegment = plan.shotPlanning.mode === 'shotlist'
    ? (plan.shotPlanning.shots ?? []).filter(shot => shot.segmentId === context.segmentId).length
    : 1;
  const storyboardDensity = plan.schemaVersion >= 2
    ? shotsInSegment
    : (plan.shotPlanning.shots?.length ?? 0);
  const mannequinReplacesStoryboard = plan.schemaVersion >= 2 && mannequinControlled;
  const modelingReplacesStoryboard = plan.schemaVersion >= 2 && modelingControlled;
  addCapability(capabilities, 'director-intent-v1', 'every shot must convert story purpose into observable directing choices');
  if (context.characterIds.length > 0) {
    addCapability(
      capabilities,
      'character-performance-v1',
      simpleRemake
        ? '简单复刻直接使用深度视频中的动作、遮挡与时序，不额外创建人物身份资产。'
        : 'visible characters require motivated actions, micro-motion, stable identity and anti-AI performance discipline',
      simpleRemake ? { requiredAssets: [] } : undefined
    );
  }
  if (hasMultipleVisibleCharacters
    && (signals.relationshipBeat || signals.requiresMutualEyeLine || signals.hasDialogue)) {
    addCapability(capabilities, 'relationship-eyeline-v1', 'multi-character relationship beat requires named gaze targets, reactions and coherent screen direction');
  }
  if (signals.emotionalTurn || signals.closePerformance || signals.relationshipBeat || (signals.hasDialogue && context.characterIds.length > 0)) {
    addCapability(capabilities, 'emotion-performance-v1', 'emotion, dialogue reaction or relationship subtext requires a playable visible performance plan');
  }
  const multiShot = plan.shotPlanning.mode === 'single_take' || (plan.shotPlanning.shots?.length ?? 0) > 1;
  if (multiShot) addCapability(capabilities, 'sequence-continuity-v1', 'connected beats require state, geography and endpoint continuity');
  if (!explicitlySkippedAssets.includes('storyboard')
    && !localDeterministic && !mannequinReplacesStoryboard && !modelingReplacesStoryboard && plan.shotPlanning.mode === 'shotlist'
    && (storyboardDensity >= 3 || signals.complexBlocking || signals.complexPhysicalAction)) {
    addCapability(capabilities, 'storyboard-control-v1', 'dense or complex shot progression benefits from one complete 15-second first-pass storyboard sheet');
  }
  if (mannequinControlled) addCapability(capabilities, 'mannequin-grid-v1', 'viral replication uses a frame-derived mannequin sequence as the specialized storyboard and pose evidence without source identity leakage');
  if (modelingControlled) addCapability(capabilities, 'modeling-control-v1', 'strong-control and one-to-one work uses one camera-matched Blender scene as the authoritative spatial and motion previsualization');
  if (signals.complexBlocking && !explicitlySkippedAssets.includes('camera_blocking')) {
    addCapability(capabilities, 'overhead-blocking-v1', 'complex people and camera paths need explicit geography');
  }
  if (signals.productInteraction !== 'none') {
    addCapability(
      capabilities,
      'product-proof-v1',
      `product interaction is ${signals.productInteraction}`,
      { requiredAssets: productProofAssets(signals) }
    );
  }

  const explicitlyRequired = (signals.requiredAssetTypes ?? []).filter(type => {
    if (localDeterministic && ['scene_multiview', 'storyboard', 'mannequin_grid'].includes(type)) return false;
    if (mannequinReplacesStoryboard && type === 'storyboard') return false;
    if (modelingReplacesStoryboard && ['storyboard', 'mannequin_grid'].includes(type)) return false;
    return true;
  });
  // Space references are not a universal prerequisite.  The locked asset plan is
  // the authority for whether a shot needs a scene board; forcing one here makes
  // a user-approved keyframe-only route silently grow an irrelevant asset batch.
  const plannedSceneAssets = requiredAssetPlanTypes(plan)
    .filter(type => type === 'scene_multiview' || type === 'scene_overhead');
  const plannedCharacterAssets = requiredAssetPlanTypes(plan);
  const depthControlled = plannedCharacterAssets.includes('depth_video_reference');
  const endpointFramesCarryIdentity = plannedCharacterAssets.includes('initial_blocking')
    && plannedCharacterAssets.includes('handoff_blocking')
    && (explicitlySkippedAssets.includes('character_identity_single_view')
      || explicitlySkippedAssets.includes('character_board'));
  const canonicalCharacterIdentityAsset = plannedCharacterAssets.includes('character_identity_single_view')
    && !plannedCharacterAssets.includes('character_board')
      ? 'character_identity_single_view'
      : plannedCharacterAssets.includes('character_product_state')
        && explicitlySkippedAssets.includes('character_board')
        ? 'character_product_state'
      : endpointFramesCarryIdentity
        ? 'initial_blocking'
        : 'character_board';
  const routeCapabilityAsset = type => {
    if (type === 'character_board') return canonicalCharacterIdentityAsset;
    if (type === 'camera_blocking' && depthControlled) return 'depth_video_reference';
    return type;
  };
  const requiredAssets = unique([
    ...(!localDeterministic ? plannedSceneAssets : []),
    ...explicitlyRequired,
    ...(!depthControlled && !explicitlySkippedAssets.includes('dialogue_axis_board')
      && ((signals.hasDialogue && signals.requiresMutualEyeLine) || signals.complexBlocking)
      && context.characterIds.length > 1 ? ['dialogue_axis_board'] : []),
    ...capabilities.flatMap(item => item.requiredAssets.map(routeCapabilityAsset))
  ]);
  if (modelingControlled) {
    requiredAssets.push('director_view_proxy');
    if (controlProfile.modelingInputMode === 'animatic_video') requiredAssets.push('spatial_control_animatic');
  }
  const requiredSkillIds = unique(capabilities.flatMap(item => item.skillIds));
  return {
    shotId: context.shotId,
    segmentId: context.segmentId,
    sceneId: context.sceneId,
    characterIds: context.characterIds,
    sceneCharacterIds: context.sceneCharacterIds ?? context.characterIds,
    offscreenCharacterIds: context.offscreenCharacterIds ?? [],
    visibleSpeakerIds: context.visibleSpeakerIds ?? [],
    legacyInference: context.legacyInference,
    signals: structuredClone(signals),
    resultContract: {
      narrativeFunction: context.directorIntent.narrativeFunction,
      valueTurn: context.directorIntent.valueTurn,
      povCharacter: context.directorIntent.povCharacter,
      powerShift: context.directorIntent.powerShift,
      subtext: context.directorIntent.subtext,
      feltIntent: context.directorIntent.feltIntent,
      whyThisShot: context.directorIntent.whyThisShot,
      audienceAttention: context.directorIntent.audienceAttention,
      expressiveDetail: context.directorIntent.expressiveDetail,
      intentCarriers: structuredClone(context.directorIntent.intentCarriers)
    },
    capabilities,
    requiredSkillIds,
    requiredAssets: unique(requiredAssets),
    requiredArtifacts: modelingControlled ? ['spatial_control_model'] : [],
    warnings: context.legacyInference ? ['legacy story plan used conservative local inference; create a schemaVersion 2 story plan for precise per-shot routing'] : []
  };
}

export function assertDirectorPlan(plan) {
  if (plan.schemaVersion < 2) return plan;
  if (!plan.directorPlan || typeof plan.directorPlan !== 'object' || Array.isArray(plan.directorPlan)) throw new TypeError('directorPlan is required for schemaVersion 2');
  if (!PROJECT_TYPES.has(plan.directorPlan.projectType)) throw new TypeError('directorPlan.projectType is invalid');
  inferTransformMode(plan.directorPlan.projectType, plan.directorPlan.transformMode);
  assertControlProfile(plan.directorPlan);
  for (const field of ['directorialVoice', 'audienceFeltIntent', 'visualStrategy', 'rhythmStrategy', 'realismStrategy']) text(plan.directorPlan[field], `directorPlan.${field}`);
  return plan;
}

export function assertDirectorRoutingInputs(plan) {
  assertDirectorPlan(plan);
  if (plan.schemaVersion < 2) return plan;
  if (plan.shotPlanning.mode === 'single_take') singleTakeContexts(plan);
  else explicitShotContexts(plan);
  return plan;
}

export function compileDirectorCapabilityManifest(plan, { storyPlanId = plan.id, storyPlanSha256 } = {}) {
  if (plan.schemaVersion < 2) {
    const error = new Error('director routing requires a schemaVersion 2 story plan with explicit per-shot directorIntent; legacy inference may not be activated as a verified route');
    error.code = 'DIRECTOR_ROUTE_STORY_PLAN_V2_REQUIRED';
    throw error;
  }
  assertDirectorRoutingInputs(plan);
  const executability = assessStoryPlanExecutability(plan);
  if (executability.status === 'BLOCKED') {
    const error = new Error(`director route is not executable: ${executability.findings.filter(item => item.severity === 'error').map(item => `${item.scope}:${item.id}`).join(', ')}`);
    error.code = 'DIRECTOR_ROUTE_EXECUTABILITY_BLOCKED';
    error.findings = executability.findings;
    throw error;
  }
  id(storyPlanId, 'storyPlanId');
  if (!SHA256.test(storyPlanSha256 ?? '')) throw new TypeError('storyPlanSha256 must be a lowercase SHA-256');
  const contexts = plan.shotPlanning.mode === 'single_take'
    ? singleTakeContexts(plan)
    : explicitShotContexts(plan);
  if (contexts.length === 0) throw new TypeError('director routing requires at least one shot or continuous-take segment');
  const shots = contexts.map(context => routeShot(context, plan));
  const requiredAssetsBySegment = {};
  const requiredArtifactsBySegment = {};
  for (const shot of shots) requiredAssetsBySegment[shot.segmentId] = unique([...(requiredAssetsBySegment[shot.segmentId] ?? []), ...shot.requiredAssets]);
  for (const shot of shots) requiredArtifactsBySegment[shot.segmentId] = unique([...(requiredArtifactsBySegment[shot.segmentId] ?? []), ...(shot.requiredArtifacts ?? [])]);
  const projectRequiredAssets = unique((plan.assetPlan ?? [])
    .filter(item => item.decision === 'required' && PROJECT_ASSET_TYPES.has(item.assetType))
    .map(item => item.assetType));
  const safeSourceContract = executionSourceContract(plan);
  return {
    schemaVersion: 1,
    id: `capability-${storyPlanId}-v7`,
    kind: 'capability_manifest',
    routeVersion: DIRECTOR_ROUTE_VERSION,
    routePrecision: 'explicit_v2',
    storyPlanSchemaVersion: 2,
    projectId: plan.projectId,
    storyPlanId,
    storyPlanSha256,
    projectType: plan.directorPlan.projectType,
    transformMode: executability.transformMode,
    controlMode: executability.controlMode,
    fidelityTarget: executability.fidelityTarget,
    modelingInputMode: executability.modelingInputMode,
    directorialVoice: plan.directorPlan.directorialVoice,
    executability,
    shots,
    ...(safeSourceContract ? { executionSourceContract: safeSourceContract } : {}),
    projectRequiredAssets,
    requiredAssetsBySegment,
    requiredArtifactsBySegment,
    createdAt: new Date().toISOString()
  };
}

export function assertCapabilityManifest(value, { allowLegacyMissingProjectRequiredAssets = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('capability manifest must be an object');
  if (value.schemaVersion !== 1 || value.kind !== 'capability_manifest'
    || !['director-route-v1', 'director-route-v2', 'director-route-v3', 'director-route-v4', 'director-route-v5', 'director-route-v6', DIRECTOR_ROUTE_VERSION].includes(value.routeVersion)) throw new TypeError('unsupported capability manifest');
  if (value.routePrecision !== 'explicit_v2' || value.storyPlanSchemaVersion !== 2) throw new TypeError('capability manifest must prove explicit schemaVersion 2 routing');
  id(value.id, 'id');
  assertProjectId(value.projectId);
  id(value.storyPlanId, 'storyPlanId');
  if (!SHA256.test(value.storyPlanSha256 ?? '')) throw new TypeError('storyPlanSha256 must be a lowercase SHA-256');
  if (value.executionSourceContract !== undefined) assertExecutionSourceContract(value.executionSourceContract);
  if (!PROJECT_TYPES.has(value.projectType)) throw new TypeError('projectType is invalid');
  if (value.transformMode !== undefined) inferTransformMode(value.projectType, value.transformMode);
  if (value.executability !== undefined) {
    if (!value.executability || !['PASS', 'WARN'].includes(value.executability.status)) throw new TypeError('capability manifest executability must be PASS or WARN');
    if (!Array.isArray(value.executability.findings) || !Array.isArray(value.executability.generationGuidance)) {
      throw new TypeError('capability manifest executability requires findings and generationGuidance arrays');
    }
  }
  text(value.directorialVoice, 'directorialVoice');
  if (!Array.isArray(value.shots) || value.shots.length === 0) throw new TypeError('shots must be a non-empty array');
  const projectRequiredAssets = value.projectRequiredAssets === undefined && allowLegacyMissingProjectRequiredAssets
    ? []
    : value.projectRequiredAssets;
  if (!Array.isArray(projectRequiredAssets) || projectRequiredAssets.some(type => !PROJECT_ASSET_TYPES.has(type))) {
    throw new TypeError('projectRequiredAssets must contain only canonical project asset types');
  }
  const shotIds = new Set();
  for (const shot of value.shots) {
    for (const field of ['shotId', 'segmentId', 'sceneId']) text(shot[field], `shot.${field}`);
    if (shotIds.has(shot.shotId)) throw new TypeError(`duplicate routed shotId: ${shot.shotId}`);
    shotIds.add(shot.shotId);
    if (shot.legacyInference !== false) {
      throw new TypeError(`shot ${shot.shotId} uses legacy inference and cannot be accepted as a verified capability route`);
    }
    if (!Array.isArray(shot.capabilities) || shot.capabilities.length === 0) throw new TypeError(`shot ${shot.shotId} requires capabilities`);
    for (const capability of shot.capabilities) {
      if (!CAPABILITY_DEFINITIONS[capability.id]) throw new TypeError(`unknown capability: ${capability.id}`);
      text(capability.reason, `capability ${capability.id}.reason`);
    }
    if (!Array.isArray(shot.requiredSkillIds) || !shot.requiredSkillIds.includes('seedance2-prompt')) throw new TypeError(`shot ${shot.shotId} must require seedance2-prompt`);
    if (!Array.isArray(shot.requiredAssets)) throw new TypeError(`shot ${shot.shotId}.requiredAssets must be an array`);
    if (shot.sceneCharacterIds !== undefined && (!Array.isArray(shot.sceneCharacterIds) || shot.sceneCharacterIds.some(item => typeof item !== 'string'))) {
      throw new TypeError(`shot ${shot.shotId}.sceneCharacterIds must be a string array`);
    }
    if (shot.offscreenCharacterIds !== undefined && (!Array.isArray(shot.offscreenCharacterIds) || shot.offscreenCharacterIds.some(item => typeof item !== 'string'))) {
      throw new TypeError(`shot ${shot.shotId}.offscreenCharacterIds must be a string array`);
    }
    if (shot.visibleSpeakerIds !== undefined && (!Array.isArray(shot.visibleSpeakerIds)
      || shot.visibleSpeakerIds.some(item => typeof item !== 'string' || !shot.characterIds.includes(item)))) {
      throw new TypeError(`shot ${shot.shotId}.visibleSpeakerIds must be a subset of visible characterIds`);
    }
    const requiredArtifacts = shot.requiredArtifacts ?? [];
    if (!Array.isArray(requiredArtifacts)) throw new TypeError(`shot ${shot.shotId}.requiredArtifacts must be an array`);
  }
  if (!value.requiredAssetsBySegment || typeof value.requiredAssetsBySegment !== 'object' || Array.isArray(value.requiredAssetsBySegment)) throw new TypeError('requiredAssetsBySegment must be an object');
  const requiredArtifactsBySegment = value.requiredArtifactsBySegment ?? {};
  if (!requiredArtifactsBySegment || typeof requiredArtifactsBySegment !== 'object' || Array.isArray(requiredArtifactsBySegment)) throw new TypeError('requiredArtifactsBySegment must be an object');
  text(value.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(value.createdAt))) throw new TypeError('createdAt must be a date-time');
  return value.projectRequiredAssets === undefined
    ? { ...value, projectRequiredAssets }
    : value;
}

export function routedShotsForSegment(manifest, segmentId) {
  assertCapabilityManifest(manifest);
  return manifest.shots.filter(shot => shot.segmentId === segmentId);
}

export const DIRECTOR_CAPABILITIES = CAPABILITY_DEFINITIONS;
