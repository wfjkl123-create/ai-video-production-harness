import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { runProcess } from '../adapters/process-runner.js';
import { assertBatchGenerationApproval } from '../domain/batch-generation.js';
import { assertExternalAuditAttestation } from '../domain/external-audit-attestation.js';
import { checkSceneAuthority } from './scene-authority-check.js';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { inspectVideoPackage } from './video-generation-service.js';
import { verifyGptFallbackApprovalBindings } from './gpt-fallback-generation-service.js';
import { assertGenerationFailureGate } from './generation-failure-service.js';
import { auditProjectReadiness } from './project-readiness-audit-service.js';
import { requireExecutionControlEvidence } from './execution-control-evidence-service.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';

const PROJECT_UUID = /^[a-f0-9]{32}$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function projectArgs(projectUuid) {
  if (!PROJECT_UUID.test(projectUuid ?? '')) throw new Error('LibTV project UUID must be 32 lowercase hexadecimal characters');
  return ['-p', projectUuid];
}

function sourceName(segmentId, kind, index, namespace) {
  if (namespace?.startsWith('canvas-')) {
    const code = { image: 'i', video: 'v', audio: 'a' }[kind] ?? kind.slice(0, 1);
    return `${code}${index + 1}-${namespace.slice('canvas-'.length, 'canvas-'.length + 10)}`;
  }
  const base = `${segmentId}-${kind}-${String(index + 1).padStart(2, '0')}`;
  return namespace ? `${base}-${namespace}` : base;
}

const MEDIA_TAG = Object.freeze({ image: '图', video: '视频', audio: '音频' });

// LibTV 音频素材合规合同。证据来源：2026-08-24 OEING 前 12 秒复刻实测——m4a
// 音频上传后被画布合规审核拒绝（审核不通过），重导出为 mp3 后通过；Seedance 2.0
// 全能参考官方合同要求音频仅 mp3/wav、参考视频与音频合计 ≤15 秒、每个视频/音频
// 单段必须严格大于 1.8 秒，音频体积 ≤15MB。上传前在本机预检，
// 把"画布审核不通过"前移成准备阶段的明确失败，避免用户到画布才发现。
const LIBTV_AUDIO_CONTRACT = Object.freeze({
  extensions: Object.freeze(['.mp3', '.wav']),
  maxBytes: 15 * 1024 * 1024
});
const SEEDANCE20_REFERENCE_DURATION_CONTRACT = Object.freeze({
  minItemDurationExclusiveSec: 1.8,
  maxCombinedDurationSec: 15
});

// Seedance 2.5 官方手册（双源核验基线）：多模态参考视频/音频单段约 2–30 秒、
// 每类最多 10 段、每类合计约 30 秒；live schema mixed2videoConfig 读回
// videoMax=10 / imageMax=30 / audioMax=10（2026-09-02 star-video2.5）。
// 2.0 的"视频+音频合计 ≤15s"硬合同不适用于 2.5，否则 15s 以内的口播包
// 会因 视频+音频 双份计时被误拦。
const SEEDANCE25_REFERENCE_DURATION_CONTRACT = Object.freeze({
  minItemDurationExclusiveSec: 1.8,
  maxItemDurationSec: 30,
  maxPerTypeCombinedDurationSec: 30
});

async function probeMediaDurationSec(probeRunner, path, root) {
  const result = await probeRunner('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path
  ], { cwd: root, shell: false });
  if (result.code !== 0) throw new Error(`ffprobe could not inspect upload media duration: ${path}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`ffprobe returned invalid JSON for upload media: ${path}`); }
  const duration = Number(parsed?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe must return a finite positive duration for ${path}`);
  return duration;
}

async function stageLibTvCompatibleAudio(plan, { runner = runProcess, root }) {
  const derivations = [];
  for (const upload of plan.mediaUploads ?? []) {
    if (upload.type !== 'audio') continue;
    if (extname(upload.path ?? '').toLowerCase() !== '.wav') continue;
    const probe = await runner('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', upload.path
    ], { cwd: root, shell: false });
    if (probe.code !== 0) throw new Error(`ffprobe could not inspect LibTV audio compatibility: ${upload.path}`);
    let stream;
    try { stream = JSON.parse(probe.stdout)?.streams?.[0]; } catch { throw new Error(`ffprobe returned invalid audio stream JSON: ${upload.path}`); }
    // Test doubles and older ffprobe wrappers may only return format duration.
    // Keep their established path unchanged; the live runner returns a stream.
    if (!stream?.codec_name || !Number.isFinite(Number(stream.sample_rate)) || !Number.isFinite(Number(stream.channels))) continue;
    if (stream.codec_name === 'pcm_s16le' && Number(stream.sample_rate) === 48000 && Number(stream.channels) === 1) continue;
    const sourceSha256 = await sha256File(upload.path);
    const stagingDir = join(root, 'outputs', 'libtv-staging', sourceSha256.slice(0, 16));
    await mkdir(stagingDir, { recursive: true });
    const stagedPath = join(stagingDir, `${upload.name}.48k-mono.wav`);
    const converted = await runner('ffmpeg', [
      '-y', '-i', upload.path, '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', stagedPath
    ], { cwd: root, shell: false });
    if (converted.code !== 0) throw new Error(`ffmpeg could not create LibTV-compatible audio: ${converted.stderr ?? upload.path}`);
    const stagedSha256 = await sha256File(stagedPath);
    const command = plan.uploadCommands.find(args => args[1] === upload.name);
    const resourceIndex = command?.indexOf('--resource') ?? -1;
    if (resourceIndex < 0) throw new Error(`LibTV upload command is missing --resource for ${upload.name}`);
    command[resourceIndex + 1] = stagedPath;
    derivations.push({
      name: upload.name,
      sourcePath: upload.path,
      sourceSha256,
      stagedPath,
      stagedSha256,
      transform: 'ffmpeg -map_metadata -1 -ac 1 -ar 48000 -c:a pcm_s16le',
      preserves: ['dialogue words', 'speaker timbre', 'speed', 'pitch', 'pauses', 'relative timing'],
      transportOnly: true
    });
    upload.path = stagedPath;
  }
  plan.transportDerivations = derivations;
  return plan;
}

