import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  artifactResponsibilityStage,
  assertGate5ReworkWorkOrder,
  upgradeGate5ReworkWorkOrder
} from '../../src/domain/gate5-rework-work-order.js';

function workOrder() {
  return {
    schemaVersion: 1, kind: 'gate5_rework_work_order', id: 'gate5-rework-001', status: 'READY',
    projectId: '中文项目-001', failureReturnId: 'gate5-return-001', failureReturnSha256: 'a'.repeat(64),
    scope: 'segment', segmentId: 'segment-001',
    rejection: { reviewId: 'review-001', artifactId: 'video-v1', artifactSha256: 'b'.repeat(64) },
    returnStage: 'assets', responsibilityStage: 'assets', reworkAction: 'revise_asset_binding',
    frozenEvidence: {
      artifacts: [{
        id: 'story-v1', type: 'story_plan', stage: 'story', revision: 1, status: 'locked',
        path: 'planning/story-v1.json', sha256: 'c'.repeat(64), lockedByReviewId: 'review-story-v1'
      }],
      fingerprintSha256: 'd'.repeat(64)
    },
    allowedMutationStages: ['assets', 'prompt', 'paid_approval', 'generation', 'editing', 'technical_review', 'gate5'],
    replacementContract: { mustSupersedeArtifactId: 'video-v1', minimumRevision: 2, mustReturnToGate5: true },
    paidBoundary: { newAuthorizationRequired: true, automaticRetryAllowed: false, existingApprovalReusable: false },
    steps: ['assets', 'prompt', 'paid_approval', 'generation', 'editing', 'technical_review', 'gate5']
      .map(stage => ({ stage, status: 'pending' })),
    createdAt: '2026-08-25T02:00:00.000Z'
  };
}

test('work order accepts an ordered minimum return path with immutable paid boundaries', () => {
  assert.equal(assertGate5ReworkWorkOrder(workOrder()).status, 'READY');
  const upgraded = upgradeGate5ReworkWorkOrder(workOrder(), '2026-08-25T03:00:00.000Z');
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.progressRevision, 0);
  assert.equal(upgraded.steps[0].checkpoint, null);
  assert.equal(artifactResponsibilityStage({ type: 'creative_brief' }), 'creative');
  assert.equal(artifactResponsibilityStage({ type: 'video_segment' }), 'generation');
});

test('work order rejects an omitted intermediate stage or reusable paid approval', () => {
  const skipped = workOrder();
  skipped.allowedMutationStages.splice(2, 1);
  skipped.steps.splice(2, 1);
  assert.throws(() => assertGate5ReworkWorkOrder(skipped), /ordered path/);
  const reusable = workOrder();
  reusable.paidBoundary.existingApprovalReusable = true;
  assert.throws(() => assertGate5ReworkWorkOrder(reusable), /cannot automatically retry or reuse/);
});

test('work order cannot redirect replacement or return after its responsibility stage', () => {
  const redirected = workOrder();
  redirected.replacementContract.mustSupersedeArtifactId = 'different-video-v1';
  assert.throws(() => assertGate5ReworkWorkOrder(redirected), /directly supersede/);
  const reversed = workOrder();
  reversed.returnStage = 'generation';
  assert.throws(() => assertGate5ReworkWorkOrder(reversed), /must not follow/);
});

test('published work-order schema fixes automatic retry, old approval reuse and resumable progress', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/gate5-rework-work-order.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.equal(schema.properties.kind.const, 'gate5_rework_work_order');
  assert.ok(schema.properties.status.enum.includes('PAUSED'));
  assert.ok(schema.properties.status.enum.includes('COMPLETED'));
  assert.equal(schema.properties.paidBoundary.properties.automaticRetryAllowed.const, false);
  assert.equal(schema.properties.paidBoundary.properties.existingApprovalReusable.const, false);
});
