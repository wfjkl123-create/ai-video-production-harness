import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterBoardIrs, buildImagePromptPlan } from '../../src/services/image-profile-router-service.js';
import { characterBoardInput, directorViewProxyInput, verifiedModelProfile, visualStyleContract } from '../helpers/image-prompt-fixture.js';

test('expands one character into exactly four template-traced atomic images', () => {
  const irs = buildCharacterBoardIrs(characterBoardInput(), { visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile() });
  assert.equal(irs.length, 4);
  assert.deepEqual(irs.map(ir => ir.compositionContract.slot), ['top_left', 'top_right', 'bottom_left', 'bottom_right']);
  assert.ok(irs.every(ir => ir.skillsApplied.includes('seedance-characters')));
  assert.ok(irs.every(ir => ir.subjectContract.characterId === 'character-a'));
  assert.ok(irs.every(ir => ir.templateSource.startsWith('knowledge/image-profiles/character-board.md#')));
});

test('coverage-driven identity assets generate only the Shot-required views', () => {
  const board = {
    ...characterBoardInput(),
    coveragePlan: {
      kind: 'character_shot_coverage_v1', characterId: 'character-a',
      requiredProfileIds: ['character_front_face_closeup_v1', 'character_front_full_body_v2']
    }
  };
  const irs = buildCharacterBoardIrs(board, { visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile() });
  assert.deepEqual(irs.map(ir => ir.profileId), ['character_front_face_closeup_v1', 'character_front_full_body_v2']);
  assert.ok(irs.every(ir => ir.assetType === 'character_identity_pack_v2'));
  assert.ok(irs.every(ir => ir.compositionContract.slot !== 'bottom_left'));
  assert.ok(irs.every(ir => ir.acceptanceChecks.some(check => check.includes('without forced collage'))));
});

test('every character atom remains self-contained and does not cite unbound sibling views', () => {
  const irs = buildCharacterBoardIrs(characterBoardInput(), { visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile() });
  const forbidden = /(?:front face image|other character-board views|other three views)/i;
  for (const ir of irs) {
    assert.doesNotMatch(JSON.stringify({
      subjectContract: ir.subjectContract,
      constraints: ir.constraints,
      acceptanceChecks: ir.acceptanceChecks
    }), forbidden);
  }
});

test('multiple characters receive separate parallel lanes while one character keeps one worker lane', () => {
  const plan = buildImagePromptPlan({
    id: 'plan-two-characters-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 8,
    visualStyleContract: visualStyleContract(),
    characterBoards: [characterBoardInput('character-a'), characterBoardInput('character-b')], promptIrs: []
  }, verifiedModelProfile());
  assert.equal(plan.requests.length, 8);
  assert.equal(plan.dispatch.taskCount, 8);
  assert.equal(plan.dispatch.laneCount, 2);
  assert.deepEqual(plan.dispatch.waves[0].lanes.map(lane => lane.id), ['character:character-a', 'character:character-b']);
  assert.ok(plan.dispatch.waves[0].lanes.every(lane => lane.tasks.length === 4));
  assert.match(plan.planFingerprint, /^[a-f0-9]{64}$/);
});

test('director-routed image plans must cover required assets without loading unrelated capabilities', () => {
  const capabilityManifest = {
    id: 'capability-story-v1', storyPlanId: 'story-v1', storyPlanSha256: 'a'.repeat(64), routeVersion: 'director-route-v1',
    requiredAssetsBySegment: { 'segment-001': ['character_board', 'scene_multiview'] }
  };
  const input = {
    id: 'plan-routed-v1', projectId: 'project-001', capabilityManifestId: capabilityManifest.id, segmentIds: ['segment-001'],
    executionMode: 'parallel', maxConcurrency: 8, visualStyleContract: visualStyleContract(),
    characterBoards: [characterBoardInput('character-a')], promptIrs: []
  };
  assert.throws(() => buildImagePromptPlan(input, verifiedModelProfile(), { capabilityManifest }), /missing director-required assets.*scene_multiview/);
  const plan = buildImagePromptPlan(input, verifiedModelProfile(), { capabilityManifest, satisfiedAssetTypes: ['scene_multiview'] });
  assert.equal(plan.capabilityBinding.id, capabilityManifest.id);
  assert.equal(plan.dispatch.laneCount, 1);
});

