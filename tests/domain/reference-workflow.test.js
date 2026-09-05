import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReferenceWorkflow, assertSourceFactContract, isAssetAnchoredReferenceWorkflow, resolveReferenceWorkflow } from '../../src/domain/reference-workflow.js';

function sourceFactContract(overrides = {}) {
  const actionLedger = [
    { startSec: 0, endSec: 4, observedAction: '人物拿起原产品', emotionBeat: '平静介绍', spokenLine: '原片第一句' },
    { startSec: 4, endSec: 12, observedAction: '人物转向镜头展示产品', emotionBeat: '语气加重', spokenLine: '原片第二句' }
  ];
  return {
    analysisMode: 'adaptive_source_analysis',
    sourceVideoIds: ['source-001'],
    sourceRange: { startSec: 0, endSec: 12 },
    dialoguePolicy: 'verbatim',
    visualEvidence: ['逐帧确认人物、产品、机位和动作时点'],
    dialogueEvidence: ['逐字转录并校对说话人和停顿'],
    preserveFacts: ['保留原片动作顺序、人物反应和镜头节奏'],
    replaceFacts: ['只替换产品名称和对应口播'],
    uncertainties: [],
    actionLedger,
    executionReplacementMap: [{
      sourceFact: '只替换产品名称和对应口播', startSec: 0, endSec: 12,
      executionAction: '使用替换产品完成同一展示节奏。', mustNotShow: ['原产品']
    }],
    executionSafeActionLedger: actionLedger.map(beat => ({
      startSec: beat.startSec, endSec: beat.endSec, sourceObservedAction: beat.observedAction,
      executionAction: beat.observedAction, emotionBeat: beat.emotionBeat, mustNotShow: ['原产品']
    })),
    ...overrides
  };
}

test('pure ideas use the standard creative route without source analysis', () => {
  const result = resolveReferenceWorkflow({ referenceIntent: 'idea_only', sourceVideoIds: [] });
  assert.equal(result.workflowRoute, 'standard_creation');
  assert.equal(result.requiresSourceFactWorkflow, false);
});

test('style inspiration does not promote a source video to factual authority', () => {
  const result = resolveReferenceWorkflow({ referenceIntent: 'inspiration_only', sourceVideoIds: ['source-001'] });
  assert.equal(result.sourceRole, 'inspiration');
  assert.equal(result.workflowRoute, 'standard_creation');
});

test('faithful remakes and source modifications require the source-fact route', () => {
  for (const referenceIntent of ['faithful_remake', 'source_modification']) {
    const result = resolveReferenceWorkflow({ referenceIntent, sourceVideoIds: ['source-001'] });
    assert.equal(result.sourceRole, 'authority');
    assert.equal(result.workflowRoute, 'source_fact');
    assert.equal(result.requiresSourceFactWorkflow, true);
    assert.deepEqual(result.requiredStages, ['adaptive_source_analysis', 'source_fact_contract', 'source_comparator_audit']);
  }
});

test('source-authority intent cannot proceed without a bound source video', () => {
  assert.throws(
    () => resolveReferenceWorkflow({ referenceIntent: 'faithful_remake', sourceVideoIds: [] }),
    /requires at least one sourceVideoId/
  );
});

test('idea-only contracts cannot retain a source binding that downstream stages might misuse', () => {
  assert.throws(
    () => resolveReferenceWorkflow({ referenceIntent: 'idea_only', sourceVideoIds: ['source-001'] }),
    /must not bind sourceVideoIds/
  );
});

test('stored derived fields cannot contradict the deterministic route', () => {
  assert.throws(
    () => assertReferenceWorkflow({
      referenceIntent: 'source_modification', sourceVideoIds: ['source-001'], workflowRoute: 'standard_creation'
    }),
    /conflicts/
  );
});

test('source-fact route requires a contiguous evidence contract', () => {
  const workflow = { referenceIntent: 'source_modification', sourceVideoIds: ['source-001'] };
  assert.equal(assertSourceFactContract(sourceFactContract(), workflow).analysisMode, 'adaptive_source_analysis');
  assert.throws(() => assertSourceFactContract(undefined, workflow), /is required/);
  assert.throws(
    () => assertSourceFactContract(sourceFactContract({
      actionLedger: [{ startSec: 1, endSec: 12, observedAction: '动作', emotionBeat: '情绪', spokenLine: null }]
    }), workflow),
    /contiguously/
  );
});

test('depth plus first-frame plus product routes keep evidence work internal', () => {
  const workflow = resolveReferenceWorkflow({ referenceIntent: 'faithful_remake', sourceVideoIds: ['source-001'] });
  const creativeDecision = {
    visualControlMethod: 'depth',
    estimatedAssetCombination: ['深度视频', '首帧', '产品图片']
  };
  assert.equal(isAssetAnchoredReferenceWorkflow(workflow, creativeDecision), true);
  assert.equal(assertSourceFactContract(undefined, workflow, creativeDecision), null);
  assert.throws(
    () => assertSourceFactContract(sourceFactContract(), workflow, creativeDecision),
    /does not accept a manually authored sourceFactContract/
  );
});

test('source modification separates source forensics from the execution-safe action ledger', () => {
  const workflow = { referenceIntent: 'source_modification', sourceVideoIds: ['source-001'] };
  const invalid = sourceFactContract();
  delete invalid.executionSafeActionLedger;
  assert.throws(() => assertSourceFactContract(invalid, workflow), /executionSafeActionLedger/);
  assert.equal(assertSourceFactContract(sourceFactContract(), workflow).executionReplacementMap.length, 1);
});

test('standard creation forbids accidental source-fact expansion', () => {
  assert.throws(
    () => assertSourceFactContract(sourceFactContract(), { referenceIntent: 'idea_only', sourceVideoIds: [] }),
    /forbidden/
  );
});
