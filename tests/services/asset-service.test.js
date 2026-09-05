import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAssetManifest, assertLockedAssetInputs } from '../../src/services/asset-service.js';

const locked = (id, type, extra = {}) => ({
  id,
  type,
  revision: 1,
  status: 'locked',
  path: `${type}/${id}.json`,
  lockedByReviewId: `review-${id}`,
  ...(['project_asset', 'segment_asset', 'video_segment'].includes(type) ? { sha256: 'a'.repeat(64) } : {}),
  ...extra
});

function project(overrides = {}) {
  const character = locked('character-001', 'project_asset', {
    assetType: 'character_board', characterId: 'character-a', visualContractVersion: 1,
    visualAuditId: 'visual-audit-character-001'
  });
  const visualAudit = locked('visual-audit-character-001', 'asset_visual_audit', {
    assetId: character.id, assetType: 'character_board', assetRevision: character.revision,
    assetSha256: character.sha256, decision: 'PASS', inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context', inspectorTaskId: 'fresh-agent-001',
    observedIdentityCount: 1, blockerCount: 0
  });
  return {
    artifacts: [
      locked('script-001', 'script'),
      locked('shotlist-001', 'shotlist'),
      character,
      visualAudit,
      locked('product-001', 'project_asset', { assetType: 'product_reference' })
    ],
    segments: [firstSegment],
    ...overrides
  };
}

const firstSegment = {
  id: 'segment-001',
  status: 'locked',
  lockedByReviewId: 'review-segment-001',
  previousSegmentId: null,
  nextSegmentId: null,
  projectAssetIds: ['character-001', 'product-001'],
  segmentAssetRequirements: ['initial_blocking', 'camera_blocking', 'storyboard']
};

const evidencedField = (value, basis = 'observed', timestamps = [7.25, 8.75, 9.75]) => ({ value, basis, timestamps });

function observedHandoff(overrides = {}) {
  return locked('handoff-001', 'handoff', {
    segmentId: 'segment-001',
    observed: true,
    preparedHandoffId: 'handoff-prepared-segment-001',
    preparedHandoffSha256: 'b'.repeat(64),
    sourceVideoId: 'video-segment-001',
    sourceVideoSha256: 'c'.repeat(64),
    evidenceTimestamps: [7.25, 8.75, 9.75],
    people: evidencedField([{ personId: 'person-1', leftRight: 'left', depth: 'foreground', bodyDirection: 'camera-right', faceDirection: 'toward-person-2', gaze: 'person-2' }]),
    distances: evidencedField([{ from: 'person-1', to: 'person-2', distance: 'one arm length' }]),
    productState: evidencedField({ description: 'worn and waistband flat' }),
    props: evidencedField([{ propId: 'phone', state: 'held upright', holder: 'person-2' }]),
    camera: evidencedField({ position: 'front-left medium distance', direction: 'toward room center', shotSize: 'medium' }),
    openMotion: evidencedField(['person-1 continues turning right'], 'multi_frame_inference'),
    unknowns: evidencedField(['exact lens focal length']),
    sha256: 'd'.repeat(64),
    ...overrides
  });
}

function canonicalHdRestorationHandoff(source, overrides = {}) {
  return locked('handoff-restoration-001', 'handoff', {
    segmentId: 'segment-001',
    observed: false,
    handoffKind: 'canonical_hd_restoration',
    derivation: 'canonical_hd_reconstruction',
    sourceArtifactId: source.id,
    sourceArtifactSha256: source.sha256,
    sha256: 'e'.repeat(64),
    ...overrides
  });
}

function handoffReconciliation(source, overrides = {}) {
  return locked('handoff-reconciliation-001-002', 'handoff_reconciliation', {
    segmentId: 'segment-002', previousSegmentId: 'segment-001', nextSegmentId: 'segment-002',
    decision: 'PASS', observedHandoffId: source.id, observedHandoffSha256: source.sha256,
    sourceSegmentationId: 'segmentation-v2', sourceSegmentationSha256: 'f'.repeat(64),
    canonicalAuthorityArtifactIds: ['character-001'], sha256: '1'.repeat(64),
    ...overrides
  });
}

test('compiles recognized project and conditional segment assets with bounded responsibilities', () => {
  const manifest = compileAssetManifest(project(), firstSegment);
  assert.deepEqual(manifest.sourceArtifactIds, { script: 'script-001', shotlist: 'shotlist-001' });
  assert.deepEqual(manifest.items.map(({ type }) => type), [
    'character_board', 'product_reference', 'initial_blocking', 'camera_blocking', 'storyboard'
  ]);
  for (const item of manifest.items) {
    assert.equal(typeof item.responsibility, 'string');
    assert.ok(item.responsibility.length > 0);
    assert.ok(Array.isArray(item.mustNotControl) && item.mustNotControl.length > 0);
  }
  const camera = manifest.items.find(({ type }) => type === 'camera_blocking');
  assert.deepEqual(camera.mustNotControl, ['identity', 'wardrobe', 'product appearance', 'color grade', 'final texture']);
  assert.deepEqual(manifest.items[0], {
    ...manifest.items[0],
    revision: 1,
    path: 'project_asset/character-001.json',
    lockedByReviewId: 'review-character-001',
    sha256: 'a'.repeat(64)
  });
});

test('rejects unknown asset types', () => {
  const segment = { ...firstSegment, segmentAssetRequirements: ['mystery_board'] };
  assert.throws(() => compileAssetManifest(project({ segments: [segment] }), segment), /unknown segment asset type/);
});

test('never resolves a scope-invalidated asset as a current explicit input', () => {
  const state = project();
  const character = state.artifacts.find(artifact => artifact.id === 'character-001');
  character.invalidatedByScopeRevisionId = 'direction-revision-2';
  character.invalidationReason = 'execution direction changed';
  assert.throws(() => compileAssetManifest(state, firstSegment), /referenced project asset character-001 is not locked/);
});

