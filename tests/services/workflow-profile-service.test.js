import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import {
  getWorkflowProfileView,
  setWorkflowProfile,
  setAssetSelection,
  setRemakeControlSelection,
  buildRemakeAssetDispatch
} from '../../src/services/workflow-profile-service.js';

const ROUTE = {
  policyVersion: 'ingress-route-v1',
  harnessRequired: true,
  reason: 'video_input_and_creation_intent',
  inputTypes: ['video'],
  sourceVideoIds: ['reference-video-001'],
  referenceRoleStatus: 'authority'
};

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'wf-profile-'));
  await initializeProject(root, { projectId: 'WF-1', routeDecision: ROUTE });
  return root;
}

async function projectWithProductIntake() {
  const root = await project();
  await writeJsonAtomic(join(root, 'brief', 'director-intake-v1.json'), {
    schemaVersion: 1, projectId: 'WF-1', requestText: '复刻这个视频并替换产品，台词动作不变。',
    route: ROUTE, recordedAt: new Date().toISOString()
  });
  return root;
}

test('recommendation for a source-authority remake is simple_remake', async () => {
  const root = await project();
  const view = await getWorkflowProfileView(root);
  assert.equal(view.recommendation.id, 'simple_remake');
  assert.equal(view.profile, null);
  assert.equal(view.canSwitch, true);
});

test('setting the profile persists and drives visible steps and asset defaults', async () => {
  const root = await project();
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  const view = await getWorkflowProfileView(root);
  assert.equal(view.profile.id, 'simple_remake');
  assert.deepEqual(view.visibleSteps.map(step => step.gate), [1, 4, 5]);
  assert.ok(view.assetDefaults.recommended.includes('depth_video'));
});

test('asset selection enforces required assets and estimates paid tasks', async () => {
  const root = await projectWithProductIntake();
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  await assert.rejects(
    () => setAssetSelection(root, { selected: ['depth_video', 'first_frame'] }),
    /必需资产/
  );
  const record = await setAssetSelection(root, { selected: ['product_image', 'depth_video', 'first_frame', 'character_board'] });
  assert.equal(record.estimatedPaidImageTasks, 1);
  assert.equal(record.profileId, 'simple_remake');
});

test('remake control selection automatically dispatches assets and prompt policy', async () => {
  const root = await projectWithProductIntake();
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  const result = await setRemakeControlSelection(root, { selectedModes: ['depth_control', 'storyboard_control'] });
  assert.deepEqual(result.remakeControlSelection.selectedModes, ['storyboard_control', 'depth_control']);
  assert.equal(result.remakeControlSelection.requiresReversePrompt, true);
  assert.deepEqual(result.assetSelection.selected, ['storyboard', 'depth_video', 'product_image', 'voice_reference']);
  assert.equal(result.dispatch.rows.find(row => row.assetId === 'depth_video').ignore.includes('面部表情'), true);
  await assert.rejects(() => setAssetSelection(root, { selected: ['product_image'] }), /自动调度/);
});

test('native source only avoids reverse prompt and does not invent control images', () => {
  const dispatch = buildRemakeAssetDispatch({ selectedModes: ['native_source'], requestText: '官方原生替换场景' });
  assert.equal(dispatch.requiresReversePrompt, false);
  assert.deepEqual(dispatch.selectedAssetIds, ['scene_image']);
  assert.equal(dispatch.rows[0].assetId, 'reference_video');
});

test('complex source motion alone does not manufacture a character identity asset', () => {
  const dispatch = buildRemakeAssetDispatch({ selectedModes: ['depth_control'], requestText: '保留复杂人物动作和运镜' });
  assert.equal(dispatch.selectedAssetIds.includes('character_reference'), false);
  assert.equal(dispatch.selectedAssetIds.includes('character_board'), false);
});

