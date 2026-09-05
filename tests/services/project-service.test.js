import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject, getProjectStatus } from '../../src/services/project-service.js';

const directories = ['brief', 'planning/creative-briefs', 'planning/story-plans', 'segments', 'assets/project', 'prompts', 'outputs', 'reviews', 'runs', 'versions', 'scripts'];

test('initializes the exact project layout and valid initial state without secrets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'harness-project-'));
  const root = join(parent, 'QC-001');
  const state = await initializeProject(root, { projectId: 'QC-001', apiKey: 'do-not-write-me' });

  assert.equal(state.projectId, 'QC-001');
  assert.equal(state.workflowVersion, 2);
  assert.equal(state.ingressPolicyVersion, 'ingress-route-v1');
  assert.equal(Object.hasOwn(state, 'routeDecision'), false);
  for (const directory of directories) assert.equal((await stat(join(root, directory))).isDirectory(), true);
  const bundledScrubber = await readFile(join(root, 'scripts', 'derive-multiface-full-head-scrub-v1.py'), 'utf8');
  assert.match(bundledScrubber, /strongly anonymized, multi-face source reference/);
  const persisted = await readFile(join(root, 'project-state.json'), 'utf8');
  assert.doesNotMatch(persisted, /do-not-write-me|apiKey/);
  assert.deepEqual(await getProjectStatus(root), {
    ...state,
    pendingHumanGate: []
  });
});

test('explicit legacy initialization remains available and does not enable ingress routing', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'harness-legacy-project-'));
  const root = join(parent, 'LEGACY-001');
  const state = await initializeProject(root, { projectId: 'LEGACY-001', workflowVersion: 1 });
  assert.equal(state.workflowVersion, 1);
  assert.equal(Object.hasOwn(state, 'ingressPolicyVersion'), false);
  assert.equal(Object.hasOwn(state, 'routeDecision'), false);
});

test('initialization persists an explicitly supplied route decision', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'harness-routed-project-'));
  const root = join(parent, 'ROUTED-001');
  const routeDecision = {
    policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input',
    inputTypes: ['video'], sourceVideoIds: ['source-video-001'], referenceRoleStatus: 'inspiration'
  };
  const state = await initializeProject(root, { projectId: 'ROUTED-001', routeDecision });
  assert.deepEqual(state.routeDecision, routeDecision);
  assert.equal(state.videoGovernanceVersion, 2);
  assert.equal(state.directionRevision.status, 'awaiting_answers');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8')).routeDecision, routeDecision);
});

test('is idempotent only for an existing valid project with the same id', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'harness-existing-'));
  const root = join(parent, 'QC-001');
  await initializeProject(root, { projectId: 'QC-001' });
  assert.equal((await initializeProject(root, { projectId: 'QC-001' })).projectId, 'QC-001');
  await assert.rejects(initializeProject(root, { projectId: 'QC-002' }), /projectId|non-empty/);

  const occupied = join(parent, 'occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'unrelated.txt'), 'keep');
  await assert.rejects(initializeProject(occupied, { projectId: 'QC-003' }), /non-empty/);
});
