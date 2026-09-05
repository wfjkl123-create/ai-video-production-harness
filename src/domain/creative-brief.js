const SEGMENTATION_STRATEGIES = new Set(['scene', 'story_beat', 'hybrid', 'single_clip']);
const EXECUTION_MODES = new Set(['parallel', 'sequential', 'mixed']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const PLACEHOLDER = /(TODO|TBD|待填写|请填写|用一句话写清|选择一种|示例)/i;
const VISUAL_CONTROL_METHODS = new Set(['storyboard', 'depth', 'modeling']);
const CHARACTER_IMPORTANCE = new Set(['lead', 'key_opponent', 'supporting', 'functional']);
const UNCERTAINTY_DISPOSITIONS = new Set([
  'must_answer_now', 'director_recommendation', 'deferred_to_gate2', 'experiment_required', 'irrelevant_to_scope'
]);
const UNCERTAINTY_OWNERS = new Set(['user', 'director', 'system', 'evidence']);
const UNCERTAINTY_STATUSES = new Set(['resolved', 'deferred', 'planned', 'not_applicable', 'unresolved']);
const STRUCTURE_MODES = new Set(['narrative', 'montage', 'interview', 'product_demo', 'local_edit', 'faithful_remake', 'other']);
const NARRATIVE_STRUCTURE_MODES = new Set(['narrative', 'product_demo', 'faithful_remake']);
const CHARACTER_MODES = new Set(['character_driven', 'subject_only', 'none']);
import { assertReferenceWorkflow } from './reference-workflow.js';
import { assertProjectId } from './project-id.js';

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  if (PLACEHOLDER.test(value)) throw new TypeError(`${field} contains an unresolved template placeholder`);
}

