import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';
import { persistSegmentation } from '../../src/services/segmentation-workflow-service.js';
import { compileAssetManifest } from '../../src/services/asset-service.js';
import { compileSeedancePackage } from '../../src/services/seedance-package-service.js';
import { runGenerateVideoCommand } from '../../src/commands/generate-video-cli.js';
import { runApprovePaidGeneration } from '../../src/commands/approve-paid-generation.js';
import { runPrepareHandoff } from '../../src/commands/prepare-handoff.js';
import { runRecordHandoff } from '../../src/commands/record-handoff.js';
import { runReviewHandoff } from '../../src/commands/review-handoff.js';
import { runGenerateAssets } from '../../src/commands/generate-assets.js';
import { runReviewAssetManifest } from '../../src/commands/review-asset-manifest.js';
import { runAssets } from '../../src/commands/assets.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import { lintNarration } from '../../src/services/narration-lint-service.js';
import { lockPassingIndependentAudit } from '../helpers/independent-creative-audit-fixture.js';
import { REQUIRED_VISUAL_CHECKS } from '../../src/domain/asset-visual-audit.js';
import { runAssetVisualAudit } from '../../src/commands/asset-visual-audit.js';

const fixtureRoot = new URL('../fixtures/pilot-project/', import.meta.url);
const execFile = promisify(execFileCallback);

async function copyFixture(root, name, destination) {
  const contents = await readFile(new URL(name, fixtureRoot));
  const path = join(root, destination);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  return path;
}

async function addAndApprove(root, descriptor, note = 'human approved fixture') {
  const artifact = await registerArtifact(root, descriptor);
  await submitForReview(root, artifact.id);
  const review = await approveArtifact(root, artifact.id, note);
  return { review, artifact: (await readJson(join(root, 'project-state.json'))).artifacts.find(({ id }) => id === artifact.id) };
}

async function lockCharacterVisualAudit(root, asset) {
  const auditId = asset.visualAuditId;
  const path = join(root, 'reviews', `${auditId}.json`);
  await writeFile(path, `${JSON.stringify({
    id: auditId, kind: 'asset_visual_audit', assetId: asset.id, assetType: asset.assetType,
    assetRevision: asset.revision, assetSha256: asset.sha256, decision: 'PASS',
    inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: 'fresh-test-visual-agent', observedIdentityCount: 1,
    checks: REQUIRED_VISUAL_CHECKS.character_board.map(id => ({ id, result: 'PASS', evidence: `fixture pixels checked: ${id}` })),
    blockerCount: 0, reviewedAt: '2026-07-26T12:00:00Z'
  }, null, 2)}\n`);
  await runAssetVisualAudit(['--project', root, '--input', path]);
  await submitForReview(root, auditId);
  await approveArtifact(root, auditId, 'human accepts clean multimodal character asset audit');
}

// 讲戏门 helper：写讲戏本 → 机审(narration-lint) → 人审锁定 → 返回可绑定的 id 与 SHA。
async function lockNarration(root, segmentId, shotId = 'shot-001') {
  const rel = `prompts/${segmentId}-narration.json`;
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, rel), JSON.stringify({
    id: `narration-${segmentId}`, segmentId, sourceSegmentId: segmentId, revision: 1, status: 'draft',
    shots: [{
      shotId, physicalActions: ['主角抬手把收腹裤展开，指尖沿腰头滑过'],
      cameraMove: '中景缓慢推近', lightSources: ['左前方柔光箱主光'], emotionThroughAction: '下颌微收，嘴角轻轻上扬'
    }]
  }, null, 2) + '\n');
  const { artifact } = { artifact: await registerArtifact(root, {
    id: `narration-${segmentId}`, type: 'shot_narration', segmentId, revision: 1, status: 'draft', path: rel
  }) };
  await lintNarration(root, artifact.id); // 机审通过 → awaiting_review
  await approveArtifact(root, artifact.id, 'human approved shot narration');
  const locked = (await readJson(join(root, 'project-state.json'))).artifacts.find(({ id }) => id === artifact.id);
  return { narrationSourceId: locked.id, narrationSha256: locked.sha256 };
}

