import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertLibTvUploadMediaContract, buildLibTvVideoPlan, executeLibTvVideo, prepareLibTvVideoCanvas, resumeLibTvVideoDownload } from '../../src/services/libtv-video-generation-service.js';
import { runReconcileLibTvRun } from '../../src/commands/reconcile-libtv-run.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { initializeProject } from '../../src/services/project-service.js';
import { readExecutionEvents } from '../../src/services/execution-ledger-service.js';

const projectUuid = 'a'.repeat(32);
const nodeName = 'segment-001-seedance-video';
const libtvFingerprint = (sha256 = 'a'.repeat(64)) => ({
  sha256,
  generationContract: {
    provider: 'libtv', transport: 'official_cli', projectUuid, nodeName,
    model: 'Seedance 2.0 VIP', modeType: 'mixed2video',
    request: { duration: 10, ratio: '9:16', resolution: '720p', enableSound: true, count: 1, searchEnabled: 0 }
  }
});

test('blocks Seedance 2.0 reference items at or below 1.8s and combined video/audio above 15s', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-duration-contract-'));
  const audio = join(root, 'audio.wav');
  const video = join(root, 'video.mp4');
  await writeFile(audio, 'audio');
  await writeFile(video, 'video');
  const probe = durations => async (_command, args) => ({
    code: 0,
    stdout: JSON.stringify({ format: { duration: durations[args.at(-1)] } }),
    stderr: ''
  });
  await assert.rejects(
    assertLibTvUploadMediaContract(
      [{ name: 'too-short', type: 'audio', path: audio }],
      { root, probeRunner: probe({ [audio]: 1.8 }) }
    ),
    /严格大于 1\.8s/
  );
  await assert.rejects(
    assertLibTvUploadMediaContract(
      [{ name: 'video', type: 'video', path: video }, { name: 'audio', type: 'audio', path: audio }],
      { root, probeRunner: probe({ [video]: 10, [audio]: 5.01 }) }
    ),
    /总时长 15\.010s.*上限 15s/
  );
  await assert.doesNotReject(
    assertLibTvUploadMediaContract(
      [{ name: 'valid-audio', type: 'audio', path: audio }],
      { root, probeRunner: probe({ [audio]: 2.000045 }) }
    )
  );
});

test('builds official CLI create-without-run then exactly one separate Seedance run', async () => {
  const root = '/safe/project';
  const inspect = async () => ({
    fingerprint: libtvFingerprint(),
    input: {
      prompt: '@图1 controls identity. @视频1 controls motion. three middle-aged adults talk naturally', duration: 10, ratio: '9:16', resolution: '720p',
      imageInputs: ['/safe/project/assets/a.png'], videoInputs: ['/safe/project/assets/motion.mp4'], audioInputs: []
    }
  });
  const plan = await buildLibTvVideoPlan(root, 'segment-001', {
    projectUuid: 'a'.repeat(32), outputRoot: '/safe/project/outputs/run-1', inspect
  });
  assert.equal(plan.model, 'Seedance 2.0 VIP');
  assert.equal(plan.fingerprint.generationContract.provider, 'libtv');
  assert.equal(plan.fingerprint.generationContract.projectUuid, projectUuid);
  assert.equal(plan.modeType, 'mixed2video');
  assert.equal(plan.createCommand.includes('--run'), false);
  assert.deepEqual(plan.runCommand, ['node', '-p', 'a'.repeat(32), 'segment-001-seedance-video', '--run']);
  assert.equal(plan.uploadCommands.length, 2);
  assert.equal(plan.createCommand.filter(value => value === '--left').length, 2);
  assert.match(plan.canvasPrompt, /\{\{Node "segment-001-image-01"\}\}/);
  assert.match(plan.canvasPrompt, /\{\{Node "segment-001-video-01"\}\}/);
  assert.doesNotMatch(plan.canvasPrompt, /@图1|@视频1/);
  assert.equal(plan.promptBindingMode, 'libtv_node_placeholders');
  assert.equal(plan.createCommand[plan.createCommand.indexOf('enableSound=on')], 'enableSound=on');
  await assert.rejects(buildLibTvVideoPlan(root, 'segment 1', { projectUuid: 'a'.repeat(32) }), /safe identifiers/);
  await assert.rejects(buildLibTvVideoPlan(root, 'segment-001', { projectUuid: 'not-a-uuid' }), /32 lowercase/);
});