test('routes project asset types declared in the segment input contract to the project lane', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['initial_blocking', 'product_reference']
  };
  const manifest = compileAssetManifest(project({ segments: [segment] }), segment);
  assert.deepEqual(manifest.items.map(({ type }) => type).sort(), ['initial_blocking', 'product_reference']);
  assert.equal(manifest.items.find(({ type }) => type === 'product_reference').scope, 'project');
});

test('canonicalizes a reviewed source-observed prop set to the story_prop manifest role', () => {
  const propSet = locked('negative-prop-set-v1', 'project_asset', { assetType: 'story_prop_set_v1' });
  const segment = {
    ...firstSegment,
    projectAssetIds: [propSet.id],
    segmentAssetRequirements: []
  };
  const state = project({ segments: [segment] });
  state.artifacts.push(propSet);
  const manifest = compileAssetManifest(state, segment);
  assert.deepEqual(manifest.items.map(({ id, type, scope }) => ({ id, type, scope })), [
    { id: propSet.id, type: 'story_prop', scope: 'project' }
  ]);
});

test('resolves a source-visible character profile to the canonical single-view requirement without transferring its scene', () => {
  const character = locked('character-lead-source-visible-v1', 'project_asset', {
    assetType: 'character_identity_source_visible_v1',
    characterId: 'lead-presenter',
    visualContractVersion: 1,
    visualAuditId: 'visual-audit-character-lead-source-visible-v1'
  });
  const visualAudit = locked('visual-audit-character-lead-source-visible-v1', 'asset_visual_audit', {
    assetId: character.id,
    assetType: character.assetType,
    assetRevision: character.revision,
    assetSha256: character.sha256,
    decision: 'PASS',
    inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: 'fresh-source-visible-auditor',
    observedIdentityCount: 1,
    blockerCount: 0
  });
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['character_identity_single_view']
  };
  const state = project({
    segments: [segment],
    artifacts: [
      ...project().artifacts.filter(item => !['character-001', 'visual-audit-character-001'].includes(item.id)),
      character,
      visualAudit
    ]
  });

  const manifest = compileAssetManifest(state, segment);
  assert.equal(manifest.items.length, 1);
  assert.deepEqual(manifest.items[0], {
    id: character.id,
    type: 'character_identity_single_view',
    scope: 'project',
    status: 'locked',
    responsibility: 'single identity, face, hair, white mesh top, plaid skirt, and body proportions visible in the source frame from head through at least the knees only',
    mustNotControl: ['source scene appearance or layout', 'story action', 'camera', 'product appearance', 'text', 'watermark', 'UI', 'color grade', 'unseen full-body proportions', 'reference-board layout'],
    revision: 1,
    path: character.path,
    lockedByReviewId: character.lockedByReviewId,
    sha256: character.sha256,
    characterId: 'lead-presenter',
    visualContractVersion: 1,
    visualAuditId: visualAudit.id
  });
});

test('uses the highest locked script and shotlist revisions as manifest sources', () => {
  const state = project();
  state.artifacts.push(
    locked('script-002', 'script', { revision: 2 }),
    locked('shotlist-002', 'shotlist', { revision: 2 })
  );
  const manifest = compileAssetManifest(state, firstSegment);
  assert.deepEqual(manifest.sourceArtifactIds, { script: 'script-002', shotlist: 'shotlist-002' });
});

test('workflowVersion 2 requires verified story-plan evidence and uses it as script and shot truth', () => {
  const storyPlan = locked('story-plan-v1', 'story_plan');
  const state = project({ workflowVersion: 2, verifiedStoryPlanId: storyPlan.id });
  state.artifacts.push(storyPlan);
  const manifest = compileAssetManifest(state, firstSegment);
  assert.deepEqual(manifest.sourceArtifactIds, { script: storyPlan.id, shotlist: storyPlan.id });
  assert.throws(() => compileAssetManifest({ ...state, verifiedStoryPlanId: null }, firstSegment), /story_plan/);
});

test('uses resolved editorial-to-canonical capability requirements without silently dropping locked assets', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: []
  };
  const state = project({ segments: [segment] });
  const storyPlan = locked('story-plan-a1', 'story_plan');
  const capability = locked('capability-a1', 'capability_manifest', {
    storyPlanId: storyPlan.id,
    storyPlanSha256: 'd'.repeat(64),
    routePrecision: 'explicit_v2',
    storyPlanSchemaVersion: 2,
    requiredAssetsBySegment: { A1: ['character_board', 'scene_multiview', 'depth_video_reference', 'source_audio_candidate'] },
    requiredArtifactsBySegment: { A1: [] }
  });
  const scene = locked('scene-a1', 'project_asset', {
    assetType: 'scene_multiview', visualAuditId: 'visual-audit-scene-a1'
  });
  const sceneAudit = locked('visual-audit-scene-a1', 'asset_visual_audit', {
    assetId: scene.id, assetType: scene.assetType, assetRevision: scene.revision,
    assetSha256: scene.sha256, decision: 'PASS', inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context', inspectorTaskId: 'fresh-agent-scene', observedIdentityCount: 0, blockerCount: 0
  });
  const depth = locked('depth-a1', 'segment_asset', {
    assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'video',
    visualAuditId: 'visual-audit-depth-a1'
  });
  const depthAudit = locked('visual-audit-depth-a1', 'asset_visual_audit', {
    assetId: depth.id, assetType: depth.assetType, assetRevision: depth.revision,
    assetSha256: depth.sha256, decision: 'PASS', inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context', inspectorTaskId: 'fresh-agent-depth', observedIdentityCount: 0, blockerCount: 0
  });
  const audio = locked('audio-a1', 'segment_asset', {
    assetType: 'source_audio_candidate', segmentId: 'segment-001', mediaKind: 'audio'
  });
  state.workflowVersion = 2;
  state.verifiedStoryPlanId = storyPlan.id;
  state.verifiedCapabilityManifestId = capability.id;
  state.directorRoutingVersion = 1;
  state.resolvedCapabilityRequirementsBySegment = {
    'segment-001': ['character_board', 'scene_multiview', 'depth_video_reference', 'source_audio_candidate']
  };
  state.resolvedCapabilityArtifactsBySegment = { 'segment-001': [] };
  state.artifacts.push(storyPlan, capability, scene, sceneAudit, depth, depthAudit, audio);

  const manifest = compileAssetManifest(state, segment);
  assert.deepEqual(manifest.items.map(item => item.type), [
    'character_board', 'scene_multiview', 'depth_video_reference', 'source_audio_candidate'
  ]);
});

