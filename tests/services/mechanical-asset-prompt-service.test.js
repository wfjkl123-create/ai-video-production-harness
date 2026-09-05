import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { autoLockArtifact } from '../../src/services/review-service.js';
import {
  mechanicalAssetPromptInternals,
  prepareMechanicalAssetPromptPackage,
  prepareMechanicalLibTvCanvas
} from '../../src/services/mechanical-asset-prompt-service.js';
import { readJson } from '../../src/storage/json-store.js';

const routeDecision = {
  policyVersion: 'ingress-route-v1',
  harnessRequired: true,
  reason: 'video_input_and_creation_intent',
  inputTypes: ['video', 'image'],
  sourceVideoIds: ['source-video-001'],
  assetInputIds: ['product-001'],
  referenceRoleStatus: 'authority',
  executionClass: 'mechanical_asset_prompt'
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mechanical-package-'));
  await initializeProject(root, { projectId: 'MECHANICAL-1', routeDecision });
  await mkdir(join(root, 'assets', 'project'), { recursive: true });
  await writeFile(join(root, 'brief', 'source.mp4'), 'source-video');
  await writeFile(join(root, 'assets', 'project', 'product.png'), 'product-image');
  await registerArtifact(root, {
    id: 'source-video-001', type: 'reference_video', revision: 1, status: 'draft', path: 'brief/source.mp4'
  });
  await autoLockArtifact(root, 'source-video-001', 'source input checksum verified');
  await registerArtifact(root, {
    id: 'product-001', type: 'project_asset', assetType: 'product_reference',
    mediaKind: 'image', revision: 1, status: 'draft', path: 'assets/project/product.png'
  });
  await autoLockArtifact(root, 'product-001', 'mechanical product input checksum verified', {
    delegatedByExecutionClass: 'mechanical_asset_prompt'
  });
  return root;
}

async function faceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'mechanical-face-package-'));
  const faceRoute = { ...routeDecision, assetInputIds: ['face-001'] };
  await initializeProject(root, { projectId: 'MECHANICAL-FACE-1', routeDecision: faceRoute });
  await mkdir(join(root, 'assets', 'project'), { recursive: true });
  await writeFile(join(root, 'brief', 'source.mp4'), 'source-video');
  await writeFile(join(root, 'assets', 'project', 'face.png'), 'face-image');
  await registerArtifact(root, {
    id: 'source-video-001', type: 'reference_video', revision: 1, status: 'draft', path: 'brief/source.mp4'
  });
  await autoLockArtifact(root, 'source-video-001', 'source input checksum verified');
  await registerArtifact(root, {
    id: 'face-001', type: 'project_asset', assetType: 'character_identity_single_view',
    characterId: 'replacement-face-subject', visualContractVersion: 1,
    mediaKind: 'image', revision: 1, status: 'draft', path: 'assets/project/face.png'
  });
  await autoLockArtifact(root, 'face-001', 'mechanical face input checksum verified', {
    delegatedByExecutionClass: 'mechanical_asset_prompt'
  });
  return root;
}

async function multiSourceFaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'mechanical-multi-face-package-'));
  const faceRoute = {
    ...routeDecision,
    sourceVideoIds: ['source-video-001', 'source-video-002'],
    assetInputIds: ['face-001']
  };
  await initializeProject(root, { projectId: 'MECHANICAL-MULTI-FACE-1', routeDecision: faceRoute });
  await mkdir(join(root, 'assets', 'project'), { recursive: true });
  await writeFile(join(root, 'brief', 'source-001.mp4'), 'source-video-001');
  await writeFile(join(root, 'brief', 'source-002.mp4'), 'source-video-002');
  await writeFile(join(root, 'assets', 'project', 'face.png'), 'face-image');
  for (const id of ['001', '002']) {
    await registerArtifact(root, {
      id: `source-video-${id}`, type: 'reference_video', revision: 1, status: 'draft', path: `brief/source-${id}.mp4`
    });
    await autoLockArtifact(root, `source-video-${id}`, 'source input checksum verified');
  }
  await registerArtifact(root, {
    id: 'face-001', type: 'project_asset', assetType: 'character_identity_single_view',
    characterId: 'replacement-face-subject', visualContractVersion: 1,
    mediaKind: 'image', revision: 1, status: 'draft', path: 'assets/project/face.png'
  });
  await autoLockArtifact(root, 'face-001', 'mechanical face input checksum verified', {
    delegatedByExecutionClass: 'mechanical_asset_prompt'
  });
  return root;
}