test('writes and later reads back an explicit disabled-sound node plan', async () => {
  const fingerprint = libtvFingerprint('f'.repeat(64));
  fingerprint.generationContract.request.enableSound = false;
  const plan = await buildLibTvVideoPlan('/safe/project', 'segment-001', {
    projectUuid,
    inspect: async () => ({
      fingerprint,
      input: {
        prompt: 'silent visual continuity test', duration: 10, ratio: '9:16', resolution: '720p', generateAudio: false,
        imageInputs: [], videoInputs: [], audioInputs: []
      }
    })
  });
  assert.ok(plan.createCommand.includes('enableSound=off'));
  assert.equal(plan.createCommand.includes('enableSound=on'), false);
});

test('uses current Seedance 2.5 videoEdit2video auto settings and never binds runtime audio', async () => {
  const fingerprint = {
    sha256: 'e'.repeat(64),
    generationContract: {
      provider: 'libtv', transport: 'official_cli', projectUuid, nodeName: 'direct-edit-001',
      model: 'Seedance 2.5', modeType: 'videoEdit2video',
      request: { ratio_auto: 'adaptive', duration_auto: 0, resolution: '1080p', enableSound: true, count: 1, searchEnabled: 0, autoCompliance: true }
    }
  };
  const plan = await buildLibTvVideoPlan('/safe/project', 'direct-edit-001', {
    projectUuid,
    nodeName: 'direct-edit-001',
    model: 'Seedance 2.5',
    inspect: async () => ({
      fingerprint,
      input: {
        prompt: '@图1 identity. @图2 product. @图3 card. @视频1 source pixels.',
        duration: 15, ratio: 'adaptive', resolution: '1080p', generateAudio: true,
        imageInputs: ['/safe/project/face.png', '/safe/project/product.png', '/safe/project/card.png'],
        videoInputs: ['/safe/project/source.mp4'], audioInputs: []
      }
    })
  });
  assert.equal(plan.modeType, 'videoEdit2video');
  assert.equal(plan.mediaUploads.filter(item => item.type === 'video').length, 1);
  assert.equal(plan.mediaUploads.filter(item => item.type === 'audio').length, 0);
  assert.ok(plan.createCommand.includes('ratio_auto=adaptive'));
  assert.ok(plan.createCommand.includes('duration_auto=0'));
  assert.equal(plan.createCommand.includes('ratio=adaptive'), false);
  assert.equal(plan.createCommand.includes('duration=15'), false);
  assert.ok(plan.createCommand.includes('enableSound=on'));
  assert.equal(plan.createCommand.includes('--run'), false);
});

test('a reviewed multi-shot contract is written into the actual LibTV node settings', async () => {
  const fingerprint = libtvFingerprint();
  fingerprint.generationContract.request.multi_shots = true;
  fingerprint.executionControlContract = {
    version: 1, plannedShotCount: 12, generatedUnitShotCount: 12,
    executionUnitStrategy: 'platform_multi_shot', requiresIndependentShotControl: true,
    platformCapability: {
      surface: 'LibTV Seedance node', profileId: 'seedance-2-libtv-v1', parameter: 'multi_shots',
      exposed: true, enabled: true, evidence: 'planned exact node readback',
      verificationMode: 'libtv_canvas_node_readback'
    }
  };
  const plan = await buildLibTvVideoPlan('/safe/project', 'segment-001', {
    projectUuid,
    inspect: async () => ({
      fingerprint,
      input: { prompt: 'twelve controlled shots', duration: 10, ratio: '9:16', resolution: '720p', imageInputs: [], videoInputs: [], audioInputs: [] }
    })
  });
  assert.equal(plan.createCommand.includes('multi_shots=on'), true);
});

