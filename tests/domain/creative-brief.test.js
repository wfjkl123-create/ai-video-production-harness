import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCreativeBrief } from '../../src/domain/creative-brief.js';
import { creativeBrief } from '../helpers/creative-brief-fixture.js';

test('schemaVersion 3 accepts one director creative master with provisional execution choices', () => {
  const value = creativeBrief();
  assert.equal(assertCreativeBrief(value), value);
});

test('legacy schemaVersion 1 and 2 briefs remain readable', () => {
  const base = creativeBrief();
  const legacyDecision = structuredClone(base.creativeDecision);
  delete legacyDecision.directorCreativeContract;
  const v1 = { ...base, schemaVersion: 1, creativeDecision: legacyDecision };
  delete v1.creativeDecision.referenceWorkflow;
  assert.equal(assertCreativeBrief(v1), v1);
  const v2 = { ...base, schemaVersion: 2, creativeDecision: { ...legacyDecision, referenceWorkflow: { referenceIntent: 'idea_only', sourceVideoIds: [] } } };
  assert.equal(assertCreativeBrief(v2), v2);
});

test('Gate 1 rejects unresolved high-impact questions instead of manufacturing certainty', () => {
  const value = creativeBrief();
  value.creativeDecision.directorCreativeContract.uncertaintyLedger.push({
    variable: '这条片究竟是广告还是个人表达', disposition: 'must_answer_now', owner: 'user',
    status: 'unresolved', resolution: '等待用户明确项目用途',
    evidenceOrReason: '用途会改变故事、人物和产品功能', revisitAt: 'Gate 0'
  });
  assert.throws(() => assertCreativeBrief(value), /must be resolved before Gate 1/);
});

test('a formerly blocking question remains auditable after the user resolves it', () => {
  const value = creativeBrief();
  value.creativeDecision.directorCreativeContract.uncertaintyLedger.push({
    variable: '这条片究竟是广告还是个人表达', disposition: 'must_answer_now', owner: 'user',
    status: 'resolved', resolution: '用户确认这是带货广告，产品必须承担剧情解决功能',
    evidenceOrReason: '当前 Gate 0 对话中的明确回答', revisitAt: '仅当项目用途改变时'
  });
  assert.equal(assertCreativeBrief(value), value);
});

test('contrast directions are optional but capped and must have distinct ids', () => {
  const value = creativeBrief();
  const alternative = index => ({
    directionId: `alternative-${index}`, materialDifference: `改变核心冲突 ${index}`,
    expectedAudienceEffect: `产生不同观众感受 ${index}`, tradeoff: `增加执行代价 ${index}`, notSelectedReason: `不如主方向匹配目标 ${index}`
  });
  value.creativeDecision.directorCreativeContract.alternativesConsidered = [alternative(1), alternative(2), alternative(3)];
  assert.throws(() => assertCreativeBrief(value), /at most two meaningful alternatives/);
  value.creativeDecision.directorCreativeContract.alternativesConsidered = [{ ...alternative(1), directionId: 'direction-visible-proof' }];
  assert.throws(() => assertCreativeBrief(value), /duplicate creative directionId/);
});

test('the recommended opening is a shootable text design rather than a generic hook label', () => {
  const value = creativeBrief();
  delete value.creativeDecision.directorCreativeContract.recommendedDirection.openingDesign.firstFrame;
  assert.throws(() => assertCreativeBrief(value), /openingDesign\.firstFrame/);
});

test('lead characters require objective obstacle tactic and arc while functional roles do not', () => {
  const lead = creativeBrief();
  delete lead.creativeDecision.directorCreativeContract.characters[0].tactic;
  assert.throws(() => assertCreativeBrief(lead), /characters\[0\]\.tactic/);

  const functional = creativeBrief();
  functional.creativeDecision.directorCreativeContract.characterMode = 'subject_only';
  functional.creativeDecision.directorCreativeContract.characters = [{
    characterId: 'passerby', importance: 'functional', dramaticFunction: '触发一次视线转移',
    emotionalBaseline: '中性', audienceRelationship: '只承担空间提示', visibleBehavior: '从画面后方经过'
  }];
  assert.equal(assertCreativeBrief(functional), functional);
});