test('excludes a story-plan-denied locked segment asset instead of silently reusing it', () => {
  const storyPlan = locked('story-plan-v2', 'story_plan', {
    excludedAssetIds: ['legacy-storyboard-rgb']
  });
  const oldStoryboard = locked('legacy-storyboard-rgb', 'segment_asset', {
    assetType: 'storyboard', segmentId: 'segment-001'
  });
  const state = project({ workflowVersion: 2, verifiedStoryPlanId: storyPlan.id });
  state.artifacts.push(storyPlan, oldStoryboard);
  const manifest = compileAssetManifest(state, firstSegment);
  const storyboard = manifest.items.find(({ type }) => type === 'storyboard');
  assert.equal(storyboard.id, 'segment-001-storyboard');
  assert.equal(storyboard.status, 'awaiting_review');
  assert.deepEqual(manifest.sourceArtifactIds.excludedAssetIds, ['legacy-storyboard-rgb']);
});

test('excludes a byte-identical legacy alias of a story-plan-denied asset', () => {
  const denied = locked('legacy-storyboard-rgb', 'segment_asset', {
    assetType: 'storyboard', segmentId: 'segment-001', path: 'assets/old-rgb.png', sha256: 'b'.repeat(64)
  });
  const alias = locked('legacy-storyboard-rgb-alias', 'segment_asset', {
    assetType: 'storyboard', segmentId: 'segment-001', path: 'assets/old-rgb.png', sha256: 'b'.repeat(64), revision: 2
  });
  const storyPlan = locked('story-plan-v3', 'story_plan', {
    excludedAssetIds: [denied.id]
  });
  const state = project({ workflowVersion: 2, verifiedStoryPlanId: storyPlan.id });
  state.artifacts.push(storyPlan, denied, alias);
  const manifest = compileAssetManifest(state, firstSegment);
  const storyboard = manifest.items.find(({ type }) => type === 'storyboard');
  assert.equal(storyboard.id, 'segment-001-storyboard');
  assert.equal(storyboard.status, 'awaiting_review');
});

test('compiles a director-view proxy as a composition-only conditional asset', () => {
  const segment = {
    ...firstSegment,
    segmentAssetRequirements: ['director_view_proxy']
  };
  const manifest = compileAssetManifest(project({ segments: [segment] }), segment);
  const proxy = manifest.items.find(({ type }) => type === 'director_view_proxy');
  assert.equal(proxy.scope, 'segment');
  assert.match(proxy.responsibility, /final camera-view subject order/);
  assert.ok(proxy.mustNotControl.includes('identity'));
  assert.ok(proxy.mustNotControl.includes('mannequin color transfer'));
});

test('supports project-level wardrobe and color boards and preserves generation exclusions', () => {
  const wardrobe = locked('wardrobe-001', 'project_asset', { assetType: 'wardrobe_board' });
  const palette = locked('palette-001', 'project_asset', { assetType: 'color_board' });
  const proxy = locked('proxy-001', 'segment_asset', {
    assetType: 'director_view_proxy', segmentId: 'segment-001', required: false, excludeFromGeneration: true
  });
  const segment = {
    ...firstSegment,
    projectAssetIds: ['character-001', 'product-001', wardrobe.id, palette.id],
    segmentAssetRequirements: ['director_view_proxy']
  };
  const state = project({ segments: [segment] });
  state.artifacts.push(wardrobe, palette, proxy);
  const manifest = compileAssetManifest(state, segment);
  const wardrobeItem = manifest.items.find(({ id }) => id === wardrobe.id);
  const paletteItem = manifest.items.find(({ id }) => id === palette.id);
  const proxyItem = manifest.items.find(({ id }) => id === proxy.id);
  assert.equal(wardrobeItem.scope, 'project');
  assert.equal(wardrobeItem.segmentId, undefined);
  assert.equal(paletteItem.scope, 'project');
  assert.equal(paletteItem.segmentId, undefined);
  assert.equal(proxyItem.required, false);
  assert.equal(proxyItem.excludeFromGeneration, true);
});

test('keeps overlapping wardrobe and color board types segment-scoped when required by a segment', () => {
  const segment = {
    ...firstSegment,
    segmentAssetRequirements: ['wardrobe_board', 'color_board']
  };
  const wardrobe = locked('segment-wardrobe-001', 'segment_asset', {
    assetType: 'wardrobe_board', segmentId: 'segment-001'
  });
  const palette = locked('segment-color-001', 'segment_asset', {
    assetType: 'color_board', segmentId: 'segment-001'
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, wardrobe, palette] });
  const manifest = compileAssetManifest(state, segment);
  const wardrobeItem = manifest.items.find(({ id }) => id === wardrobe.id);
  const paletteItem = manifest.items.find(({ id }) => id === palette.id);
  assert.equal(wardrobeItem.scope, 'segment');
  assert.equal(wardrobeItem.segmentId, 'segment-001');
  assert.equal(paletteItem.scope, 'segment');
  assert.equal(paletteItem.segmentId, 'segment-001');
});