test('names live-run source nodes uniquely when a source namespace is supplied', async () => {
  const root = '/safe/project';
  const inspect = async () => ({
    fingerprint: libtvFingerprint(),
    input: {
      prompt: '@图1 controls identity. @视频1 controls motion.', duration: 10, ratio: '9:16', resolution: '720p',
      imageInputs: ['/safe/project/assets/a.png'], videoInputs: ['/safe/project/assets/motion.mp4'], audioInputs: []
    }
  });
  const plan = await buildLibTvVideoPlan(root, 'segment-001', {
    projectUuid, sourceNamespace: 'libtv-video-run-1', inspect
  });
  assert.equal(plan.sourceNamespace, 'libtv-video-run-1');
  assert.match(plan.canvasPrompt, /\{\{Node "segment-001-image-01-libtv-video-run-1"\}\}/);
  assert.match(plan.canvasPrompt, /\{\{Node "segment-001-video-01-libtv-video-run-1"\}\}/);
  assert.equal(plan.createCommand.filter(value => value === 'segment-001-image-01-libtv-video-run-1').length, 1);
  assert.equal(plan.createCommand.filter(value => value === 'segment-001-video-01-libtv-video-run-1').length, 1);
});

test('uses compact traceable canvas aliases for a full Seedance 2.0 9/1/1 input set', async () => {
  const imageInputs = Array.from({ length: 9 }, (_, index) => `/safe/project/assets/i${index + 1}.png`);
  const tags = [
    ...Array.from({ length: 9 }, (_, index) => `@图${index + 1}`),
    '@视频1', '@音频1'
  ];
  const inspect = async () => ({
    fingerprint: libtvFingerprint('b'.repeat(64)),
    input: {
      prompt: `${'约束'.repeat(4500)}${tags.join(' ')}`,
      duration: 10, ratio: '9:16', resolution: '720p', generateAudio: true,
      imageInputs, videoInputs: ['/safe/project/assets/depth.mp4'], audioInputs: ['/safe/project/assets/timing.wav']
    }
  });
  const plan = await buildLibTvVideoPlan('/safe/project', 'segment-001', {
    projectUuid, sourceNamespace: 'canvas-bbbbbbbbbbbb', inspect
  });
  for (let index = 1; index <= 9; index += 1) {
    assert.match(plan.canvasPrompt, new RegExp(`\\{\\{Node "i${index}-bbbbbbbbbb"\\}\\}`));
  }
  assert.match(plan.canvasPrompt, /\{\{Node "v1-bbbbbbbbbb"\}\}/);
  assert.match(plan.canvasPrompt, /\{\{Node "a1-bbbbbbbbbb"\}\}/);
  assert.doesNotMatch(plan.canvasPrompt, /@图|@视频|@音频/);
  assert.ok([...plan.canvasPrompt].length < 10000);
  assert.equal(plan.createCommand.includes('--run'), false);
});

