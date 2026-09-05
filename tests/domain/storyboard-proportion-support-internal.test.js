import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAssetVisualAudit, REQUIRED_VISUAL_CHECKS } from '../../src/domain/asset-visual-audit.js';

test('accepts clean-zero-context internal storyboard proportion-support audit evidence', () => {
  const assetType = 'storyboard_proportion_support_internal';
  const audit = {
    id: 'audit-support-v1', kind: 'asset_visual_audit', assetId: 'support-v1', assetType, assetRevision: 1,
    assetSha256: 'a'.repeat(64), decision: 'PASS', inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context', inspectorTaskId: 'independent-source-lane', observedIdentityCount: 1,
    checks: REQUIRED_VISUAL_CHECKS[assetType].map(id => ({ id, result: 'PASS', evidence: 'independently inspected pixels' })),
    blockerCount: 0, reviewedAt: '2026-08-13T14:38:00.000Z'
  };
  assert.equal(assertAssetVisualAudit(audit).decision, 'PASS');
});
