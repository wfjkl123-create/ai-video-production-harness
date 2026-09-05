import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAssetGenerationPlan, executeAssetGenerationPlan } from '../../src/commands/generate-assets.js';
import { runGenerateAssets } from '../../src/commands/generate-assets.js';
import { runReviewAssetManifest } from '../../src/commands/review-asset-manifest.js';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import { setWorkflowProfile } from '../../src/services/workflow-profile-service.js';

const fixtureRoot = resolve('tests/fixtures/project-ready');

const manifest = {
  id: 'segment-001-asset-manifest',
  segmentId: 'segment-001',
  status: 'locked',
  items: [{
    id: 'character-001', type: 'character_board', scope: 'project', status: 'locked', characterId: 'character-a', visualContractVersion: 1, visualAuditId: 'visual-audit-character-001',
    responsibility: 'identity only', mustNotControl: ['camera'], path: 'assets/project/character.png'
  }, {
    id: 'segment-001-storyboard', type: 'storyboard', scope: 'segment', status: 'locked',
    responsibility: 'shot composition', mustNotControl: ['identity']
  }]
};

test('dry-run plan lists bounded responsibilities, paths, outputs, and exact CLI argument arrays', () => {
  const plan = buildAssetGenerationPlan(manifest, { root: fixtureRoot, model: 'Image Model' });
  assert.equal(plan.segmentId, 'segment-001');
  assert.equal(plan.mutatesLibTv, false);
  assert.deepEqual(plan.assets[0].commands[0], [
    'upload', 'character-001-input', '-t', 'image', '--resource', resolve(fixtureRoot, 'assets/project/character.png')
  ]);
  assert.deepEqual(plan.assets[1], {
    assetId: 'segment-001-storyboard',
    nodeResponsibility: 'shot composition',
    inputPaths: [],
    promptPath: resolve(fixtureRoot, 'prompts/segment-001-storyboard.txt'),
    expectedOutputDirectory: resolve(fixtureRoot, 'outputs/segment-001-storyboard'),
    normalizedOutputPath: resolve(fixtureRoot, 'outputs/segment-001-storyboard.png'),
    normalization: {
      kind: 'single-file-move',
      sourceDirectory: resolve(fixtureRoot, 'outputs/segment-001-storyboard'),
      requireSingleFile: true,
      destinationPath: resolve(fixtureRoot, 'outputs/segment-001-storyboard.png')
    },
    commands: [[
      'node', 'create', 'segment-001-storyboard', '-t', 'image',
      '-s', 'model=Image Model', '-s', 'ratio=9:16', '-s', 'quality=2K',
      '--prompt', 'Create a storyboard with clear shot composition.'
    ], ['node', 'segment-001-storyboard'], ['node', 'segment-001-storyboard', '--run'],
    ['download', '--node', 'segment-001-storyboard', '--out', resolve(fixtureRoot, 'outputs/segment-001-storyboard')]]
  });
});

test('generation planning refuses an unlocked asset manifest', () => {
  assert.throws(() => buildAssetGenerationPlan({ ...manifest, status: 'awaiting_review' }, { root: '/project' }), /manifest.*locked/);
});

test('default live image model is a current official LibTV model name', () => {
  const plan = buildAssetGenerationPlan(manifest, { root: fixtureRoot });
  const create = plan.assets[0].commands.find(command => command.includes('create'));
  assert.ok(create.includes('model=Seedream 4.5'));
});

test('explicit LibTV project UUID is attached to every remote command', () => {
  const projectUuid = 'df93e472f4ad441bad1448ab7f1f760d';
  const plan = buildAssetGenerationPlan(manifest, { root: fixtureRoot, model: 'Image Model', projectUuid });
  for (const command of plan.assets[0].commands) {
    assert.deepEqual(command.slice(command.indexOf('-p'), command.indexOf('-p') + 2), ['-p', projectUuid]);
  }
  assert.throws(() => buildAssetGenerationPlan(manifest, { root: fixtureRoot, projectUuid: 'not-a-uuid' }), /project UUID/);
});

