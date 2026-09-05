const REFERENCE_INTENTS = new Set([
  'idea_only',
  'inspiration_only',
  'faithful_remake',
  'source_modification'
]);

const SOURCE_AUTHORITY_INTENTS = new Set(['faithful_remake', 'source_modification']);

const ROUTES = Object.freeze({
  standard: 'standard_creation',
  sourceFact: 'source_fact'
});
const DIALOGUE_POLICIES = new Set(['verbatim', 'replace_locked_lines', 'adapted', 'none']);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function sourceVideoIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('sourceVideoIds must be an array');
  const ids = value.map((item, index) => text(item, `sourceVideoIds[${index}]`));
  if (new Set(ids).size !== ids.length) throw new TypeError('sourceVideoIds must not contain duplicates');
  return ids;
}

function sameTime(left, right) {
  return Math.abs(left - right) <= 0.001;
}

// `actionLedger` is the source-forensics record.  In a source-modification
// project it deliberately retains the original pixels/actions so the source
// comparator can prove what was changed.  It must never be the execution
// authority: a separate, contiguous ledger is required for assets and prompts.
function assertExecutionModificationContract(value, { startSec, endSec }) {
  if (!Array.isArray(value.executionSafeActionLedger) || value.executionSafeActionLedger.length === 0) {
    throw new TypeError('source_modification requires a non-empty executionSafeActionLedger');
  }
  if (!Array.isArray(value.executionReplacementMap) || value.executionReplacementMap.length === 0) {
    throw new TypeError('source_modification requires a non-empty executionReplacementMap');
  }
  const replacementFacts = new Set(value.replaceFacts);
  const mappedFacts = new Set();
  for (const [index, item] of value.executionReplacementMap.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`executionReplacementMap[${index}] must be an object`);
    }
    text(item.sourceFact, `executionReplacementMap[${index}].sourceFact`);
    if (!replacementFacts.has(item.sourceFact)) {
      throw new TypeError(`executionReplacementMap[${index}].sourceFact must be a replaceFact`);
    }
    if (!Number.isFinite(item.startSec) || !Number.isFinite(item.endSec) || item.endSec <= item.startSec) {
      throw new TypeError(`executionReplacementMap[${index}] must declare a valid source time range`);
    }
    text(item.executionAction, `executionReplacementMap[${index}].executionAction`);
    if (!Array.isArray(item.mustNotShow) || item.mustNotShow.length === 0) {
      throw new TypeError(`executionReplacementMap[${index}].mustNotShow must be a non-empty array`);
    }
    item.mustNotShow.forEach((entry, prohibitionIndex) => text(entry, `executionReplacementMap[${index}].mustNotShow[${prohibitionIndex}]`));
    mappedFacts.add(item.sourceFact);
  }
  for (const fact of replacementFacts) {
    if (!mappedFacts.has(fact)) throw new TypeError('each replaceFact requires one executionReplacementMap entry');
  }

  let cursor = startSec;
  for (const [index, beat] of value.executionSafeActionLedger.entries()) {
    if (!beat || typeof beat !== 'object' || Array.isArray(beat)) {
      throw new TypeError(`executionSafeActionLedger[${index}] must be an object`);
    }
    if (!Number.isFinite(beat.startSec) || !Number.isFinite(beat.endSec)
      || !sameTime(beat.startSec, cursor) || beat.endSec <= beat.startSec) {
      throw new TypeError('executionSafeActionLedger must cover sourceRange contiguously');
    }
    text(beat.sourceObservedAction, `executionSafeActionLedger[${index}].sourceObservedAction`);
    text(beat.executionAction, `executionSafeActionLedger[${index}].executionAction`);
    text(beat.emotionBeat, `executionSafeActionLedger[${index}].emotionBeat`);
    if (!Array.isArray(beat.mustNotShow) || beat.mustNotShow.length === 0) {
      throw new TypeError(`executionSafeActionLedger[${index}].mustNotShow must be a non-empty array`);
    }
    beat.mustNotShow.forEach((entry, prohibitionIndex) => text(entry, `executionSafeActionLedger[${index}].mustNotShow[${prohibitionIndex}]`));
    const sourceBeat = value.actionLedger.find(candidate => sameTime(candidate.startSec, beat.startSec) && sameTime(candidate.endSec, beat.endSec));
    if (!sourceBeat || sourceBeat.observedAction !== beat.sourceObservedAction) {
      throw new TypeError('executionSafeActionLedger must map each exact source actionLedger interval');
    }
    cursor = beat.endSec;
  }
  if (!sameTime(cursor, endSec)) throw new TypeError('executionSafeActionLedger must end at sourceRange.endSec');
}

