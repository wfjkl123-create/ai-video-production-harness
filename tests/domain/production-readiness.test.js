import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReferenceAuthority, assessStoryPlanExecutability, inferTransformMode } from '../../src/domain/production-readiness.js';

function intent(overrides = {}) {
  return { signals: {
    hasDialogue: false, emotionalTurn: false, relationshipBeat: false, requiresMutualEyeLine: false,
    complexBlocking: false, complexPhysicalAction: false, productInteraction: 'none', localDeterministic: false,
    ...overrides
  } };
}

function beat() {
  return {
    trigger: '她先看见外裤后中缝受力', observableReaction: '笑意停住，重心后移',
    decision: '她停止迎接并转身离开', partnerFeedback: '男主追视后肩膀下沉',
    cutPoint: '女主完成转身且男主尚未追上', soundRole: '环境声持续，脚步成为切点'
  };
}

function plan({ duration = 6, transformMode = 'faithful_remake', people = ['m', 'f'], signals = {}, performanceBeat = beat() } = {}) {
  return {
    schemaVersion: 2,
    directorPlan: { projectType: 'viral_remake', transformMode },
    characters: people.map(characterId => ({ characterId })),
    videoSegments: [{ segmentId: 'segment-001', startSec: 0, endSec: duration, sceneIds: ['scene-001'] }],
    shotPlanning: { mode: 'shotlist', continuousTakePlan: null, shots: [{
      shotId: 'shot-001', segmentId: 'segment-001', durationSec: duration, characterIds: people,
      directorIntent: intent({ relationshipBeat: people.length > 1, emotionalTurn: people.length > 0, ...signals }),
      performanceBeat, mustSee: ['第一帧看见外裤后中缝受力']
    }] }
  };
}

test('explicit A/B/C transform modes are preserved', () => {
  assert.deepEqual(inferTransformMode('viral_remake', 'local_edit'), { mode: 'local_edit', inferred: false });
  assert.equal(inferTransformMode('viral_remake').mode, 'faithful_remake');
  assert.equal(inferTransformMode('narrative').mode, 'story_creation');
});

test('a complete 4-7 second causal performance unit passes', () => {
  const result = assessStoryPlanExecutability(plan());
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.generationGuidance[0].durationRangeSec, [4, 7]);
});

test('one-to-one fidelity is blocked unless modeling strong control is locked', () => {
  const value = plan();
  value.directorPlan.fidelityTarget = 'one_to_one';
  value.directorPlan.controlMode = 'standard';
  const result = assessStoryPlanExecutability(value);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some(item => item.id === 'ONE_TO_ONE_REQUIRES_MODELING_CONTROL'));
});

test('model-derived keyframes expose a control downgrade instead of claiming video-level motion lock', () => {
  const value = plan();
  value.directorPlan.fidelityTarget = 'one_to_one';
  value.directorPlan.controlMode = 'modeling_strong_control';
  value.directorPlan.modelingInputMode = 'keyframes_only';
  const result = assessStoryPlanExecutability(value);
  assert.equal(result.status, 'WARN');
  assert.equal(result.controlMode, 'modeling_strong_control');
  assert.ok(result.findings.some(item => item.id === 'MODELING_CONTROL_DOWNGRADED_TO_KEYFRAMES'));
});

test('micro-segmented relationship performance is blocked rather than praised as precise timing', () => {
  const result = assessStoryPlanExecutability(plan({ duration: 1.858 }));
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some(item => item.id === 'MICRO_SEGMENT_PERFORMANCE_RESET'));
});

test('missing visible performance causality is surfaced', () => {
  const result = assessStoryPlanExecutability(plan({ performanceBeat: null }));
  assert.equal(result.status, 'WARN');
  assert.ok(result.findings.some(item => item.id === 'PERFORMANCE_CAUSALITY_UNDECLARED'));
});

test('three-person physical and blocking overload is blocked', () => {
  const result = assessStoryPlanExecutability(plan({
    people: ['m', 'a', 'b'],
    signals: { complexPhysicalAction: true, complexBlocking: true, productInteraction: 'wearing' }
  }));
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some(item => item.id === 'MULTI_SUBJECT_PHYSICS_OVERLOAD'));
});

test('a reaction scene with an isolated contact is not misrouted as multi-person product physics', () => {
  const result = assessStoryPlanExecutability(plan({
    people: ['m', 'a', 'b'],
    signals: { complexPhysicalAction: true, complexBlocking: true, productInteraction: 'none' }
  }));
  assert.equal(result.findings.some(item => item.id === 'MULTI_SUBJECT_PHYSICS_OVERLOAD'), false);
});

test('product-only deterministic work is routed as an insert without character performance requirements', () => {
  const value = plan({ people: [], transformMode: 'local_edit', signals: { productInteraction: 'display', localDeterministic: true }, performanceBeat: undefined });
  const result = assessStoryPlanExecutability(value);
  assert.equal(result.generationGuidance[0].unit, 'deterministic_edit');
  assert.equal(result.findings.some(item => /PERFORMANCE/.test(item.id)), false);
});

test('local deterministic character edit does not require generated performance causality', () => {
  const value = plan({
    duration: 1,
    people: ['m'],
    transformMode: 'local_edit',
    signals: { localDeterministic: true },
    performanceBeat: undefined
  });
  const result = assessStoryPlanExecutability(value);
  assert.equal(result.findings.some(item => item.id === 'PERFORMANCE_CAUSALITY_UNDECLARED'), false);
  assert.equal(result.findings.some(item => item.id === 'FINAL_CUT_USED_AS_GENERATION_DURATION'), false);
});

test('short final cut may come from a valid four-second performance coverage window', () => {
  const value = plan({ duration: 1.567, people: ['m', 'f'] });
  value.videoSegments[0].generationCoverage = { durationSec: 4, editInSec: 1, editOutSec: 2.567 };
  const result = assessStoryPlanExecutability(value);
  assert.equal(result.status, 'PASS');
  assert.equal(result.generationGuidance[0].finalEditDurationSec, 1.567);
  assert.equal(result.generationGuidance[0].generationDurationSec, 4);
});

test('generation coverage edit window must exactly produce the final cut duration', () => {
  const value = plan({ duration: 1.567, people: ['m', 'f'] });
  value.videoSegments[0].generationCoverage = { durationSec: 4, editInSec: 1, editOutSec: 3 };
  const result = assessStoryPlanExecutability(value);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some(item => item.id === 'GENERATION_COVERAGE_WINDOW_INVALID'));
});

test('generated output may observe motion but cannot own identity texture or quality', () => {
  const result = assessReferenceAuthority([
    { id: 'tail', origin: 'generated_output', use: 'generation', authorities: ['position', 'motion_phase', 'identity'] }
  ]);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some(item => item.id === 'GENERATED_OUTPUT_AS_CANONICAL_AUTHORITY'));
  assert.ok(result.findings.some(item => item.id === 'GENERATED_OUTPUT_REQUIRES_CANONICAL_REANCHOR'));
});

test('size-only upscale cannot claim restored quality', () => {
  const result = assessReferenceAuthority([
    { id: 'fake-4k', origin: 'generated_output', use: 'generation', derivation: 'upscale', authorities: ['quality'] }
  ]);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some(item => item.id === 'UPSCALE_MISLABELED_AS_RESTORATION'));
});