function fakeMediaTools(duration = 12) {
  return async (executable, args) => {
    if (executable === 'ffprobe') return { code: 0, stdout: `${duration}\n`, stderr: '' };
    await writeFile(args.at(-1), `frame:${args[args.indexOf('-ss') + 1]}`);
    return { code: 0, stdout: '', stderr: '' };
  };
}

function observedHandoff(prepared) {
  const field = value => ({ value, basis: 'observed', timestamps: [prepared.evidenceTimestamps.at(-1)] });
  return {
    id: 'handoff-segment-001', segmentId: 'segment-001', revision: 1,
    preparedHandoffId: prepared.id, reviewId: 'review-handoff-001', decision: 'approved',
    evidenceTimestamps: prepared.evidenceTimestamps,
    acceptDeviation: false,
    people: field([{ personId: 'lead', leftRight: 'center', depth: 'midground', bodyDirection: 'front', faceDirection: 'front', gaze: 'camera' }]),
    distances: field([]), productState: field({ description: 'shapewear fitted and stable' }), props: field([]),
    camera: field({ position: 'front', direction: 'toward lead', shotSize: 'medium' }),
    openMotion: field([]), unknowns: field([])
  };
}

test('completes the two-segment pilot dry-run through every human gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-e2e-'));
  await initializeProject(root, { projectId: 'PILOT-E2E', workflowVersion: 1 });

  await copyFixture(root, 'script.md', 'brief/script-v1.md');
  await copyFixture(root, 'shotlist.md', 'brief/shotlist-v1.md');
  await addAndApprove(root, { id: 'script-v1', type: 'script', revision: 1, status: 'draft', path: 'brief/script-v1.md' });
  await addAndApprove(root, { id: 'shotlist-v1', type: 'shotlist', revision: 1, status: 'draft', path: 'brief/shotlist-v1.md' });

  const blueprint = await readJson(new URL('segments.json', fixtureRoot));
  const segmentation = await persistSegmentation(root, {
    id: 'segmentation-v1', path: 'segments/segmentation-v1.json', segments: blueprint.segments
  });
  await submitForReview(root, segmentation.id);
  const segmentationReview = await approveArtifact(root, segmentation.id, 'two natural 12-second beats approved');
  const lockedSegmentation = (await readJson(join(root, 'project-state.json'))).artifacts.find(({ id }) => id === segmentation.id);
  const lockedSegments = (await readJson(join(root, lockedSegmentation.path))).segments;
  assert.ok(lockedSegments.every(segment => segment.status === 'locked' && segment.lockedByReviewId === segmentationReview.id));

  const projectAssetTypes = ['character_board', 'product_reference', 'scene_multiview', 'scene_overhead', 'story_prop'];
  for (const [index, assetType] of projectAssetTypes.entries()) {
    const path = `assets/project/${assetType}.png`;
    await mkdir(join(root, 'assets/project'), { recursive: true });
    await writeFile(join(root, path), `distinct fixture pixels for ${assetType}\n`);
    const descriptor = {
      id: lockedSegments[0].projectAssetIds[index], type: 'project_asset', assetType,
      revision: 1, status: 'draft', path,
      ...(assetType === 'character_board' ? {
        characterId: 'character-a', visualContractVersion: 1,
        visualAuditId: `visual-audit-${lockedSegments[0].projectAssetIds[index]}`
      } : {})
    };
    const approved = await addAndApprove(root, descriptor);
    if (assetType === 'character_board') await lockCharacterVisualAudit(root, approved.artifact);
  }

  let state = await readJson(join(root, 'project-state.json'));
  const draftManifest = compileAssetManifest({ ...state, segments: lockedSegments }, lockedSegments[0]);
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'), draftManifest);
  for (const item of draftManifest.items.filter(({ scope }) => scope === 'segment')) {
    await writeFile(join(root, `prompts/${item.id}.txt`), `${item.responsibility}; one responsibility only`);
  }
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'human approved current segment requirements'
  ]);
  const libtvCalls = [];
  const libtv = await runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], { runId: 'libtv-main-e2e', runner: async (executable, args, options) => {
    libtvCalls.push({ executable, args, options });
    if (args[0] === 'download') {
      const directory = args[args.indexOf('--out') + 1];
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'result.png'), `fake-libtv:${args[args.indexOf('--node') + 1]}`);
    }
    return { code: 0, stdout: '{}', stderr: '' };
  } });
  assert.ok(libtvCalls.every(({ executable, options }) => executable === 'libtv' && options.shell === false));
  for (const output of libtv.outputs) {
    const item = draftManifest.items.find(({ id }) => id === output.assetId);
    const approved = await addAndApprove(root, {
      id: output.assetId, type: 'segment_asset', assetType: item.type, segmentId: 'segment-001',
      revision: 1, status: 'draft', path: output.path
    }, `approved LibTV result for ${item.type}`);
    assert.equal(approved.artifact.sha256, output.sha256);
  }
  state = await readJson(join(root, 'project-state.json'));
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'),
    compileAssetManifest({ ...state, segments: lockedSegments }, lockedSegments[0]));
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'human approved final locked input manifest'
  ]);
  const manifest = await readJson(join(root, 'assets/segment-001-asset-manifest.json'));

  await mkdir(join(root, 'prompts/segment-001'), { recursive: true });
  await writeFile(join(root, 'prompts/segment-001.txt'), '主角按锁定调度完成收腹裤产品展示。');
  const narration001 = await lockNarration(root, 'segment-001');
  const { artifact: prompt } = await addAndApprove(root, {
    id: 'prompt-segment-001', type: 'seedance_prompt', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'prompts/segment-001.txt', ...narration001
  });
  state = await readJson(join(root, 'project-state.json'));
  const compiled = await compileSeedancePackage({ ...state, root, segments: lockedSegments, assetManifest: manifest, prompt }, 'segment-001');
  await writeJsonAtomic(join(root, 'prompts/segment-001/seedance-package.json'), compiled);
  await lockPassingIndependentAudit(root, 'segment-001');
  assert.equal(compiled.ratio, '9:16');
  assert.ok(compiled.imageInputs.every(({ status }) => status === 'locked'));

  const fakeAdapter = {
    upload: async path => `fake://upload/${path}`,
    submitVideo: async input => { assert.equal(input.ratio, '9:16'); return 'fake-task-001'; },
    waitForCompletion: async () => ({ status: 'SUCCESS', results: [{ url: 'fake://result.mp4' }] }),
    downloadResults: async (_result, destination) => {
      await mkdir(destination, { recursive: true });
      const path = join(destination, 'result-1.mp4');
      await writeFile(path, 'fake approved video bytes');
      return [path];
    }
  };
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-segment-001' });
  const paidApproval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId,
    '--note', 'human approved this exact paid generation fingerprint'
  ], { id: 'review-paid-001' });
  const generated = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', paidApproval.id
  ], { adapter: fakeAdapter, runId: 'runninghub-live-001' });
  assert.equal(generated.taskId, 'fake-task-001');
  assert.equal(generated.outputs.length, 1);

  await addAndApprove(root, {
    id: 'video-segment-001', type: 'video_segment', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: generated.outputs[0].path
  }, 'human approved video segment 001');
  await runPrepareHandoff(['--project', root, '--artifact', 'video-segment-001'], { runner: fakeMediaTools() });
  state = await readJson(join(root, 'project-state.json'));
  const prepared = state.artifacts.find(({ id }) => id === 'handoff-prepared-segment-001');
  await writeJsonAtomic(join(root, 'reviews/handoff-input.json'), observedHandoff(prepared));
  const handoffReview = await runReviewHandoff([
    '--project', root, '--input', 'reviews/handoff-input.json', '--decision', 'approved',
    '--note', 'human approved observed handoff geometry'
  ], { id: 'review-handoff-001' });
  await runRecordHandoff([
    '--project', root, '--input', 'reviews/handoff-input.json', '--review', handoffReview.id
  ]);

  state = await readJson(join(root, 'project-state.json'));
  const eligible = await runAssets(['--project', root, '--segment', 'segment-002']);
  assert.equal(eligible.segmentId, 'segment-002');
  assert.equal(eligible.observedHandoffId, 'handoff-segment-001');
  assert.equal(await sha256File(join(root, generated.outputs[0].path)), state.artifacts.find(({ id }) => id === 'video-segment-001').sha256);
});

