import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_VISUAL_CHECKS,
  assertAssetVisualAudit,
  assertCharacterBoardDescriptor,
  requireMatchingAssetVisualAudit
} from '../../src/domain/asset-visual-audit.js';

function audit(overrides = {}) {
  return {
    id: 'visual-audit-character-a-v1', kind: 'asset_visual_audit',
    assetId: 'character-a-board-v1', assetType: 'character_board', assetRevision: 1,
    assetSha256: 'a'.repeat(64), decision: 'PASS', inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context', inspectorTaskId: 'fresh-agent-001',
    observedIdentityCount: 1,
    checks: REQUIRED_VISUAL_CHECKS.character_board.map(id => ({ id, result: 'PASS', evidence: `pixels inspected for ${id}` })),
    blockerCount: 0, reviewedAt: '2026-07-26T12:00:00Z', ...overrides
  };
}

test('accepts checksum-bound one-person four-view visual PASS evidence', () => {
  assert.equal(assertAssetVisualAudit(audit()).decision, 'PASS');
});

test('rejects cast composites and missing required four-view observations', () => {
  assert.throws(() => assertAssetVisualAudit(audit({ observedIdentityCount: 3 })), /exactly one/);
  assert.throws(() => assertAssetVisualAudit(audit({ checks: audit().checks.slice(1) })), /missing/);
  const failedProfile = audit();
  failedProfile.checks.find(({ id }) => id === 'profile_face_closeup').result = 'FAIL';
  assert.throws(() => assertAssetVisualAudit(failedProfile), /profile_face_closeup/);
});

test('requires a single character identity and versioned visual contract', () => {
  const descriptor = { type: 'project_asset', assetType: 'character_board', characterId: 'character-a', visualContractVersion: 1 };
  assert.equal(assertCharacterBoardDescriptor(descriptor), descriptor);
  assert.throws(() => assertCharacterBoardDescriptor({ ...descriptor, characterId: '' }), /characterId/);
  assert.throws(() => assertCharacterBoardDescriptor({ ...descriptor, characterIds: ['a', 'b', 'c'] }), /exactly one/);

  const sourceVisible = { ...descriptor, assetType: 'character_identity_source_visible_v1' };
  assert.equal(assertCharacterBoardDescriptor(sourceVisible), sourceVisible);
  assert.throws(() => assertCharacterBoardDescriptor({ ...sourceVisible, visualContractVersion: undefined }), /visualContractVersion/);
  assert.throws(() => assertCharacterBoardDescriptor({ ...sourceVisible, characterIds: ['a', 'b'] }), /exactly one/);
});

test('accepts one source-visible front identity through the knees without requiring scene isolation', () => {
  const profile = 'character_identity_source_visible_v1';
  assert.deepEqual(REQUIRED_VISUAL_CHECKS[profile], [
    'single_identity',
    'front_source_visible_head_through_at_least_knees_complete',
    'face_hair_white_mesh_top_plaid_skirt_legible',
    'not_multi_person_panel_or_cast_composite',
    'no_product_text_watermark_ui',
    'source_scene_context_allowed_but_not_authoritative',
    'role_suitability_identity_wardrobe_source_visible_body_proportions_only'
  ]);
  const sourceVisible = audit({
    assetId: 'character-lead-source-visible-v1',
    assetType: profile,
    checks: REQUIRED_VISUAL_CHECKS[profile].map(id => ({
      id,
      result: 'PASS',
      evidence: `source pixels inspected for ${id}`
    }))
  });
  assert.equal(assertAssetVisualAudit(sourceVisible).decision, 'PASS');
  assert.throws(() => assertAssetVisualAudit({ ...sourceVisible, observedIdentityCount: 2 }), /exactly one/);
  assert.throws(() => assertAssetVisualAudit({ ...sourceVisible, checks: sourceVisible.checks.slice(1) }), /missing/);
});

test('requires locked PASS visual evidence bound to the exact asset revision and SHA', () => {
  const asset = {
    id: 'character-a-board-v1', type: 'project_asset', assetType: 'character_board', revision: 1,
    status: 'locked', path: 'character.png', sha256: 'a'.repeat(64), characterId: 'character-a',
    visualContractVersion: 1, visualAuditId: 'visual-audit-character-a-v1'
  };
  const evidence = { ...audit(), type: 'asset_visual_audit', status: 'locked' };
  assert.equal(requireMatchingAssetVisualAudit({ artifacts: [asset, evidence] }, asset), evidence);
  assert.throws(() => requireMatchingAssetVisualAudit({ artifacts: [asset, { ...evidence, assetSha256: 'b'.repeat(64) }] }, asset), /stale/);
});

