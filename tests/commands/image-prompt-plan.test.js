import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planningSatisfiedAssetTypes, runImagePromptPlan, validateRemainingAssetLifecycle } from '../../src/commands/image-prompt-plan.js';
import { buildImagePromptPlan } from '../../src/services/image-profile-router-service.js';
import { characterBoardInput, directorViewProxyInput, verifiedModelProfile, visualStyleContract } from '../helpers/image-prompt-fixture.js';

test('CLI writes a non-generating parallel character prompt plan inside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-prompt-plan-'));
  await mkdir(join(root, 'inputs'));
  await writeFile(join(root, 'inputs', 'plan.json'), JSON.stringify({
    id: 'character-plan-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 4,
    visualStyleContract: visualStyleContract(), characterBoards: [characterBoardInput()], promptIrs: []
  }));
  await writeFile(join(root, 'inputs', 'model.json'), JSON.stringify(verifiedModelProfile()));
  const result = await runImagePromptPlan([
    '--project', root, '--input', 'inputs/plan.json', '--model-profile', 'inputs/model.json'
  ]);
  assert.equal(result.requests.length, 4);
  assert.equal(result.path, 'runs/image-prompt-plans/character-plan-v1.json');
  const persisted = JSON.parse(await readFile(join(root, result.path), 'utf8'));
  assert.equal(persisted.dispatch.laneCount, 1);
  assert.ok(persisted.requests.every(request => request.autoRetry === false));
});

test('CLI uses the bundled Codex profile and refuses to overwrite a changed plan fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-prompt-plan-default-'));
  await mkdir(join(root, 'inputs'));
  const inputPath = join(root, 'inputs', 'plan.json');
  const input = {
    id: 'immutable-character-plan-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 4,
    visualStyleContract: visualStyleContract(), characterBoards: [characterBoardInput()], promptIrs: []
  };
  await writeFile(inputPath, JSON.stringify(input));
  const first = await runImagePromptPlan(['--project', root, '--input', 'inputs/plan.json']);
  assert.equal(first.requests[0].modelProfileId, 'codex-image-gen-generic-v1');
  await writeFile(inputPath, JSON.stringify({
    ...input,
    characterBoards: [{ ...input.characterBoards[0], purpose: 'A different purpose must produce a new plan ID' }]
  }));
  await assert.rejects(runImagePromptPlan(['--project', root, '--input', 'inputs/plan.json']), /different fingerprint/);
});

test('character prompt planning supports a non-real handcrafted clay identity without live-action skin requirements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-prompt-plan-clay-'));
  await mkdir(join(root, 'inputs'));
  await writeFile(join(root, 'inputs', 'plan.json'), JSON.stringify({
    id: 'clay-character-plan-v1', projectId: 'project-001', executionMode: 'sequential', maxConcurrency: 1,
    visualStyleContract: visualStyleContract({
      description: 'handcrafted matte stop-motion clay character reference',
      locks: ['matte clay surface', 'subtle sculpting fingerprints', 'no real human skin']
    }),
    characterBoards: [characterBoardInput('character-a', { characterMedium: 'stylized_clay' })],
    promptIrs: []
  }));
  const result = await runImagePromptPlan(['--project', root, '--input', 'inputs/plan.json']);
  assert.equal(result.requests.length, 4);
  assert.ok(result.requests.every(request => request.prompt.includes('non-real handcrafted clay figure')));
  assert.ok(result.requests.every(request => request.prompt.includes('no human pores')));
  assert.ok(result.requests.every(request => !request.prompt.includes('real skin texture without beauty-filter plasticity')));
});