test('LibTV live bridge uses only official CLI argument arrays and preserves run evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-live-e2e-'));
  await initializeProject(root, { projectId: 'LIBTV-LIVE-FAKE', workflowVersion: 1 });
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/target.txt'), 'one responsibility only');
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'), {
    id: 'manifest-001', segmentId: 'segment-001', status: 'awaiting_review',
    items: [{ id: 'target', type: 'storyboard', scope: 'segment', status: 'awaiting_review',
      responsibility: 'framing only', mustNotControl: ['identity'] }]
  });
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'human approved fake live requirements'
  ]);
  const calls = [];
  const runner = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args[0] === 'download') {
      const directory = args[args.indexOf('--out') + 1];
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'libtv-result.png'), 'fake image');
    }
    return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
  };
  const result = await runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], { runner, runId: 'libtv-fake-001' });
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.executable === 'libtv' && call.options.shell === false));
  assert.deepEqual(result.outputs.map(({ path }) => path), ['outputs/target.png']);
  assert.equal((await readJson(join(root, 'runs/libtv-fake-001.json'))).status, 'SUCCESS');
});

test('public CLI persists intake and segmentation and performs a network-free video preflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-cli-e2e-'));
  await execFile(process.execPath, ['src/cli.js', 'init', '--project', root, '--project-id', 'CLI-E2E', '--workflow-version', '1']);
  await writeFile(join(root, 'brief/script.md'), 'script');
  await writeFile(join(root, 'script-artifact.json'), JSON.stringify({
    id: 'script-v1', type: 'script', revision: 1, status: 'draft', path: 'brief/script.md'
  }));
  await execFile(process.execPath, ['src/cli.js', 'register-artifact', '--project', root, '--input', join(root, 'script-artifact.json')]);
  await execFile(process.execPath, [
    'src/cli.js', 'segments', '--project', root, '--artifact', 'segmentation-v1', '--output', 'segments/segmentation-v1.json',
    '--duration', '24', '--beats', '0,12,24'
  ]);
  const status = JSON.parse((await execFile(process.execPath, ['src/cli.js', 'status', '--project', root])).stdout);
  assert.deepEqual(status.artifacts.map(({ id }) => id), ['script-v1', 'segmentation-v1']);

  const ready = await mkdtemp(join(tmpdir(), 'video-preflight-e2e-'));
  for (const directory of ['assets', 'outputs', 'reviews', 'rules', 'segments']) {
    await cp(`tests/fixtures/project-ready/${directory}`, join(ready, directory), { recursive: true });
  }
  await mkdir(join(ready, 'prompts'), { recursive: true });
  for (const name of ['character-001.txt', 'segment-001-camera-blocking.txt', 'segment-001-storyboard.txt', 'segment-001.txt', 'segment-001-narration.json']) {
    await cp(`tests/fixtures/project-ready/prompts/${name}`, join(ready, 'prompts', name));
  }
  await cp('tests/fixtures/project-ready/project-state.json', join(ready, 'project-state.json'));
  await execFile(process.execPath, [
    'src/cli.js', 'compile-seedance', '--project', ready, '--segment', 'segment-001', '--video-executor', 'runninghub'
  ]);
  await lockPassingIndependentAudit(ready, 'segment-001');
  const plan = JSON.parse((await execFile(process.execPath, [
    'src/cli.js', 'generate-video', '--project', ready, '--segment', 'segment-001', '--dry-run'
  ])).stdout);
  assert.equal(plan.ratio, '9:16');
  assert.equal(plan.mutatesRunningHub, false);
  assert.equal(plan.requiresPaidApproval, true);
  const approval = JSON.parse((await execFile(process.execPath, [
    'src/cli.js', 'approve-paid-generation', '--project', ready, '--segment', 'segment-001',
    '--preflight', plan.preflightId, '--note', 'human approved exact public CLI fingerprint'
  ])).stdout);
  assert.equal(approval.actor, 'human');
  assert.equal(approval.preflightId, plan.preflightId);
  assert.equal(JSON.parse(await readFile(join(ready, 'reviews', `${encodeURIComponent(approval.id)}.json`), 'utf8')).fingerprint.sha256, plan.fingerprint.sha256);
});