async function liveFixture() {
  const root = await mkdtemp(join(tmpdir(), 'libtv-video-'));
  await initializeProject(root, { projectId: 'p1' });
  const digest = 'a'.repeat(64);
  await writeJsonAtomic(join(root, 'reviews', 'batch-1.json'), {
    id: 'batch-1', kind: 'batch_generation_approval', actor: 'human', decision: 'approved', projectId: 'p1', executor: 'libtv', libtvProjectUuid: 'a'.repeat(32), externalAuditModel: 'claude-ocx-anthropic--claude-opus-4-8',
    segments: [{ segmentId: 'segment-001', strategy: 'editorial_cut', maxPaidAttempts: 1 }],
    budget: { unit: 'tasks', limit: 1 }, externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.8 },
    maxPaidSubmissions: 1, stopVetoes: ['blur'], approvedAt: '2026-07-26T00:00:00Z'
  });
  await writeJsonAtomic(join(root, 'reviews', 'audit-1.json'), {
    id: 'audit-1', kind: 'external_audit_attestation', segmentId: 'segment-001', auditStage: 'pre_generation',
    provider: 'anthropic', model: 'claude-ocx-anthropic--claude-opus-4-8', providerTaskId: 'session-1', auditRunId: 'audit-run-1',
    cleanZeroContext: true, decision: 'PASS', fingerprintSha256: digest, reportSha256: 'b'.repeat(64), reviewedAt: '2026-07-26T00:01:00Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'audit-run-1.json'), {
    id: 'audit-run-1', kind: 'external_model_audit', status: 'SUCCESS', attestationId: 'audit-1', sessionId: 'session-1',
    model: 'claude-ocx-anthropic--claude-opus-4-8', segmentId: 'segment-001', auditStage: 'pre_generation', fingerprintSha256: digest
  });
  await writeJsonAtomic(join(root, 'reviews', 'paid-1.json'), {
    id: 'paid-1', kind: 'paid_generation_approval', actor: 'delegated_batch_policy', decision: 'approved', segmentId: 'segment-001',
    fingerprint: libtvFingerprint(digest), parentBatchApprovalId: 'batch-1', externalAuditAttestationId: 'audit-1', executor: 'libtv', libtvProjectUuid: projectUuid,
    consumedByRunId: null, consumedAt: null
  });
  const inspect = async () => ({
    fingerprint: libtvFingerprint(digest),
    input: { prompt: 'natural dialogue', duration: 10, ratio: '9:16', resolution: '720p', imageInputs: [], videoInputs: [], audioInputs: [] }
  });
  return { root, inspect };
}

test('rejects a RunningHub fingerprint before any LibTV command can be built', async () => {
  let called = false;
  await assert.rejects(buildLibTvVideoPlan('/safe/project', 'segment-001', {
    projectUuid,
    inspect: async () => ({
      fingerprint: { sha256: 'a'.repeat(64), generationContract: { provider: 'runninghub' } },
      input: { prompt: 'x', duration: 10, ratio: '9:16', resolution: '720p', imageInputs: [], videoInputs: [], audioInputs: [] }
    })
  }).then(value => { called = true; return value; }), /LibTV official-CLI/);
  assert.equal(called, false);
});

test('prepares a real LibTV canvas node with true media placeholders and never runs generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-canvas-prep-'));
  await mkdir(join(root, 'runs'), { recursive: true });
  await writeFile(join(root, 'a.png'), 'png-bytes');
  await writeFile(join(root, 'a.wav'), 'wav-bytes');
  const inspect = async () => ({
    fingerprint: libtvFingerprint(),
    input: {
      prompt: '@图1 controls identity. @音频1 controls ambience.', duration: 10, ratio: '9:16', resolution: '720p', generateAudio: true,
      imageInputs: [join(root, 'a.png')], videoInputs: [], audioInputs: [join(root, 'a.wav')]
    }
  });
  const calls = [];
  const runner = async (_exe, args) => {
    calls.push(args);
    if (args[0] === 'node' && args.includes('create')) return { code: 0, stdout: '{"nodeKey":"prepared-node-1"}', stderr: '' };
    if (args[0] === 'node' && args.includes('-p') && args[1] === 'prepared-node-1') {
      return {
        code: 0,
        stdout: JSON.stringify({
          nodeKey: 'prepared-node-1',
          data: {
            type: 'video',
            params: {
              prompt: '{{Node node-i1}} controls identity. {{Node node-a1}} controls ambience.',
              model: 'Seedance 2.0 VIP', modeType: 'mixed2video', count: 1,
              settings: { ratio: '9:16', duration: 10, resolution: '720p', enableSound: 'on' },
              mixedList: [
                { nodeId: 'node-i1', label: 'i1-aaaaaaaaaa', mediaType: 'image' },
                { nodeId: 'node-a1', label: 'a1-aaaaaaaaaa', mediaType: 'audio' }
              ]
            }
          }
        }),
        stderr: ''
      };
    }
    return { code: 0, stdout: '{"nodeKey":"asset-node"}', stderr: '' };
  };
  const probeRunner = async () => ({ code: 0, stdout: '{"format":{"duration":"12.0"}}', stderr: '' });
  const result = await prepareLibTvVideoCanvas(root, {
    segmentId: 'segment-001', projectUuid, nodeName, model: 'Seedance 2.0 VIP'
  }, { inspect, runner, probeRunner, runId: 'canvas-prep-1' });
  assert.equal(result.run.status, 'READY_FOR_USER_CANVAS_GENERATION');
  assert.equal(result.run.nodeKey, 'prepared-node-1');
  assert.equal(result.paidGenerationTriggered, false);
  assert.equal(result.run.verification.diffs.length, 0);
  assert.equal(result.run.verification.snapshot.model, 'Seedance 2.0 VIP');
  assert.equal(result.run.verification.snapshot.mixedList.length, 2);
  assert.equal(calls.some(args => args.includes('--run')), false);
  const create = calls.find(args => args[0] === 'node' && args.includes('create'));
  const prompt = create[create.indexOf('--prompt') + 1];
  assert.match(prompt, /\{\{Node "i1-aaaaaaaaaa"\}\}/);
  assert.match(prompt, /\{\{Node "a1-aaaaaaaaaa"\}\}/);
  assert.doesNotMatch(prompt, /@图1|@音频1/);
});