export const REFERENCE_WORKFLOW_ROUTES = ROUTES;

export function resolveReferenceWorkflow({ referenceIntent, sourceVideoIds: inputSourceVideoIds = [] }) {
  if (!REFERENCE_INTENTS.has(referenceIntent)) {
    throw new TypeError('referenceIntent must be idea_only, inspiration_only, faithful_remake, or source_modification');
  }

  const videos = sourceVideoIds(inputSourceVideoIds);
  const sourceIsAuthority = SOURCE_AUTHORITY_INTENTS.has(referenceIntent);

  if (referenceIntent === 'idea_only' && videos.length > 0) {
    throw new TypeError('idea_only must not bind sourceVideoIds; use inspiration_only when a video is only a reference');
  }
  if ((referenceIntent === 'inspiration_only' || sourceIsAuthority) && videos.length === 0) {
    throw new TypeError(`${referenceIntent} requires at least one sourceVideoId`);
  }

  const workflowRoute = sourceIsAuthority ? ROUTES.sourceFact : ROUTES.standard;
  const sourceRole = sourceIsAuthority
    ? 'authority'
    : referenceIntent === 'inspiration_only'
      ? 'inspiration'
      : 'none';

  return {
    referenceIntent,
    sourceVideoIds: videos,
    sourceRole,
    workflowRoute,
    requiresSourceFactWorkflow: sourceIsAuthority,
    requiredStages: sourceIsAuthority
      ? ['adaptive_source_analysis', 'source_fact_contract', 'source_comparator_audit']
      : ['standard_creative_development']
  };
}

export function assertReferenceWorkflow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('referenceWorkflow must be an object');
  }
  const resolved = resolveReferenceWorkflow(value);
  for (const field of ['sourceRole', 'workflowRoute', 'requiresSourceFactWorkflow']) {
    if (value[field] !== undefined && value[field] !== resolved[field]) {
      throw new TypeError(`referenceWorkflow.${field} conflicts with referenceIntent and sourceVideoIds`);
    }
  }
  return resolved;
}

// A depth-controlled, three-asset replication is intentionally lighter than
// a full source-forensics route.  The depth video carries motion/occlusion,
// the first frame carries the opening composition, and the product image
// carries the replacement product identity.  In this profile the system
// still owns the evidence work, but the operator does not have to author an
// observed-action ledger before Gate 2.
export function isAssetAnchoredReferenceWorkflow(referenceWorkflow, creativeDecision = {}) {
  if (!referenceWorkflow || typeof referenceWorkflow !== 'object') return false;
  if (!['faithful_remake', 'source_modification'].includes(referenceWorkflow.referenceIntent)) return false;
  if (referenceWorkflow.workflowRoute !== ROUTES.sourceFact || referenceWorkflow.requiresSourceFactWorkflow !== true) return false;
  if (creativeDecision?.visualControlMethod !== 'depth') return false;
  const assets = Array.isArray(creativeDecision?.estimatedAssetCombination)
    ? creativeDecision.estimatedAssetCombination.join(' ').toLowerCase()
    : '';
  const hasDepth = /深度视频|深度参考|depth[_ -]?video/.test(assets);
  const hasFirstFrame = /首帧|first[_ -]?frame/.test(assets);
  const hasProduct = /产品图片|产品图|product[_ -]?reference|product[_ -]?image/.test(assets);
  return hasDepth && hasFirstFrame && hasProduct;
}

// A workflow profile can delegate the source-fact evidence work to the
// system. simple_remake keeps the source-authority intent but replaces the
// hand-authored observed-fact ledger with machine-organized evidence, so the
// story plan must not be blocked on a manual sourceFactContract.
export function isSourceFactMachineDelegated(referenceWorkflow, creativeDecision = {}, workflowProfileId = null) {
  if (isAssetAnchoredReferenceWorkflow(referenceWorkflow, creativeDecision)) return true;
  return workflowProfileId === 'simple_remake'
    && !!referenceWorkflow
    && typeof referenceWorkflow === 'object'
    && !Array.isArray(referenceWorkflow)
    && ['faithful_remake', 'source_modification'].includes(referenceWorkflow.referenceIntent);
}