test('human-reviewed requirements manifest generates only pending segment assets and recompiles locked results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manifest-gate-e2e-'));
  await initializeProject(root, { projectId: 'MANIFEST-GATE', workflowVersion: 1 });
  await mkdir(join(root, 'assets/project'), { recursive: true });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'assets/project/character.png'), 'character');
  await writeFile(join(root, 'prompts/segment-001-camera_blocking.txt'), 'camera paths only');
  const projectAsset = (await addAndApprove(root, {
    id: 'character', type: 'project_asset', assetType: 'character_board', revision: 1,
    status: 'draft', path: 'assets/project/character.png', characterId: 'character-a',
    visualContractVersion: 1, visualAuditId: 'visual-audit-character'
  })).artifact;
  await lockCharacterVisualAudit(root, projectAsset);
  const state = await readJson(join(root, 'project-state.json'));
  const current = {
    id: 'segment-001', duration: 10, status: 'locked', lockedByReviewId: 'review-segment',
    projectAssetIds: ['character'], segmentAssetRequirements: ['camera_blocking'],
    previousSegmentId: null, nextSegmentId: null
  };
  const upstream = [
    { id: 'script-e2e', type: 'script', revision: 1, status: 'locked', path: 'brief/script', lockedByReviewId: 'review-script' },
    { id: 'shotlist-e2e', type: 'shotlist', revision: 1, status: 'locked', path: 'brief/shotlist', lockedByReviewId: 'review-shotlist' }
  ];
  const manifest = compileAssetManifest({
    ...state, segments: [current], artifacts: [...state.artifacts, ...upstream]
  }, current);
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'), manifest);
  const review = await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'requirements approved'
  ]);
  assert.equal(review.actor, 'human');
  const plan = await runGenerateAssets(['--project', root, '--segment', 'segment-001', '--dry-run']);
  assert.deepEqual(plan.assets.map(({ assetId }) => assetId), ['segment-001-camera_blocking']);
  assert.ok(plan.uploadCommands.some(command => command[0] === 'upload' && command.includes('character-input')));

  await mkdir(join(root, 'assets/segment-001'), { recursive: true });
  await writeFile(join(root, 'assets/segment-001/camera.png'), 'camera');
  const camera = (await addAndApprove(root, {
    id: 'camera', type: 'segment_asset', assetType: 'camera_blocking', segmentId: 'segment-001',
    revision: 1, status: 'draft', path: 'assets/segment-001/camera.png'
  })).artifact;
  const refreshed = compileAssetManifest({
    ...(await readJson(join(root, 'project-state.json'))), segments: [current],
    artifacts: [...(await readJson(join(root, 'project-state.json'))).artifacts, ...upstream]
  }, current);
  assert.equal(refreshed.items.find(({ type }) => type === 'camera_blocking').id, camera.id);
  assert.equal(refreshed.items.find(({ type }) => type === 'camera_blocking').status, 'locked');
});