// A 项：上传素材预检。Seedance 2.0 对所有参考视频/音频执行时长硬合同：
// 每段 >1.8s 且两类素材总时长 ≤15s；音频另验 mp3/wav 与 ≤15MB。图片无时长合同。
// 上传素材列表来自编译包的锁定输入，
// SHA 已在 inspectVideoPackage 阶段核验，这里只补 LibTV 平台的受理合同。
export async function assertLibTvUploadMediaContract(mediaUploads, { probeRunner = runProcess, root = process.cwd(), model = 'Seedance 2.0 VIP' } = {}) {
  const violations = [];
  let combinedReferenceDurationSec = 0;
  const seedance25 = model === 'Seedance 2.5';
  let combinedVideoSec = 0;
  let combinedAudioSec = 0;
  for (const upload of mediaUploads ?? []) {
    if (!['video', 'audio'].includes(upload.type)) continue;
    if (upload.type === 'audio') {
      const extension = extname(upload.path ?? '').toLowerCase();
      if (!LIBTV_AUDIO_CONTRACT.extensions.includes(extension)) {
        violations.push(`音频「${upload.name}」格式 ${extension || '(无扩展名)'} 不在 LibTV 受理范围（仅 ${LIBTV_AUDIO_CONTRACT.extensions.join('/')}）；m4a 会被画布合规审核拒绝，请先转码为 mp3 或 wav`);
        continue;
      }
      const info = await stat(upload.path);
      if (info.size > LIBTV_AUDIO_CONTRACT.maxBytes) {
        violations.push(`音频「${upload.name}」体积 ${(info.size / 1024 / 1024).toFixed(1)}MB 超过 LibTV 上限 15MB`);
      }
    }
    const duration = await probeMediaDurationSec(probeRunner, upload.path, root);
    combinedReferenceDurationSec += duration;
    if (upload.type === 'video') combinedVideoSec += duration;
    if (upload.type === 'audio') combinedAudioSec += duration;
    if (duration <= SEEDANCE20_REFERENCE_DURATION_CONTRACT.minItemDurationExclusiveSec) {
      violations.push(`${upload.type === 'audio' ? '音频' : '视频'}「${upload.name}」时长 ${duration.toFixed(3)}s；Seedance 2.0 要求每段严格大于 1.8s，最小替换窗口不得直接当作上传参考素材`);
    }
    if (seedance25 && duration > SEEDANCE25_REFERENCE_DURATION_CONTRACT.maxItemDurationSec) {
      violations.push(`${upload.type === 'audio' ? '音频' : '视频'}「${upload.name}」时长 ${duration.toFixed(3)}s 超过 Seedance 2.5 单段约 30s 上限`);
    }
  }
  if (seedance25) {
    if (combinedVideoSec > SEEDANCE25_REFERENCE_DURATION_CONTRACT.maxPerTypeCombinedDurationSec) {
      violations.push(`参考视频合计 ${combinedVideoSec.toFixed(3)}s 超过 Seedance 2.5 每类约 30s 上限`);
    }
    if (combinedAudioSec > SEEDANCE25_REFERENCE_DURATION_CONTRACT.maxPerTypeCombinedDurationSec) {
      violations.push(`参考音频合计 ${combinedAudioSec.toFixed(3)}s 超过 Seedance 2.5 每类约 30s 上限`);
    }
  } else if (combinedReferenceDurationSec > SEEDANCE20_REFERENCE_DURATION_CONTRACT.maxCombinedDurationSec) {
    violations.push(`参考视频与音频总时长 ${combinedReferenceDurationSec.toFixed(3)}s 超过 Seedance 2.0 上限 15s`);
  }
  if (violations.length > 0) {
    throw Object.assign(new Error(`LibTV 上传素材预检未通过：${violations.join('；')}`), { uploadContractViolations: violations });
  }
  return true;
}

function bindPromptToLibTvNodes(prompt, sources) {
  let bound = prompt;
  for (const source of sources) {
    const tag = `@${MEDIA_TAG[source.type]}${source.index + 1}`;
    const pattern = new RegExp(`${tag.replace('@', '@\\s*')}(?![0-9])`, 'gu');
    if (!pattern.test(bound)) {
      throw new Error(`LibTV prompt does not reference connected media ${tag}; refuse a plain-text-only media connection`);
    }
    pattern.lastIndex = 0;
    bound = bound.replace(pattern, `{{Node "${source.name}"}}`);
  }
  if (/@(?:图|视频|音频)\s*[1-9][0-9]*/u.test(bound)) {
    throw new Error('LibTV prompt still contains unresolved positional media text after node binding');
  }
  return bound;
}

function assertLibTvFingerprint(fingerprint, { projectUuid, nodeName }) {
  const contract = fingerprint?.generationContract;
  if (contract?.provider !== 'libtv' || contract.transport !== 'official_cli' || !['Seedance 2.0', 'Seedance 2.0 VIP', 'Seedance 2.5', 'Kling O3'].includes(contract.model)) {
    throw new Error('LibTV operation requires a LibTV official-CLI fingerprint with a supported model');
  }
  if (contract.projectUuid !== projectUuid || contract.nodeName !== nodeName) {
    throw new Error('LibTV fingerprint canvas or node name does not match the requested operation');
  }
}