test('accepts LibTV imageList readback when the platform omits image labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-image-list-readback-'));
  await mkdir(join(root, 'runs'), { recursive: true });
  await writeFile(join(root, 'a.png'), 'png-bytes');
  await writeFile(join(root, 'motion.mp4'), 'video-bytes');
  await writeFile(join(root, 'timing.wav'), 'wav-bytes');
  const inspect = async () => ({
    fingerprint: libtvFingerprint(),
    input: {
      prompt: '@图1 identity. @视频1 timing. @音频1 sound.', duration: 10, ratio: '9:16', resolution: '720p', generateAudio: true,
      imageInputs: [join(root, 'a.png')], videoInputs: [join(root, 'motion.mp4')], audioInputs: [join(root, 'timing.wav')]
    }
  });
  const resource = {
    'i1-aaaaaaaaaa': ['node-image', 'image'],
    'v1-aaaaaaaaaa': ['node-video', 'video'],
    'a1-aaaaaaaaaa': ['node-audio', 'audio']
  };
  const runner = async (_exe, args) => {
    if (args[0] === 'node' && args.includes('create')) return { code: 0, stdout: '{"nodeKey":"prepared-node-image-list"}', stderr: '' };
    if (args[0] === 'node' && args[1] === 'prepared-node-image-list') return {
      code: 0,
      stdout: JSON.stringify({ nodeKey: 'prepared-node-image-list', data: { type: 'video', params: {
        prompt: '{{Node node-image}} identity. {{Node node-video}} timing. {{Node node-audio}} sound.',
        model: 'Seedance 2.0 VIP', modeType: 'mixed2video', count: 1,
        settings: { ratio: '9:16', duration: 10, resolution: '720p', enableSound: 'on' },
        imageList: [{ nodeId: 'node-image' }], videoList: [{ nodeId: 'node-video' }], audioList: [{ nodeId: 'node-audio' }]
      } } }), stderr: ''
    };
    if (args[0] === 'node' && resource[args[1]]) {
      const [nodeKey, type] = resource[args[1]];
      return { code: 0, stdout: JSON.stringify({ nodeKey, data: { name: args[1], type } }), stderr: '' };
    }
    return { code: 0, stdout: '{"nodeKey":"uploaded"}', stderr: '' };
  };
  const probeRunner = async () => ({ code: 0, stdout: '{"format":{"duration":"7.0"}}', stderr: '' });
  const result = await prepareLibTvVideoCanvas(root, { segmentId: 'segment-001', projectUuid, nodeName, model: 'Seedance 2.0 VIP' }, { inspect, runner, probeRunner, runId: 'canvas-prep-image-list' });
  assert.equal(result.run.status, 'READY_FOR_USER_CANVAS_GENERATION');
  assert.deepEqual(result.run.verification.snapshot.mixedList.map(item => item.label), ['i1-aaaaaaaaaa', 'v1-aaaaaaaaaa', 'a1-aaaaaaaaaa']);
});