test('preserves a locked dialogue audio reference as an audio input', () => {
  const segment = {
    ...firstSegment,
    segmentAssetRequirements: ['dialogue_audio_reference']
  };
  const audio = locked('dialogue-audio-001', 'segment_asset', {
    assetType: 'dialogue_audio_reference', segmentId: 'segment-001', mediaKind: 'audio',
    path: 'assets/segment-001/dialogue.m4a', shotIds: ['shot-001']
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, audio] });
  const manifest = compileAssetManifest(state, segment);
  const item = manifest.items.find(({ type }) => type === 'dialogue_audio_reference');
  assert.equal(item.mediaKind, 'audio');
  assert.deepEqual(item.shotIds, ['shot-001']);
  assert.match(item.responsibility, /written prompt text supplies dialogue words/);
  assert.ok(item.mustNotControl.includes('dialogue wording'));
  assert.ok(item.mustNotControl.includes('visual identity'));
});

test('preserves a locked AI timing audio reference without source-audio authority', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['timing_audio_reference']
  };
  const audio = locked('timing-audio-001', 'segment_asset', {
    assetType: 'timing_audio_reference', segmentId: 'segment-001', mediaKind: 'audio',
    path: 'assets/segment-001/timing.wav', shotIds: ['shot-001']
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, audio] });
  state.directorRoutingVersion = 1;
  const manifest = compileAssetManifest(state, segment);
  const item = manifest.items.find(({ type }) => type === 'timing_audio_reference');
  assert.equal(item.mediaKind, 'audio');
  assert.match(item.responsibility, /dialogue entry timing/);
  assert.match(item.responsibility, /speaker handoff/);
  assert.ok(item.mustNotControl.includes('dialogue wording'));
  assert.ok(item.mustNotControl.includes('final speaker timbre'));
  assert.ok(item.mustNotControl.includes('visual identity'));
});

test('preserves every locked identity pair board and its deterministic slot metadata', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['identity_pair_board']
  };
  const pair = (number, left, right) => locked(`identity-pair-${number}`, 'segment_asset', {
    assetType: 'identity_pair_board', segmentId: 'segment-001', mediaKind: 'image',
    path: `assets/segment-001/identity-pair-${number}.png`,
    sourceAssetIds: [left, right],
    identitySlotBindings: [
      { slot: 'left', sourceAssetId: left },
      { slot: 'right', sourceAssetId: right }
    ],
    compositionMethod: 'deterministic_center_crop_hstack',
    shotIds: [`shot-${number}`]
  });
  const pairs = [
    pair('01', 'mother-01', 'mother-02'),
    pair('02', 'mother-03', 'mother-04'),
    pair('03', 'mother-05', 'mother-06'),
    pair('04', 'mother-07', 'mother-08')
  ];
  const state = project({ segments: [segment], artifacts: [...project().artifacts, ...pairs] });
  const manifest = compileAssetManifest(state, segment);
  const items = manifest.items.filter(({ type }) => type === 'identity_pair_board');
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(({ id }) => id), pairs.map(({ id }) => id));
  assert.deepEqual(items[3].sourceAssetIds, ['mother-07', 'mother-08']);
  assert.deepEqual(items[3].identitySlotBindings, [
    { slot: 'left', sourceAssetId: 'mother-07' },
    { slot: 'right', sourceAssetId: 'mother-08' }
  ]);
  assert.equal(items[3].compositionMethod, 'deterministic_center_crop_hstack');
});

test('preserves one source audio candidate with dialogue, timing, ambience, and mux responsibility', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['source_audio_candidate']
  };
  const audio = locked('source-audio-a1-001', 'segment_asset', {
    assetType: 'source_audio_candidate', segmentId: 'segment-001', mediaKind: 'audio',
    path: 'assets/segment-001/source-audio-a1.m4a', shotIds: ['shot-001']
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, audio] });
  const manifest = compileAssetManifest(state, segment);
  const item = manifest.items.find(({ type }) => type === 'source_audio_candidate');
  assert.equal(item.mediaKind, 'audio');
  assert.match(item.responsibility, /original speaker timbre/);
  assert.match(item.responsibility, /final-mux candidate/);
  assert.ok(item.mustNotControl.includes('visual identity'));
});

test('simple remake keeps one original-audio input when both the route and picker require it', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['source_audio_candidate']
  };
  const audio = locked('source-audio-simple-remake', 'segment_asset', {
    assetType: 'source_audio_candidate', segmentId: 'segment-001', mediaKind: 'audio',
    path: 'assets/segment-001/source-audio-simple-remake.wav'
  });
  const state = project({
    workflowProfile: {
      id: 'simple_remake', selectedBy: 'user', reason: 'faithful source remake', updatedAt: '2026-08-24T00:00:00.000Z'
    },
    assetSelection: { selected: ['voice_reference'] },
    segments: [segment],
    artifacts: [...project().artifacts, audio]
  });
  const manifest = compileAssetManifest(state, segment);
  assert.equal(manifest.items.filter(({ type }) => type === 'source_audio_candidate').length, 1);
});

test('precise director route prevents legacy picker selections from appending extra assets', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: []
  };
  const storyPlan = locked('story-plan-direct-edit-v1', 'story_plan');
  const capability = locked('capability-direct-edit-v1', 'capability_manifest', {
    storyPlanId: storyPlan.id,
    storyPlanSha256: storyPlan.sha256,
    routePrecision: 'explicit_v2',
    storyPlanSchemaVersion: 2,
    requiredAssetsBySegment: { 'segment-001': [] },
    requiredArtifactsBySegment: { 'segment-001': [] }
  });
  const state = project({
    workflowVersion: 2,
    workflowProfile: {
      id: 'simple_remake', selectedBy: 'user', reason: 'direct source edit', updatedAt: '2026-08-25T00:00:00.000Z'
    },
    assetSelection: { selected: ['character_reference', 'voice_reference'] },
    verifiedStoryPlanId: storyPlan.id,
    verifiedCapabilityManifestId: capability.id,
    directorRoutingVersion: 1,
    resolvedCapabilityRequirementsBySegment: { 'segment-001': [] },
    resolvedCapabilityArtifactsBySegment: { 'segment-001': [] },
    segments: [segment],
    artifacts: [...project().artifacts, storyPlan, capability]
  });

  const manifest = compileAssetManifest(state, segment);
  assert.deepEqual(manifest.items, []);
});

