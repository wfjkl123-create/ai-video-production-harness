import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertQualityReview,
  assertQualityRubric,
  evaluateQualityRubric
} from '../../src/domain/quality-review.js';

const rubric = {
  id: 'rubric-v1', version: 1, threshold: 80,
  dimensions: [
    { id: 'identity', label: '人物身份与产品一致性', weight: 60, minimum: 70, critical: true },
    { id: 'camera', label: '镜头叙事', weight: 40, minimum: 60, critical: false }
  ],
  vetoes: [{ id: 'product_deformed', label: '产品结构明显变形' }]
};

test('computes weighted quality and enforces critical floors plus vetoes', () => {
  const passing = evaluateQualityRubric(rubric, {
    scores: { identity: 90, camera: 70 }, triggeredVetoIds: []
  });
  assert.equal(passing.overall, 82);
  assert.equal(passing.qualifies, true);
  assert.deepEqual(passing.failures, []);

  const criticalFailure = evaluateQualityRubric(rubric, {
    scores: { identity: 69, camera: 100 }, triggeredVetoIds: []
  });
  assert.equal(criticalFailure.overall, 81.4);
  assert.equal(criticalFailure.qualifies, false);
  assert.match(criticalFailure.failures[0], /identity/);

  const vetoed = evaluateQualityRubric(rubric, {
    scores: { identity: 100, camera: 100 }, triggeredVetoIds: ['product_deformed']
  });
  assert.equal(vetoed.qualifies, false);
  assert.match(vetoed.failures[0], /product_deformed/);
});

test('requires a complete normalized rubric and one score per dimension', () => {
  assert.equal(assertQualityRubric(rubric), rubric);
  assert.throws(() => assertQualityRubric({ ...rubric, threshold: 101 }), /threshold/);
  assert.throws(() => assertQualityRubric({ ...rubric, dimensions: [{ ...rubric.dimensions[0], weight: 99 }] }), /100/);
  assert.throws(() => evaluateQualityRubric(rubric, { scores: { identity: 80 }, triggeredVetoIds: [] }), /camera/);
  assert.throws(() => evaluateQualityRubric(rubric, { scores: { identity: 80, camera: 70, extra: 90 }, triggeredVetoIds: [] }), /extra/);
});

test('final quality evidence must be human and explain a decision that contradicts qualification', () => {
  const base = {
    id: 'review-quality-1', kind: 'quality_review', actor: 'human', artifactId: 'video-1',
    artifactSha256: 'a'.repeat(64), submittedArtifactSha256: 'a'.repeat(64), rubricId: 'rubric-v1', rubricSha256: 'b'.repeat(64),
    rubricVersion: 1, decision: 'approved', scores: { identity: 90, camera: 70 },
    triggeredVetoIds: [], overall: 82, qualifies: true, failures: [], note: '通过',
    correction: null, overrideReason: null, createdAt: '2026-07-14T00:00:00Z'
  };
  assert.equal(assertQualityReview(base), base);
  assert.throws(() => assertQualityReview({ ...base, actor: 'model' }), /human/);
  assert.throws(() => assertQualityReview({ ...base, decision: 'rejected', correction: '重做镜头', overrideReason: null }), /overrideReason/);
  assert.equal(assertQualityReview({ ...base, decision: 'rejected', correction: '重做镜头', overrideReason: '人工认为卖点不清晰' }).decision, 'rejected');
  const structuredRejection = {
    ...base, decision: 'rejected', correction: '回到资产阶段修正人物绑定', overrideReason: '人工确认人物身份漂移',
    failureObservation: {
      category: 'identity_drift', rootCauseKey: 'gate5.identity.character-binding',
      responsibilityStage: 'assets', returnStage: 'assets', retryKind: 'none'
    }
  };
  assert.equal(assertQualityReview(structuredRejection).failureObservation.returnStage, 'assets');
  assert.throws(() => assertQualityReview({
    ...structuredRejection, failureObservation: { ...structuredRejection.failureObservation, retryKind: 'paid' }
  }), /retryKind none/);
  assert.throws(() => assertQualityReview({ ...base, failureObservation: structuredRejection.failureObservation }), /only valid for rejected/);
});

test('publishes quality rubric and review JSON schemas', async () => {
  const rubricSchema = JSON.parse(await readFile(new URL('../../schemas/quality-rubric.schema.json', import.meta.url), 'utf8'));
  const reviewSchema = JSON.parse(await readFile(new URL('../../schemas/quality-review.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(rubricSchema.required, ['id', 'version', 'threshold', 'dimensions', 'vetoes']);
  assert.ok(reviewSchema.required.includes('rubricSha256'));
  assert.ok(reviewSchema.required.includes('submittedArtifactSha256'));
  assert.ok(reviewSchema.required.includes('overall'));
  assert.equal(reviewSchema.properties.actor.const, 'human');
  assert.ok(reviewSchema.properties.failureObservation);
  assert.ok(reviewSchema.properties.resolvedRejection);
});