test('rejects an m4a audio upload before any LibTV upload command runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-canvas-prep-m4a-'));
  await mkdir(join(root, 'runs'), { recursive: true });
  await writeFile(join(root, 'a.png'), 'png-bytes');
  await writeFile(join(root, 'a.m4a'), 'm4a-bytes');
  const inspect = async () => ({
    fingerprint: libtvFingerprint(),
    input: {
      prompt: '@图1 controls identity. @音频1 controls ambience.', duration: 10, ratio: '9:16', resolution: '720p', generateAudio: true,
      imageInputs: [join(root, 'a.png')], videoInputs: [], audioInputs: [join(root, 'a.m4a')]
    }
  });
  const calls = [];
  const runner = async (_exe, args) => { calls.push(args); return { code: 0, stdout: '{}', stderr: '' }; };
  await assert.rejects(prepareLibTvVideoCanvas(root, {
    segmentId: 'segment-001', projectUuid, nodeName, model: 'Seedance 2.0 VIP'
  }, { inspect, runner, runId: 'canvas-prep-m4a' }), /上传素材预检未通过.*m4a/);
  assert.equal(calls.length, 0);
  const run = await readJson(join(root, 'runs', 'canvas-prep-m4a.json'));
  assert.equal(run.status, 'CANVAS_PREPARATION_FAILED');
  assert.ok(run.uploadContractViolations[0].includes('m4a'));
});

test('fails canvas preparation when the node read-back differs from the plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-canvas-prep-drift-'));
  await mkdir(join(root, 'runs'), { recursive: true });
  const inspect = async () => ({
    fingerprint: libtvFingerprint(),
    input: {
      prompt: 'natural dialogue, no media', duration: 10, ratio: '9:16', resolution: '720p', generateAudio: true,
      imageInputs: [], videoInputs: [], audioInputs: []
    }
  });
  const runner = async (_exe, args) => {
    if (args[0] === 'node' && args.includes('create')) return { code: 0, stdout: '{"nodeKey":"prepared-node-1"}', stderr: '' };
    if (args[0] === 'node' && args.includes('-p')) {
      return {
        code: 0,
        stdout: JSON.stringify({
          nodeKey: 'prepared-node-1',
          data: {
            type: 'video',
            params: {
              prompt: 'natural dialogue, no media',
              // 模拟实测事故：写入 --prompt 后 model 被重置、resolution 掉回 480p。
              model: 'Seedance 2.0', modeType: 'text2video', count: 1,
              settings: { ratio: '9:16', duration: 10, resolution: '480p', enableSound: 'on' },
              mixedList: []
            }
          }
        }),
        stderr: ''
      };
    }
    return { code: 0, stdout: '{}', stderr: '' };
  };
  await assert.rejects(prepareLibTvVideoCanvas(root, {
    segmentId: 'segment-001', projectUuid, nodeName, model: 'Seedance 2.0 VIP'
  }, { inspect, runner, runId: 'canvas-prep-drift' }), /写后读回校验失败/);
  const run = await readJson(join(root, 'runs', 'canvas-prep-drift.json'));
  assert.equal(run.status, 'CANVAS_PREPARATION_FAILED');
  assert.ok(run.verificationDiffs.some(diff => diff.includes('model')));
  assert.ok(run.verificationDiffs.some(diff => diff.includes('resolution')));
});