test('a project-only image plan validates only the shared required assets before dependent segment assets exist', () => {
  const capabilityManifest = {
    id: 'capability-project-only-v1', storyPlanId: 'story-v1', storyPlanSha256: 'c'.repeat(64), routeVersion: 'director-route-v1',
    projectRequiredAssets: ['character_board', 'scene_multiview'],
    requiredAssetsBySegment: { 'segment-001': ['character_board', 'scene_multiview', 'storyboard', 'dialogue_axis_board'] }
  };
  const input = {
    id: 'plan-project-only-v1', projectId: 'project-001', capabilityManifestId: capabilityManifest.id,
    planScope: 'project_only', executionMode: 'parallel', maxConcurrency: 8,
    visualStyleContract: visualStyleContract(), characterBoards: [characterBoardInput('character-a')], promptIrs: []
  };
  const plan = buildImagePromptPlan(input, verifiedModelProfile(), { capabilityManifest, satisfiedAssetTypes: ['scene_multiview'] });
  assert.equal(plan.planScope, 'project_only');
  assert.equal(plan.requests.length, 4);
  assert.equal(plan.capabilityBinding.id, capabilityManifest.id);
});

test('director-routed plan compiles a director-view proxy into a blocking lane with clean lint', () => {
  const capabilityManifest = {
    id: 'capability-story-proxy-v1', storyPlanId: 'story-proxy-v1', storyPlanSha256: 'b'.repeat(64), routeVersion: 'director-route-v1',
    requiredAssetsBySegment: { 'segment-001': ['director_view_proxy'] }
  };
  const plan = buildImagePromptPlan({
    id: 'plan-director-proxy-v1', projectId: 'project-001', capabilityManifestId: capabilityManifest.id, segmentIds: ['segment-001'],
    executionMode: 'parallel', maxConcurrency: 8, visualStyleContract: visualStyleContract(),
    characterBoards: [], directorViewProxies: [directorViewProxyInput()], promptIrs: []
  }, verifiedModelProfile(), { capabilityManifest });
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].assetType, 'director_view_proxy');
  assert.equal(plan.requests[0].lint.decision, 'PASS');
  assert.equal(plan.dispatch.waves[0].lanes[0].id, 'blocking:S01');
});

test('a routed source-modification asset plan must bind the execution-safe source contract', () => {
  const capabilityManifest = {
    id: 'capability-safe-source-v1', storyPlanId: 'story-safe-v1', storyPlanSha256: 'd'.repeat(64), routeVersion: 'director-route-v2',
    requiredAssetsBySegment: { 'segment-001': ['scene_multiview'] },
    executionSourceContract: {
      version: 1, authority: 'executionSafeActionLedger_only', replacementMap: [{ id: 'replace-1' }], safeActionLedger: [{ id: 'safe-1' }],
      fingerprintSha256: 'e'.repeat(64)
    }
  };
  const input = {
    id: 'plan-safe-source-v1', projectId: 'project-001', capabilityManifestId: capabilityManifest.id, segmentIds: ['segment-001'],
    executionMode: 'parallel', maxConcurrency: 8, visualStyleContract: visualStyleContract(),
    characterBoards: [characterBoardInput('character-a')], promptIrs: []
  };
  assert.throws(() => buildImagePromptPlan(input, verifiedModelProfile(), { capabilityManifest, satisfiedAssetTypes: ['scene_multiview'] }), /execution-safe source contract/);
  const plan = buildImagePromptPlan({
    ...input,
    sourceExecutionBinding: { authority: 'executionSafeActionLedger_only', fingerprintSha256: 'e'.repeat(64) }
  }, verifiedModelProfile(), { capabilityManifest, satisfiedAssetTypes: ['scene_multiview'] });
  assert.equal(plan.sourceExecutionBinding.fingerprintSha256, 'e'.repeat(64));
});