export async function buildLibTvVideoPlan(root, segmentId, { projectUuid, nodeName = `${segmentId}-seedance-video`, outputRoot, model = 'Seedance 2.0 VIP', sourceNamespace, inspect = inspectVideoPackage } = {}) {
  if (!SAFE_NAME.test(segmentId) || !SAFE_NAME.test(nodeName) || (sourceNamespace && !SAFE_NAME.test(sourceNamespace))) throw new Error('segment and LibTV node names must use safe identifiers');
  const project = projectArgs(projectUuid);
  const inspected = await inspect(root, segmentId, {
    executor: 'libtv', libtvProjectUuid: projectUuid, nodeName, model
  });
  assertLibTvFingerprint(inspected.fingerprint, { projectUuid, nodeName });
  const uploads = [];
  const add = (paths, type) => paths.map((path, index) => {
    const name = sourceName(segmentId, type, index, sourceNamespace);
    uploads.push({ name, type, index, path, args: ['upload', name, ...project, '-t', type, '--resource', path] });
    return name;
  });
  const requestedModeType = inspected.fingerprint?.generationContract?.modeType;
  // Existing generic packages derive text2video/mixed2video from their actual
  // runtime inputs.  Only the explicit direct-edit mode has settings that
  // cannot be inferred from counts, so it is the sole fingerprint override.
  const modeType = requestedModeType === 'videoEdit2video' ? requestedModeType : ((inspected.input.imageInputs.length + inspected.input.videoInputs.length + inspected.input.audioInputs.length) === 0
    ? 'text2video'
    : 'mixed2video');
  const isVideoEdit = modeType === 'videoEdit2video';
  if (isVideoEdit) {
    if (model !== 'Seedance 2.5') throw new Error('videoEdit2video canvas plans require Seedance 2.5');
    if (inspected.input.videoInputs.length !== 1 || inspected.input.audioInputs.length !== 0) {
      throw new Error('Seedance 2.5 videoEdit2video accepts exactly one video and no runtime audio inputs; keep timing audio as local evidence, not a canvas binding');
    }
    if (inspected.input.imageInputs.length > 30) throw new Error('Seedance 2.5 videoEdit2video accepts at most 30 image inputs');
  }
  // Kling O3 mixed2video does not accept audio inputs (audio2video: [0,0]).
  const skipAudio = model === 'Kling O3' || isVideoEdit;
  const upstream = [
    ...add(inspected.input.imageInputs, 'image'),
    ...add(inspected.input.videoInputs, 'video'),
    ...(skipAudio ? [] : add(inspected.input.audioInputs, 'audio'))
  ];
  const canvasPrompt = bindPromptToLibTvNodes(inspected.input.prompt, uploads);
  // The generic historical "Seedance 2.0" schema has no autoCompliance field,
  // but the actually creatable current 2.0 VIP route does expose it.  Bind the
  // setting only to models whose current LibTV schema advertises it.
  const modelSettings = model === 'Kling O3'
    ? ['-s', 'quality=high']
    : ['-s', `resolution=${inspected.input.resolution}`, '-s', 'search_enabled=0',
      ...(['Seedance 2.5', 'Seedance 2.0 VIP'].includes(model) ? ['-s', 'autoCompliance=1'] : [])];
  const request = inspected.fingerprint.generationContract.request ?? {};
  const modeSettings = isVideoEdit
    ? ['-s', `ratio_auto=${request.ratio_auto}`, '-s', `duration_auto=${request.duration_auto}`]
    : ['-s', `ratio=${request.ratio ?? inspected.input.ratio}`, '-s', `duration=${request.duration ?? inspected.input.duration}`];
  if (isVideoEdit && (request.ratio_auto === undefined || request.duration_auto === undefined)) {
    throw new Error('videoEdit2video fingerprint requires ratio_auto and duration_auto readback settings');
  }
  const createArgs = [
    'node', ...project, 'create', nodeName, '-t', 'video',
    '-s', `model=${model}`, '-s', `modeType=${modeType}`, '-s', 'count=1',
    ...modeSettings, '-s', `enableSound=${(inspected.input.generateAudio ?? true) ? 'on' : 'off'}`,
    ...(request.multi_shots === true ? ['-s', 'multi_shots=on'] : []),
    ...modelSettings,
    '--prompt', canvasPrompt
  ];
  for (const name of upstream) createArgs.push('--left', name);
  const destination = outputRoot ?? join(root, 'outputs', '.libtv-video-runs', `plan-${randomUUID()}`, segmentId);
  return {
    kind: 'libtv_video_plan', segmentId, projectUuid, nodeName, model, modeType, sourceNamespace: sourceNamespace ?? null,
    promptBindingMode: 'libtv_node_placeholders', canvasPrompt,
    mediaUploads: uploads.map(({ name, type, index, path }) => ({ name, type, index, path })),
    fingerprint: inspected.fingerprint, mutatesLibTv: false, requiresPaidApproval: true,
    uploadCommands: uploads.map(item => item.args), createCommand: createArgs,
    runCommand: ['node', ...project, nodeName, '--run'],
    downloadCommand: ['download', ...project, '--node', nodeName, '--out', destination],
    outputDirectory: destination,
    relativeOutputDirectory: relative(root, destination).split(sep).join('/')
  };
}

