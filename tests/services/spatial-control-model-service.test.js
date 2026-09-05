import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { registerSpatialControlModel } from '../../src/services/spatial-control-model-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';

test('verifies every model file and registers a draft spatial-control authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spatial-control-'));
  await initializeProject(root, { projectId: 'MODEL-1', workflowVersion: 2 });
  const dir = join(root, 'planning', 'modeling');
  await mkdir(dir, { recursive: true });
  const paths = {
    source: join(dir, 'source.mp4'), blender: join(dir, 'control.blend'), animatic: join(dir, 'animatic.mp4'),
    start: join(dir, 'start.png'), end: join(dir, 'end.png')
  };
  for (const [name, path] of Object.entries(paths)) await writeFile(path, `test-${name}`);
  const rel = path => `planning/modeling/${path.split('/').at(-1)}`;
  const file = async path => ({ path: rel(path), sha256: await sha256File(path) });
  const input = {
    schemaVersion: 1, id: 'spatial-control-segment-001-v1', projectId: 'MODEL-1', segmentId: 'segment-001', revision: 1,
    fidelityTarget: 'one_to_one', modelingInputMode: 'keyframes_only',
    sourceReference: await file(paths.source), blenderProject: await file(paths.blender),
    animatic: { ...(await file(paths.animatic)), durationSec: 7, fps: 24, width: 540, height: 960 },
    cameraMatch: { aspectRatio: '9:16', cutTimesSec: [4], validationTimesSec: [0, 4, 7] },
    subjects: [{ subjectId: 'M01', role: 'male', proxyColor: 'muted_blue' }],
    authority: {
      controls: ['position', 'pose', 'contact', 'occlusion', 'camera', 'camera_path', 'action_timing', 'shot_transitions'],
      mustNotControl: ['identity', 'face', 'wardrobe_appearance', 'product_appearance', 'texture', 'color', 'quality', 'world_style']
    },
    derivedAssets: [
      { id: 'start-v1', type: 'director_view_proxy', ...(await file(paths.start)) },
      { id: 'end-v1', type: 'director_view_proxy', ...(await file(paths.end)) }
    ],
    validation: { status: 'PASS', comparisonId: 'comparison-v1', checks: ['camera', 'blocking', 'contact', 'timing', 'endpoint'] }
  };
  const inputPath = join(root, 'planning', 'spatial-control.json');
  await writeJsonAtomic(inputPath, input);
  const artifact = await registerSpatialControlModel(root, inputPath);
  assert.equal(artifact.type, 'spatial_control_model');
  assert.equal(artifact.segmentId, 'segment-001');
  assert.equal(artifact.status, 'draft');
  assert.equal(artifact.modelingInputMode, 'keyframes_only');
});

test('rejects a Blender file whose recorded checksum is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spatial-control-stale-'));
  await initializeProject(root, { projectId: 'MODEL-STALE', workflowVersion: 2 });
  const inputPath = join(root, 'spatial.json');
  await writeFile(join(root, 'control.blend'), 'current');
  await writeFile(join(root, 'animatic.mp4'), 'animatic');
  await writeFile(join(root, 'start.png'), 'start');
  await writeFile(join(root, 'end.png'), 'end');
  const digest = async path => sha256File(join(root, path));
  await writeJsonAtomic(inputPath, {
    schemaVersion: 1, id: 'spatial-control-stale-v1', projectId: 'MODEL-STALE', segmentId: 'segment-001', revision: 1,
    fidelityTarget: 'faithful', modelingInputMode: 'keyframes_only',
    blenderProject: { path: 'control.blend', sha256: '0'.repeat(64) },
    animatic: { path: 'animatic.mp4', sha256: await digest('animatic.mp4'), durationSec: 3, fps: 24, width: 540, height: 960 },
    cameraMatch: { aspectRatio: '9:16', cutTimesSec: [], validationTimesSec: [0, 3] },
    subjects: [{ subjectId: 'M01', role: 'male', proxyColor: 'muted_blue' }],
    authority: { controls: ['position'], mustNotControl: ['identity'] },
    derivedAssets: [
      { id: 'start-v1', type: 'director_view_proxy', path: 'start.png', sha256: await digest('start.png') },
      { id: 'end-v1', type: 'director_view_proxy', path: 'end.png', sha256: await digest('end.png') }
    ],
    validation: { status: 'PASS', comparisonId: 'comparison-v1', checks: ['camera', 'blocking', 'contact', 'timing', 'endpoint'] }
  });
  await assert.rejects(() => registerSpatialControlModel(root, inputPath), /blenderProject.sha256/);
});
