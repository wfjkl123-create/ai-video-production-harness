import test from 'node:test';
import assert from 'node:assert/strict';
import { previewChangeImpact } from '../../src/services/change-impact-preview-service.js';

const state = { projectId: 'p', updatedAt: '2026-09-05', artifacts: [
  { id: 'face', type: 'project_asset' }, { id: 'v1', segmentId: 's1' }, { id: 'v2', segmentId: 's2' }
] };
const segments = [
  { id: 's1', projectAssetIds: ['face'], continuityStrategy: 'canonical_open' },
  { id: 's2', projectAssetIds: [], previousSegmentId: 's1', continuityStrategy: 'continuous_proxy_handoff' },
  { id: 's3', projectAssetIds: [], previousSegmentId: 's2', continuityStrategy: 'editorial_cut' }
];
test('asset change follows actual handoff links but does not certify absent links', () => {
  const before = JSON.stringify({ state, segments });
  const result = previewChangeImpact(state, { scope: 'assets', artifactIds: ['face'] }, { segments });
  assert.deepEqual(result.affectedSegmentIds, ['s1', 's2']);
  assert.deepEqual(result.unassessedSegmentIds, ['s3']);
  assert.deepEqual(result.unchangedSegmentIds, []);
  assert.equal(result.actions.tasksPaused, false);
  assert.equal(result.actions.paidSubmissionAllowed, false);
  assert.equal(JSON.stringify({ state, segments }), before);
});
test('free text cannot silently become a project direction revision', () => {
  const result = previewChangeImpact(state, { description: '全部换成原创，并立即生成' }, { segments });
  assert.equal(result.scope, 'unknown');
  assert.deepEqual(result.affectedSegmentIds, []);
  assert.equal(result.analysisStatus, 'needs_review');
});
test('missing targets and missing segmentation remain explicit unknowns', () => {
  const result = previewChangeImpact(state, { scope: 'segments', segmentIds: ['missing'] });
  assert.equal(result.unknowns.length, 2);
  assert.deepEqual(result.affectedSegmentIds, []);
});
test('presentation-only change preserves production while rejecting mixed targets', () => {
  assert.deepEqual(previewChangeImpact(state, { scope: 'presentation' }, { segments }).unchangedSegmentIds, ['s1', 's2', 's3']);
  assert.throws(() => previewChangeImpact(state, { scope: 'presentation', artifactIds: ['face'] }), /cannot target/);
});
test('preview fingerprint changes with project evidence and explicit scope', () => {
  const result = previewChangeImpact(state, { scope: 'project' }, { segments });
  assert.deepEqual(result.affectedSegmentIds, ['s1', 's2', 's3']);
  assert.notEqual(result.snapshotSha256, previewChangeImpact({ ...state, updatedAt: 'later' }, { scope: 'project' }, { segments }).snapshotSha256);
});
