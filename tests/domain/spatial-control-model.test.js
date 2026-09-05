import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpatialControlModel } from '../../src/domain/spatial-control-model.js';

const sha = 'a'.repeat(64);

function valid(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'spatial-control-segment-001-v1',
    projectId: 'MODEL-1',
    segmentId: 'segment-001',
    revision: 1,
    fidelityTarget: 'one_to_one',
    modelingInputMode: 'keyframes_only',
    sourceReference: { path: 'source.mp4', sha256: sha },
    blenderProject: { path: 'control.blend', sha256: sha },
    animatic: { path: 'animatic.mp4', sha256: sha, durationSec: 7, fps: 24, width: 540, height: 960 },
    cameraMatch: { aspectRatio: '9:16', cutTimesSec: [4], validationTimesSec: [0, 4, 7] },
    subjects: [
      { subjectId: 'M01', role: 'male', proxyColor: 'muted_blue' },
      { subjectId: 'F01', role: 'female', proxyColor: 'muted_rose' }
    ],
    authority: {
      controls: ['position', 'pose', 'contact', 'occlusion', 'camera', 'camera_path', 'action_timing', 'shot_transitions'],
      mustNotControl: ['identity', 'face', 'wardrobe_appearance', 'product_appearance', 'texture', 'color', 'quality', 'world_style']
    },
    derivedAssets: [
      { id: 'start-v1', type: 'director_view_proxy', path: 'start.png', sha256: sha },
      { id: 'end-v1', type: 'director_view_proxy', path: 'end.png', sha256: sha }
    ],
    validation: { status: 'PASS', comparisonId: 'comparison-v1', checks: ['camera', 'blocking', 'contact', 'timing', 'endpoint'] },
    ...overrides
  };
}

test('accepts one Blender authority with an animatic and model-derived endpoints', () => {
  assert.equal(assertSpatialControlModel(valid()).id, 'spatial-control-segment-001-v1');
});

test('one-to-one control requires a source reference and animatic video mode requires the derived video', () => {
  const missingSource = valid();
  delete missingSource.sourceReference;
  assert.throws(() => assertSpatialControlModel(missingSource), /sourceReference/);

  const missingAnimaticAsset = valid({ modelingInputMode: 'animatic_video' });
  assert.throws(() => assertSpatialControlModel(missingAnimaticAsset), /spatial_control_animatic/);
});

test('rejects independent stills that do not provide at least two model-derived endpoints', () => {
  const value = valid();
  value.derivedAssets = [value.derivedAssets[0]];
  assert.throws(() => assertSpatialControlModel(value), /at least two/);
});