test('CLI bundled Codex profile compiles a director-view proxy without generating an image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-prompt-plan-director-proxy-'));
  await mkdir(join(root, 'inputs'));
  await writeFile(join(root, 'inputs', 'plan.json'), JSON.stringify({
    id: 'director-proxy-plan-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 4,
    visualStyleContract: visualStyleContract(), characterBoards: [], directorViewProxies: [directorViewProxyInput()], promptIrs: []
  }));
  const result = await runImagePromptPlan(['--project', root, '--input', 'inputs/plan.json']);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].modelProfileId, 'codex-image-gen-generic-v1');
  assert.equal(result.requests[0].profileId, 'director_view_proxy_v1');
  assert.equal(result.requests[0].lint.decision, 'PASS');
});

test('CLI rejects input and output-directory symlinks that escape the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-prompt-plan-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'image-prompt-plan-outside-'));
  const outsideInput = join(outside, 'plan.json');
  await writeFile(outsideInput, JSON.stringify({
    id: 'escaped-plan-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 4,
    visualStyleContract: visualStyleContract(), characterBoards: [characterBoardInput()], promptIrs: []
  }));
  await symlink(outsideInput, join(root, 'escaped-input.json'));
  await assert.rejects(runImagePromptPlan(['--project', root, '--input', 'escaped-input.json']), /readable regular project file/);

  await mkdir(join(root, 'inputs'));
  await writeFile(join(root, 'inputs', 'plan.json'), await readFile(outsideInput));
  await symlink(outside, join(root, 'runs'));
  await assert.rejects(runImagePromptPlan(['--project', root, '--input', 'inputs/plan.json']), /must not contain symlinks/);
  await assert.rejects(access(join(outside, 'image-prompt-plans')));
});

test('an exact-SHA audited draft asset satisfies non-generating prompt planning without bypassing Gate 3', () => {
  const sha256 = 'a'.repeat(64);
  const asset = {
    id: 'reused-product-v1', type: 'project_asset', assetType: 'product_reference', revision: 1,
    status: 'draft', path: 'assets/project/reused-product-v1.png', sha256,
    visualAuditId: 'visual-audit-reused-product-v1', requiredVisualChecks: ['asset_role_fidelity']
  };
  const audit = {
    id: 'visual-audit-reused-product-v1', type: 'asset_visual_audit', status: 'locked',
    assetId: asset.id, assetType: asset.assetType, assetRevision: 1, assetSha256: sha256,
    decision: 'PASS', inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: '/root/asset-pixel-audit', observedIdentityCount: 0, blockerCount: 0,
    checkIds: ['asset_role_fidelity']
  };
  assert.deepEqual(planningSatisfiedAssetTypes({ artifacts: [asset, audit] }), ['product_reference']);
  assert.equal(asset.status, 'draft');
});

test('a source-visible character profile satisfies the canonical single-view planning requirement', () => {
  const sha256 = 'c'.repeat(64);
  const asset = {
    id: 'character-lead-source-visible-v1', type: 'project_asset',
    assetType: 'character_identity_source_visible_v1', characterId: 'lead-presenter',
    visualContractVersion: 1, revision: 1, status: 'draft',
    path: 'assets/project/character-lead-source-visible-v1.png', sha256,
    visualAuditId: 'visual-audit-character-lead-source-visible-v1'
  };
  const audit = {
    id: asset.visualAuditId, type: 'asset_visual_audit', status: 'locked',
    assetId: asset.id, assetType: asset.assetType, assetRevision: 1, assetSha256: sha256,
    decision: 'PASS', inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: '/root/source-visible-auditor', observedIdentityCount: 1, blockerCount: 0
  };

  assert.deepEqual(planningSatisfiedAssetTypes({ artifacts: [asset, audit] }), ['character_identity_single_view']);
  assert.equal(asset.status, 'draft');
});

test('a prepared draft audio asset satisfies image planning but remains pending Gate 3', () => {
  const audio = {
    id: 'timing-audio-v1', type: 'segment_asset', assetType: 'timing_audio_reference',
    revision: 1, status: 'draft', path: 'assets/segment/segment-001/audio.wav',
    sha256: 'b'.repeat(64), mediaKind: 'audio', segmentId: 'segment-001'
  };
  assert.deepEqual(planningSatisfiedAssetTypes({ artifacts: [audio] }), ['timing_audio_reference']);
  assert.equal(audio.status, 'draft');
});