function localRunner(calls) {
  return async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === 'ffprobe' && args.includes('format=duration:stream=codec_type')) {
      const clip = await readFile(args.at(-1), 'utf8');
      const duration = Number(clip.split(':').at(-1));
      return { code: 0, stdout: JSON.stringify({ format: { duration }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), stderr: '' };
    }
    if (executable === 'ffprobe') return { code: 0, stdout: '190.8\n', stderr: '' };
    if (executable === 'ffmpeg') {
      await writeFile(args.at(-1), `clip:${args[args.indexOf('-ss') + 1]}:${args[args.indexOf('-t') + 1]}`);
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected executable ${executable}`);
  };
}

test('mechanical package deterministically creates 13 clips and media-bound prompts without generation', async () => {
  const root = await fixture();
  const calls = [];
  const result = await prepareMechanicalAssetPromptPackage(root, { runner: localRunner(calls) });
  assert.equal(result.reused, false);
  assert.equal(result.package.effectiveDurationSec, 190);
  assert.equal(result.package.segmentCount, 13);
  assert.deepEqual(result.package.segments.map(item => item.durationSec), [...Array(12).fill(15), 10]);
  assert.equal(result.package.assistantMaySubmitPaidGeneration, false);
  assert.equal(result.package.segments.every(item => item.generationSettings.enableSound === 'on'), true);
  assert.equal(result.package.segments.every(item => item.clip.hasAudio && item.clip.verifiedDurationSec === item.durationSec), true);
  assert.equal(calls.filter(item => item.executable === 'ffmpeg').length, 13);
  assert.equal(calls.filter(item => item.executable === 'ffprobe').length, 14);
  const executionPrompt = await readFile(join(root, result.package.segments[0].executionPrompt.path), 'utf8');
  assert.match(executionPrompt, /@视频1/);
  assert.match(executionPrompt, /@图1/);
  assert.doesNotMatch(executionPrompt, /@素材\[/);
  assert.match(executionPrompt, /只做一项修改/);
  const again = await prepareMechanicalAssetPromptPackage(root, { runner: localRunner([]) });
  assert.equal(again.reused, true);
});

test('mechanical windows cover the requested duration without sub-4-second fragments', () => {
  for (let total = 4; total <= 30; total += 1) {
    for (let segment = 4; segment <= 15; segment += 1) {
      const windows = mechanicalAssetPromptInternals.buildWindows(total, segment);
      assert.equal(windows[0].startSec, 0, `${total}/${segment} starts at zero`);
      assert.equal(windows.at(-1).endSec, total, `${total}/${segment} covers the end`);
      assert.equal(windows.every(item => item.durationSec >= 4 && item.durationSec <= 15), true, `${total}/${segment} durations are valid`);
      for (let index = 1; index < windows.length; index += 1) {
        assert.equal(windows[index - 1].endSec, windows[index].startSec, `${total}/${segment} has no gaps or overlaps`);
      }
    }
  }
});

test('mechanical face package uses the whole replacement identity and preserves a fractional scene-cut boundary', async () => {
  const root = await faceFixture();
  const result = await prepareMechanicalAssetPromptPackage(root, {
    maxDurationSec: 10.933,
    runner: localRunner([])
  });
  assert.equal(result.package.effectiveDurationSec, 10.933);
  assert.equal(result.package.segmentCount, 1);
  assert.equal(result.package.segments[0].durationSec, 10.933);
  assert.equal(result.package.segments[0].generationSettings.duration, 11);
  assert.equal(result.package.replacementAsset.assetType, 'character_identity_single_view');
  const executionPrompt = await readFile(join(root, result.package.segments[0].executionPrompt.path), 'utf8');
  assert.match(executionPrompt, /整张人脸身份/);
  assert.match(executionPrompt, /不得只参考眉眼/);
  assert.match(executionPrompt, /不是把两张脸融合/);
  assert.match(executionPrompt, /保留原片已有的字幕/);
});

test('mechanical face package can add an image-grounded text anchor without creating a second identity owner', async () => {
  const root = await faceFixture();
  const description = '脸部整体是偏窄的柔和鹅蛋脸，下颌线自然内收，眼睛是中等大小的杏仁眼。';
  const result = await prepareMechanicalAssetPromptPackage(root, {
    maxDurationSec: 9.833,
    faceIdentityDescription: description,
    runner: localRunner([])
  });
  assert.equal(result.package.faceIdentityDescription, description);
  assert.equal(result.package.faceIdentityDescriptionRole, 'image-grounded-readable-feature-anchor_not_an_independent_identity_source');
  assert.equal(result.package.promptMethod, 'seedance2-prompt/face_identity_replacement_with_text_anchor_v2');
  const executionPrompt = await readFile(join(root, result.package.segments[0].executionPrompt.path), 'utf8');
  assert.match(executionPrompt, /不是第二个身份来源/);
  assert.match(executionPrompt, /始终以 @图1 为准/);
  assert.match(executionPrompt, /柔和鹅蛋脸/);
});

test('mechanical face package preserves multiple presegmented sources and locked 480p vertical defaults', async () => {
  const root = await multiSourceFaceFixture();
  const calls = [];
  const runner = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    assert.equal(executable, 'ffprobe');
    const source = args.at(-1);
    const duration = source.endsWith('source-001.mp4') ? 10.5 : 12.5;
    if (args.includes('format=duration:stream=codec_type')) {
      return { code: 0, stdout: JSON.stringify({ format: { duration }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), stderr: '' };
    }
    return { code: 0, stdout: `${duration}\n`, stderr: '' };
  };
  const result = await prepareMechanicalAssetPromptPackage(root, { runner, sourceFaceIdentityScrubbed: true });
  assert.equal(result.package.segmentCount, 2);
  assert.equal(result.package.effectiveDurationSec, 23);
  assert.deepEqual(result.package.sourceVideos.map(item => item.id), ['source-video-001', 'source-video-002']);
  assert.deepEqual(result.package.segments.map(item => item.clip.id), ['source-video-001', 'source-video-002']);
  assert.equal(result.package.segments.every(item => item.generationSettings.model === 'Seedance 2.0 VIP'), true);
  assert.equal(result.package.segments.every(item => item.generationSettings.resolution === '480p'), true);
  assert.equal(result.package.segments.every(item => item.generationSettings.ratio === '9:16'), true);
  assert.equal(result.package.segments.every(item => item.generationSettings.enableSound === 'on'), true);
  assert.equal(calls.some(call => call.executable === 'ffmpeg'), false);
  const executionPrompt = await readFile(join(root, result.package.segments[0].executionPrompt.path), 'utf8');
  assert.match(executionPrompt, /只为清除旧人物身份而做的输入预处理/);
  assert.match(executionPrompt, /不得保留模糊、马赛克、空白脸/);
  assert.match(executionPrompt, /依据原有声音、粗略头姿和说话节奏重建自然同步的新人脸表演/);
  assert.match(executionPrompt, /嘴唇、面颊与下颌随发音自然联动/);
  assert.match(executionPrompt, /不复制已被模糊的旧五官轨迹/);
  assert.doesNotMatch(executionPrompt, /每 2 至 5 秒|任何一秒至少|全段不超过 1 至 2 次/);
  assert.match(executionPrompt, /允许人物在消化信息、压住反应或维持立场时短暂主动静止/);
});

function libTvRunner(calls) {
  const nodes = new Map();
  let sequence = 0;
  return async (executable, args) => {
    assert.equal(executable, 'libtv');
    calls.push([...args]);
    assert.equal(args.includes('--run'), false);
    if (args[0] === 'upload') {
      const name = args[1];
      const type = args[args.indexOf('-t') + 1];
      const value = { nodeKey: `upload-${++sequence}`, data: { name, type } };
      nodes.set(name, value); nodes.set(value.nodeKey, value);
      return { code: 0, stdout: JSON.stringify(value), stderr: '' };
    }
    if (args[0] === 'node' && args[1] === 'create') {
      const name = args[2];
      const prompt = args[args.indexOf('--prompt') + 1];
      const settings = Object.fromEntries(args.filter(item => item.includes('=')).map(item => item.split(/=(.*)/s).slice(0, 2)));
      const leftKeys = args.flatMap((item, index) => item === '--left' ? [args[index + 1]] : []);
      const value = {
        nodeKey: `video-${++sequence}`, name,
        data: { params: {
          prompt, model: settings.model, modeType: settings.modeType, count: Number(settings.count),
          settings: {
            ratio: settings.ratio, resolution: settings.resolution, duration: Number(settings.duration),
            enableSound: settings.enableSound, search_enabled: Number(settings.search_enabled)
          },
          mixedList: leftKeys.map((nodeId, index) => ({ nodeId, label: `input-${index + 1}`, mediaType: index === 0 ? 'video' : 'image' }))
        } }
      };
      nodes.set(name, value); nodes.set(value.nodeKey, value);
      return { code: 0, stdout: JSON.stringify(value), stderr: '' };
    }
    if (args[0] === 'node') {
      const value = nodes.get(args[1]);
      return value
        ? { code: 0, stdout: JSON.stringify(value), stderr: '' }
        : { code: 1, stdout: '', stderr: 'node not found' };
    }
    throw new Error(`unexpected LibTV args: ${args.join(' ')}`);
  };
}

test('LibTV preparation uploads, binds and reads back every segment but never runs generation', async () => {
  const root = await fixture();
  await prepareMechanicalAssetPromptPackage(root, { runner: localRunner([]) });
  const calls = [];
  const projectUuid = 'a'.repeat(32);
  const result = await prepareMechanicalLibTvCanvas(root, { projectUuid, runner: libTvRunner(calls) });
  assert.equal(result.status, 'READY_FOR_USER_CANVAS_GENERATION');
  assert.equal(result.nodes.length, 13);
  assert.equal(result.paidGenerationTriggered, false);
  assert.equal(result.assistantMaySubmitPaidGeneration, false);
  assert.equal(calls.filter(args => args[0] === 'node' && args[1] === 'create').length, 13);
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.mechanicalCanvas.packageArtifactId, result.packageArtifactId);
  const callCount = calls.length;
  const reused = await prepareMechanicalLibTvCanvas(root, { projectUuid, runner: libTvRunner(calls) });
  assert.equal(reused.reused, true);
  assert.ok(calls.length > callCount, 'cached local state must still be verified against live LibTV nodes');
});

test('LibTV preparation rejects stale product bindings and disabled sound on readback', async () => {
  for (const mutate of [
    params => { params.mixedList[1].nodeId = 'stale-product-node'; },
    params => { params.settings.enableSound = 'off'; },
    params => { params.mixedList.push({ ...params.mixedList[0] }); }
  ]) {
    const root = await fixture();
    await prepareMechanicalAssetPromptPackage(root, { runner: localRunner([]) });
    const baseRunner = libTvRunner([]);
    const runner = async (command, args) => {
      const result = await baseRunner(command, args);
      if (result.code === 0 && args[0] === 'node' && args[1] !== 'create') {
        const value = JSON.parse(result.stdout);
        if (value?.data?.params?.prompt) {
          mutate(value.data.params);
          return { ...result, stdout: JSON.stringify(value) };
        }
      }
      return result;
    };
    await assert.rejects(
      prepareMechanicalLibTvCanvas(root, { projectUuid: 'e'.repeat(32), runner }),
      /LibTV readback mismatch/
    );
  }
});

test('LibTV preparation stops immediately on authentication or project access failure', async () => {
  const root = await fixture();
  await prepareMechanicalAssetPromptPackage(root, { runner: localRunner([]) });
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    return { code: 1, stdout: '', stderr: '401 unauthorized for project' };
  };
  await assert.rejects(
    prepareMechanicalLibTvCanvas(root, { projectUuid: 'd'.repeat(32), runner }),
    /authentication or project access failed/
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['libtv', 'node']);
});