test('claims one LibTV paid run, invokes node run exactly once, and saves downloaded SHA evidence', async () => {
  const { root, inspect } = await liveFixture();
  const calls = [];
  const runner = async (_exe, args) => {
    calls.push(args);
    if (args[0] === 'node' && args.includes('create')) return { code: 0, stdout: '{"nodeKey":"node-1"}', stderr: '' };
    if (args[0] === 'node' && args.includes('-p') && args.at(-1) !== '--run') {
      return {
        code: 0,
        stdout: JSON.stringify({
          nodeKey: 'node-1',
          data: {
            type: 'video',
            params: {
              prompt: 'natural dialogue',
              model: 'Seedance 2.0 VIP', modeType: 'text2video', count: 1,
              settings: { ratio: '9:16', duration: 10, resolution: '720p', enableSound: 'on' },
              mixedList: []
            }
          }
        }),
        stderr: ''
      };
    }
    if (args[0] === 'node' && args.at(-1) === '--run') return { code: 0, stdout: '{"nodeKey":"node-1","taskId":"task-1","status":2}', stderr: '' };
    if (args[0] === 'download') {
      const out = args[args.indexOf('--out') + 1]; await mkdir(out, { recursive: true }); await writeFile(join(out, 'result.mp4'), 'video-bytes');
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    }
    return { code: 0, stdout: '{"ok":true}', stderr: '' };
  };
  const result = await executeLibTvVideo(root, {
    segmentId: 'segment-001', projectUuid: 'a'.repeat(32), paidApprovalId: 'paid-1'
  }, { inspect, runner, runId: 'libtv-video-1' });
  assert.equal(result.run.status, 'SUCCESS');
  assert.equal(result.run.taskId, 'task-1');
  assert.equal(result.run.outputs[0].sha256.length, 64);
  assert.equal(calls.filter(args => args[0] === 'node' && args.at(-1) === '--run').length, 1);
  const uploads = calls.filter(args => args[0] === 'upload');
  assert.ok(uploads.every(args => args[1].endsWith('-libtv-video-1')));
  assert.equal((await readJson(join(root, 'reviews', 'paid-1.json'))).consumedByRunId, 'libtv-video-1');
  assert.deepEqual((await readExecutionEvents(root)).map(event => event.type), [
    'ledger.bootstrap', 'generation.claimed', 'generation.submitted', 'generation.succeeded'
  ]);
});

test('does not rerun video when download fails after confirmed generation', async () => {
  const { root, inspect } = await liveFixture();
  const runner = async (_exe, args) => {
    if (args[0] === 'node' && args.includes('create')) return { code: 0, stdout: '{"nodeKey":"node-1"}', stderr: '' };
    if (args[0] === 'node' && args.includes('-p') && args.at(-1) !== '--run') {
      return {
        code: 0,
        stdout: JSON.stringify({
          nodeKey: 'node-1',
          data: {
            type: 'video',
            params: {
              prompt: 'natural dialogue',
              model: 'Seedance 2.0 VIP', modeType: 'text2video', count: 1,
              settings: { ratio: '9:16', duration: 10, resolution: '720p', enableSound: 'on' },
              mixedList: []
            }
          }
        }),
        stderr: ''
      };
    }
    if (args[0] === 'node' && args.at(-1) === '--run') return { code: 0, stdout: '{"taskId":"task-1","status":2}', stderr: '' };
    return { code: 7, stdout: '', stderr: 'secret remote error' };
  };
  await assert.rejects(executeLibTvVideo(root, {
    segmentId: 'segment-001', projectUuid: 'a'.repeat(32), paidApprovalId: 'paid-1'
  }, { inspect, runner, runId: 'libtv-video-1' }), /exit code 7/);
  const run = await readJson(join(root, 'runs', 'libtv-video-1.json'));
  assert.equal(run.status, 'INTERRUPTED_DOWNLOAD');
  assert.equal(run.taskId, 'task-1');
  assert.doesNotMatch(JSON.stringify(run), /secret remote error/);
  const events = await readExecutionEvents(root);
  assert.deepEqual(events.map(event => event.type), [
    'ledger.bootstrap', 'generation.claimed', 'generation.submitted', 'generation.interrupted'
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secret remote error/);
});

test('resumes only the download and never invokes the paid video node again', async () => {
  const { root } = await liveFixture();
  await writeJsonAtomic(join(root, 'runs', 'libtv-video-1.json'), {
    id: 'libtv-video-1', kind: 'libtv_video', status: 'INTERRUPTED_DOWNLOAD', segmentId: 'segment-001',
    paidApprovalId: 'paid-1', fingerprint: libtvFingerprint(),
    projectUuid: 'a'.repeat(32), nodeName: 'segment-001-seedance-video', nodeKey: 'node-1', taskId: 'task-1', commands: [], outputs: []
  });
  const calls = [];
  const runner = async (_exe, args) => {
    calls.push(args);
    const out = args[args.indexOf('--out') + 1]; await mkdir(out, { recursive: true }); await writeFile(join(out, 'result.mp4'), 'video-bytes');
    return { code: 0, stdout: '{"ok":true}', stderr: '' };
  };
  const completed = await resumeLibTvVideoDownload(root, 'libtv-video-1', { runner });
  assert.equal(completed.status, 'SUCCESS');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'download');
  assert.equal(calls[0].includes('--run'), false);
  assert.deepEqual((await readExecutionEvents(root)).map(event => event.type), [
    'ledger.bootstrap', 'generation.succeeded'
  ]);
});

