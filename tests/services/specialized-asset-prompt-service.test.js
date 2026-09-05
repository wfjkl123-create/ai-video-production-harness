import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectorViewProxyIr, buildMannequinFrameIrs, buildSceneMultiviewIrs, buildStoryPropIrs } from '../../src/services/specialized-asset-prompt-service.js';
import { buildImagePromptPlan } from '../../src/services/image-profile-router-service.js';
import { directorViewProxyInput, verifiedModelProfile, visualStyleContract } from '../helpers/image-prompt-fixture.js';

const defaults = () => ({ visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile() });
const binding = (index) => ({ tag: 'Image1', artifactId: `source-${index}`, path: `assets/source-${index}.png`, sha256: 'a'.repeat(64), primaryRole: 'original frame pose camera blocking and real scene', subjectSelector: 'all visible people', transfer: ['pose', 'camera', 'blocking', 'real scene'], ignore: ['identity', 'real face', 'subtitle', 'watermark'] });

test('scene multiview expands to nine camera-traced atomic images', () => {
  const scene = {
    projectId: 'p1', assetId: 'scene-room-v1', sceneId: 'room', purpose: 'lock one room across shots',
    locationDefinition: 'small real apartment living room', spatialAnchors: 'door right, window left, sofa center',
    lightingContract: 'soft daylight from left window', materialContract: 'matte plaster walls and worn fabric sofa', inputBindings: [],
    views: Array.from({ length: 9 }, (_, index) => ({ viewId: `view-${index + 1}`, cameraContract: index === 8 ? 'strict overhead geography' : `locked camera angle ${index + 1}`, visibleAnchors: 'door window sofa and table', purpose: `show spatial view ${index + 1}` }))
  };
  const irs = buildSceneMultiviewIrs(scene, defaults());
  assert.equal(irs.length, 9);
  assert.equal(irs.at(-1).profileId, 'scene_overhead_v1');
  assert.ok(irs.every(ir => ir.skillsApplied.includes('seedance-camera') && ir.constraints.some(item => /no person/.test(item))));
});

test('scene multiview uses exterior-only continuity language for an exterior scene', () => {
  const scene = {
    projectId: 'p1', assetId: 'waterside-scene-v1', sceneId: 'waterside-promenade', purpose: 'lock a waterside promenade',
    spaceKind: 'exterior',
    locationDefinition: 'gray hard walkway beside a black metal rail and open water',
    spatialAnchors: 'straight path, rail at water edge, skyline across water',
    lightingContract: 'overcast daylight', materialContract: 'concrete, matte black metal and water', inputBindings: [],
    views: Array.from({ length: 9 }, (_, index) => ({ viewId: `view-${index + 1}`, cameraContract: index === 8 ? 'strict overhead geography' : `locked exterior angle ${index + 1}`, visibleAnchors: 'path rail water and skyline', purpose: `show exterior view ${index + 1}` }))
  };
  const irs = buildSceneMultiviewIrs(scene, defaults());
  assert.ok(irs.every(ir => /fixed exterior anchors/.test(ir.photographyContract.continuity)));
  assert.ok(irs.every(ir => !ir.avoid.some(item => /door|window|room/i.test(item))));
  assert.ok(irs.every(ir => !/other views|all nine views|same scene geography/i.test(`${ir.purpose} ${ir.responsibility} ${ir.photographyContract.continuity} ${ir.acceptanceChecks.join(' ')}`)));
});

test('story prop expands to front side back and detail without asking the model to compose', () => {
  const irs = buildStoryPropIrs({
    projectId: 'p1', assetId: 'prop-letter-v1', propId: 'letter', purpose: 'lock the plot prop', structure: 'folded rectangular paper with wax seal',
    material: 'fibrous off-white paper and matte red wax', color: 'warm off-white and dark red', scaleAnchor: 'twenty centimeters beside an adult hand', inputBindings: [],
    views: ['front', 'side', 'back', 'detail'].map(viewId => ({ viewId, description: `${viewId} geometry and material` }))
  }, defaults());
  assert.deepEqual(irs.map(ir => ir.compositionContract.viewId), ['front', 'side', 'back', 'detail']);
  assert.ok(irs.every(ir => ir.compositionContract.output === 'one independent prop view only'));
});

