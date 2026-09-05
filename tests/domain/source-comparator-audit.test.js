import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceFactAnalysis } from '../../src/domain/source-fact-analysis.js';
import { buildSourceComparatorAudit, sourceComparatorAuditInputFingerprint } from '../../src/domain/source-comparator-audit.js';

const sha = character => character.repeat(64);

function fixture() {
  const sourceAnalysis = buildSourceFactAnalysis({
    projectId: 'compare-1', referenceVideo: { artifactId: 'video-1', artifactRevision: 1, artifactSha256: sha('a') }, durationSec: 2,
    samplingStrategy: { version: 'adaptive-source-sampling-v1', normal: { mode: 'uniform_low_frequency', targetFps: 1 }, strongAction: { mode: 'dense_action_sampling', targetFps: 4 } },
    timeline: [
      { rowId: 'r1', startSec: 0, endSec: 1, samplingClass: 'normal', samplingReason: 'steady', targetFps: 1, sampleTimesSec: [0], observedFacts: [{ statement: '人物居中', modality: 'visual', evidenceTimesSec: [0] }], interpretation: ['人物可能紧张'], uncertainties: ['手部被遮挡'] },
      { rowId: 'r2', startSec: 1, endSec: 2, samplingClass: 'normal', samplingReason: 'steady', targetFps: 1, sampleTimesSec: [1], observedFacts: [{ statement: '听见一句人声', modality: 'audible', evidenceTimesSec: [1.2] }], interpretation: [], uncertainties: [] }
    ]
  }, { revision: 2, createdAt: '2026-08-08T00:00:00Z' });
  const storyPlan = {
    schemaVersion: 1, id: 'story-1', projectId: 'compare-1', creativeBriefId: 'brief-1', targetDurationSec: 2,
    creativeDecision: { storyDirection: 'test', successDefinition: 'test', segmentationStrategy: 'single_clip', segmentationRationale: 'test', executionMode: 'sequential', assetExecutionMode: 'sequential', videoExecutionMode: 'sequential', parallelPlan: ['one local lane'], estimatedAssetCombination: ['one prop'], referenceWorkflow: { referenceIntent: 'faithful_remake', sourceVideoIds: ['video-1'] } },
    sourceFactContract: { analysisMode: 'adaptive_source_analysis', sourceVideoIds: ['video-1'], sourceRange: { startSec: 0, endSec: 2 }, dialoguePolicy: 'verbatim', visualEvidence: ['人物居中'], dialogueEvidence: ['听见一句人声'], preserveFacts: ['人物居中', '听见一句人声'], replaceFacts: [], uncertainties: ['手部被遮挡'], actionLedger: [{ startSec: 0, endSec: 1, observedAction: '人物居中', emotionBeat: '中性', spokenLine: null }, { startSec: 1, endSec: 2, observedAction: '听见一句人声', emotionBeat: '中性', spokenLine: '台词' }] },
    story: { logline: 'x', storyPromise: 'x', initialCondition: 'x', objective: 'x', centralConflict: 'x', turn: 'x', climax: 'x', finalOutcome: 'x', tone: 'x' },
    characters: [{ characterId: 'c1', tag: 'x', role: 'x', background: 'x', personality: 'x', stance: 'x', objective: 'x', obstacle: 'x', appearance: 'x', wardrobeLock: 'x', relationshipMap: 'x', arc: 'x' }],
    script: { scenes: [{ sceneId: 's1', location: 'x', timeOfDay: 'x', sceneFunction: 'x', pov: 'x', powerShift: 'x', subtext: 'x', beats: ['x'], dialogue: [] }] },
    videoSegments: [{ segmentId: 'seg1', startSec: 0, endSec: 2, storyBeat: 'x', splitReason: 'single complete beat', sceneIds: ['s1'] }],
    shotPlanning: { mode: 'shotlist', shots: [{ shotId: 'sh1', segmentId: 'seg1', sceneId: 's1', characterIds: ['c1'], durationSec: 2, purpose: 'x', subjectAction: 'x', shotContract: 'x', blocking: 'x', startState: 'x', endState: 'x', audio: 'x', continuityAnchors: ['x'], risks: ['x'] }], continuousTakePlan: null, roughStoryboardPreview: null },
    assetPlan: [{ assetType: 'story_prop', decision: 'required', reason: 'x', assetIds: ['x'] }]
  };
  return { sourceAnalysis, storyPlan, sourceAnalysisBinding: { artifactId: sourceAnalysis.id, artifactRevision: 2, artifactSha256: sha('b') }, storyPlanBinding: { artifactId: 'story-1', artifactRevision: 3, artifactSha256: sha('c') } };
}

test('PASS binds exact input revisions and SHAs and reports complete per-row coverage', () => {
  const input = fixture();
  const audit = buildSourceComparatorAudit(input, { createdAt: '2026-08-08T01:00:00Z' });
  assert.equal(audit.decision, 'PASS');
  assert.equal(audit.gateEffect, 'GATE_2_ELIGIBLE');
  assert.equal(audit.coverage.observedFactClassificationRatio, 1);
  assert.equal(audit.coverage.actionCoverageRatio, 1);
  assert.equal(audit.rowComparisons.length, 2);
  assert.deepEqual(audit.rowComparisons[0].interpretationExcluded, ['人物可能紧张']);
  assert.equal(sourceComparatorAuditInputFingerprint(input), audit.inputFingerprintSha256);
});

test('FAIL exposes differences, dropped uncertainties, and interpretation promoted as fact', () => {
  const input = fixture();
  input.storyPlan.sourceFactContract.preserveFacts = ['人物可能紧张', '听见一句人声'];
  input.storyPlan.sourceFactContract.visualEvidence = ['人物可能紧张'];
  input.storyPlan.sourceFactContract.uncertainties = [];
  input.storyPlan.sourceFactContract.actionLedger[0].observedAction = '人物可能紧张';
  const audit = buildSourceComparatorAudit(input, { createdAt: '2026-08-08T01:00:00Z' });
  assert.equal(audit.decision, 'FAIL');
  assert.equal(audit.gateEffect, 'BLOCK_GATE_2');
  assert.ok(audit.differences.some(item => item.code === 'INTERPRETATION_PROMOTED_TO_FACT'));
  assert.ok(audit.differences.some(item => item.code === 'SOURCE_UNCERTAINTY_DROPPED'));
  assert.equal(audit.coverage.uncertaintyRetentionRatio, 0);
});