test('reconciles a created video node with no task without restoring the paid approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-video-reconcile-'));
  await mkdir(join(root, 'reviews'), { recursive: true });
  await mkdir(join(root, 'runs'), { recursive: true });
  await writeJsonAtomic(join(root, 'reviews', 'paid-1.json'), {
    id: 'paid-1', kind: 'paid_generation_approval', maxPaidAttempts: 1,
    consumedByRunId: 'libtv-video-1', consumedAt: '2026-07-28T00:00:00Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'libtv-video-1.json'), {
    id: 'libtv-video-1', kind: 'libtv_video', status: 'UNCERTAIN', segmentId: 'segment-001',
    paidApprovalId: 'paid-1', projectUuid, nodeName, nodeKey: '11111111-2222-4333-8444-555555555555',
    taskId: null, outputs: [], commands: [
      { executable: 'libtv', args: ['node', '-p', projectUuid, 'create', nodeName], exitCode: 0 },
      { executable: 'libtv', args: ['node', '-p', projectUuid, nodeName, '--run'], exitCode: 1 }
    ]
  });
  await writeJsonAtomic(join(root, 'runs', 'libtv-video-owner.json'), {
    status: 'UNCERTAIN', runId: 'libtv-video-1'
  });
  await writeFile(join(root, 'reviews', 'evidence.png'), 'human canvas screenshot');
  const args = [
    '--project', root, '--run', 'libtv-video-1', '--confirmed-node-created-no-task',
    '--node-key', '11111111-2222-4333-8444-555555555555', '--evidence', 'reviews/evidence.png',
    '--note', 'human and CLI confirmed no task or output'
  ];
  const result = await runReconcileLibTvRun(args);
  assert.equal(result.status, 'RECONCILED_NOT_SUBMITTED');
  assert.equal(result.reconciliation.paidApprovalRestored, false);
  assert.equal(result.reconciliation.automaticRetryAllowed, false);
  assert.equal(result.reconciliation.evidencePath, 'reviews/evidence.png');
  assert.equal(result.reconciliation.evidenceSha256.length, 64);
  assert.equal((await readJson(join(root, 'runs', 'libtv-video-owner.json'))).status, 'RELEASED');
  assert.equal((await readJson(join(root, 'reviews', 'paid-1.json'))).consumedByRunId, 'libtv-video-1');
  await assert.rejects(runReconcileLibTvRun(args), /only an UNCERTAIN/);
});