test('workflowVersion 2 ignores a segment asset bound to an older segmentation', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['timing_audio_reference']
  };
  const storyPlan = locked('story-plan-v2', 'story_plan');
  const staleAudio = locked('timing-audio-stale', 'segment_asset', {
    assetType: 'timing_audio_reference', segmentId: 'segment-001', mediaKind: 'audio',
    segmentationId: 'segmentation-old', segmentationSha256: 'b'.repeat(64)
  });
  const state = project({
    workflowVersion: 2,
    verifiedStoryPlanId: storyPlan.id,
    verifiedSegmentationId: 'segmentation-current',
    verifiedSegmentationRevision: 2,
    verifiedSegmentationSha256: 'c'.repeat(64),
    segments: [segment],
    artifacts: [...project().artifacts, storyPlan, staleAudio]
  });
  const manifest = compileAssetManifest(state, segment);
  const item = manifest.items.find(({ type }) => type === 'timing_audio_reference');
  assert.equal(item.id, 'segment-001-timing_audio_reference');
  assert.equal(item.status, 'awaiting_review');
  assert.equal(manifest.sourceArtifactIds.segmentation, 'segmentation-current');
});

test('rejects a timing audio reference that is mislabeled as an image', () => {
  const segment = { ...firstSegment, segmentAssetRequirements: ['timing_audio_reference'] };
  const wrong = locked('timing-audio-wrong', 'segment_asset', {
    assetType: 'timing_audio_reference', segmentId: 'segment-001', mediaKind: 'image',
    path: 'assets/segment-001/timing.png'
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, wrong] });
  assert.throws(() => compileAssetManifest(state, segment), /timing_audio_reference.*mediaKind audio/);
});

test('compiles a Blender-derived animatic as a video-only control asset', () => {
  const segment = { ...firstSegment, segmentAssetRequirements: ['spatial_control_animatic'] };
  const animatic = locked('animatic-001', 'segment_asset', {
    assetType: 'spatial_control_animatic', segmentId: 'segment-001', mediaKind: 'video',
    sourceControlModelId: 'spatial-control-001', sourceControlModelSha256: 'b'.repeat(64),
    path: 'assets/segment-001/control-animatic.mp4'
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, animatic] });
  const manifest = compileAssetManifest(state, segment);
  const item = manifest.items.find(({ type }) => type === 'spatial_control_animatic');
  assert.equal(item.mediaKind, 'video');
  assert.match(item.responsibility, /camera-matched blocking/);
  assert.ok(item.mustNotControl.includes('identity'));
  assert.equal(item.sourceControlModelId, 'spatial-control-001');
});

test('rejects a spatial control animatic mislabeled as an image', () => {
  const segment = { ...firstSegment, segmentAssetRequirements: ['spatial_control_animatic'] };
  const wrong = locked('animatic-wrong', 'segment_asset', {
    assetType: 'spatial_control_animatic', segmentId: 'segment-001', mediaKind: 'image'
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, wrong] });
  assert.throws(() => compileAssetManifest(state, segment), /spatial_control_animatic.*mediaKind video/);
});

test('compiles a monocular depth reference as a video-only control asset', () => {
  const segment = { ...firstSegment, segmentAssetRequirements: ['depth_video_reference'] };
  const depth = locked('depth-a1-001', 'segment_asset', {
    assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'video',
    path: 'assets/segment-001/depth-a1.mp4'
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, depth] });
  const manifest = compileAssetManifest(state, segment);
  const item = manifest.items.find(({ type }) => type === 'depth_video_reference');
  assert.equal(item.mediaKind, 'video');
  assert.match(item.responsibility, /monocular relative depth/);
  assert.ok(item.mustNotControl.includes('identity'));
  assert.ok(item.mustNotControl.includes('depth grayscale as final color'));
});

test('rejects a depth video reference mislabeled as an image', () => {
  const segment = { ...firstSegment, segmentAssetRequirements: ['depth_video_reference'] };
  const wrong = locked('depth-a1-wrong', 'segment_asset', {
    assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'image'
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, wrong] });
  assert.throws(() => compileAssetManifest(state, segment), /depth_video_reference.*mediaKind video/);
});

test('character-product state cannot override identity, wardrobe, or product appearance', () => {
  const segment = {
    ...firstSegment,
    segmentAssetRequirements: ['character_product_state']
  };
  const stateAsset = locked('state-001', 'segment_asset', {
    assetType: 'character_product_state', segmentId: 'segment-001'
  });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, stateAsset] });
  const manifest = compileAssetManifest(state, segment);
  const item = manifest.items.find(({ type }) => type === 'character_product_state');
  assert.ok(item.mustNotControl.includes('identity'));
  assert.ok(item.mustNotControl.includes('wardrobe'));
  assert.ok(item.mustNotControl.includes('product appearance'));
});

test('compiles every locked project-scoped character-product state and treats a camera-path contract as non-media', () => {
  const segment = {
    ...firstSegment,
    projectAssetIds: [],
    segmentAssetRequirements: ['character_product_state', 'continuous_camera_path_contract']
  };
  const stateA = locked('state-a', 'project_asset', { assetType: 'character_product_state' });
  const stateB = locked('state-b', 'project_asset', { assetType: 'character_product_state' });
  const state = project({ segments: [segment], artifacts: [...project().artifacts, stateA, stateB] });
  const manifest = compileAssetManifest(state, segment);
  assert.deepEqual(manifest.items.map(({ id }) => id), ['state-a', 'state-b']);
  assert.ok(manifest.items.every(item => item.scope === 'project'));
  assert.ok(manifest.items.every(item => item.type === 'character_product_state'));
});

