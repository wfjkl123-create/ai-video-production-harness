import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShotStrategy } from '../../src/domain/shot-strategy.js';

const base = {
  shotStructure: 'standalone', shotCount: 1, peopleCount: 1,
  hasPreviousSegment: false, strictSpatialCarryover: false, hasDialogue: false,
  complexPhysicalAction: false, complexBlocking: false, productInteraction: 'none',
  motionReferenceAvailable: false, visibleDrift: false, extensionDepth: 0
};

test('keeps a simple standalone shot lightweight', () => {
  const result = classifyShotStrategy(base);
  assert.equal(result.route, 'canonical_open');
  assert.deepEqual(result.assetRequirements, []);
  assert.ok(result.explicitlyNotRequired.includes('proxy_handoff_model'));
});

test('uses a proxy handoff only for strict continuous spatial carryover', () => {
  const result = classifyShotStrategy({
    ...base, shotStructure: 'continuous_take', hasPreviousSegment: true,
    strictSpatialCarryover: true, peopleCount: 2
  });
  assert.equal(result.route, 'continuous_proxy_handoff');
  assert.ok(result.capabilities.includes('proxy_handoff_model'));
  assert.ok(result.assetRequirements.includes('handoff_blocking'));
  assert.equal(result.referencePolicy.generatedTailFrame, 'observation_only');
});

test('uses an editorial cut without a proxy handoff', () => {
  const result = classifyShotStrategy({
    ...base, shotStructure: 'editorial_sequence', shotCount: 3,
    hasPreviousSegment: true, peopleCount: 3, hasDialogue: true
  });
  assert.equal(result.route, 'editorial_cut');
  assert.ok(result.capabilities.includes('speaker_position_dialogue_map'));
  assert.ok(result.capabilities.includes('line_storyboard'));
  assert.ok(!result.capabilities.includes('proxy_handoff_model'));
});

test('triggers a director-view proxy for over-shoulder and crowded compositions', () => {
  const overShoulder = classifyShotStrategy({
    ...base, cameraComposition: 'over_shoulder', peopleCount: 3
  });
  assert.ok(overShoulder.capabilities.includes('director_view_proxy'));
  assert.ok(overShoulder.assetRequirements.includes('director_view_proxy'));
  assert.equal(overShoulder.referencePolicy.directorViewProxy, 'camera_view_subject_layout_only');

  const crowded = classifyShotStrategy({ ...base, peopleCount: 5 });
  assert.ok(crowded.capabilities.includes('director_view_proxy'));
});

test('does not burden a simple two-person standard composition with a director proxy', () => {
  const result = classifyShotStrategy({ ...base, peopleCount: 2, cameraComposition: 'standard' });
  assert.ok(!result.capabilities.includes('director_view_proxy'));
  assert.ok(result.explicitlyNotRequired.includes('director_view_proxy'));
});

test('routes complex dressing to motion reference and product scale controls', () => {
  const result = classifyShotStrategy({
    ...base, shotStructure: 'continuous_take', hasPreviousSegment: true,
    strictSpatialCarryover: true, complexPhysicalAction: true,
    motionReferenceAvailable: true, productInteraction: 'wearing'
  });
  assert.ok(result.capabilities.includes('motion_reference_video'));
  assert.ok(result.capabilities.includes('product_human_scale_board'));
  assert.ok(result.assetRequirements.includes('character_product_state'));
});

test('requires action decomposition when complex motion has no donor reference', () => {
  const result = classifyShotStrategy({ ...base, complexPhysicalAction: true });
  assert.ok(result.capabilities.includes('action_decomposition'));
  assert.match(result.warnings[0], /split/);
});

test('schedules canonical re-anchor at chain depth two or visible drift', () => {
  assert.ok(classifyShotStrategy({ ...base, extensionDepth: 2 }).capabilities.includes('canonical_reanchor'));
  assert.ok(classifyShotStrategy({ ...base, visibleDrift: true }).capabilities.includes('canonical_reanchor'));
});

test('strong modeling control replaces independent storyboard work with one Blender authority', () => {
  const result = classifyShotStrategy({
    ...base,
    shotCount: 4,
    peopleCount: 2,
    complexPhysicalAction: true,
    controlMode: 'modeling_strong_control',
    modelingInputMode: 'keyframes_only'
  });
  assert.equal(result.controlRoute, 'modeling_strong_control');
  assert.ok(result.capabilities.includes('spatial_control_model'));
  assert.ok(result.assetRequirements.includes('director_view_proxy'));
  assert.equal(result.assetRequirements.includes('storyboard'), false);
  assert.equal(result.assetRequirements.includes('spatial_control_animatic'), false);
  assert.match(result.warnings.join(' '), /cannot claim exact continuous motion/);
  assert.equal(result.referencePolicy.spatialControlAnimatic, 'internal_validation_only');
});

test('animatic video mode routes the model-derived motion input', () => {
  const result = classifyShotStrategy({
    ...base,
    peopleCount: 2,
    controlMode: 'modeling_strong_control',
    modelingInputMode: 'animatic_video'
  });
  assert.ok(result.assetRequirements.includes('director_view_proxy'));
  assert.ok(result.assetRequirements.includes('spatial_control_animatic'));
  assert.equal(result.referencePolicy.spatialControlAnimatic, 'blocking_pose_contact_camera_timing_only');
});