test('KOC remake dispatches precise A-roll control, identity, optional first frame, parallel reviews and durable memory', async () => {
  const root = await projectWithProductIntake();
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  const result = await setRemakeControlSelection(root, {
    selectedModes: ['koc_remake'], firstFramePolicy: 'selected_segments'
  });
  assert.deepEqual(result.remakeControlSelection.selectedModes, ['koc_remake']);
  assert.equal(result.remakeControlSelection.firstFramePolicy, 'selected_segments');
  assert.equal(result.remakeControlSelection.promptPolicy, 'koc_source_bound_identity_replacement');
  assert.ok(result.assetSelection.selected.includes('koc_aroll_control'));
  assert.ok(result.assetSelection.selected.includes('character_reference'));
  assert.ok(result.assetSelection.selected.includes('first_frame'));
  assert.equal(result.dispatch.executionContract.segmentPolicy.exclude, 'broll_never_generate');
  assert.equal(result.dispatch.executionContract.reviewLanes.length, 3);
  assert.equal(result.dispatch.executionContract.generationPolicy.assistantMaySubmitByDefault, false);
});

test('legacy remake asset selection is projected as read-only control modes', async () => {
  const root = await projectWithProductIntake();
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  await setAssetSelection(root, { selected: ['product_image', 'depth_video'] });
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({ id: 'story-v1', type: 'story_plan', revision: 1, status: 'locked', path: 'planning/story-v1.json', sha256: 'x'.repeat(64), lockedByReviewId: 'review-story-v1' });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const view = await getWorkflowProfileView(root);
  assert.deepEqual(view.remakeControlSelection.selectedModes, ['depth_control']);
  assert.equal(view.remakeControlSelection.legacyInferred, true);
  assert.equal(view.remakeControlsEditable, false);
});

test('switching is blocked once a story plan is locked', async () => {
  const root = await project();
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({ id: 'story-v1', type: 'story_plan', revision: 1, status: 'locked', path: 'planning/story-v1.json', sha256: 'x'.repeat(64), lockedByReviewId: 'review-story-v1' });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await assert.rejects(() => setWorkflowProfile(root, { id: 'narrative', selectedBy: 'user' }), /不能切换/);
  const view = await getWorkflowProfileView(root);
  assert.equal(view.canSwitch, false);
});

test('authority cannot be silently converted to an original profile', async () => {
  const root = await project();
  const before = await readJson(join(root, 'project-state.json'));
  for (const id of ['original', 'narrative']) {
    await assert.rejects(() => setWorkflowProfile(root, { id }), /保留原片/);
  }
  assert.deepEqual(await readJson(join(root, 'project-state.json')), before);
  const view = await getWorkflowProfileView(root);
  assert.equal(view.profiles.find(item => item.id === 'original').available, false);
});

test('inspiration can use original creation but cannot silently become remake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-inspiration-'));
  await initializeProject(root, { projectId: 'WF-I', routeDecision: { ...ROUTE, referenceRoleStatus: 'inspiration' } });
  await setWorkflowProfile(root, { id: 'original' });
  await assert.rejects(() => setWorkflowProfile(root, { id: 'simple_remake' }), /灵感/);
  assert.equal((await getWorkflowProfileView(root)).profileId, 'original');
});

test('mechanical route cannot acquire a creative profile and retains its own steps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-mechanical-'));
  await initializeProject(root, { projectId: 'WF-M', routeDecision: { ...ROUTE, executionClass: 'mechanical_asset_prompt' } });
  for (const id of ['original', 'narrative', 'simple_remake']) {
    await assert.rejects(() => setWorkflowProfile(root, { id }), /无需选择创作路线/);
  }
  const view = await getWorkflowProfileView(root);
  assert.equal(view.canSwitch, false);
  assert.deepEqual(view.visibleSteps.map(step => step.gate), [4]);
  assert.equal(view.profileId, null);
});

test('legacy conflicting profile is inspectable without implicit state migration', async () => {
  const root = await project();
  const path = join(root, 'project-state.json');
  const state = await readJson(path);
  state.workflowProfile = { id: 'original', selectedBy: 'user', reason: 'historical record', updatedAt: new Date().toISOString() };
  await writeJsonAtomic(path, state);
  const view = await getWorkflowProfileView(root);
  assert.equal(view.profileId, 'original');
  assert.match(view.profileConflict, /保留原片/);
  assert.deepEqual(await readJson(path), state);
});

test('unresolved source role cannot be bypassed by a profile selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-unresolved-'));
  await initializeProject(root, { projectId: 'WF-U', routeDecision: { ...ROUTE, referenceRoleStatus: 'awaiting_reference_role' } });
  await assert.rejects(() => setWorkflowProfile(root, { id: 'original' }), /确认原视频/);
  assert.equal((await getWorkflowProfileView(root)).profileId, null);
});