test('preserves the unique global owner contract for a project-scoped character state', () => {
  const segment = { ...firstSegment, projectAssetIds: [], segmentAssetRequirements: ['character_product_state'] };
  const canonical = locked('state-canonical', 'project_asset', {
    assetType: 'character_product_state', stateRole: 'canonical_after', ownerScope: 'unique_global_owner'
  });
  const manifest = compileAssetManifest(project({ segments: [segment], artifacts: [...project().artifacts, canonical] }), segment);
  const item = manifest.items[0];
  assert.equal(item.ownerScope, 'unique_global_owner');
  assert.equal(item.stateRole, 'canonical_after');
  assert.match(item.responsibility, /unique global owner/);
  assert.ok(!item.mustNotControl.includes('identity'));
});

test('grants only bounded angle endpoints to local state references without contradicting camera-path ownership', () => {
  const segment = { ...firstSegment, projectAssetIds: [], segmentAssetRequirements: ['character_product_state'] };
  const side = locked('state-side', 'project_asset', {
    assetType: 'character_product_state', stateRole: 'sag_after_flat_profile', ownerScope: 'local_shape_pose_camera_endpoint_only'
  });
  const manifest = compileAssetManifest(project({ segments: [segment], artifacts: [...project().artifacts, side] }), segment);
  const item = manifest.items[0];
  assert.match(item.responsibility, /90-degree side-angle endpoint/);
  assert.ok(item.mustNotControl.includes('camera path'));
  assert.ok(!item.mustNotControl.includes('camera'));
  assert.ok(item.mustNotControl.includes('subject scale'));
  assert.ok(item.mustNotControl.includes('crop'));
});

test('requires locked script, shotlist, and referenced project assets', () => {
  const unlockedScript = project({ artifacts: project().artifacts.map((item) => item.id === 'script-001' ? { ...item, status: 'awaiting_review' } : item) });
  assert.throws(() => compileAssetManifest(unlockedScript, firstSegment), /locked script/);

  const manifest = compileAssetManifest(project(), firstSegment);
  manifest.items[0].status = 'awaiting_review';
  assert.throws(() => assertLockedAssetInputs(manifest), /not locked/);
  const fullyLocked = compileAssetManifest(project(), firstSegment);
  fullyLocked.items.forEach((item) => { item.status = 'locked'; });
  assert.equal(assertLockedAssetInputs(fullyLocked), true);
});

test('resolves a Gate 2 project asset ID through one explicit locked Gate 3 successor chain', () => {
  const state = project();
  const predecessor = state.artifacts.find(item => item.id === 'character-001');
  predecessor.status = 'draft';
  delete predecessor.lockedByReviewId;
  const successor = locked('character-002', 'project_asset', {
    revision: 2,
    assetType: 'character_board',
    characterId: 'character-a-v2',
    visualContractVersion: 1,
    visualAuditId: 'visual-audit-character-002',
    supersedesArtifactId: 'character-001'
  });
  const audit = locked('visual-audit-character-002', 'asset_visual_audit', {
    assetId: successor.id,
    assetType: successor.assetType,
    assetRevision: successor.revision,
    assetSha256: successor.sha256,
    decision: 'PASS',
    inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: 'fresh-agent-002',
    observedIdentityCount: 1,
    blockerCount: 0
  });
  state.artifacts.push(successor, audit);
  const manifest = compileAssetManifest(state, firstSegment);
  assert.equal(manifest.items.find(item => item.type === 'character_board').id, 'character-002');
});

test('normalizes the locked legacy scene_multiview_v1 asset type without changing its artifact ID', () => {
  const scene = locked('scene-legacy-v1', 'project_asset', { assetType: 'scene_multiview_v1' });
  const segment = { ...firstSegment, projectAssetIds: ['scene-legacy-v1'], segmentAssetRequirements: [] };
  const state = project({ segments: [segment], artifacts: [...project().artifacts, scene] });
  const manifest = compileAssetManifest(state, segment);
  assert.deepEqual(manifest.items.map(item => ({ id: item.id, type: item.type })), [
    { id: 'scene-legacy-v1', type: 'scene_multiview' }
  ]);
});

test('routes a legacy segment asset ID stored in projectAssetIds through its locked successor into the segment lane', () => {
  const predecessor = {
    id: 'depth-old', type: 'segment_asset', revision: 1, status: 'draft', path: 'segment_asset/depth-old.mp4',
    assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'video', sha256: 'b'.repeat(64)
  };
  const successor = locked('depth-new', 'segment_asset', {
    revision: 2, assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'video',
    supersedesArtifactId: 'depth-old'
  });
  const segment = {
    ...firstSegment,
    projectAssetIds: ['character-001', 'depth-old'],
    segmentAssetRequirements: ['depth_video_reference']
  };
  const state = project({ segments: [segment], artifacts: [...project().artifacts, predecessor, successor] });
  const manifest = compileAssetManifest(state, segment);
  assert.equal(manifest.items.find(item => item.type === 'depth_video_reference').id, 'depth-new');
  assert.equal(manifest.items.find(item => item.type === 'depth_video_reference').scope, 'segment');
});

test('uses a reviewed same-scope successor map when the final asset is not linked directly in artifact metadata', () => {
  const predecessor = {
    id: 'depth-reviewed-old', type: 'segment_asset', revision: 1, status: 'draft', path: 'segment_asset/depth-reviewed-old.mp4',
    assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'video', sha256: 'b'.repeat(64)
  };
  const successor = locked('depth-reviewed-final', 'segment_asset', {
    revision: 4, assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'video'
  });
  const segment = {
    ...firstSegment,
    projectAssetIds: ['character-001', 'depth-reviewed-old'],
    segmentAssetRequirements: ['depth_video_reference']
  };
  const state = project({
    segments: [segment],
    artifacts: [...project().artifacts, predecessor, successor],
    resolvedAssetSuccessorMap: { 'depth-reviewed-old': 'depth-reviewed-final' }
  });
  const manifest = compileAssetManifest(state, segment);
  assert.equal(manifest.items.find(item => item.type === 'depth_video_reference').id, 'depth-reviewed-final');
});