test('character-driven work cannot pass with an empty cast, while a subject-only montage can', () => {
  const emptyCast = creativeBrief();
  emptyCast.creativeDecision.directorCreativeContract.characters = [];
  assert.throws(() => assertCreativeBrief(emptyCast), /require at least one lead or key_opponent/);

  const montage = creativeBrief();
  const contract = montage.creativeDecision.directorCreativeContract;
  contract.structureMode = 'montage';
  contract.characterMode = 'subject_only';
  contract.characters = [];
  contract.storyOutline = ['按视觉主题完成信息递进'];
  delete contract.recommendedDirection.centralConflict;
  delete contract.recommendedDirection.coreTurn;
  delete contract.recommendedDirection.endingPayoff;
  assert.equal(assertCreativeBrief(montage), montage);
});

test('non-commercial work does not fabricate a product function', () => {
  const value = creativeBrief();
  const contract = value.creativeDecision.directorCreativeContract;
  contract.projectIntent.commercialIntent = false;
  delete contract.projectIntent.productDramaticFunction;
  contract.projectIntent.nonCommercialRationale = '这是个人表达短片，不承担产品销售或品牌任务';
  delete contract.recommendedDirection.recommendationRationale.productFunction;
  assert.equal(assertCreativeBrief(value), value);

  const staleProjectFunction = structuredClone(value);
  staleProjectFunction.creativeDecision.directorCreativeContract.projectIntent.productDramaticFunction = '过期产品承接';
  assert.throws(() => assertCreativeBrief(staleProjectFunction), /must not retain productDramaticFunction/);

  const staleRecommendationFunction = structuredClone(value);
  staleRecommendationFunction.creativeDecision.directorCreativeContract.recommendedDirection.recommendationRationale.productFunction = '过期产品理由';
  assert.throws(() => assertCreativeBrief(staleRecommendationFunction), /must not retain recommendationRationale.productFunction/);
});

test('legacy summary aliases cannot contradict the v3 director authority', () => {
  const value = creativeBrief();
  value.creativeDecision.storyDirection = '与导演母版相反的另一个故事';
  assert.throws(() => assertCreativeBrief(value), /storyDirection must equal/);
});

test('Gate 1 refuses to present provisional execution estimates as final Gate 2 locks', () => {
  const value = creativeBrief();
  value.creativeDecision.directorCreativeContract.provisionalExecution.assetScope = 'locked';
  assert.throws(() => assertCreativeBrief(value), /provisional_until_gate2/);
});

test('the single Gate 1 review page exposes the director master without adding another approval form', async () => {
  const html = await readFile(new URL('../../templates/lavish-checkpoint/checkpoint-creative.html', import.meta.url), 'utf8');
  for (const marker of [
    '{{PURPOSE_AUDIENCE}}', '{{RECOMMENDED_DIRECTION}}', '{{CHARACTER_FUNCTIONS}}', '{{OPENING_PROMISE}}',
    '{{CONFLICT_AND_TURN}}', '{{ENDING_PAYOFF}}', '{{COMMERCIAL_FUNCTION_OR_NONCOMMERCIAL_RATIONALE}}', '{{EMOTION_RHYTHM}}',
    '{{AUDIOVISUAL_STRATEGY}}', '{{REJECTED_PATTERNS}}', '{{DECISION_LEDGER}}', '{{UNCERTAINTY_LEDGER}}', '{{CHANGE_IMPACT}}'
  ]) assert.match(html, new RegExp(marker.replace(/[{}]/g, '\\$&')));
  assert.equal((html.match(/data-lavish-question=/g) ?? []).length, 1);
  assert.match(html, /只在 Gate 1 正式确认一次/);
});
