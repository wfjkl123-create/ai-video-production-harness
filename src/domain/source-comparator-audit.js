import { createHash } from 'node:crypto';
import { assertSourceFactAnalysis } from './source-fact-analysis.js';
import { assertStoryPlan } from './story-plan.js';

const SHA256 = /^[a-f0-9]{64}$/;
const EPSILON = 0.001;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function sha(value, field) {
  const normalized = text(value, field);
  if (!SHA256.test(normalized)) throw new TypeError(`${field} must be a lowercase SHA-256`);
  return normalized;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function binding(value, field, expectedId) {
  object(value, field);
  const normalized = {
    artifactId: text(value.artifactId, `${field}.artifactId`),
    artifactRevision: positiveInteger(value.artifactRevision, `${field}.artifactRevision`),
    artifactSha256: sha(value.artifactSha256, `${field}.artifactSha256`)
  };
  if (expectedId !== undefined && normalized.artifactId !== expectedId) {
    throw new TypeError(`${field}.artifactId must match the bound document id`);
  }
  return normalized;
}

function overlap(left, right) {
  return left.startSec < right.endSec - EPSILON && right.startSec < left.endSec - EPSILON;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(6));
}

function addDifference(differences, code, scope, statement, details) {
  differences.push({ code, scope, statement, details });
}