test('does not request a redundant initial blocking image when the reviewed capability route uses depth control', () => {
  const storyPlan = locked('story-plan-depth', 'story_plan');
  const capability = locked('capability-depth', 'capability_manifest', {
    storyPlanId: storyPlan.id,
    storyPlanSha256: 'd'.repeat(64),
    routePrecision: 'explicit_v2',
    storyPlanSchemaVersion: 2,
    requiredAssetsBySegment: { 'segment-001': ['depth_video_reference'] },
    requiredArtifactsBySegment: { 'segment-001': [] }
  });
  const depth = locked('depth-control', 'segment_asset', {
    assetType: 'depth_video_reference', segmentId: 'segment-001', mediaKind: 'video',
    visualAuditId: 'visual-audit-depth-control'
  });
  const depthAudit = locked('visual-audit-depth-control', 'asset_visual_audit', {
    assetId: depth.id, assetType: depth.assetType, assetRevision: depth.revision,
    assetSha256: depth.sha256, decision: 'PASS', inspectionMode: 'multimodal_pixels',
    inspectorContextMode: 'clean_zero_context', inspectorTaskId: 'fresh-agent-depth-control',
    observedIdentityCount: 0, blockerCount: 0
  });
  const segment = {
    ...firstSegment,
    projectAssetIds: ['character-001', 'depth-control'],
    segmentAssetRequirements: ['initial_blocking', 'depth_video_reference']
  };
  const state = project({
    workflowVersion: 2,
    directorRoutingVersion: 1,
    verifiedStoryPlanId: storyPlan.id,
    verifiedCapabilityManifestId: capability.id,
    resolvedCapabilityRequirementsBySegment: { 'segment-001': ['depth_video_reference'] },
    resolvedCapabilityArtifactsBySegment: { 'segment-001': [] },
    segments: [segment],
    artifacts: [...project().artifacts, storyPlan, capability, depth, depthAudit]
  });
  const manifest = compileAssetManifest(state, segment);
  assert.equal(manifest.items.some(item => item.type === 'initial_blocking'), false);
  assert.equal(manifest.items.find(item => item.type === 'depth_video_reference').id, 'depth-control');
});

test('refuses ambiguous Gate 3 successor forks for a Gate 2 project asset ID', () => {
  const state = project();
  state.artifacts.push(
    locked('character-002a', 'project_asset', { revision: 2, assetType: 'character_board', supersedesArtifactId: 'character-001' }),
    locked('character-002b', 'project_asset', { revision: 2, assetType: 'character_board', supersedesArtifactId: 'character-001' })
  );
  assert.throws(() => compileAssetManifest(state, firstSegment), /ambiguous successors/);
});

test('blocks segment-specific assets until prior segment and its observed handoff are locked', () => {
  const second = {
    ...firstSegment,
    id: 'segment-002',
    previousSegmentId: 'segment-001',
    segmentAssetRequirements: ['handoff_blocking', 'camera_blocking']
  };
  const prior = { ...firstSegment, status: 'awaiting_review', lockedByReviewId: undefined, nextSegmentId: 'segment-002' };
  assert.throws(() => compileAssetManifest(project({ segments: [prior, second] }), second), /earlier segment.*locked/);

  const approvedPrior = { ...prior, status: 'locked', lockedByReviewId: 'review-segment-001' };
  assert.throws(() => compileAssetManifest(project({ segments: [approvedPrior, second] }), second), /locked observed handoff/);

  const handoff = observedHandoff();
  assert.throws(() => compileAssetManifest(project({
    realismContractsVersion: 2,
    segments: [approvedPrior, second], artifacts: [...project().artifacts, handoff],
    verifiedObservedHandoffIds: [handoff.id]
  }), second), /canonical HD restoration handoff/);

  const derived = canonicalHdRestorationHandoff(handoff);
  const lockedManifest = compileAssetManifest(project({
    realismContractsVersion: 2,
    segments: [approvedPrior, second],
    verifiedObservedHandoffIds: [handoff.id],
    // This test isolates the v2 restoration dependency.  Reconciliation has
    // its own exact observed-tail coverage below.
    artifacts: [...project().artifacts, handoff, derived, handoffReconciliation(handoff)]
  }), second);
  assert.equal(lockedManifest.observedHandoffId, 'handoff-001');
  assert.equal(lockedManifest.canonicalHdRestorationHandoffId, 'handoff-restoration-001');
});

test('canonical-open and editorial-cut segments do not invent an observed-handoff dependency', () => {
  for (const continuityStrategy of ['canonical_open', 'editorial_cut']) {
    const prior = { ...firstSegment, nextSegmentId: 'segment-002' };
    const second = {
      ...firstSegment,
      id: 'segment-002',
      previousSegmentId: 'segment-001',
      continuityStrategy,
      projectAssetIds: ['character-001', 'product-001'],
      segmentAssetRequirements: []
    };
    const manifest = compileAssetManifest(project({ segments: [prior, second] }), second);
    assert.equal(manifest.observedHandoffId, null);
    assert.equal(manifest.canonicalHdRestorationHandoffId, null);
  }
});