function id(value, field) {
  text(value, field);
  if (!SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function textArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  value.forEach((item, index) => text(item, `${field}[${index}]`));
}

function array(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function enumValue(value, allowed, field) {
  if (!allowed.has(value)) throw new TypeError(`${field} has an unsupported value`);
}

function directorCreativeContract(value) {
  object(value, 'creativeDecision.directorCreativeContract');
  enumValue(value.structureMode, STRUCTURE_MODES, 'creativeDecision.directorCreativeContract.structureMode');
  enumValue(value.characterMode, CHARACTER_MODES, 'creativeDecision.directorCreativeContract.characterMode');

  object(value.projectIntent, 'creativeDecision.directorCreativeContract.projectIntent');
  for (const field of ['purpose', 'audience', 'desiredAudienceEffect', 'deliveryContext']) {
    text(value.projectIntent[field], `creativeDecision.directorCreativeContract.projectIntent.${field}`);
  }
  if (typeof value.projectIntent.commercialIntent !== 'boolean') {
    throw new TypeError('creativeDecision.directorCreativeContract.projectIntent.commercialIntent must be a boolean');
  }
  if (value.projectIntent.commercialIntent) {
    text(value.projectIntent.productDramaticFunction, 'creativeDecision.directorCreativeContract.projectIntent.productDramaticFunction');
    if (value.projectIntent.nonCommercialRationale !== undefined) {
      throw new TypeError('commercial creative briefs must not retain nonCommercialRationale');
    }
  } else {
    text(value.projectIntent.nonCommercialRationale, 'creativeDecision.directorCreativeContract.projectIntent.nonCommercialRationale');
    if (value.projectIntent.productDramaticFunction !== undefined) {
      throw new TypeError('non-commercial creative briefs must not retain productDramaticFunction');
    }
  }

  object(value.recommendedDirection, 'creativeDecision.directorCreativeContract.recommendedDirection');
  for (const field of ['directionId', 'logline', 'coreMeaning', 'extensionOfUserIdea', 'progressionLogic']) {
    text(value.recommendedDirection[field], `creativeDecision.directorCreativeContract.recommendedDirection.${field}`);
  }
  for (const field of ['centralConflict', 'coreTurn', 'endingPayoff']) {
    if (NARRATIVE_STRUCTURE_MODES.has(value.structureMode)) {
      text(value.recommendedDirection[field], `creativeDecision.directorCreativeContract.recommendedDirection.${field}`);
    } else if (value.recommendedDirection[field] !== undefined) {
      text(value.recommendedDirection[field], `creativeDecision.directorCreativeContract.recommendedDirection.${field}`);
    }
  }
  id(value.recommendedDirection.directionId, 'creativeDecision.directorCreativeContract.recommendedDirection.directionId');
  object(value.recommendedDirection.openingDesign, 'creativeDecision.directorCreativeContract.recommendedDirection.openingDesign');
  for (const field of ['firstFrame', 'trigger', 'audienceQuestion', 'storyBridge', 'rationale']) {
    text(value.recommendedDirection.openingDesign[field], `creativeDecision.directorCreativeContract.recommendedDirection.openingDesign.${field}`);
  }
  object(value.recommendedDirection.recommendationRationale, 'creativeDecision.directorCreativeContract.recommendedDirection.recommendationRationale');
  for (const field of ['audienceEffect', 'storyCausality', 'executionRisk']) {
    text(value.recommendedDirection.recommendationRationale[field], `creativeDecision.directorCreativeContract.recommendedDirection.recommendationRationale.${field}`);
  }
  if (value.projectIntent.commercialIntent) {
    text(value.recommendedDirection.recommendationRationale.productFunction, 'creativeDecision.directorCreativeContract.recommendedDirection.recommendationRationale.productFunction');
  } else if (value.recommendedDirection.recommendationRationale.productFunction !== undefined) {
    throw new TypeError('non-commercial creative briefs must not retain recommendationRationale.productFunction');
  }

  array(value.alternativesConsidered, 'creativeDecision.directorCreativeContract.alternativesConsidered');
  if (value.alternativesConsidered.length > 2) throw new TypeError('creativeDecision.directorCreativeContract.alternativesConsidered allows at most two meaningful alternatives');
  const directionIds = new Set([value.recommendedDirection.directionId]);
  for (const [index, alternative] of value.alternativesConsidered.entries()) {
    object(alternative, `creativeDecision.directorCreativeContract.alternativesConsidered[${index}]`);
    for (const field of ['directionId', 'materialDifference', 'expectedAudienceEffect', 'tradeoff', 'notSelectedReason']) {
      text(alternative[field], `creativeDecision.directorCreativeContract.alternativesConsidered[${index}].${field}`);
    }
    id(alternative.directionId, `creativeDecision.directorCreativeContract.alternativesConsidered[${index}].directionId`);
    if (directionIds.has(alternative.directionId)) throw new TypeError(`duplicate creative directionId: ${alternative.directionId}`);
    directionIds.add(alternative.directionId);
  }

  array(value.characters, 'creativeDecision.directorCreativeContract.characters');
  const characterIds = new Set();
  for (const [index, character] of value.characters.entries()) {
    object(character, `creativeDecision.directorCreativeContract.characters[${index}]`);
    id(character.characterId, `creativeDecision.directorCreativeContract.characters[${index}].characterId`);
    enumValue(character.importance, CHARACTER_IMPORTANCE, `creativeDecision.directorCreativeContract.characters[${index}].importance`);
    for (const field of ['dramaticFunction', 'emotionalBaseline', 'audienceRelationship', 'visibleBehavior']) {
      text(character[field], `creativeDecision.directorCreativeContract.characters[${index}].${field}`);
    }
    if (['lead', 'key_opponent'].includes(character.importance)) {
      for (const field of ['objective', 'obstacle', 'tactic', 'arc']) {
        text(character[field], `creativeDecision.directorCreativeContract.characters[${index}].${field}`);
      }
    }
    if (characterIds.has(character.characterId)) throw new TypeError(`duplicate characterId: ${character.characterId}`);
    characterIds.add(character.characterId);
  }
  if (value.characterMode === 'character_driven'
    && !value.characters.some(character => ['lead', 'key_opponent'].includes(character.importance))) {
    throw new TypeError('character_driven creative briefs require at least one lead or key_opponent');
  }
  if (value.characterMode === 'none' && value.characters.length > 0) {
    throw new TypeError('characterMode none requires an empty characters array');
  }

  textArray(value.storyOutline, 'creativeDecision.directorCreativeContract.storyOutline');
  if (NARRATIVE_STRUCTURE_MODES.has(value.structureMode) && value.storyOutline.length < 3) {
    throw new TypeError('creativeDecision.directorCreativeContract.storyOutline requires at least opening, turn, and payoff for narrative structures');
  }
  textArray(value.scenePriorities, 'creativeDecision.directorCreativeContract.scenePriorities');

  object(value.emotionAndRhythm, 'creativeDecision.directorCreativeContract.emotionAndRhythm');
  for (const field of ['emotionCurve', 'rhythmStrategy']) {
    text(value.emotionAndRhythm[field], `creativeDecision.directorCreativeContract.emotionAndRhythm.${field}`);
  }
  object(value.audiovisualStrategy, 'creativeDecision.directorCreativeContract.audiovisualStrategy');
  for (const field of ['pointOfView', 'cameraMotive', 'editingStrategy', 'soundStrategy']) {
    text(value.audiovisualStrategy[field], `creativeDecision.directorCreativeContract.audiovisualStrategy.${field}`);
  }
  array(value.audiovisualStrategy.specialTechniques, 'creativeDecision.directorCreativeContract.audiovisualStrategy.specialTechniques');
  value.audiovisualStrategy.specialTechniques.forEach((item, index) => text(item, `creativeDecision.directorCreativeContract.audiovisualStrategy.specialTechniques[${index}]`));

  object(value.creativeBoundaries, 'creativeDecision.directorCreativeContract.creativeBoundaries');
  array(value.creativeBoundaries.mustKeep, 'creativeDecision.directorCreativeContract.creativeBoundaries.mustKeep');
  value.creativeBoundaries.mustKeep.forEach((item, index) => text(item, `creativeDecision.directorCreativeContract.creativeBoundaries.mustKeep[${index}]`));
  textArray(value.creativeBoundaries.mustAvoid, 'creativeDecision.directorCreativeContract.creativeBoundaries.mustAvoid');

  array(value.uncertaintyLedger, 'creativeDecision.directorCreativeContract.uncertaintyLedger');
  for (const [index, uncertainty] of value.uncertaintyLedger.entries()) {
    object(uncertainty, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}]`);
    text(uncertainty.variable, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}].variable`);
    enumValue(uncertainty.disposition, UNCERTAINTY_DISPOSITIONS, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}].disposition`);
    enumValue(uncertainty.owner, UNCERTAINTY_OWNERS, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}].owner`);
    enumValue(uncertainty.status, UNCERTAINTY_STATUSES, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}].status`);
    text(uncertainty.evidenceOrReason, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}].evidenceOrReason`);
    text(uncertainty.resolution, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}].resolution`);
    text(uncertainty.revisitAt, `creativeDecision.directorCreativeContract.uncertaintyLedger[${index}].revisitAt`);
    if (uncertainty.disposition === 'must_answer_now' && uncertainty.status !== 'resolved') {
      throw new TypeError(`creativeDecision.directorCreativeContract.uncertaintyLedger[${index}] must be resolved before Gate 1`);
    }
    if (uncertainty.disposition === 'director_recommendation' && uncertainty.status !== 'resolved') {
      throw new TypeError(`creativeDecision.directorCreativeContract.uncertaintyLedger[${index}] director recommendation must record a resolved decision`);
    }
    if (uncertainty.disposition === 'deferred_to_gate2' && uncertainty.status !== 'deferred') {
      throw new TypeError(`creativeDecision.directorCreativeContract.uncertaintyLedger[${index}] Gate 2 deferral must use deferred status`);
    }
    if (uncertainty.disposition === 'experiment_required' && uncertainty.status !== 'planned') {
      throw new TypeError(`creativeDecision.directorCreativeContract.uncertaintyLedger[${index}] experiment must use planned status`);
    }
    if (uncertainty.disposition === 'irrelevant_to_scope' && uncertainty.status !== 'not_applicable') {
      throw new TypeError(`creativeDecision.directorCreativeContract.uncertaintyLedger[${index}] irrelevant item must use not_applicable status`);
    }
  }

  object(value.decisionLedger, 'creativeDecision.directorCreativeContract.decisionLedger');
  textArray(value.decisionLedger.confirmedFacts, 'creativeDecision.directorCreativeContract.decisionLedger.confirmedFacts');
  textArray(value.decisionLedger.professionalRecommendations, 'creativeDecision.directorCreativeContract.decisionLedger.professionalRecommendations');
  textArray(value.decisionLedger.lockedVariables, 'creativeDecision.directorCreativeContract.decisionLedger.lockedVariables');
  array(value.decisionLedger.rejectedPatterns, 'creativeDecision.directorCreativeContract.decisionLedger.rejectedPatterns');
  for (const [index, rejected] of value.decisionLedger.rejectedPatterns.entries()) {
    object(rejected, `creativeDecision.directorCreativeContract.decisionLedger.rejectedPatterns[${index}]`);
    for (const field of ['pattern', 'reason', 'scope', 'reopenTrigger']) {
      text(rejected[field], `creativeDecision.directorCreativeContract.decisionLedger.rejectedPatterns[${index}].${field}`);
    }
  }

  object(value.provisionalExecution, 'creativeDecision.directorCreativeContract.provisionalExecution');
  for (const field of ['segmentation', 'assetScope', 'parallelism']) {
    if (value.provisionalExecution[field] !== 'provisional_until_gate2') {
      throw new TypeError(`creativeDecision.directorCreativeContract.provisionalExecution.${field} must be provisional_until_gate2`);
    }
  }
}

function revisionImpact(value) {
  object(value, 'creativeDecision.revisionImpact');
  if (value.previousCreativeBriefId !== null) id(value.previousCreativeBriefId, 'creativeDecision.revisionImpact.previousCreativeBriefId');
  text(value.changeSummary, 'creativeDecision.revisionImpact.changeSummary');
  for (const field of ['changedDecisionPaths', 'affectedStages', 'affectedArtifactIds', 'requiredRework', 'preservedDecisions']) {
    array(value[field], `creativeDecision.revisionImpact.${field}`);
    value[field].forEach((item, index) => text(item, `creativeDecision.revisionImpact.${field}[${index}]`));
  }
  if (value.impactPolicy !== 'conservative_v1') throw new TypeError('creativeDecision.revisionImpact.impactPolicy must be conservative_v1');
}

export function assertCreativeBrief(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('creative brief must be an object');
  if (![1, 2, 3].includes(value.schemaVersion)) throw new TypeError('schemaVersion must be 1, 2, or 3');
  id(value.id, 'id');
  assertProjectId(value.projectId);
  if (typeof value.targetDurationSec !== 'number' || !Number.isFinite(value.targetDurationSec)
    || value.targetDurationSec < 1 || value.targetDurationSec > 3600) {
    throw new TypeError('targetDurationSec must be between 1 and 3600');
  }
  const decision = value.creativeDecision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new TypeError('creativeDecision must be an object');
  text(decision.storyDirection, 'creativeDecision.storyDirection');
  text(decision.successDefinition, 'creativeDecision.successDefinition');
  if (decision.visualControlMethod !== undefined && !VISUAL_CONTROL_METHODS.has(decision.visualControlMethod)) {
    throw new TypeError('creativeDecision.visualControlMethod must be storyboard, depth, or modeling');
  }
  if (value.schemaVersion >= 2 && decision.referenceWorkflow === undefined) {
    throw new TypeError(`schemaVersion ${value.schemaVersion} requires creativeDecision.referenceWorkflow`);
  }
  if (decision.referenceWorkflow !== undefined) assertReferenceWorkflow(decision.referenceWorkflow);
  if (value.schemaVersion === 3) {
    directorCreativeContract(decision.directorCreativeContract);
    revisionImpact(decision.revisionImpact);
    if (decision.storyDirection !== decision.directorCreativeContract.recommendedDirection.logline) {
      throw new TypeError('creativeDecision.storyDirection must equal directorCreativeContract.recommendedDirection.logline for schemaVersion 3');
    }
    if (decision.successDefinition !== decision.directorCreativeContract.projectIntent.desiredAudienceEffect) {
      throw new TypeError('creativeDecision.successDefinition must equal directorCreativeContract.projectIntent.desiredAudienceEffect for schemaVersion 3');
    }
  }
  if (!SEGMENTATION_STRATEGIES.has(decision.segmentationStrategy)) throw new TypeError('unknown segmentationStrategy');
  text(decision.segmentationRationale, 'creativeDecision.segmentationRationale');
  for (const field of ['executionMode', 'assetExecutionMode', 'videoExecutionMode']) {
    if (!EXECUTION_MODES.has(decision[field])) throw new TypeError(`creativeDecision.${field} must be parallel, sequential, or mixed`);
  }
  textArray(decision.parallelPlan, 'creativeDecision.parallelPlan');
  textArray(decision.estimatedAssetCombination, 'creativeDecision.estimatedAssetCombination');
  textArray(value.lockedConstraints, 'lockedConstraints');
  return value;
}
