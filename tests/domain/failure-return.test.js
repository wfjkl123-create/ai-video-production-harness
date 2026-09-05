import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createGate5FailureReturn } from '../../src/domain/failure-return.js';

function input(overrides = {}) {
  const base = {
    projectId: '中文项目-001',
    artifact: {
      id: 'video-segment-001-v1', type: 'video_segment', segmentId: 'segment-001',
      revision: 1, status: 'rejected', path: 'videos/segment-001-v1.mp4', sha256: 'a'.repeat(64)
    },
    review: {
      id: 'quality-review-001', createdAt: '2026-08-25T01:00:00.000Z',
      correction: '重新绑定商品资产，只重做受影响镜头。',
      failureObservation: {
        category: 'asset_wrong_binding', rootCauseKey: 'asset-binding-001',
        responsibilityStage: 'assets', returnStage: 'assets', retryKind: 'none'
      }
    }
  };
  return { ...base, ...overrides };
}

test('Gate 5 asset rejection preserves earlier evidence and forbids automatic paid retry', () => {
  const result = createGate5FailureReturn(input());
  assert.equal(result.projectId, '中文项目-001');
  assert.equal(result.routing.returnStage, 'assets');
  assert.deepEqual(result.routing.preserveStages, [
    'intake', 'source_analysis', 'creative', 'story', 'segmentation', 'storyboard'
  ]);
  assert.deepEqual(result.routing.reworkStages, [
    'assets', 'prompt', 'paid_approval', 'generation', 'editing', 'technical_review', 'gate5'
  ]);
  assert.equal(result.routing.forbidWholeChainRestart, true);
  assert.equal(result.routing.preserveLockedEvidence, true);
  assert.equal(result.routing.replacementMustSupersedeArtifactId, 'video-segment-001-v1');
  assert.equal(result.routing.minimumReplacementRevision, 2);
  assert.equal(result.routing.automaticPaidRetryAllowed, false);
  assert.equal(result.routing.newPaidAuthorizationRequired, true);
});

test('editorial-only rejection does not invent another paid-generation authorization', () => {
  const value = input();
  value.review.failureObservation = {
    category: 'wrong_shot_order', rootCauseKey: 'edit-order-001',
    responsibilityStage: 'editing', returnStage: 'editing', retryKind: 'none'
  };
  const result = createGate5FailureReturn(value);
  assert.equal(result.routing.newPaidAuthorizationRequired, false);
  assert.deepEqual(result.routing.preserveStages.at(-1), 'generation');
  assert.deepEqual(result.routing.reworkStages, ['editing', 'technical_review', 'gate5']);
});

test('open failure return rejects claimed retries and post-Gate-5 return stages', () => {
  const paid = input();
  paid.review.failureObservation.retryKind = 'paid';
  assert.throws(() => createGate5FailureReturn(paid), /must not claim a retry/);
  const delivery = input();
  delivery.review.failureObservation.returnStage = 'delivery';
  assert.throws(() => createGate5FailureReturn(delivery), /must not be after gate5/);
  const skippedCause = input();
  skippedCause.review.failureObservation.returnStage = 'prompt';
  assert.throws(() => createGate5FailureReturn(skippedCause), /must not skip past the responsibilityStage/);
});

test('published failure return schema carries the freeze and authorization contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/gate5-failure-return.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.kind.const, 'gate5_failure_return');
  assert.equal(schema.properties.routing.properties.preserveLockedEvidence.const, true);
  assert.equal(schema.properties.routing.properties.automaticPaidRetryAllowed.const, false);
  assert.ok(schema.properties.routing.required.includes('newPaidAuthorizationRequired'));
});