test('realism v2 continuous handoff requires the locked three-way reconciliation for the exact observed tail', () => {
  const second = {
    ...firstSegment, id: 'segment-002', previousSegmentId: 'segment-001', lockedByReviewId: 'review-segment-002',
    continuityStrategy: 'continuous_proxy_handoff', segmentAssetRequirements: ['handoff_blocking']
  };
  const first = { ...firstSegment, nextSegmentId: second.id };
  const observed = observedHandoff();
  const restoration = canonicalHdRestorationHandoff(observed);
  const base = {
    realismContractsVersion: 2,
    segments: [first, second],
    artifacts: [...project().artifacts, observed, restoration],
    verifiedObservedHandoffIds: [observed.id]
  };
  assert.throws(() => compileAssetManifest(project(base), second), /locked PASS handoff reconciliation/);
  const reconciliation = handoffReconciliation(observed);
  const manifest = compileAssetManifest(project({ ...base, artifacts: [...base.artifacts, reconciliation] }), second);
  assert.equal(manifest.handoffReconciliationId, reconciliation.id);

  const stale = { ...reconciliation, id: 'handoff-reconciliation-stale', observedHandoffSha256: '9'.repeat(64) };
  assert.throws(() => compileAssetManifest(project({ ...base, artifacts: [...base.artifacts, stale] }), second), /locked PASS handoff reconciliation/);
});

test('rejects planned or unlocked handoffs for a later segment', () => {
  const second = { ...firstSegment, id: 'segment-002', previousSegmentId: 'segment-001', segmentAssetRequirements: ['handoff_blocking'] };
  const prior = { ...firstSegment, nextSegmentId: 'segment-002' };
  const planned = locked('handoff-001', 'handoff', { segmentId: 'segment-001', observed: false });
  assert.throws(() => compileAssetManifest(project({ segments: [prior, second], artifacts: [...project().artifacts, planned] }), second), /locked observed handoff/);
});

test('requires the current segment itself to be locked by human review', () => {
  const awaiting = { ...firstSegment, status: 'awaiting_review', lockedByReviewId: undefined };
  assert.throws(() => compileAssetManifest(project({ segments: [awaiting] }), awaiting), /current segment.*locked/);
});

test('derives first segment and adjacency from canonical project order', () => {
  const second = {
    ...firstSegment,
    id: 'segment-002',
    previousSegmentId: null,
    nextSegmentId: null,
    lockedByReviewId: 'review-segment-002',
    segmentAssetRequirements: ['handoff_blocking']
  };
  assert.throws(() => compileAssetManifest(project({ segments: [{ ...firstSegment, nextSegmentId: 'segment-002' }, second] }), second), /previousSegmentId.*segment-001/);

  const wrongOrderFirst = { ...firstSegment, previousSegmentId: 'segment-999' };
  assert.throws(() => compileAssetManifest(project({ segments: [wrongOrderFirst] }), wrongOrderFirst), /previousSegmentId.*null/);
});

test('rejects caller segment data that disagrees with the canonical project segment', () => {
  const canonical = { ...firstSegment, nextSegmentId: null };
  const caller = { ...canonical, nextSegmentId: 'segment-002' };
  assert.throws(() => compileAssetManifest(project({ segments: [canonical] }), caller), /canonical segment/);
});

test('rejects fake locked artifacts and segments without required review or checksum evidence', () => {
  const cases = [
    ['script', (state) => { delete state.artifacts.find(({ type }) => type === 'script').lockedByReviewId; }],
    ['shotlist', (state) => { delete state.artifacts.find(({ type }) => type === 'shotlist').lockedByReviewId; }],
    ['project asset review', (state) => { delete state.artifacts.find(({ type }) => type === 'project_asset').lockedByReviewId; }],
    ['project asset checksum', (state) => { delete state.artifacts.find(({ type }) => type === 'project_asset').sha256; }]
  ];
  for (const [label, mutate] of cases) {
    const state = structuredClone(project({ segments: [firstSegment] }));
    mutate(state);
    assert.throws(() => compileAssetManifest(state, firstSegment), /lockedByReviewId|sha256/, label);
  }

  const fakeCurrent = { ...firstSegment, lockedByReviewId: undefined };
  assert.throws(() => compileAssetManifest(project({ segments: [fakeCurrent] }), fakeCurrent), /current segment.*review evidence/);

  const second = { ...firstSegment, id: 'segment-002', previousSegmentId: 'segment-001', lockedByReviewId: 'review-segment-002', segmentAssetRequirements: ['handoff_blocking'] };
  const fakePrevious = { ...firstSegment, lockedByReviewId: undefined, nextSegmentId: 'segment-002' };
  assert.throws(() => compileAssetManifest(project({ segments: [fakePrevious, second] }), second), /earlier segment.*review evidence/);

  const fakeHandoff = locked('handoff-001', 'handoff', { segmentId: 'segment-001', observed: true });
  delete fakeHandoff.lockedByReviewId;
  assert.throws(
    () => compileAssetManifest(project({ segments: [{ ...firstSegment, nextSegmentId: 'segment-002' }, second], artifacts: [...project().artifacts, fakeHandoff] }), second),
    /lockedByReviewId/
  );
});

test('sorts canonical segments by validated numeric IDs and rejects ambiguous sequences', () => {
  const first = { ...firstSegment, nextSegmentId: 'segment-002' };
  const second = { ...firstSegment, id: 'segment-002', previousSegmentId: 'segment-001', lockedByReviewId: 'review-segment-002' };
  const handoff = observedHandoff();
  const restoration = canonicalHdRestorationHandoff(handoff);
  const unordered = project({
    segments: [second, first], artifacts: [...project().artifacts, handoff, restoration],
    verifiedObservedHandoffIds: [handoff.id]
  });
  assert.equal(compileAssetManifest(unordered, second).observedHandoffId, 'handoff-001');

  const invalidCases = [
    [{ ...first, id: 'scene-001' }],
    [first, { ...second, id: 'segment-001' }],
    [first, { ...second, id: 'segment-003', previousSegmentId: 'segment-001' }]
  ];
  for (const segments of invalidCases) {
    assert.throws(() => compileAssetManifest(project({ segments }), segments.at(-1)), /segment ID|duplicate|contiguous/);
  }
});