test('accepts a locked FAIL audit for a regular asset only through an exact human visual exception', () => {
  const asset = {
    id: 'segment-001-first-frame-v1', type: 'segment_asset', assetType: 'initial_blocking', revision: 1,
    status: 'locked', path: 'first.png', sha256: 'a'.repeat(64),
    visualAuditId: 'visual-audit-first-v1', humanVisualExceptionId: 'visual-exception-first-v1'
  };
  const evidence = {
    id: 'visual-audit-first-v1', type: 'asset_visual_audit', status: 'locked',
    assetId: asset.id, assetType: asset.assetType, assetRevision: 1, assetSha256: asset.sha256,
    decision: 'FAIL', inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: 'independent-review-first-v1', observedIdentityCount: 1, blockerCount: 1,
    checkIds: ['opening_state_match'], failedCheckIds: ['canonical_product_topology']
  };
  const exception = {
    id: 'visual-exception-first-v1', type: 'human_visual_exception', status: 'locked',
    assetId: asset.id, assetRevision: 1, assetSha256: asset.sha256,
    visualAuditId: evidence.id, acceptedFailedCheckIds: ['canonical_product_topology']
  };
  assert.deepEqual(requireMatchingAssetVisualAudit({ artifacts: [asset, evidence, exception] }, asset), { audit: evidence, exception });
  assert.throws(() => requireMatchingAssetVisualAudit({ artifacts: [asset, evidence, { ...exception, assetSha256: 'b'.repeat(64) }] }, asset), /stale/);
  assert.throws(() => requireMatchingAssetVisualAudit({ artifacts: [asset, evidence, { ...exception, acceptedFailedCheckIds: ['unrelated'] }] }, asset), /not failed/);
});

test('uses profile-specific checks for atomic character views', () => {
  const atomic = audit({
    assetId: 'character-a-front-v1',
    assetType: 'character_front_face_closeup_v1',
    checks: REQUIRED_VISUAL_CHECKS.character_front_face_closeup_v1.map(id => ({ id, result: 'PASS', evidence: `pixels inspected for ${id}` }))
  });
  assert.equal(assertAssetVisualAudit(atomic).decision, 'PASS');
  assert.throws(() => assertAssetVisualAudit({ ...atomic, checks: atomic.checks.slice(1) }), /missing/);
});

test('a stylized clay front-face audit proves clay material instead of live-action skin texture', () => {
  const clay = audit({
    assetId: 'clay-front-v1',
    assetType: 'character_front_face_closeup_v1',
    characterMedium: 'stylized_clay',
    checks: REQUIRED_VISUAL_CHECKS.character_front_face_closeup_v1.map(id => ({
      id: id === 'natural_skin_texture' ? 'matte_clay_surface_no_human_skin' : id,
      result: 'PASS',
      evidence: 'pixel evidence'
    }))
  });
  assert.equal(assertAssetVisualAudit(clay).characterMedium, 'stylized_clay');
  assert.throws(() => assertAssetVisualAudit({
    ...clay,
    checks: REQUIRED_VISUAL_CHECKS.character_front_face_closeup_v1.map(id => ({ id, result: 'PASS', evidence: 'pixel evidence' }))
  }), /matte_clay_surface_no_human_skin/);
});

test('accepts a garment-only wardrobe board without inventing a character face audit', () => {
  const wardrobe = audit({
    assetId: 'bride-wardrobe-board-v2',
    assetType: 'wardrobe_board',
    observedIdentityCount: 0,
    checks: REQUIRED_VISUAL_CHECKS.wardrobe_board.map(id => ({ id, result: 'PASS', evidence: `garment pixels inspected for ${id}` }))
  });
  assert.equal(assertAssetVisualAudit(wardrobe).decision, 'PASS');
  assert.throws(() => assertAssetVisualAudit({ ...wardrobe, checks: wardrobe.checks.slice(1) }), /missing/);
});

test('accepts a source-observed multi-prop set without pretending it is one prop in four views', () => {
  const propSet = audit({
    assetId: 'negative-prop-set-v1',
    assetType: 'story_prop_set_v1',
    observedIdentityCount: 1,
    checks: REQUIRED_VISUAL_CHECKS.story_prop_set_v1.map(id => ({
      id, result: 'PASS', evidence: `source pixels inspected for ${id}`
    }))
  });
  assert.equal(assertAssetVisualAudit(propSet).decision, 'PASS');
  assert.throws(() => assertAssetVisualAudit({ ...propSet, checks: propSet.checks.slice(1) }), /missing/);
});