function occurrences(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function compareSourceToContract(sourceAnalysis, storyPlan) {
  const contract = storyPlan.sourceFactContract;
  const differences = [];
  const observed = sourceAnalysis.timeline.flatMap(row => row.observedFacts.map(fact => ({ ...fact, rowId: row.rowId })));
  const observedStatements = new Set(observed.map(fact => fact.statement));
  const visualStatements = new Set(observed.filter(fact => fact.modality === 'visual').map(fact => fact.statement));
  const audibleStatements = new Set(observed.filter(fact => fact.modality === 'audible').map(fact => fact.statement));
  const interpretations = new Set(sourceAnalysis.timeline.flatMap(row => row.interpretation));
  const sourceUncertainties = new Set(sourceAnalysis.timeline.flatMap(row => row.uncertainties));
  const preserve = new Set(contract.preserveFacts);
  const replace = new Set(contract.replaceFacts);
  const visualEvidence = new Set(contract.visualEvidence);
  const dialogueEvidence = new Set(contract.dialogueEvidence);
  const contractFactClaims = [
    ...contract.preserveFacts,
    ...contract.replaceFacts,
    ...contract.visualEvidence,
    ...contract.dialogueEvidence,
    ...contract.actionLedger.map(beat => beat.observedAction)
  ];

  for (const [statement, count] of occurrences(contractFactClaims)) {
    if (interpretations.has(statement) && !observedStatements.has(statement)) {
      addDifference(differences, 'INTERPRETATION_PROMOTED_TO_FACT', 'contract', statement,
        'The statement exists only in source interpretation and cannot be used as an observed fact.');
    }
    if (count > 1 && preserve.has(statement) && replace.has(statement)) {
      addDifference(differences, 'CONFLICTING_DISPOSITION', 'contract', statement,
        'The same observed fact cannot be both preserved and replaced.');
    }
  }

  for (const statement of preserve) {
    if (!observedStatements.has(statement)) addDifference(differences, 'UNSUPPORTED_PRESERVE_FACT', 'contract', statement, 'No exact observed source fact matches this preserve fact.');
  }
  for (const statement of replace) {
    if (!observedStatements.has(statement)) addDifference(differences, 'UNSUPPORTED_REPLACE_FACT', 'contract', statement, 'No exact observed source fact matches this replace fact.');
  }
  for (const statement of visualEvidence) {
    if (!visualStatements.has(statement)) addDifference(differences, 'UNSUPPORTED_VISUAL_EVIDENCE', 'contract', statement, 'No exact observed visual fact matches this evidence statement.');
  }
  for (const statement of dialogueEvidence) {
    if (!audibleStatements.has(statement)) addDifference(differences, 'UNSUPPORTED_DIALOGUE_EVIDENCE', 'contract', statement, 'No exact observed audible fact matches this evidence statement.');
  }

  const rowComparisons = sourceAnalysis.timeline.map(row => {
    const rowDifferences = [];
    const facts = row.observedFacts.map(fact => {
      const dispositions = [preserve.has(fact.statement) ? 'preserve' : null, replace.has(fact.statement) ? 'replace' : null].filter(Boolean);
      const evidenceMatched = fact.modality === 'visual' ? visualEvidence.has(fact.statement) : dialogueEvidence.has(fact.statement);
      if (dispositions.length === 0) {
        const difference = { code: 'OBSERVED_FACT_UNCLASSIFIED', scope: row.rowId, statement: fact.statement, details: 'Observed fact is absent from preserveFacts and replaceFacts.' };
        rowDifferences.push(difference); differences.push(difference);
      } else if (dispositions.length > 1) {
        const difference = { code: 'CONFLICTING_DISPOSITION', scope: row.rowId, statement: fact.statement, details: 'Observed fact is both preserved and replaced.' };
        rowDifferences.push(difference); differences.push(difference);
      }
      if (!evidenceMatched) {
        const difference = { code: fact.modality === 'visual' ? 'VISUAL_EVIDENCE_MISSING' : 'DIALOGUE_EVIDENCE_MISSING', scope: row.rowId, statement: fact.statement, details: `Observed ${fact.modality} fact is absent from its matching contract evidence list.` };
        rowDifferences.push(difference); differences.push(difference);
      }
      return {
        statement: fact.statement,
        modality: fact.modality,
        evidenceTimesSec: fact.evidenceTimesSec,
        disposition: dispositions.length === 1 ? dispositions[0] : dispositions.length === 0 ? 'unclassified' : 'conflict',
        evidenceMatched
      };
    });
    const actionBeats = contract.actionLedger.filter(beat => overlap(row, beat)).map(beat => {
      const observedActionMatched = row.observedFacts.some(fact => fact.statement === beat.observedAction);
      if (!observedActionMatched) {
        const difference = { code: 'ACTION_NOT_OBSERVED_IN_ROW', scope: row.rowId, statement: beat.observedAction, details: 'Overlapping actionLedger beat does not exactly match an observed fact in this source row.' };
        rowDifferences.push(difference); differences.push(difference);
      }
      return { startSec: beat.startSec, endSec: beat.endSec, observedAction: beat.observedAction, observedActionMatched, spokenLine: beat.spokenLine ?? null };
    });
    if (actionBeats.length === 0) {
      const difference = { code: 'ACTION_COVERAGE_GAP', scope: row.rowId, statement: row.rowId, details: 'No actionLedger beat overlaps this source timeline row.' };
      rowDifferences.push(difference); differences.push(difference);
    }
    return {
      rowId: row.rowId,
      startSec: row.startSec,
      endSec: row.endSec,
      observedFacts: facts,
      actionBeats,
      sourceUncertainties: [...row.uncertainties],
      contractUncertainties: row.uncertainties.filter(item => contract.uncertainties.includes(item)),
      missingUncertainties: row.uncertainties.filter(item => !contract.uncertainties.includes(item)),
      interpretationExcluded: [...row.interpretation],
      decision: rowDifferences.length === 0 ? 'PASS' : 'FAIL',
      differences: rowDifferences
    };
  });

  for (const uncertainty of sourceUncertainties) {
    if (!contract.uncertainties.includes(uncertainty)) {
      addDifference(differences, 'SOURCE_UNCERTAINTY_DROPPED', 'contract', uncertainty, 'Source uncertainty must remain explicit in sourceFactContract.');
    }
  }

  if (contract.sourceRange.startSec !== sourceAnalysis.sourceRange.startSec
    || Math.abs(contract.sourceRange.endSec - sourceAnalysis.sourceRange.endSec) > EPSILON) {
    addDifference(differences, 'SOURCE_RANGE_MISMATCH', 'contract', `${contract.sourceRange.startSec}-${contract.sourceRange.endSec}`,
      `Contract sourceRange must exactly match ${sourceAnalysis.sourceRange.startSec}-${sourceAnalysis.sourceRange.endSec}.`);
  }
  if (contract.sourceVideoIds.length !== 1 || contract.sourceVideoIds[0] !== sourceAnalysis.referenceVideo.artifactId) {
    addDifference(differences, 'SOURCE_VIDEO_BINDING_MISMATCH', 'contract', contract.sourceVideoIds.join(','),
      'Contract must bind the exact reference video used by the locked source analysis.');
  }
  if (contract.dialoguePolicy === 'none') {
    if (contract.dialogueEvidence.length > 0 || contract.actionLedger.some(beat => beat.spokenLine !== null && beat.spokenLine !== undefined)) {
      addDifference(differences, 'DIALOGUE_POLICY_CONFLICT', 'contract', 'none', 'dialoguePolicy none forbids dialogue evidence and spoken lines.');
    }
  } else if (audibleStatements.size === 0) {
    addDifference(differences, 'DIALOGUE_WITHOUT_SOURCE_EVIDENCE', 'contract', contract.dialoguePolicy, 'A non-none dialogue policy requires at least one observed audible source fact.');
  }

  const classifiedFacts = observed.filter(fact => preserve.has(fact.statement) !== replace.has(fact.statement)).length;
  const evidenceMatchedFacts = observed.filter(fact => fact.modality === 'visual' ? visualEvidence.has(fact.statement) : dialogueEvidence.has(fact.statement)).length;
  const actionBeatCount = contract.actionLedger.length;
  const matchedActionBeats = contract.actionLedger.filter(beat => sourceAnalysis.timeline
    .filter(row => overlap(row, beat))
    .some(row => row.observedFacts.some(fact => fact.statement === beat.observedAction))).length;
  const retainedUncertainties = [...sourceUncertainties].filter(item => contract.uncertainties.includes(item)).length;
  const coverage = {
    timelineRowCount: sourceAnalysis.timeline.length,
    passingTimelineRowCount: rowComparisons.filter(row => row.decision === 'PASS').length,
    observedFactCount: observed.length,
    classifiedObservedFactCount: classifiedFacts,
    observedFactClassificationRatio: ratio(classifiedFacts, observed.length),
    evidenceMatchedFactCount: evidenceMatchedFacts,
    evidenceCoverageRatio: ratio(evidenceMatchedFacts, observed.length),
    actionBeatCount,
    matchedActionBeatCount: matchedActionBeats,
    actionCoverageRatio: ratio(matchedActionBeats, actionBeatCount),
    sourceUncertaintyCount: sourceUncertainties.size,
    retainedSourceUncertaintyCount: retainedUncertainties,
    uncertaintyRetentionRatio: ratio(retainedUncertainties, sourceUncertainties.size)
  };
  return {
    decision: differences.length === 0 ? 'PASS' : 'FAIL',
    rowComparisons,
    differences,
    coverage,
    uncertainties: {
      source: [...sourceUncertainties],
      retained: [...sourceUncertainties].filter(item => contract.uncertainties.includes(item)),
      missing: [...sourceUncertainties].filter(item => !contract.uncertainties.includes(item)),
      additionalContractUncertainties: contract.uncertainties.filter(item => !sourceUncertainties.has(item))
    }
  };
}

export function sourceComparatorAuditInputFingerprint(input) {
  object(input, 'source comparator audit input');
  const sourceAnalysis = assertSourceFactAnalysis(input.sourceAnalysis);
  const storyPlan = assertStoryPlan(input.storyPlan);
  const sourceAnalysisBinding = binding(input.sourceAnalysisBinding, 'sourceAnalysisBinding', sourceAnalysis.id);
  const storyPlanBinding = binding(input.storyPlanBinding, 'storyPlanBinding', storyPlan.id);
  if (sourceAnalysis.projectId !== storyPlan.projectId) throw new TypeError('source analysis and story plan projectId must match');
  return fingerprint({
    version: 'source-comparator-v1',
    sourceAnalysisBinding,
    storyPlanBinding,
    sourceAnalysisContentFingerprintSha256: sourceAnalysis.contentFingerprintSha256
  });
}

export function buildSourceComparatorAudit(input, { createdAt }) {
  const sourceAnalysis = assertSourceFactAnalysis(input.sourceAnalysis);
  const storyPlan = assertStoryPlan(input.storyPlan);
  if (!storyPlan.sourceFactContract) throw new TypeError('story plan must contain sourceFactContract');
  const sourceAnalysisBinding = binding(input.sourceAnalysisBinding, 'sourceAnalysisBinding', sourceAnalysis.id);
  const storyPlanBinding = binding(input.storyPlanBinding, 'storyPlanBinding', storyPlan.id);
  const inputFingerprintSha256 = sourceComparatorAuditInputFingerprint(input);
  const comparison = compareSourceToContract(sourceAnalysis, storyPlan);
  const timestamp = text(createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError('createdAt must be a date-time');
  return {
    schemaVersion: 1,
    id: `source-comparator-audit-${inputFingerprintSha256.slice(0, 16)}`,
    kind: 'source_comparator_audit',
    status: 'completed',
    comparatorVersion: 'source-comparator-v1',
    projectId: sourceAnalysis.projectId,
    decision: comparison.decision,
    gateEffect: comparison.decision === 'PASS' ? 'GATE_2_ELIGIBLE' : 'BLOCK_GATE_2',
    sourceAnalysisBinding,
    storyPlanBinding,
    sourceAnalysisContentFingerprintSha256: sourceAnalysis.contentFingerprintSha256,
    inputFingerprintSha256,
    factPolicy: {
      observedFactsOnly: true,
      interpretationIsNonAuthoritative: true,
      uncertaintiesMustRemainExplicit: true
    },
    ...comparison,
    createdAt: timestamp
  };
}

export function assertSourceComparatorAudit(value) {
  object(value, 'source comparator audit');
  if (value.schemaVersion !== 1 || value.kind !== 'source_comparator_audit' || value.status !== 'completed') throw new TypeError('invalid source comparator audit envelope');
  if (value.comparatorVersion !== 'source-comparator-v1') throw new TypeError('comparatorVersion must be source-comparator-v1');
  text(value.projectId, 'projectId');
  if (!['PASS', 'FAIL'].includes(value.decision)) throw new TypeError('decision must be PASS or FAIL');
  if (value.gateEffect !== (value.decision === 'PASS' ? 'GATE_2_ELIGIBLE' : 'BLOCK_GATE_2')) throw new TypeError('gateEffect must match decision');
  binding(value.sourceAnalysisBinding, 'sourceAnalysisBinding');
  binding(value.storyPlanBinding, 'storyPlanBinding');
  sha(value.sourceAnalysisContentFingerprintSha256, 'sourceAnalysisContentFingerprintSha256');
  sha(value.inputFingerprintSha256, 'inputFingerprintSha256');
  if (value.id !== `source-comparator-audit-${value.inputFingerprintSha256.slice(0, 16)}`) throw new TypeError('id must match inputFingerprintSha256');
  object(value.factPolicy, 'factPolicy');
  if (value.factPolicy.observedFactsOnly !== true || value.factPolicy.interpretationIsNonAuthoritative !== true || value.factPolicy.uncertaintiesMustRemainExplicit !== true) throw new TypeError('factPolicy must enforce source evidence boundaries');
  if (!Array.isArray(value.rowComparisons) || value.rowComparisons.length === 0) throw new TypeError('rowComparisons must be a non-empty array');
  if (!Array.isArray(value.differences)) throw new TypeError('differences must be an array');
  if (value.decision === 'PASS' && value.differences.length !== 0) throw new TypeError('PASS audit cannot contain differences');
  if (value.decision === 'FAIL' && value.differences.length === 0) throw new TypeError('FAIL audit must contain differences');
  object(value.coverage, 'coverage');
  object(value.uncertainties, 'uncertainties');
  text(value.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(value.createdAt))) throw new TypeError('createdAt must be a date-time');
  return value;
}