test('pending assets upload shared locked sources only once per plan', () => {
  const projectUuid = 'df93e472f4ad441bad1448ab7f1f760d';
  const pendingManifest = {
    ...manifest,
    lockedByReviewId: 'review-manifest',
    items: [manifest.items[0],
      { ...manifest.items[1], id: 'segment-001-storyboard', status: 'awaiting_review' },
      { ...manifest.items[1], id: 'segment-001-camera-blocking', status: 'awaiting_review' }]
  };
  const plan = buildAssetGenerationPlan(pendingManifest, { root: fixtureRoot, model: 'Seedream 5.0 Pro', projectUuid });
  assert.equal(plan.uploadCommands.length, 1);
  assert.equal(plan.assets.length, 2);
  assert.ok(plan.assets.every(asset => asset.commands.every(command => command[0] !== 'upload')));
  assert.ok(plan.assets.every(asset => asset.commands[0].includes('modeType=image2image')));
});

test('image generation fails fast instead of treating pending timing audio as a PNG target', () => {
  const pendingAudioManifest = {
    ...manifest,
    lockedByReviewId: 'review-manifest',
    items: [
      manifest.items[0],
      {
        id: 'segment-001-timing-audio', type: 'timing_audio_reference', mediaKind: 'audio',
        scope: 'segment', status: 'awaiting_review',
        responsibility: 'source waveform and action clock', mustNotControl: ['visual identity']
      }
    ]
  };
  assert.throws(
    () => buildAssetGenerationPlan(pendingAudioManifest, { root: fixtureRoot }),
    /audio asset segment-001-timing-audio must be prepared and locked/
  );
});

test('dry run reads only a reviewed manifest without invoking LibTV', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-dry-run-reviewed-'));
  await initializeProject(root, { projectId: 'ASSET-DRY-RUN' });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/target.txt'), 'Create a storyboard with clear shot composition.');
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'), {
    id: 'manifest-dry-run', segmentId: 'segment-001', status: 'awaiting_review',
    items: [{ id: 'target', type: 'storyboard', scope: 'segment', status: 'awaiting_review',
      responsibility: 'shot composition', mustNotControl: ['identity'] }]
  });
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'approve exact dry-run inputs'
  ]);
  const plan = await runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ]);
  assert.equal(plan.segmentId, 'segment-001');
  assert.equal(plan.mutatesLibTv, false);
  assert.ok(plan.assets.length > 0);
  const promptIndex = plan.assets[0].commands[0].indexOf('--prompt');
  assert.equal(plan.assets[0].commands[0][promptIndex + 1], 'Create a storyboard with clear shot composition.');
  assert.doesNotMatch(plan.assets[0].commands[0][promptIndex + 1], /^@/);
  const download = plan.assets[0].commands.at(-1);
  const out = download[download.indexOf('--out') + 1];
  assert.equal(out, plan.assets[0].expectedOutputDirectory);
  assert.notEqual(out, plan.assets[0].normalizedOutputPath);
  assert.doesNotMatch(out, /\.[a-z0-9]+$/i);
  assert.deepEqual(plan.assets[0].normalization, {
    kind: 'single-file-move',
    sourceDirectory: out,
    requireSingleFile: true,
    destinationPath: plan.assets[0].normalizedOutputPath
  });
});

test('simple remake accepts a system-reviewed manifest for its automatic core-asset route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-dry-run-simple-remake-'));
  await initializeProject(root, { projectId: 'ASSET-DRY-RUN-SIMPLE' });
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/target.txt'), 'Create one exact storyboard target.');
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'), {
    id: 'manifest-simple-remake', segmentId: 'segment-001', status: 'awaiting_review',
    items: [{ id: 'target', type: 'storyboard', scope: 'segment', status: 'awaiting_review',
      responsibility: 'shot composition', mustNotControl: ['identity'] }]
  });
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'simple remake system review'
  ], { delegatedByProfile: 'simple_remake' });

  const plan = await runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ]);
  assert.equal(plan.segmentId, 'segment-001');
  assert.equal(plan.assets.length, 1);
});