export function assertSourceFactContract(value, referenceWorkflow, creativeDecision = {}, workflowProfileId = null) {
  const workflow = assertReferenceWorkflow(referenceWorkflow);
  if (isSourceFactMachineDelegated(workflow, creativeDecision, workflowProfileId)) {
    if (value !== undefined && value !== null) {
      throw new TypeError('asset-anchored depth replication does not accept a manually authored sourceFactContract');
    }
    return null;
  }
  if (!workflow.requiresSourceFactWorkflow) {
    if (value !== undefined && value !== null) {
      throw new TypeError('sourceFactContract is forbidden when referenceWorkflow uses standard_creation');
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sourceFactContract is required for the source_fact route');
  }
  if (value.analysisMode !== 'adaptive_source_analysis') {
    throw new TypeError('sourceFactContract.analysisMode must be adaptive_source_analysis');
  }
  const contractVideos = sourceVideoIds(value.sourceVideoIds);
  if (contractVideos.length !== workflow.sourceVideoIds.length
    || contractVideos.some((item, index) => item !== workflow.sourceVideoIds[index])) {
    throw new TypeError('sourceFactContract.sourceVideoIds must exactly match referenceWorkflow.sourceVideoIds');
  }
  if (!value.sourceRange || typeof value.sourceRange !== 'object' || Array.isArray(value.sourceRange)) {
    throw new TypeError('sourceFactContract.sourceRange must be an object');
  }
  const { startSec, endSec } = value.sourceRange;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    throw new TypeError('sourceFactContract.sourceRange must have a valid startSec and endSec');
  }
  if (!DIALOGUE_POLICIES.has(value.dialoguePolicy)) {
    throw new TypeError('sourceFactContract.dialoguePolicy is invalid');
  }
  for (const field of ['visualEvidence', 'preserveFacts']) {
    if (!Array.isArray(value[field]) || value[field].length === 0) {
      throw new TypeError(`sourceFactContract.${field} must be a non-empty array`);
    }
    value[field].forEach((item, index) => text(item, `sourceFactContract.${field}[${index}]`));
  }
  for (const field of ['dialogueEvidence', 'replaceFacts', 'uncertainties']) {
    if (!Array.isArray(value[field])) throw new TypeError(`sourceFactContract.${field} must be an array`);
    value[field].forEach((item, index) => text(item, `sourceFactContract.${field}[${index}]`));
  }
  if (value.dialoguePolicy !== 'none' && value.dialogueEvidence.length === 0) {
    throw new TypeError('sourceFactContract.dialogueEvidence is required when dialoguePolicy is not none');
  }
  if (workflow.referenceIntent === 'source_modification' && value.replaceFacts.length === 0) {
    throw new TypeError('sourceFactContract.replaceFacts is required for source_modification');
  }
  if (!Array.isArray(value.actionLedger) || value.actionLedger.length === 0) {
    throw new TypeError('sourceFactContract.actionLedger must be a non-empty array');
  }
  let cursor = startSec;
  for (const [index, beat] of value.actionLedger.entries()) {
    if (!beat || typeof beat !== 'object' || Array.isArray(beat)) {
      throw new TypeError(`sourceFactContract.actionLedger[${index}] must be an object`);
    }
    if (!Number.isFinite(beat.startSec) || !Number.isFinite(beat.endSec)
      || Math.abs(beat.startSec - cursor) > 0.001 || beat.endSec <= beat.startSec) {
      throw new TypeError('sourceFactContract.actionLedger must cover sourceRange contiguously');
    }
    text(beat.observedAction, `sourceFactContract.actionLedger[${index}].observedAction`);
    text(beat.emotionBeat, `sourceFactContract.actionLedger[${index}].emotionBeat`);
    if (beat.spokenLine !== null && beat.spokenLine !== undefined) {
      text(beat.spokenLine, `sourceFactContract.actionLedger[${index}].spokenLine`);
    }
    cursor = beat.endSec;
  }
  if (Math.abs(cursor - endSec) > 0.001) {
    throw new TypeError('sourceFactContract.actionLedger must end at sourceRange.endSec');
  }
  if (workflow.referenceIntent === 'source_modification') {
    assertExecutionModificationContract(value, { startSec, endSec });
  }
  return value;
}