test('director-view proxy builder emits one final-camera composition-only request with conditional character skill', () => {
  const ir = buildDirectorViewProxyIr(directorViewProxyInput(), defaults());
  assert.equal(ir.profileId, 'director_view_proxy_v1');
  assert.equal(ir.assetType, 'director_view_proxy');
  assert.equal(ir.compositionContract.mode, 'single_final_camera_view_director_proxy');
  assert.equal(ir.compositionContract.subjectLayout.length, 2);
  assert.deepEqual(ir.skillsApplied, ['gpt-image-2-style-library', 'imagegen', 'seedance-camera', 'seedance-characters']);
  assert.equal(ir.templateSource, 'knowledge/image-profiles/director-view-proxy.md#director_view_proxy_v1');
  assert.ok(ir.mustNotControl.some(item => /identity/.test(item)));
  assert.ok(ir.mustNotControl.some(item => /material and texture/.test(item)));
  assert.throws(() => buildDirectorViewProxyIr(directorViewProxyInput({
    subjects: directorViewProxyInput().subjects.map(subject => ({ ...subject, wardrobe: 'forbidden appearance authority' }))
  }), defaults()), /unsupported appearance or metadata/);
});

test('director-view proxy accepts role-bounded storyboard geometry without appearance transfer', () => {
  const sourceBinding = {
    tag: 'Image1', artifactId: 'storyboard-panel-v1', path: 'assets/storyboard-panel.png', sha256: 'b'.repeat(64),
    primaryRole: 'source storyboard camera composition and blocking', subjectSelector: 'all declared proxy subjects',
    transfer: ['camera perspective', 'blocking', 'screen scale', 'depth layers', 'occlusion', 'contact points', 'scene geometry'],
    ignore: ['identity and facial appearance', 'wardrobe design', 'product appearance and geometry', 'material and texture', 'final color grade']
  };
  const proxy = directorViewProxyInput({ inputBindings: [sourceBinding] });
  const ir = buildDirectorViewProxyIr(proxy, defaults());
  assert.equal(ir.operation, 'edit');
  const plan = buildImagePromptPlan({
    id: 'director-proxy-bound-input-v1', projectId: 'project-001', visualStyleContract: visualStyleContract(),
    characterBoards: [], directorViewProxies: [proxy], promptIrs: []
  }, verifiedModelProfile());
  assert.equal(plan.requests[0].lint.decision, 'PASS');
  assert.deepEqual(plan.requests[0].inputBindings[0].transfer, sourceBinding.transfer);
});

test('mannequin sequence compiles one role-bound edit per source frame and never one whole-grid edit', () => {
  const sequence = {
    projectId: 'p1', segmentId: 'segment-001', assetId: 'mannequin-seq-v1', purpose: 'preserve source choreography with faceless clay figures',
    originalSceneContract: 'retain the original real living room background and source lighting', characterColorMap: { A: 'gray-white', B: 'low-saturation blue-gray' },
    frames: [1, 2].map(frameIndex => ({ frameIndex, timeSec: frameIndex - 1, poseContract: 'exact source joint angles and body weight', contactContract: 'exact hand-to-product contact', cameraContract: 'exact source camera and shot scale', blockingContract: 'exact source positions and occlusion', inputBindings: [binding(frameIndex)] }))
  };
  const irs = buildMannequinFrameIrs(sequence, defaults());
  assert.equal(irs.length, 2);
  assert.ok(irs.every(ir => ir.operation === 'edit' && ir.compositionContract.output === 'one repaired source frame only'));
  const plan = buildImagePromptPlan({ id: 'mannequin-plan-v1', projectId: 'p1', visualStyleContract: visualStyleContract(), executionMode: 'parallel', characterBoards: [], sceneMultiviews: [], storyProps: [], mannequinSequences: [sequence], storyboardSheets: [], storyboardRepairs: [], promptIrs: [] }, verifiedModelProfile());
  assert.equal(plan.requests.length, 2);
  assert.ok(plan.requests.every(request => request.lint.decision === 'PASS'));
});
