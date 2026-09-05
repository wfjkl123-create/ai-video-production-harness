import { createHash } from 'node:crypto';

const SEGMENTATION_STRATEGIES = new Set(['scene', 'story_beat', 'hybrid', 'single_clip']);
const EXECUTION_MODES = new Set(['parallel', 'sequential', 'mixed']);
const SHOT_MODES = new Set(['shotlist', 'single_take']);
const ASSET_DECISIONS = new Set(['required', 'conditional', 'skipped']);
const CANONICAL_ASSET_TYPES = new Set([
  'character_board', 'character_identity_single_view', 'scene_multiview', 'scene_overhead', 'product_reference',
  'story_prop', 'wardrobe_board', 'color_board', 'initial_blocking', 'handoff_blocking', 'camera_blocking',
  'director_view_proxy', 'dialogue_axis_board', 'storyboard', 'mannequin_grid', 'character_product_state',
  'spatial_control_animatic', 'depth_video_reference', 'expression_board', 'dialogue_audio_reference', 'timing_audio_reference', 'source_audio_candidate'
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PLACEHOLDER = /(TODO|TBD|待填写|请填写|用一句话写清|场景地点|按顺序写清)/i;
const VISUAL_CONTROL_METHODS = new Set(['storyboard', 'depth', 'modeling']);
const NARRATIVE_STRUCTURE_MODES = new Set(['narrative', 'product_demo', 'faithful_remake']);
const VIDEO_GENERATION_PROFILES = Object.freeze({
  legacy_standard_15: Object.freeze({ maxSegmentDurationSec: 15 }),
  seedance_2_5_standard_30: Object.freeze({ maxSegmentDurationSec: 30 })
});
import { assertDirectorRoutingInputs } from './director-capability.js';
import { assertSourceFactContract } from './reference-workflow.js';
import { assertCreativeBrief } from './creative-brief.js';
import { assertProjectId } from './project-id.js';

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  if (PLACEHOLDER.test(value)) throw new TypeError(`${field} contains an unresolved template placeholder`);
}

function id(value, field) {
  text(value, field);
  if (!SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function array(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
}

function number(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${field} must be between ${min} and ${max}`);
}

function storyFields(value, structureMode = 'narrative') {
  for (const field of ['logline', 'storyPromise', 'finalOutcome', 'tone']) text(value[field], `story.${field}`);
  if (NARRATIVE_STRUCTURE_MODES.has(structureMode)) {
    for (const field of ['initialCondition', 'objective', 'centralConflict', 'turn', 'climax']) text(value[field], `story.${field}`);
  } else {
    text(value.progression, 'story.progression');
    for (const field of ['initialCondition', 'objective', 'centralConflict', 'turn', 'climax']) {
      if (value[field] !== undefined) text(value[field], `story.${field}`);
    }
  }
}

function characters(value, characterMode = 'character_driven') {
  if (!Array.isArray(value)) throw new TypeError('characters must be an array');
  if (characterMode === 'character_driven' && value.length === 0) {
    throw new TypeError('character_driven story plans require at least one character');
  }
  if (characterMode === 'none' && value.length > 0) {
    throw new TypeError('characterMode none requires an empty characters array');
  }
  const ids = new Set();
  for (const [index, character] of value.entries()) {
    object(character, `characters[${index}]`);
    id(character.characterId, `characters[${index}].characterId`);
    text(character.tag, `characters[${index}].tag`);
    for (const field of ['role', 'background', 'personality', 'stance', 'objective', 'obstacle', 'appearance', 'wardrobeLock', 'relationshipMap', 'arc']) text(character[field], `characters[${index}].${field}`);
    if (ids.has(character.characterId)) throw new TypeError(`duplicate characterId: ${character.characterId}`);
    ids.add(character.characterId);
  }
}

const CONTINUITY_STRATEGIES = new Set(['canonical_open', 'editorial_cut', 'continuous_proxy_handoff']);

function segments(value, targetDurationSec, schemaVersion, maxSegmentDurationSec = 15) {
  array(value, 'videoSegments');
  let cursor = 0;
  const ids = new Set();
  for (const [index, segment] of value.entries()) {
    id(segment.segmentId, `videoSegments[${index}].segmentId`);
    if (ids.has(segment.segmentId)) throw new TypeError(`duplicate segmentId: ${segment.segmentId}`);
    ids.add(segment.segmentId);
    number(segment.startSec, `videoSegments[${index}].startSec`);
    number(segment.endSec, `videoSegments[${index}].endSec`);
    if (Math.abs(segment.startSec - cursor) > 0.001 || segment.endSec <= segment.startSec) throw new TypeError('videoSegments must cover the timeline contiguously');
    if (segment.endSec - segment.startSec > maxSegmentDurationSec) {
      throw new TypeError(`video segment ${segment.segmentId} exceeds ${maxSegmentDurationSec} seconds`);
    }
    text(segment.storyBeat, `videoSegments[${index}].storyBeat`);
    text(segment.splitReason, `videoSegments[${index}].splitReason`);
    if (schemaVersion >= 2) {
      if (!CONTINUITY_STRATEGIES.has(segment.continuityStrategy)) {
        throw new TypeError(`videoSegments[${index}].continuityStrategy is required for schemaVersion 2`);
      }
      if (index === 0 && segment.continuityStrategy !== 'canonical_open') {
        throw new TypeError('the first video segment must use canonical_open');
      }
    } else if (segment.continuityStrategy !== undefined && !CONTINUITY_STRATEGIES.has(segment.continuityStrategy)) {
      throw new TypeError(`videoSegments[${index}].continuityStrategy is invalid`);
    }
    array(segment.sceneIds, `videoSegments[${index}].sceneIds`);
    cursor = segment.endSec;
  }
  if (Math.abs(cursor - targetDurationSec) > 0.001) throw new TypeError('videoSegments must end at targetDurationSec');
}

function shotPlanning(value, targetDurationSec) {
  object(value, 'shotPlanning');
  if (!SHOT_MODES.has(value.mode)) throw new TypeError('shotPlanning.mode must be shotlist or single_take');
  if (value.mode === 'shotlist') {
    array(value.shots, 'shotPlanning.shots');
    const ids = new Set();
    let total = 0;
    let timeCursor = 0;
    let usesExplicitTimeline = false;
    for (const [index, shot] of value.shots.entries()) {
      id(shot.shotId, `shotPlanning.shots[${index}].shotId`);
      if (ids.has(shot.shotId)) throw new TypeError(`duplicate shotId: ${shot.shotId}`);
      ids.add(shot.shotId);
      number(shot.durationSec, `shotPlanning.shots[${index}].durationSec`, { min: 0.01, max: 15 });
      const hasStart = shot.startSec !== undefined;
      const hasEnd = shot.endSec !== undefined;
      if (hasStart !== hasEnd) throw new TypeError(`shotPlanning.shots[${index}] must declare both startSec and endSec or neither`);
      if (hasStart) {
        number(shot.startSec, `shotPlanning.shots[${index}].startSec`, { min: 0, max: targetDurationSec });
        number(shot.endSec, `shotPlanning.shots[${index}].endSec`, { min: 0, max: targetDurationSec });
        if (Math.abs(shot.startSec - timeCursor) > 0.001) throw new TypeError('explicit shot timeline must be contiguous and start at 0');
        if (shot.endSec <= shot.startSec || Math.abs((shot.endSec - shot.startSec) - shot.durationSec) > 0.001) {
          throw new TypeError(`shotPlanning.shots[${index}] explicit timing must match durationSec`);
        }
        usesExplicitTimeline = true;
      } else if (usesExplicitTimeline) {
        throw new TypeError('all shots must declare explicit timing when any shot declares it');
      }
      total += shot.durationSec;
      timeCursor += shot.durationSec;
      for (const field of ['purpose', 'subjectAction', 'shotContract', 'blocking', 'startState', 'endState', 'audio']) text(shot[field], `shotPlanning.shots[${index}].${field}`);
      array(shot.continuityAnchors, `shotPlanning.shots[${index}].continuityAnchors`);
      array(shot.risks, `shotPlanning.shots[${index}].risks`);
    }
    if (Math.abs(total - targetDurationSec) > 0.01) throw new TypeError('shot durations must sum to targetDurationSec');
    if (usesExplicitTimeline && Math.abs(timeCursor - targetDurationSec) > 0.001) throw new TypeError('explicit shot timeline must end at targetDurationSec');
    if (value.shots.length > 12 && !value.roughStoryboardPreview) throw new TypeError('shot lists longer than 12 shots require roughStoryboardPreview');
    if (value.roughStoryboardPreview) {
      object(value.roughStoryboardPreview, 'shotPlanning.roughStoryboardPreview');
      text(value.roughStoryboardPreview.path, 'shotPlanning.roughStoryboardPreview.path');
    }
    if (value.continuousTakePlan !== null) throw new TypeError('shotlist mode requires continuousTakePlan to be null');
  } else {
    if (!Array.isArray(value.shots) || value.shots.length !== 0) throw new TypeError('single_take mode must not contain shot rows');
    object(value.continuousTakePlan, 'shotPlanning.continuousTakePlan');
    array(value.continuousTakePlan.phases, 'shotPlanning.continuousTakePlan.phases');
    if (value.continuousTakePlan.phases.length < 3) throw new TypeError('single_take requires at least Beginning, Then, and Finally phases');
    for (const field of ['blocking', 'cameraPath', 'geography', 'endState', 'reservedFutureActions']) text(value.continuousTakePlan[field], `shotPlanning.continuousTakePlan.${field}`);
  }
}

function assertShotSegmentMembership(shotPlan, videoSegments) {
  if (shotPlan.mode !== 'shotlist') return;
  const segmentsById = new Map(videoSegments.map(segment => [segment.segmentId, segment]));
  for (const [index, shot] of shotPlan.shots.entries()) {
    id(shot.segmentId, `shotPlanning.shots[${index}].segmentId`);
    id(shot.sceneId, `shotPlanning.shots[${index}].sceneId`);
    const segment = segmentsById.get(shot.segmentId);
    if (!segment) throw new TypeError(`shotPlanning.shots[${index}].segmentId must exist in videoSegments`);
    if (!segment.sceneIds.includes(shot.sceneId)) throw new TypeError(`shotPlanning.shots[${index}].sceneId must belong to its video segment`);
    if (shot.startSec !== undefined && (shot.startSec < segment.startSec - 0.001 || shot.endSec > segment.endSec + 0.001)) {
      throw new TypeError(`shotPlanning.shots[${index}] must remain inside its declared video segment`);
    }
  }
}

function scriptScenes(value, structureMode = 'narrative') {
  array(value, 'script.scenes');
  const ids = new Set();
  for (const [index, scene] of value.entries()) {
    id(scene.sceneId, `script.scenes[${index}].sceneId`);
    if (ids.has(scene.sceneId)) throw new TypeError(`duplicate sceneId: ${scene.sceneId}`);
    ids.add(scene.sceneId);
    for (const field of ['location', 'timeOfDay', 'sceneFunction', 'pov']) text(scene[field], `script.scenes[${index}].${field}`);
    for (const field of ['powerShift', 'subtext']) {
      if (NARRATIVE_STRUCTURE_MODES.has(structureMode)) text(scene[field], `script.scenes[${index}].${field}`);
      else if (scene[field] !== undefined) text(scene[field], `script.scenes[${index}].${field}`);
    }
    array(scene.beats, `script.scenes[${index}].beats`);
    scene.beats.forEach((beat, beatIndex) => text(beat, `script.scenes[${index}].beats[${beatIndex}]`));
    if (!Array.isArray(scene.dialogue)) throw new TypeError(`script.scenes[${index}].dialogue must be an array`);
  }
}

function assetPlan(value, schemaVersion) {
  array(value, 'assetPlan');
  const types = new Set();
  for (const [index, item] of value.entries()) {
    id(item.assetType, `assetPlan[${index}].assetType`);
    if (schemaVersion >= 2 && !CANONICAL_ASSET_TYPES.has(item.assetType)) {
      throw new TypeError(`assetPlan[${index}].assetType must use a canonical asset category for schemaVersion 2: ${item.assetType}`);
    }
    if (types.has(item.assetType)) throw new TypeError(`duplicate assetType: ${item.assetType}`);
    types.add(item.assetType);
    if (!ASSET_DECISIONS.has(item.decision)) throw new TypeError(`assetPlan[${index}].decision must be required, conditional, or skipped`);
    text(item.reason, `assetPlan[${index}].reason`);
  }
}

function assetScope(value) {
  if (value === undefined) return;
  object(value, 'assetScope');
  if (value.excludedArtifactIds !== undefined) {
    if (!Array.isArray(value.excludedArtifactIds)) throw new TypeError('assetScope.excludedArtifactIds must be an array');
    const ids = new Set();
    for (const [index, artifactId] of value.excludedArtifactIds.entries()) {
      id(artifactId, `assetScope.excludedArtifactIds[${index}]`);
      if (ids.has(artifactId)) throw new TypeError(`duplicate assetScope.excludedArtifactIds: ${artifactId}`);
      ids.add(artifactId);
    }
  }
  if (value.requiredBeforeGate3 !== undefined) {
    if (!Array.isArray(value.requiredBeforeGate3)) throw new TypeError('assetScope.requiredBeforeGate3 must be an array');
    value.requiredBeforeGate3.forEach((item, index) => text(item, `assetScope.requiredBeforeGate3[${index}]`));
  }
}

function finalExecutionDecision(value) {
  object(value, 'finalExecutionDecision');
  if (!SEGMENTATION_STRATEGIES.has(value.segmentationStrategy)) throw new TypeError('finalExecutionDecision.segmentationStrategy is invalid');
  text(value.segmentationRationale, 'finalExecutionDecision.segmentationRationale');
  if (!EXECUTION_MODES.has(value.assetExecutionMode)) throw new TypeError('finalExecutionDecision.assetExecutionMode is invalid');
  if (!EXECUTION_MODES.has(value.videoExecutionMode)) throw new TypeError('finalExecutionDecision.videoExecutionMode is invalid');
  array(value.parallelPlan, 'finalExecutionDecision.parallelPlan');
  value.parallelPlan.forEach((item, index) => text(item, `finalExecutionDecision.parallelPlan[${index}]`));
  text(value.assetScopeBasis, 'finalExecutionDecision.assetScopeBasis');
  if (value.videoGenerationProfile !== undefined && !VIDEO_GENERATION_PROFILES[value.videoGenerationProfile]) {
    throw new TypeError('finalExecutionDecision.videoGenerationProfile is invalid');
  }
}

function maxSegmentDurationFor(value) {
  const profileId = value.finalExecutionDecision?.videoGenerationProfile ?? 'legacy_standard_15';
  return VIDEO_GENERATION_PROFILES[profileId].maxSegmentDurationSec;
}

function assertFinalExecutionConsistency(value) {
  if (value.finalExecutionDecision === undefined) return;
  if (value.finalExecutionDecision.segmentationStrategy === 'single_clip' && value.videoSegments.length !== 1) {
    throw new TypeError('final single_clip execution requires exactly one video segment');
  }
  if (value.finalExecutionDecision.videoExecutionMode === 'parallel'
    && value.videoSegments.some(segment => segment.continuityStrategy === 'continuous_proxy_handoff')) {
    throw new TypeError('parallel video execution cannot contain continuous_proxy_handoff segments');
  }
}

// A source-authority plan may name the exact canonical segmentation candidate
// that will be machine-validated and auto-locked immediately after the existing
// Gate 2 story-plan approval.  The human still reviews only the story plan; this
// binding prevents a same-named, stale segmentation from being silently reused.
function segmentationCandidate(value) {
  if (value === undefined) return;
  object(value, 'segmentationCandidate');
  id(value.artifactId, 'segmentationCandidate.artifactId');
  if (value.expectedRevision !== undefined) {
    number(value.expectedRevision, 'segmentationCandidate.expectedRevision', { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!Number.isInteger(value.expectedRevision)) throw new TypeError('segmentationCandidate.expectedRevision must be an integer');
  }
  if (value.expectedStoryPlanFingerprintSha256 !== undefined
    && !SHA256.test(value.expectedStoryPlanFingerprintSha256)) {
    throw new TypeError('segmentationCandidate.expectedStoryPlanFingerprintSha256 must be a lowercase SHA-256');
  }
}

// A persisted story-plan SHA cannot be embedded in its own companion
// segmentation without a circular hash. This stable semantic fingerprint
// deliberately excludes publication fields and the self-referential candidate
// binding, while retaining every director/source/shot decision that the
// segmentation must match.
export function storyPlanSegmentationFingerprint(value) {
  const plan = structuredClone(value);
  delete plan.segmentationCandidate;
  delete plan.kind;
  delete plan.status;
  delete plan.creativeBriefSha256;
  // createStoryPlan takes these two values from the locked creative brief.
  // Remove caller-supplied copies so a pre-publication candidate hashes the
  // same semantic plan as the persisted canonical story plan.
  delete plan.targetDurationSec;
  delete plan.creativeDecision;
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export function assertStoryPlan(value) {
  object(value, 'story plan');
  if (![1, 2].includes(value.schemaVersion)) throw new TypeError('schemaVersion must be 1 or 2');
  id(value.id, 'id');
  assertProjectId(value.projectId);
  id(value.creativeBriefId, 'creativeBriefId');
  number(value.targetDurationSec, 'targetDurationSec', { min: 1, max: 3600 });
  object(value.creativeDecision, 'creativeDecision');
  text(value.creativeDecision.storyDirection, 'creativeDecision.storyDirection');
  if (!SEGMENTATION_STRATEGIES.has(value.creativeDecision.segmentationStrategy)) throw new TypeError('unknown segmentationStrategy');
  text(value.creativeDecision.segmentationRationale, 'creativeDecision.segmentationRationale');
  if (!EXECUTION_MODES.has(value.creativeDecision.executionMode)) throw new TypeError('unknown executionMode');
  if (!EXECUTION_MODES.has(value.creativeDecision.assetExecutionMode)) throw new TypeError('unknown assetExecutionMode');
  if (!EXECUTION_MODES.has(value.creativeDecision.videoExecutionMode)) throw new TypeError('unknown videoExecutionMode');
  text(value.creativeDecision.successDefinition, 'creativeDecision.successDefinition');
  if (value.creativeDecision.visualControlMethod !== undefined && !VISUAL_CONTROL_METHODS.has(value.creativeDecision.visualControlMethod)) {
    throw new TypeError('creativeDecision.visualControlMethod must be storyboard, depth, or modeling');
  }
  array(value.creativeDecision.parallelPlan, 'creativeDecision.parallelPlan');
  array(value.creativeDecision.estimatedAssetCombination, 'creativeDecision.estimatedAssetCombination');
  const creativeContract = value.creativeDecision.directorCreativeContract;
  if (creativeContract !== undefined) {
    assertCreativeBrief({
      schemaVersion: 3, id: value.creativeBriefId, projectId: value.projectId, targetDurationSec: value.targetDurationSec,
      creativeDecision: value.creativeDecision, lockedConstraints: ['Inherited from the locked Gate 1 creative brief']
    });
    finalExecutionDecision(value.finalExecutionDecision);
  }
  else if (value.finalExecutionDecision !== undefined) finalExecutionDecision(value.finalExecutionDecision);
  if (value.creativeDecision.referenceWorkflow !== undefined) {
    assertSourceFactContract(
      value.sourceFactContract,
      value.creativeDecision.referenceWorkflow,
      value.creativeDecision,
      value.sourceFactDelegation?.workflowProfileId ?? null
    );
  } else if (value.sourceFactContract !== undefined) {
    throw new TypeError('sourceFactContract requires creativeDecision.referenceWorkflow');
  }
  if (value.sourceFactDelegation !== undefined) {
    if (!value.sourceFactDelegation || typeof value.sourceFactDelegation !== 'object' || Array.isArray(value.sourceFactDelegation)) {
      throw new TypeError('sourceFactDelegation must be an object');
    }
    if (value.sourceFactDelegation.workflowProfileId !== 'simple_remake') {
      throw new TypeError('sourceFactDelegation.workflowProfileId must be simple_remake');
    }
    if (typeof value.sourceFactDelegation.reason !== 'string' || value.sourceFactDelegation.reason.trim() === '') {
      throw new TypeError('sourceFactDelegation.reason must be a non-empty string');
    }
  }
  object(value.story, 'story');
  const structureMode = creativeContract?.structureMode ?? 'narrative';
  const characterMode = creativeContract?.characterMode ?? 'character_driven';
  storyFields(value.story, structureMode);
  characters(value.characters, characterMode);
  object(value.script, 'script');
  scriptScenes(value.script.scenes, structureMode);
  segments(value.videoSegments, value.targetDurationSec, value.schemaVersion, maxSegmentDurationFor(value));
  assertFinalExecutionConsistency(value);
  shotPlanning(value.shotPlanning, value.targetDurationSec);
  assertShotSegmentMembership(value.shotPlanning, value.videoSegments);
  assetPlan(value.assetPlan, value.schemaVersion);
  assetScope(value.assetScope);
  segmentationCandidate(value.segmentationCandidate);
  assertDirectorRoutingInputs(value);
  return value;
}