test('dry run accepts a registered source-visible character behind the canonical manifest alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-source-visible-alias-'));
  await initializeProject(root, { projectId: 'ASSET-SOURCE-VISIBLE-ALIAS' });
  const sourcePath = join(root, 'assets/project/character-lead-source-visible-v1.png');
  await writeFile(sourcePath, 'source-visible-character-pixels');
  const sourceSha256 = await sha256File(sourcePath);
  const sourceReviewId = 'review-character-lead-source-visible-v1';
  const source = {
    id: 'character-lead-source-visible-v1', type: 'project_asset',
    assetType: 'character_identity_source_visible_v1', mediaKind: 'image',
    characterId: 'lead-presenter', visualContractVersion: 1,
    visualAuditId: 'visual-audit-character-lead-source-visible-v1',
    revision: 1, status: 'locked', path: 'assets/project/character-lead-source-visible-v1.png',
    sha256: sourceSha256, lockedByReviewId: sourceReviewId
  };
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push(source);
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await writeJsonAtomic(join(root, 'reviews', `${sourceReviewId}.json`), {
    id: sourceReviewId, artifactId: source.id, actor: 'human', decision: 'approved'
  });
  await writeFile(join(root, 'prompts/segment-001-storyboard.txt'), 'Create one exact storyboard target.');
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'), {
    id: 'manifest-source-visible-alias', segmentId: 'segment-001', status: 'awaiting_review',
    items: [{
      id: source.id, type: 'character_identity_single_view', scope: 'project', status: 'locked',
      characterId: source.characterId, visualContractVersion: 1, visualAuditId: source.visualAuditId,
      responsibility: 'source-visible identity only', mustNotControl: ['source scene'],
      revision: 1, path: source.path, sha256: source.sha256, lockedByReviewId: sourceReviewId
    }, {
      id: 'segment-001-storyboard', type: 'storyboard', scope: 'segment', status: 'awaiting_review',
      responsibility: 'shot composition', mustNotControl: ['identity']
    }]
  });
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'approve canonical alias inputs'
  ]);

  const plan = await runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ]);
  assert.equal(plan.assets.length, 1);
  assert.equal(plan.uploadCommands.length, 1);
  assert.equal(plan.uploadCommands[0][1], `${source.id}-input`);
});

test('the fast image executor bounds independent heavy work at two concurrent assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-bounded-parallel-'));
  const assets = [];
  for (const id of ['asset-a', 'asset-b', 'asset-c']) {
    const expectedOutputDirectory = join(root, 'staging', id);
    assets.push({
      assetId: id,
      expectedOutputDirectory,
      normalizedOutputPath: join(root, 'outputs', `${id}.png`),
      commands: [['download', '--node', id, '--out', expectedOutputDirectory]]
    });
  }
  let active = 0;
  let peak = 0;
  const execution = await executeAssetGenerationPlan({
    manifestId: 'manifest-fast', segmentId: 'segment-fast', uploadCommands: [], assets
  }, {
    root,
    runId: 'run-fast',
    maxConcurrency: 2,
    runner: async (_executable, args) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
      const out = args[args.indexOf('--out') + 1];
      await mkdir(out, { recursive: true });
      await writeFile(join(out, `${args[2]}.png`), args[2]);
      active -= 1;
      return { code: 0 };
    }
  });
  assert.equal(peak, 2);
  assert.equal(execution.maxConcurrency, 2);
  assert.deepEqual(execution.outputs.map(output => output.assetId), ['asset-a', 'asset-b', 'asset-c']);
});