test('a staged project batch must name every director-required asset deferred to a later SHA-bound batch', async () => {
  const manifest = {
    id: 'capability-story-plan-v1-v7', storyPlanId: 'story-plan-v1', storyPlanSha256: 'a'.repeat(64), routeVersion: 'director-route-v7',
    projectRequiredAssets: ['character_board', 'scene_multiview', 'wardrobe_board'], requiredAssetsBySegment: {}
  };
  const input = {
    id: 'staged-character-plan-v1', projectId: 'project-001', capabilityManifestId: manifest.id, executionMode: 'parallel', maxConcurrency: 4,
    visualStyleContract: visualStyleContract(), characterBoards: [characterBoardInput()], promptIrs: []
  };
  input.planScope = 'staged_project_batch';
  input.deferredAssetTypes = ['scene_multiview', 'wardrobe_board'];
  input.remainingAssetLifecycle = {
    deferredGeneratedAssetTypes: ['scene_multiview', 'wardrobe_board', 'storyboard'],
    deferredDeterministicAssetTypes: ['timing_audio_reference'],
    existingAssetsPendingGate3Lock: [{
      assetType: 'product_reference',
      assetId: 'product-reference-v1',
      sha256: 'a'.repeat(64)
    }],
    stageCompletionClaim: 'anchor_inputs_only_not_gate3_complete'
  };
  const plan = buildImagePromptPlan(input, verifiedModelProfile(), { capabilityManifest: manifest });
  assert.deepEqual(plan.deferredAssetTypes, ['scene_multiview', 'wardrobe_board']);
  assert.equal(plan.remainingAssetLifecycle.stageCompletionClaim, 'anchor_inputs_only_not_gate3_complete');
  assert.throws(() => buildImagePromptPlan({ ...input, deferredAssetTypes: ['scene_multiview'] }, verifiedModelProfile(), { capabilityManifest: manifest }), /missing director-required project assets: wardrobe_board/);
  assert.throws(() => buildImagePromptPlan({
    ...input,
    deferredAssetTypes: ['scene_multiview', 'wardrobe_board', 'product_reference'],
    remainingAssetLifecycle: {
      ...input.remainingAssetLifecycle,
      deferredGeneratedAssetTypes: [...input.remainingAssetLifecycle.deferredGeneratedAssetTypes, 'product_reference']
    }
  }, verifiedModelProfile(), { capabilityManifest: manifest }), /outside the director-required project scope/);
  assert.throws(() => buildImagePromptPlan({
    ...input,
    remainingAssetLifecycle: { ...input.remainingAssetLifecycle, deferredGeneratedAssetTypes: ['scene_multiview'] }
  }, verifiedModelProfile(), { capabilityManifest: manifest }), /must include deferredAssetTypes: wardrobe_board/);
  assert.throws(() => validateRemainingAssetLifecycle(plan, { artifacts: [] }), /unknown artifact product-reference-v1/);
  assert.doesNotThrow(() => validateRemainingAssetLifecycle(plan, { artifacts: [{
    id: 'product-reference-v1',
    type: 'project_asset',
    assetType: 'product_reference',
    sha256: 'a'.repeat(64),
    status: 'draft'
  }] }));
  assert.throws(() => validateRemainingAssetLifecycle(plan, { artifacts: [{
    id: 'product-reference-v1',
    type: 'project_asset',
    assetType: 'product_reference',
    sha256: 'b'.repeat(64),
    status: 'draft'
  }] }), /does not match artifact product-reference-v1/);
  assert.throws(() => validateRemainingAssetLifecycle(plan, { artifacts: [{
    id: 'product-reference-v1',
    type: 'project_asset',
    assetType: 'product_reference',
    sha256: 'a'.repeat(64),
    status: 'locked'
  }] }), /incorrectly marks locked artifact product-reference-v1 as pending Gate 3 lock/);
});