export async function prepareLibTvVideoCanvas(root, input, options = {}) {
  const inspect = options.inspect ?? inspectVideoPackage;
  const runner = options.runner ?? runProcess;
  const model = input.model ?? 'Seedance 2.0 VIP';
  const nodeName = input.nodeName ?? `${input.segmentId}-seedance-video`;
  const current = await inspect(root, input.segmentId, {
    executor: 'libtv', libtvProjectUuid: input.projectUuid, nodeName, model,
    allowMachineReviewedSimpleRemake: options.allowMachineReviewedSimpleRemake === true
  });
  const plan = await buildLibTvVideoPlan(root, input.segmentId, {
    projectUuid: input.projectUuid,
    nodeName,
    model,
    // Canvas preparation must never resolve an earlier run's same-named media
    // nodes.  The execution fingerprint is stable, so its prefix gives this
    // prepared canvas a deterministic, collision-resistant media namespace without
    // altering the reviewed prompt or generation contract.
    sourceNamespace: `canvas-${current.fingerprint.sha256.slice(0, 12)}`,
    inspect: async () => current
  });
  await stageLibTvCompatibleAudio(plan, { runner, root });
  // C 项：场景权威一致性检查。把提示词场景词、声明控制场景的素材、素材标识里的
  // 场景线索并列记录；冲突只产生黄色警告，不阻断准备（词表检测有盲区，不能臆断）。
  const sceneCheck = checkSceneAuthority({ prompt: current.input.prompt, media: sceneCheckMedia(current) });
  const runId = options.runId ?? `libtv-canvas-prep-${randomUUID()}`;
  const runPath = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
  const commands = [];
  const startedAt = new Date().toISOString();
  await writeJsonAtomic(runPath, {
    id: runId,
    kind: 'libtv_canvas_preparation',
    status: 'PREPARING',
    segmentId: input.segmentId,
    projectUuid: input.projectUuid,
    nodeName,
    model,
    fingerprint: current.fingerprint,
    transportDerivations: plan.transportDerivations,
    commands,
    sceneCheck,
    nodeKey: null,
    taskId: null,
    paidGenerationTriggered: false,
    createdAt: startedAt,
    updatedAt: startedAt
  });
  try {
    // A 项：上传素材预检在上传与建节点之前执行，格式/时长/体积不合规直接失败，
    // 不让不合规素材进入画布后才被平台合规审核拒绝。失败会记录进下方 catch。
    await assertLibTvUploadMediaContract(plan.mediaUploads, { probeRunner: options.probeRunner ?? runProcess, root, model });
    for (const args of plan.uploadCommands) await invokeJson(runner, args, root, commands);
    const created = await invokeJson(runner, plan.createCommand, root, commands);
    const nodeKey = deepField(created, ['nodeKey', 'newNodeKey']);
    if (typeof nodeKey !== 'string' || nodeKey.trim() === '') throw new Error('LibTV canvas preparation returned no nodeKey');
    // B 项：节点创建后立刻把画布真实状态完整读回，与本次计划逐项比对。
    const verification = await verifyPreparedLibTvNode({ runner, root, commands, plan, nodeKey });
    if (verification.diffs.length > 0) {
      throw Object.assign(
        new Error(`LibTV 画布节点写后读回校验失败：${verification.diffs.join('；')}`),
        { verificationDiffs: verification.diffs }
      );
    }
    const completedAt = new Date().toISOString();
    const run = {
      ...(await readJson(runPath)),
      status: 'READY_FOR_USER_CANVAS_GENERATION',
      nodeKey,
      commands,
      verification: { checkedAt: completedAt, diffs: [], snapshot: verification.snapshot },
      paidGenerationTriggered: false,
      completedAt,
      updatedAt: completedAt
    };
    await writeJsonAtomic(runPath, run);
    return {
      ...plan,
      mutatesLibTv: true,
      requiresUserCanvasGeneration: true,
      paidGenerationTriggered: false,
      run
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    await writeJsonAtomic(runPath, {
      ...(await readJson(runPath)),
      status: 'CANVAS_PREPARATION_FAILED',
      commands,
      errorMessage: error.message,
      verificationDiffs: error.verificationDiffs ?? null,
      uploadContractViolations: error.uploadContractViolations ?? null,
      paidGenerationTriggered: false,
      updatedAt: failedAt
    });
    throw error;
  }
}

// Read back an already-created canvas node without uploading media, changing
// node settings, or invoking --run.  This is used when a platform-normalized
// field name (for example ratio_auto -> ratio) requires a verification repair;
// the original failed preparation record remains immutable evidence.
export async function verifyLibTvVideoCanvas(root, input, options = {}) {
  const inspect = options.inspect ?? inspectVideoPackage;
  const runner = options.runner ?? runProcess;
  const model = input.model ?? 'Seedance 2.0 VIP';
  const nodeName = input.nodeName ?? `${input.segmentId}-seedance-video`;
  const nodeKey = input.nodeKey;
  if (typeof nodeKey !== 'string' || nodeKey.trim() === '') throw new Error('LibTV canvas nodeKey is required for readback verification');
  const current = await inspect(root, input.segmentId, {
    executor: 'libtv', libtvProjectUuid: input.projectUuid, nodeName, model,
    allowMachineReviewedSimpleRemake: options.allowMachineReviewedSimpleRemake === true
  });
  const plan = await buildLibTvVideoPlan(root, input.segmentId, {
    projectUuid: input.projectUuid,
    nodeName,
    model,
    sourceNamespace: `canvas-${current.fingerprint.sha256.slice(0, 12)}`,
    inspect: async () => current
  });
  const commands = [];
  const runId = options.runId ?? `libtv-canvas-readback-${randomUUID()}`;
  const runPath = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
  const startedAt = new Date().toISOString();
  await writeJsonAtomic(runPath, {
    id: runId,
    kind: 'libtv_canvas_readback_verification',
    status: 'VERIFYING',
    segmentId: input.segmentId,
    projectUuid: input.projectUuid,
    nodeName,
    nodeKey,
    model,
    fingerprint: current.fingerprint,
    commands,
    paidGenerationTriggered: false,
    createdAt: startedAt,
    updatedAt: startedAt
  });
  try {
    const verification = await verifyPreparedLibTvNode({ runner, root, commands, plan, nodeKey });
    const completedAt = new Date().toISOString();
    const status = verification.diffs.length === 0 ? 'READY_FOR_USER_CANVAS_GENERATION' : 'CANVAS_READBACK_FAILED';
    const run = {
      ...(await readJson(runPath)),
      status,
      commands,
      verification: { checkedAt: completedAt, diffs: verification.diffs, snapshot: verification.snapshot },
      paidGenerationTriggered: false,
      completedAt,
      updatedAt: completedAt
    };
    await writeJsonAtomic(runPath, run);
    if (verification.diffs.length > 0) {
      throw Object.assign(new Error(`LibTV 画布节点读回校验失败：${verification.diffs.join('；')}`), { verificationDiffs: verification.diffs });
    }
    return { ...plan, mutatesLibTv: false, requiresUserCanvasGeneration: true, paidGenerationTriggered: false, run };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const existing = await readJson(runPath);
    if (existing.status === 'VERIFYING') {
      await writeJsonAtomic(runPath, {
        ...existing,
        status: 'CANVAS_READBACK_FAILED',
        commands,
        verificationDiffs: error.verificationDiffs ?? null,
        paidGenerationTriggered: false,
        updatedAt: failedAt
      });
    }
    throw error;
  }
}

function sceneCheckMedia(current) {
  const inputMedia = current.fingerprint?.inputMedia ?? {};
  const responsibilityMap = current.value?.responsibilityMap ?? {};
  const items = [];
  for (const [kind, list] of [['image', inputMedia.images], ['video', inputMedia.videos], ['audio', inputMedia.audio]]) {
    for (const item of list ?? []) {
      items.push({ id: item.id, kind, path: item.path, controls: responsibilityMap[item.id]?.controls ?? [] });
    }
  }
  return items;
}

function deepField(value, names) {
  if (!value || typeof value !== 'object') return undefined;
  for (const name of names) if (value[name] !== undefined) return value[name];
  for (const child of Object.values(value)) {
    const found = deepField(child, names);
    if (found !== undefined) return found;
  }
}

// B 项：写后全量读回校验。
//
// 背景事故（2026-08-24 OEING 前 12 秒复刻，手工 CLI 操作实测）：
// 1. 一次 --prompt 写入导致节点 model 被静默重置为 "Seedance 2.0 VIP"、分辨率被重置为 480p；
// 2. --left-add/--left-rm 换边后 data.params.mixedList 残留旧媒体节点；
// 3. 提示词里的 {{Node "名称"}} 在画布侧被改写成 {{Node <nodeId>}}，只按写入文本比对会误报。
// 因此节点创建之后必须立刻把画布侧真实状态完整读回，与本次计划逐项比对；
// 任何一项不一致都视为准备失败，不得把一个"看起来建好"的节点留给用户点击生成。

function nodeParamValue(params, key) {
  return params?.settings?.[key] ?? params?.[key];
}

function resolveCanvasPromptPlaceholders(canvasPrompt, mixedList) {
  let resolved = canvasPrompt;
  for (const source of mixedList ?? []) {
    if (typeof source?.label === 'string' && typeof source?.nodeId === 'string') {
      resolved = resolved.split(`{{Node "${source.label}"}}`).join(`{{Node ${source.nodeId}}}`);
    }
  }
  return resolved;
}

function nodeSnapshot(node, mixedList = null) {
  const params = node?.data?.params ?? {};
  return {
    model: params.model ?? null,
    modeType: params.modeType ?? null,
    settings: {
      ratio: nodeParamValue(params, 'ratio') ?? null,
      // LibTV persists mode-specific ratio_auto/duration_auto through their
      // original UI fields ratio/duration.  Keep the semantic aliases in the
      // snapshot while accepting either shape on current readback.
      ratio_auto: nodeParamValue(params, 'ratio_auto') ?? nodeParamValue(params, 'ratio') ?? null,
      resolution: nodeParamValue(params, 'resolution') ?? null,
      duration: nodeParamValue(params, 'duration') ?? null,
      duration_auto: nodeParamValue(params, 'duration_auto') ?? nodeParamValue(params, 'duration') ?? null,
      enableSound: nodeParamValue(params, 'enableSound') ?? null,
      count: params.count ?? null,
      multi_shots: ['on', true, 1, '1'].includes(nodeParamValue(params, 'multi_shots'))
    },
    mixedList: (mixedList ?? (Array.isArray(params.mixedList) ? params.mixedList : [])).map(item => ({
      label: item?.label ?? null, mediaType: item?.mediaType ?? null, nodeId: item?.nodeId ?? null
    }))
  };
}

// LibTV 的当前节点读回格式不一致：视频/音频会保留 label，而图片只出现在
// imageList 中且没有 label。不能因此把真实四项绑定误判成空画布；同时也不能只按
// 数量放行。缺少 mixedList 时，逐个读取本次上传的资源节点，先核对名称与类型，再
// 用画布返回的 nodeId 精确比对各输入列表。
async function readCanvasMediaBindings({ runner, root, commands, plan, params }) {
  const direct = Array.isArray(params.mixedList) ? params.mixedList : [];
  if (direct.length > 0) return direct;
  const expected = plan.mediaUploads ?? [];
  const resourceByName = new Map();
  for (const upload of expected) {
    const resource = await invokeJson(runner, ['node', upload.name, '-p', plan.projectUuid], root, commands);
    if (resource?.data?.name !== upload.name || resource?.data?.type !== upload.type || typeof resource?.nodeKey !== 'string') {
      throw new Error(`LibTV uploaded resource readback mismatch for ${upload.name}`);
    }
    resourceByName.set(upload.name, resource.nodeKey);
  }
  const lists = {
    image: Array.isArray(params.imageList) ? params.imageList : [],
    video: Array.isArray(params.videoList) ? params.videoList : [],
    audio: Array.isArray(params.audioList) ? params.audioList : []
  };
  return expected.map(upload => ({
    label: upload.name,
    mediaType: upload.type,
    nodeId: resourceByName.get(upload.name),
    present: lists[upload.type].some(item => item?.nodeId === resourceByName.get(upload.name))
  }));
}

async function verifyPreparedLibTvNode({ runner, root, commands, plan, nodeKey }) {
  const node = await invokeJson(runner, ['node', nodeKey, '-p', plan.projectUuid], root, commands);
  const diffs = [];
  const params = node?.data?.params ?? {};
  const request = plan.fingerprint?.generationContract?.request ?? {};
  if (node?.nodeKey !== nodeKey) diffs.push(`nodeKey：读回 ${node?.nodeKey ?? '(缺失)'} ≠ 创建返回 ${nodeKey}`);
  if (params.model !== plan.model) diffs.push(`model：画布 ${params.model ?? '(缺失)'} ≠ 计划 ${plan.model}（写入可能触发了模型/设置重置）`);
  if (params.modeType !== plan.modeType) diffs.push(`modeType：画布 ${params.modeType ?? '(缺失)'} ≠ 计划 ${plan.modeType}`);
  if (plan.modeType === 'videoEdit2video') {
    const canvasRatioAuto = nodeParamValue(params, 'ratio_auto') ?? nodeParamValue(params, 'ratio');
    const canvasDurationAuto = nodeParamValue(params, 'duration_auto') ?? nodeParamValue(params, 'duration');
    if (canvasRatioAuto !== request.ratio_auto) {
      diffs.push(`ratio_auto：画布 ${canvasRatioAuto ?? '(缺失)'} ≠ 计划 ${request.ratio_auto}`);
    }
    if (Number(canvasDurationAuto) !== Number(request.duration_auto)) {
      diffs.push(`duration_auto：画布 ${canvasDurationAuto ?? '(缺失)'} ≠ 计划 ${request.duration_auto}`);
    }
  } else {
    if (nodeParamValue(params, 'ratio') !== request.ratio) diffs.push(`ratio：画布 ${nodeParamValue(params, 'ratio') ?? '(缺失)'} ≠ 计划 ${request.ratio}`);
    if (Number(nodeParamValue(params, 'duration')) !== Number(request.duration)) diffs.push(`duration：画布 ${nodeParamValue(params, 'duration') ?? '(缺失)'} ≠ 计划 ${request.duration}`);
  }
  if (request.resolution !== undefined && nodeParamValue(params, 'resolution') !== request.resolution) {
    diffs.push(`resolution：画布 ${nodeParamValue(params, 'resolution') ?? '(缺失)'} ≠ 计划 ${request.resolution}`);
  }
  const expectedSound = request.enableSound === false || request.generateAudio === false ? 'off' : 'on';
  if (nodeParamValue(params, 'enableSound') !== expectedSound) diffs.push(`enableSound：画布 ${nodeParamValue(params, 'enableSound') ?? '(缺失)'} ≠ 计划 ${expectedSound}`);
  if (Number(params.count) !== Number(request.count ?? 1)) diffs.push(`count：画布 ${params.count ?? '(缺失)'} ≠ 计划 ${request.count ?? 1}`);
  if (request.multi_shots === true && !['on', true, 1, '1'].includes(nodeParamValue(params, 'multi_shots'))) {
    diffs.push('multi_shots：画布未读回已启用状态，不得把多镜提示词冒充多镜控制');
  }
  const mixed = await readCanvasMediaBindings({ runner, root, commands, plan, params });
  const expectedUploads = plan.mediaUploads ?? [];
  if (mixed.length !== expectedUploads.length) diffs.push(`mixedList：画布 ${mixed.length} 条 ≠ 计划上传 ${expectedUploads.length} 条（可能有残留或丢失的媒体绑定）`);
  for (const upload of expectedUploads) {
    const matches = mixed.filter(item => item?.label === upload.name);
    if (matches.length !== 1) diffs.push(`mixedList：计划素材 ${upload.name} 在画布出现 ${matches.length} 次`);
    else if (matches[0]?.mediaType !== upload.type || matches[0]?.present === false) diffs.push(`mixedList：${upload.name} 未以正确类型绑定到画布`);
  }
  const resolvedPrompt = resolveCanvasPromptPlaceholders(plan.canvasPrompt, mixed);
  if (typeof params.prompt !== 'string' || (params.prompt !== plan.canvasPrompt && params.prompt !== resolvedPrompt)) {
    diffs.push('prompt：画布提示词与计划绑定文本不一致（可能存在未解析占位符或写入被重置）');
  }
  return { diffs, snapshot: nodeSnapshot(node, mixed) };
}

async function invokeJson(runner, args, root, commands) {
  const result = await runner('libtv', args, { cwd: root, shell: false });
  commands.push({ executable: 'libtv', args: [...args], exitCode: result.code });
  if (result.code !== 0) throw new Error(`LibTV ${args[0]} failed with exit code ${Number.isInteger(result.code) ? result.code : 'unknown'}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`LibTV ${args[0]} returned invalid JSON`); }
}

async function claim(root, input, current, runId) {
  return withProjectLock(root, async () => {
    const state = await readJson(join(root, 'project-state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (state?.videoGovernanceVersion === 2) {
      const audit = await auditProjectReadiness(root);
      const blockers = audit.findings.filter(item => item.severity === 'error');
      if (blockers.length > 0) {
        throw new Error(`strict video governance readiness BLOCKED: ${blockers.map(item => item.id).join(', ')}`);
      }
    }
    await assertGenerationFailureGate(root, current.fingerprint);
    await recoverJsonTransactions(root);
    const approvalPath = join(root, 'reviews', `${encodeURIComponent(input.paidApprovalId)}.json`);
    const approval = await readJson(approvalPath);
    const approvedActor = approval.actor === 'human' || approval.actor === 'delegated_batch_policy';
    if (approval.kind !== 'paid_generation_approval' || !approvedActor || approval.decision !== 'approved'
      || approval.segmentId !== input.segmentId || approval.executor !== 'libtv') {
      throw new Error('LibTV live requires a matching approved LibTV paid approval');
    }
    assertLibTvFingerprint(approval.fingerprint, { projectUuid: input.projectUuid, nodeName: input.nodeName });
    assertLibTvFingerprint(current.fingerprint, { projectUuid: input.projectUuid, nodeName: input.nodeName });
    if (approval.fingerprint.sha256 !== current.fingerprint.sha256) throw new Error('LibTV paid approval fingerprint changed');
    await requireExecutionControlEvidence(root, current.fingerprint, approval.executionControlEvidence);
    let approvedProjectUuid;
    if (approval.actor === 'human') {
      // Single-segment compatibility path: inspectVideoPackage has already
      // required a locked PASS independent_creative_audit bound to this exact
      // prompt/package/media fingerprint. Keep the human approval one-shot.
      approvedProjectUuid = approval.libtvProjectUuid;
    } else if (approval.auditAuthorizationKind === 'human_gpt_fallback') {
      approvedProjectUuid = (await verifyGptFallbackApprovalBindings(root, approval, current.fingerprint)).libtvProjectUuid;
    } else {
      const batch = assertBatchGenerationApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(approval.parentBatchApprovalId)}.json`)));
      const audit = assertExternalAuditAttestation(await readJson(join(root, 'reviews', `${encodeURIComponent(approval.externalAuditAttestationId)}.json`)));
      const auditRun = await readJson(join(root, 'runs', `${encodeURIComponent(audit.auditRunId)}.json`));
      if (batch.executor !== 'libtv' || audit.decision !== 'PASS' || audit.auditStage !== 'pre_generation'
        || audit.segmentId !== input.segmentId || audit.fingerprintSha256 !== current.fingerprint.sha256) throw new Error('LibTV paid approval lost its batch or external audit binding');
      if (auditRun.kind !== 'external_model_audit' || auditRun.status !== 'SUCCESS' || auditRun.attestationId !== audit.id
        || auditRun.sessionId !== audit.providerTaskId || auditRun.model !== audit.model) throw new Error('LibTV paid approval has no verified OpenCodex audit run');
      approvedProjectUuid = batch.libtvProjectUuid;
    }
    if (approval.libtvProjectUuid !== approvedProjectUuid || (input.projectUuid && input.projectUuid !== approvedProjectUuid)) {
      throw new Error('LibTV project UUID does not match the approved batch canvas');
    }
    if (approval.consumedByRunId) throw new Error(`paid approval already belongs to ${approval.consumedByRunId}`);
    const ownerPath = join(root, 'runs', 'libtv-video-owner.json');
    const owner = await readJson(ownerPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (owner && ['ACTIVE', 'UNCERTAIN'].includes(owner.status)) throw new Error(`LibTV video already has an active or uncertain owner: ${owner.runId}`);
    const runPath = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
    await readJson(runPath).then(() => { throw new Error(`LibTV video run already exists: ${runId}`); }, error => { if (error.code !== 'ENOENT') throw error; });
    const now = new Date().toISOString();
    const run = {
      id: runId, kind: 'libtv_video', tool: 'libtv', status: 'PREPARING', segmentId: input.segmentId,
      paidApprovalId: approval.id, fingerprint: current.fingerprint, projectUuid: approvedProjectUuid,
      nodeName: input.nodeName, taskId: null, nodeKey: null,
      commands: [], outputs: [], createdAt: now, updatedAt: now
    };
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'generation.claimed', occurredAt: now,
      actor: { kind: 'system', id: null }, segmentId: input.segmentId,
      correlationId: run.id, causationId: approval.id,
      idempotencyKey: `generation.claimed:${approval.id}`,
      references: [
        { kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` },
        { kind: 'paid_generation_approval', id: approval.id, path: `reviews/${encodeURIComponent(approval.id)}.json` }
      ],
      facts: {
        runId: run.id, approvalId: approval.id, fingerprintSha256: current.fingerprint.sha256,
        executor: 'libtv', projectUuid: approvedProjectUuid, nodeName: input.nodeName
      }
    });
    await commitJsonTransaction(root, `libtv-video-claim-${runId}`, [
      { path: runPath, value: run },
      { path: approvalPath, value: { ...approval, consumedByRunId: runId, consumedAt: now } },
      { path: ownerPath, value: { status: 'ACTIVE', runId, claimedAt: now } },
      ...ledger.writes
    ]);
    return { runPath, ownerPath, run, projectUuid: approvedProjectUuid };
  });
}

export async function executeLibTvVideo(root, input, options = {}) {
  const inspect = options.inspect ?? inspectVideoPackage;
  const approval = await readJson(join(root, 'reviews', `${encodeURIComponent(input.paidApprovalId)}.json`));
  const projectUuid = input.projectUuid ?? approval.libtvProjectUuid;
  const nodeName = input.nodeName ?? approval.fingerprint?.generationContract?.nodeName ?? `${input.segmentId}-seedance-video`;
  const model = approval.fingerprint?.generationContract?.model ?? 'Seedance 2.0 VIP';
  const current = await inspect(root, input.segmentId, {
    executor: 'libtv', libtvProjectUuid: projectUuid, nodeName, model
  });
  const runId = options.runId ?? `libtv-video-${randomUUID()}`;
  const normalizedInput = { ...input, projectUuid, nodeName };
  const claimed = await claim(root, normalizedInput, current, runId);
  const outputRoot = join(root, 'outputs', '.libtv-video-runs', runId, input.segmentId);
  const plan = await buildLibTvVideoPlan(root, input.segmentId, {
    projectUuid: claimed.projectUuid, nodeName, outputRoot, model, sourceNamespace: runId, inspect: async () => current
  });
  const runner = options.runner ?? runProcess;
  const commands = [];
  try {
    await assertLibTvUploadMediaContract(plan.mediaUploads, { probeRunner: options.probeRunner ?? runProcess, root });
    for (const args of plan.uploadCommands) await invokeJson(runner, args, root, commands);
    const created = await invokeJson(runner, plan.createCommand, root, commands);
    const nodeKey = deepField(created, ['nodeKey', 'newNodeKey']);
    if (typeof nodeKey !== 'string' || nodeKey.trim() === '') throw new Error('LibTV video node creation returned no nodeKey');
    // 付费提交前同样执行写后读回：模型/设置/媒体绑定与计划不一致时必须先失败，
    // 不得把漂移过的节点直接 --run。
    const verification = await verifyPreparedLibTvNode({ runner, root, commands, plan, nodeKey });
    if (verification.diffs.length > 0) {
      throw Object.assign(
        new Error(`LibTV 画布节点写后读回校验失败：${verification.diffs.join('；')}`),
        { verificationDiffs: verification.diffs }
      );
    }
    await withProjectLock(root, async () => {
      const run = await readJson(claimed.runPath);
      await writeJsonAtomic(claimed.runPath, { ...run, status: 'SUBMITTING', nodeKey, commands, updatedAt: new Date().toISOString() });
    });
    const terminal = await invokeJson(runner, plan.runCommand, root, commands);
    const taskId = deepField(terminal, ['taskId', 'task_id']);
    const status = deepField(terminal, ['status']);
    if (status === 3 || status === 'FAILED') throw Object.assign(new Error('LibTV video task reached terminal failure'), { terminalFailure: true, taskId, nodeKey });
    if (!(status === 2 || status === 'SUCCESS')) throw new Error('LibTV video run did not return a confirmed success terminal status');
    if (typeof taskId !== 'string' || taskId.trim() === '') throw new Error('LibTV video success returned no taskId');
    await withProjectLock(root, async () => {
      await recoverJsonTransactions(root);
      const run = await readJson(claimed.runPath);
      const generatedAt = new Date().toISOString();
      const generated = { ...run, status: 'GENERATED', taskId, nodeKey, commands, generatedAt, updatedAt: generatedAt };
      const ledger = await prepareExecutionLedgerAppend(root, {
        type: 'generation.submitted', occurredAt: generatedAt,
        actor: { kind: 'system', id: null }, segmentId: run.segmentId,
        correlationId: run.id, causationId: run.paidApprovalId,
        idempotencyKey: `generation.submitted:${run.id}:${taskId}`,
        references: [{ kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` }],
        facts: {
          runId: run.id, approvalId: run.paidApprovalId, taskId, nodeKey,
          fingerprintSha256: run.fingerprint.sha256, status: generated.status, executor: 'libtv'
        }
      });
      await commitJsonTransaction(root, `libtv-video-submitted-${runId}`, [
        { path: claimed.runPath, value: generated },
        ...ledger.writes
      ]);
    });
    await mkdir(outputRoot, { recursive: true });
    await invokeJson(runner, plan.downloadCommand, root, commands);
    const files = (await readdir(outputRoot, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('._'));
    if (files.length !== 1) throw Object.assign(new Error('LibTV video download must produce exactly one file'), { downloadOnly: true });
    const outputPath = join(outputRoot, files[0].name);
    const output = { path: relative(root, outputPath).split(sep).join('/'), sha256: await sha256File(outputPath) };
    const completedAt = new Date().toISOString();
    const completed = { ...(await readJson(claimed.runPath)), status: 'SUCCESS', taskId, nodeKey, commands, outputs: [output], completedAt, updatedAt: completedAt };
    await withProjectLock(root, async () => {
      await recoverJsonTransactions(root);
      const ledger = await prepareExecutionLedgerAppend(root, {
        type: 'generation.succeeded', occurredAt: completedAt,
        actor: { kind: 'system', id: null }, segmentId: completed.segmentId,
        correlationId: completed.id, causationId: completed.paidApprovalId,
        idempotencyKey: `generation.succeeded:${completed.id}`,
        references: [
          { kind: 'generation_run', id: completed.id, path: `runs/${encodeURIComponent(completed.id)}.json` },
          { kind: 'generated_output', id: 'output-1', path: output.path, sha256: output.sha256 }
        ],
        facts: {
          runId: completed.id, approvalId: completed.paidApprovalId, taskId,
          fingerprintSha256: completed.fingerprint.sha256, status: completed.status,
          outputCount: 1, executor: 'libtv'
        }
      });
      await commitJsonTransaction(root, `libtv-video-success-${runId}`, [
        { path: claimed.runPath, value: completed },
        { path: claimed.ownerPath, value: { status: 'RELEASED', runId, releasedAt: completedAt } },
        ...ledger.writes
      ]);
    });
    return { ...plan, mutatesLibTv: true, run: completed };
  } catch (error) {
    await withProjectLock(root, async () => {
      await recoverJsonTransactions(root);
      const run = await readJson(claimed.runPath);
      const status = error.downloadOnly || run.status === 'GENERATED' ? 'INTERRUPTED_DOWNLOAD' : error.terminalFailure ? 'FAILED' : 'UNCERTAIN';
      const updatedAt = new Date().toISOString();
      const failed = { ...run, status, taskId: error.taskId ?? run.taskId, nodeKey: error.nodeKey ?? run.nodeKey, commands, errorMessage: error.message, updatedAt };
      const eventType = status === 'FAILED' ? 'generation.failed'
        : status === 'INTERRUPTED_DOWNLOAD' ? 'generation.interrupted'
          : 'generation.submission_uncertain';
      const ledger = await prepareExecutionLedgerAppend(root, {
        type: eventType, occurredAt: updatedAt,
        actor: { kind: 'system', id: null }, segmentId: run.segmentId,
        correlationId: run.id, causationId: run.paidApprovalId,
        idempotencyKey: `${eventType}:${run.id}`,
        references: [{ kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` }],
        facts: {
          runId: run.id, approvalId: run.paidApprovalId, status,
          taskId: failed.taskId, fingerprintSha256: run.fingerprint.sha256, executor: 'libtv'
        }
      });
      await commitJsonTransaction(root, `libtv-video-failure-${runId}`, [
        { path: claimed.runPath, value: failed },
        { path: claimed.ownerPath, value: { status: status === 'FAILED' ? 'RELEASED' : 'UNCERTAIN', runId, updatedAt } },
        ...ledger.writes
      ]);
    });
    throw error;
  }
}

export async function resumeLibTvVideoDownload(root, runId, { runner = runProcess } = {}) {
  const runPath = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
  const run = await readJson(runPath);
  if (run.kind !== 'libtv_video' || run.status !== 'INTERRUPTED_DOWNLOAD' || !run.taskId || !run.nodeKey) {
    throw new Error('download resume requires a generated LibTV video with interrupted download');
  }
  const outputRoot = join(root, 'outputs', '.libtv-video-runs', run.id, run.segmentId);
  const args = ['download', '-p', run.projectUuid, '--node', run.nodeName, '--out', outputRoot];
  const commands = [...(run.commands ?? [])];
  await mkdir(outputRoot, { recursive: true });
  try {
    let files = (await readdir(outputRoot, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('._'));
    if (files.length === 0) {
      await invokeJson(runner, args, root, commands);
      files = (await readdir(outputRoot, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('._'));
    }
    if (files.length !== 1) throw new Error('LibTV resumed download must produce exactly one file');
    const outputPath = join(outputRoot, files[0].name);
    const output = { path: relative(root, outputPath).split(sep).join('/'), sha256: await sha256File(outputPath) };
    const completedAt = new Date().toISOString();
    const completed = { ...run, status: 'SUCCESS', commands, outputs: [output], completedAt, updatedAt: completedAt };
    await withProjectLock(root, async () => {
      await recoverJsonTransactions(root);
      const ledger = await prepareExecutionLedgerAppend(root, {
        type: 'generation.succeeded', occurredAt: completedAt,
        actor: { kind: 'system', id: null }, segmentId: completed.segmentId,
        correlationId: completed.id, causationId: completed.paidApprovalId,
        idempotencyKey: `generation.succeeded:${completed.id}`,
        references: [
          { kind: 'generation_run', id: completed.id, path: `runs/${encodeURIComponent(completed.id)}.json` },
          { kind: 'generated_output', id: 'output-1', path: output.path, sha256: output.sha256 }
        ],
        facts: {
          runId: completed.id, approvalId: completed.paidApprovalId, taskId: completed.taskId,
          fingerprintSha256: completed.fingerprint.sha256, status: completed.status,
          outputCount: 1, executor: 'libtv'
        }
      });
      await commitJsonTransaction(root, `libtv-video-download-resume-${runId}`, [
        { path: runPath, value: completed },
        { path: join(root, 'runs', 'libtv-video-owner.json'), value: { status: 'RELEASED', runId, releasedAt: completedAt } },
        ...ledger.writes
      ]);
    });
    return completed;
  } catch (error) {
    await withProjectLock(root, async () => {
      await writeJsonAtomic(runPath, { ...run, status: 'INTERRUPTED_DOWNLOAD', commands, errorMessage: error.message, updatedAt: new Date().toISOString() });
    });
    throw error;
  }
}
