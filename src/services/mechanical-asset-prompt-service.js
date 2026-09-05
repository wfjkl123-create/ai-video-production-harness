import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { runProcess } from '../adapters/process-runner.js';
import { sha256File, sha256Text } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { registerArtifact } from './intake-service.js';
import { autoLockArtifact } from './review-service.js';
import { compileSeedanceMediaBoundPrompt } from './seedance-media-binding-service.js';
import { requireCleanSeedanceExecutionPrompt } from './seedance-prompt-lint-service.js';

const PACKAGE_KIND = 'mechanical_asset_prompt_package_v2';
const PROMPT_METHODS = Object.freeze({
  product_reference: 'seedance2-prompt/non_narrative_product_replacement_v1',
  character_identity_single_view: 'seedance2-prompt/face_identity_replacement_v1'
});
const DEFAULT_SEGMENT_SECONDS = 15;
const MIN_GENERATION_SECONDS = 4;

function safeRelative(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.split(/[\\/]+/).includes('..')) {
    throw new TypeError(`${field} must be a safe project-relative path`);
  }
  return value.split(sep).join('/');
}

function inside(root, relativePath, field) {
  const normalized = safeRelative(relativePath, field);
  const target = resolve(root, normalized);
  if (target !== resolve(root) && !target.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${field} escapes project root`);
  return target;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function integer(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${field} must be an integer from ${min} to ${max}`);
  return value;
}

function finiteNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError(`${field} must be a finite number from ${min} to ${max}`);
  return value;
}

function optionalText(value, field, { max = 2000 } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string when provided`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length > max) throw new TypeError(`${field} must contain at most ${max} characters`);
  return normalized;
}

function buildWindows(totalSeconds, segmentSeconds = DEFAULT_SEGMENT_SECONDS) {
  finiteNumber(totalSeconds, 'totalSeconds', { min: MIN_GENERATION_SECONDS });
  integer(segmentSeconds, 'segmentSeconds', { min: MIN_GENERATION_SECONDS, max: 15 });
  const windows = [];
  for (let startSec = 0; startSec < totalSeconds; startSec += segmentSeconds) {
    windows.push({ startSec, endSec: Math.min(totalSeconds, startSec + segmentSeconds) });
  }
  if (windows.length > 1 && windows.at(-1).endSec - windows.at(-1).startSec < MIN_GENERATION_SECONDS) {
    const last = windows.at(-1);
    const prior = windows.at(-2);
    const needed = MIN_GENERATION_SECONDS - (last.endSec - last.startSec);
    if ((prior.endSec - prior.startSec) - needed < MIN_GENERATION_SECONDS) {
      prior.endSec = last.endSec;
      windows.pop();
    } else {
      prior.endSec -= needed;
      last.startSec -= needed;
    }
  }
  return windows.map((window, index) => ({
    id: `segment-${String(index + 1).padStart(3, '0')}`,
    ...window,
    durationSec: window.endSec - window.startSec
  }));
}

async function probeDurationSeconds(path, runner, ffprobeExecutable) {
  const result = await runner(ffprobeExecutable, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path
  ]);
  if (result.code !== 0) throw new Error(`ffprobe could not read the source video: ${String(result.stderr || result.stdout || '').trim()}`);
  const duration = Number(String(result.stdout).trim());
  if (!Number.isFinite(duration) || duration < MIN_GENERATION_SECONDS) throw new Error('source video must contain at least 4 seconds of readable media');
  return duration;
}

async function verifyClipMedia(path, expectedDurationSec, runner, ffprobeExecutable) {
  const result = await runner(ffprobeExecutable, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path
  ]);
  if (result.code !== 0) throw new Error(`ffprobe could not verify split media: ${String(result.stderr || result.stdout || '').trim()}`);
  let value;
  try { value = JSON.parse(String(result.stdout)); } catch { throw new Error('ffprobe returned invalid split media metadata'); }
  const duration = Number(value?.format?.duration);
  const streamTypes = Array.isArray(value?.streams) ? value.streams.map(stream => stream?.codec_type) : [];
  if (!streamTypes.includes('video')) throw new Error('split media does not contain a readable video stream');
  if (!Number.isFinite(duration) || Math.abs(duration - expectedDurationSec) > 0.5) {
    throw new Error(`split media duration mismatch: expected ${expectedDurationSec}s, observed ${Number.isFinite(duration) ? duration : 'unreadable'}s`);
  }
  return { durationSec: duration, hasAudio: streamTypes.includes('audio') };
}

async function probeMediaStreams(path, runner, ffprobeExecutable) {
  const result = await runner(ffprobeExecutable, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path
  ]);
  if (result.code !== 0) throw new Error(`ffprobe could not inspect source streams: ${String(result.stderr || result.stdout || '').trim()}`);
  let value;
  try { value = JSON.parse(String(result.stdout)); } catch { throw new Error('ffprobe returned invalid source stream metadata'); }
  const streamTypes = Array.isArray(value?.streams) ? value.streams.map(stream => stream?.codec_type) : [];
  if (!streamTypes.includes('video')) throw new Error('source video does not contain a readable video stream');
  return { hasAudio: streamTypes.includes('audio') };
}

function productReplacementPrompt({ clipId, replacementAssetId, durationSec }) {
  return [
    `总时长 ${durationSec} 秒。`,
    `@素材[${clipId}] 是本段原片的唯一事实权威，只负责人物身份、动作、表情、口型、场景、构图、镜头运动、光线、节奏和声音；不得迁移其中原产品的外观。`,
    `@素材[${replacementAssetId}] 是替换后产品的唯一身份权威，只负责产品的轮廓、结构、材质、颜色和比例；不得迁移产品图的白底、摆放角度、构图或静态姿势。`,
    `只做一项修改：把 @素材[${clipId}] 中人物手上可见的原产品替换为 @素材[${replacementAssetId}] 的产品，其余可见内容和时间顺序保持不变。`,
    '替换后的产品始终贴合手部接触点，跟随原片的遮挡、透视、尺度、受光和运动模糊，不漂浮、不穿手、不改变人物动作。',
    '原产品的轮廓、颜色、材质、文字和零件不得残留，也不得与新产品融合或让新产品变形。',
    '保留原片的对白、口型、环境声和动作节奏，不新增台词、旁白、音乐或音效。',
    '真实视频质感，不新增字幕、文字、logo、UI 或水印。'
  ].join('\n');
}

function faceReplacementPrompt({
  clipId,
  replacementAssetId,
  durationSec,
  faceIdentityDescription,
  audioExternal,
  sourceFaceIdentityScrubbed
}) {
  return [
    `总时长 ${durationSec} 秒。`,
    audioExternal
      ? `@素材[${clipId}] 是本段原片的无声视觉版，也是动作与时空事实权威，只负责人物的头部角度、粗略视线方向、说话与表情的节奏和强度、肢体动作、发型、身体、服装、场景、构图、镜头运动、光线和节奏；原片人物的脸部身份特征不得保留。`
      : `@素材[${clipId}] 是本段原片的动作与时空事实权威，只负责人物的头部角度、粗略视线方向、说话与表情的节奏和强度、肢体动作、发型、身体、服装、场景、构图、镜头运动、光线、节奏和原有声音；原片人物的脸部身份特征不得保留。`,
    ...(sourceFaceIdentityScrubbed ? [
      `@素材[${clipId}] 的人脸区域已被强模糊，这是只为清除旧人物身份而做的输入预处理，不是最终画面风格。必须用 @素材[${replacementAssetId}] 完整重建清晰、真实、可见的全脸五官与皮肤细节，不得保留模糊、马赛克、空白脸、塑料脸或低清五官；模糊区域只提供粗略头姿、说话运动节奏和表情强度，不得被解释为人脸身份。`,
      `这条重建要求覆盖全片每一帧：即使人脸被手、头发或产品部分遮挡、处于大特写、低头、侧转或快速运动中，脸部的可见区域也必须始终渲染为清晰的新脸皮肤与五官质感，遮挡物保持在脸的前方不变；任何一帧都不得回退为模糊、马赛克或低清状态，不出现模糊闪帧。`
    ] : []),
    `@素材[${replacementAssetId}] 是新人脸完整身份的唯一权威，必须整体采用她的脸型与骨相比例、额头宽度、眉弓和眉形、眼睛形状与间距、鼻梁鼻头、唇形、颚骨、面颊和下颌线；不得只参考眉眼、鼻子或嘴唇等局部，不得迁移该图的灰色背景、正面证件照构图、光线、妆面强度或静止表情。`,
    ...(faceIdentityDescription ? [
      `文字只用于帮助完整读取 @素材[${replacementAssetId}] 的可见脸部几何特征，不是第二个身份来源；如果文字与图片像素有差异，始终以 @素材[${replacementAssetId}] 为准。${faceIdentityDescription}`
    ] : []),
    `只做一项修改：将 @素材[${clipId}] 中主讲女性的整张人脸身份替换为 @素材[${replacementAssetId}] 的完整人脸身份，而不是把两张脸融合；其余画面内容和时间顺序保持不变。`,
    '替换边界严格止于主讲人物的头部轮廓与下颌线；耳饰、颈部、肩膀、衣服、身体、手、产品、家具、背景及其他画面区域必须逐像素保持清晰原样，不得模糊、柔化、重绘、变形或被面部替换影响。',
    '新脸必须在正面、侧转、低头、抬头、说话和表情变化中始终保持同一人身份，跟随原片的脸部透视、遮挡、受光、肤色环境反射和运动模糊，边缘过渡平顺，不漂移、不闪烁、不贴图、不变形。',
    `表演与生理分开处理：口播内容、说话节奏、情绪强度、视线大方向和全部肢体动作以 @素材[${clipId}] 为唯一权威，不新增、不改变；但模糊已经抹掉了旧脸的眨眼、呼吸与微表情等生理动态，这些必须由你主动重建——这是还原真人脸上的生命感，不是新增表演。`,
    '全段面部保持真实生命状态，但不按固定频率表演：眨眼只跟随原有声音的气口、句间停顿、注意力切换或情绪压力自然发生，眼睑完整闭合再睁开；没有明确触发时不强行眨眼。视线先服从原片可见目标，注意力改变时眼睛先移动、头部晚半拍跟随；眉毛、面颊、嘴角与下颌只随发音、语气和已经发生的刺激联动，左右不必机械对称。允许人物在消化信息、压住反应或维持立场时短暂主动静止，只保留与原片一致的呼吸和肌肉张力；严禁死帧冻结、循环闪烁、无因果抽动或为了“活人感”持续做小动作。',
    '表情的语义内容——什么时候微笑、疑惑、强调——只与原片已经听见的声音和已经看到的动作严格对应，不提前反应、不新增原片没有的表情含义；其余时间仍延续原片的动作状态，镜头、衣料和背景只按原片给予反馈。',
    '严禁残留或回生原片人物的脸型、眉眼、鼻子、唇形、颚骨或下颌线；严禁“新脸局部+原脸骨相”的混合脸，严禁多张脸、五官重影或不同镜头中身份变化。',
    audioExternal
      ? '完整保留原片人物的发型、耳饰、头部大小、身材、服装、产品、手势、身体动作、表演节奏与强度、场景、构图、运镜和剪辑节奏；根据另行回接的原音重建自然同步口型，不复制已被模糊的旧五官轨迹；不换头、不换发型、不改耳饰、不换身体、不改服装、不改产品、不新增动作或镜头。'
      : '完整保留原片人物的发型、耳饰、头部大小、身材、服装、产品、手势、身体动作、表演节奏与强度、场景、构图、运镜、剪辑节奏和所有原有声音；依据原有声音、粗略头姿和说话节奏重建自然同步的新人脸表演，嘴唇、面颊与下颌随发音自然联动，不复制已被模糊的旧五官轨迹；不换头、不换发型、不改耳饰、不换身体、不改服装、不改产品、不新增动作或镜头。',
    ...(audioExternal ? ['本节点必须关闭生成声音，不生成对白、旁白、音乐或音效；已锁定的原片音频将在生成完成后以确定性封装回接，不得在本节点内改写或重配声音。'] : []),
    '真实视频质感，保留原片已有的字幕和画面文字，不新增字幕、文字、logo、UI 或水印。'
  ].join('\n');
}

function sourcePrompt({
  clipId,
  replacementAssetId,
  replacementAssetType,
  durationSec,
  faceIdentityDescription,
  audioExternal,
  sourceFaceIdentityScrubbed
}) {
  return replacementAssetType === 'character_identity_single_view'
    ? faceReplacementPrompt({
      clipId,
      replacementAssetId,
      durationSec,
      faceIdentityDescription,
      audioExternal,
      sourceFaceIdentityScrubbed
    })
    : productReplacementPrompt({ clipId, replacementAssetId, durationSec });
}

function parseCliJson(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout || '').trim()}`);
  const raw = String(result.stdout ?? '').trim();
  const candidates = [raw, ...raw.split(/\r?\n/).reverse()].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next complete JSON candidate */ }
  }
  throw new Error(`${label} did not return JSON`);
}

function recursiveValues(value, key, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Object.prototype.hasOwnProperty.call(value, key)) output.push(value[key]);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') recursiveValues(child, key, output);
  }
  return output;
}

function nodeKey(value, label) {
  const found = [...recursiveValues(value, 'nodeKey'), ...recursiveValues(value, 'newNodeKey')]
    .find(item => typeof item === 'string' && item.trim() !== '');
  if (!found) throw new Error(`${label} response does not contain a nodeKey`);
  return found;
}

function nodeParam(params, key) {
  return params?.settings?.[key] ?? params?.[key];
}

// `@图1` / `@视频1` 仅是本地编译与 lint 层的稳定编号，不能直接写进
// LibTV 画布提示词。画布必须使用已连线资源节点的占位符；CLI 会把它
// 渲染为真实的素材引用标签，并在读回时保留为 {{Node <nodeKey>}}。
function bindPromptToCanvasNodes(executionPrompt, { clipKey, replacementKey }) {
  if (typeof executionPrompt !== 'string' || executionPrompt.trim() === '') {
    throw new TypeError('execution prompt is required for LibTV node binding');
  }
  const bound = executionPrompt
    .replaceAll('@视频1', `{{Node ${clipKey}}}`)
    .replaceAll('@图1', `{{Node ${replacementKey}}}`);
  if (/@(?:图|视频)\d+/.test(bound)) {
    throw new Error('unresolved platform media alias remains in LibTV canvas prompt');
  }
  for (const key of [clipKey, replacementKey]) {
    if (!bound.includes(`{{Node ${key}}}`)) {
      throw new Error(`LibTV canvas prompt is missing real media reference for ${key}`);
    }
  }
  return bound;
}

function verifyGeneratorReadback(readback, { name, clipKey, productKey, prompt, settings }) {
  const params = readback?.data?.params ?? {};
  const diffs = [];
  if (params.prompt !== prompt.trim() && params.prompt !== prompt) diffs.push('prompt');
  if (params.model !== settings.model) diffs.push('model');
  if (params.modeType !== settings.modeType) diffs.push('modeType');
  if (nodeParam(params, 'ratio') !== settings.ratio) diffs.push('ratio');
  if (nodeParam(params, 'resolution') !== settings.resolution) diffs.push('resolution');
  if (Number(nodeParam(params, 'duration')) !== Number(settings.duration)) diffs.push('duration');
  if (nodeParam(params, 'enableSound') !== settings.enableSound) diffs.push('enableSound');
  if (Number(params.count) !== Number(settings.count)) diffs.push('count');
  if (Number(nodeParam(params, 'search_enabled') ?? 0) !== Number(settings.search_enabled)) diffs.push('search_enabled');
  const direct = Array.isArray(params.mixedList) ? params.mixedList : [];
  const listedKeys = direct.map(item => item?.nodeId).filter(item => typeof item === 'string');
  const fallbackKeys = [
    ...(Array.isArray(params.imageList) ? params.imageList : []),
    ...(Array.isArray(params.videoList) ? params.videoList : [])
  ].map(item => item?.nodeId).filter(item => typeof item === 'string');
  const actualKeys = listedKeys.length > 0 ? listedKeys : fallbackKeys;
  if (actualKeys.length !== 2
    || actualKeys.filter(key => key === clipKey).length !== 1
    || actualKeys.filter(key => key === productKey).length !== 1) diffs.push('media bindings');
  if (diffs.length > 0) throw new Error(`LibTV readback mismatch for ${name}: ${diffs.join(', ')}`);
}

async function currentMechanicalInputs(root, state) {
  if (state.routeDecision?.executionClass !== 'mechanical_asset_prompt') {
    throw new Error('mechanical package preparation requires a mechanical_asset_prompt route');
  }
  const sourceIds = state.routeDecision.sourceVideoIds ?? [];
  const replacementIds = state.routeDecision.assetInputIds ?? [];
  if (sourceIds.length < 1 || replacementIds.length !== 1) {
    throw new Error('mechanical replacement requires one or more source videos and exactly one replacement image');
  }
  const sources = sourceIds.map(sourceId => state.artifacts.find(item => (
    item.id === sourceId && item.type === 'reference_video' && item.status === 'locked'
  )));
  const replacementAsset = state.artifacts.find(item => item.id === replacementIds[0] && item.type === 'project_asset'
    && Object.hasOwn(PROMPT_METHODS, item.assetType) && item.status === 'locked');
  if (sources.some(source => !source) || !replacementAsset) {
    throw new Error('all exact locked source videos and one supported replacement image are required');
  }
  const [sourceFiles, replacementFile] = await Promise.all([
    Promise.all(sources.map(source => verifyLockedArtifact(root, source))),
    verifyLockedArtifact(root, replacementAsset)
  ]);
  return {
    sources: sources.map((source, index) => ({ ...source, absolutePath: sourceFiles[index].path })),
    replacementAsset: { ...replacementAsset, absolutePath: replacementFile.path }
  };
}

async function currentOriginalAudioAssemblyInput(root, state, source) {
  const matches = state.artifacts.filter(item => item.type === 'project_asset'
    && item.assetType === 'timing_audio_reference'
    && item.status === 'locked'
    && item.sourceVideoId === source.id
    && typeof item.invalidatedByScopeRevisionId !== 'string');
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error('face identity replacement requires exactly one locked timing_audio_reference bound to the current visual source');
  }
  const audio = matches[0];
  const file = await verifyLockedArtifact(root, audio);
  return { ...audio, absolutePath: file.path };
}

export async function prepareMechanicalAssetPromptPackage(root, {
  segmentDurationSec = DEFAULT_SEGMENT_SECONDS,
  maxDurationSec = null,
  faceIdentityDescription = null,
  sourceFaceIdentityScrubbed = false,
  runner = runProcess,
  ffmpegExecutable = 'ffmpeg',
  ffprobeExecutable = 'ffprobe'
} = {}) {
  root = resolve(root);
  integer(segmentDurationSec, 'segmentDurationSec', { min: MIN_GENERATION_SECONDS, max: 15 });
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const { sources, replacementAsset } = await currentMechanicalInputs(root, state);
  if (sources.length > 1 && maxDurationSec !== null) {
    throw new TypeError('maxDurationSec is only supported when the mechanical route has one source video');
  }
  const normalizedFaceIdentityDescription = optionalText(faceIdentityDescription, 'faceIdentityDescription');
  if (typeof sourceFaceIdentityScrubbed !== 'boolean') throw new TypeError('sourceFaceIdentityScrubbed must be a boolean');
  if (normalizedFaceIdentityDescription && replacementAsset.assetType !== 'character_identity_single_view') {
    throw new TypeError('faceIdentityDescription is only valid for character_identity_single_view replacement assets');
  }
  const promptMethod = normalizedFaceIdentityDescription
    ? 'seedance2-prompt/face_identity_replacement_with_text_anchor_v2'
    : PROMPT_METHODS[replacementAsset.assetType];
  const isFaceIdentityReplacement = replacementAsset.assetType === 'character_identity_single_view';
  const sourcePlans = [];
  let globalSegmentIndex = 0;
  for (const source of sources) {
    const actualDuration = await probeDurationSeconds(source.absolutePath, runner, ffprobeExecutable);
    const sourceMedia = isFaceIdentityReplacement
      ? await probeMediaStreams(source.absolutePath, runner, ffprobeExecutable)
      : null;
    const originalAudio = isFaceIdentityReplacement && !sourceMedia.hasAudio
      ? await currentOriginalAudioAssemblyInput(root, state, source)
      : null;
    if (isFaceIdentityReplacement && !sourceMedia.hasAudio && !originalAudio) {
      throw new Error(`face identity replacement with audio-free source ${source.id} requires one locked timing_audio_reference bound to that source`);
    }
    const requestedDuration = maxDurationSec === null
      ? (sources.length === 1 ? Math.floor(actualDuration) : actualDuration)
      : finiteNumber(maxDurationSec, 'maxDurationSec', { min: MIN_GENERATION_SECONDS });
    const effectiveDurationSec = Number(Math.min(actualDuration, requestedDuration).toFixed(3));
    const windows = buildWindows(effectiveDurationSec, segmentDurationSec).map(window => ({
      ...window,
      sourceWindowId: window.id,
      id: `segment-${String(++globalSegmentIndex).padStart(3, '0')}`
    }));
    sourcePlans.push({ source, actualDuration, sourceMedia, originalAudio, effectiveDurationSec, windows });
  }
  if (sourcePlans.length > 1 && sourcePlans.some(plan => plan.originalAudio !== null)) {
    throw new Error('multi-source mechanical packages require every source video to carry its own audio stream');
  }
  const effectiveDurationSec = Number(sourcePlans.reduce((sum, plan) => sum + plan.effectiveDurationSec, 0).toFixed(3));
  const requiresExternalAudioAssembly = sourcePlans.length === 1 && sourcePlans[0].originalAudio !== null;
  const originalAudio = requiresExternalAudioAssembly ? sourcePlans[0].originalAudio : null;
  const packageFingerprint = fingerprint({
    kind: PACKAGE_KIND,
    faceReplacementPromptVersion: isFaceIdentityReplacement ? 'face-identity-replacement-v7' : null,
    promptMethod,
    sourceVideos: sourcePlans.map(plan => ({
      id: plan.source.id,
      sha256: plan.source.sha256,
      actualDurationSec: plan.actualDuration,
      effectiveDurationSec: plan.effectiveDurationSec,
      windows: plan.windows
    })),
    replacementAssetId: replacementAsset.id,
    replacementAssetSha256: replacementAsset.sha256,
    replacementAssetType: replacementAsset.assetType,
    faceIdentityDescription: normalizedFaceIdentityDescription,
    sourceFaceIdentityScrubbed,
    segmentDurationSec,
    effectiveDurationSec,
    sourceBindingStrategy: 'preserve_presegmented_source_boundaries_and_only_split_sources_over_limit_v1',
    audioStrategy: requiresExternalAudioAssembly ? 'deterministic_post_generation_mux_v1' : 'source_video_audio_generation_v1',
    ...(originalAudio ? { originalAudioId: originalAudio.id, originalAudioSha256: originalAudio.sha256 } : {})
  });
  const existing = state.artifacts.find(item => item.type === 'execution_package'
    && item.executionClass === 'mechanical_asset_prompt'
    && item.packageFingerprint === packageFingerprint
    && item.status === 'locked');
  if (existing) {
    await verifyLockedArtifact(root, existing);
    return { artifact: existing, package: await readJson(join(root, existing.path)), reused: true };
  }

  const packageRoot = `mechanical/${packageFingerprint.slice(0, 16)}`;
  const segments = [];
  await mkdir(inside(root, `${packageRoot}/clips`, 'clip directory'), { recursive: true });
  for (const plan of sourcePlans) {
    const { source, actualDuration, sourceMedia } = plan;
    for (const window of plan.windows) {
      const isCompleteSourceWindow = Math.abs(window.startSec) < 0.001
        && Math.abs(window.endSec - actualDuration) < 0.001;
      const clipId = isCompleteSourceWindow ? source.id : `mechanical-source-${window.id}-${source.sha256.slice(0, 12)}`;
      const clipPath = isCompleteSourceWindow ? source.path : `${packageRoot}/clips/${window.id}.mp4`;
      const absoluteClip = isCompleteSourceWindow ? source.absolutePath : inside(root, clipPath, `${window.id}.clipPath`);
      let media;
      let clipSha256;
      if (isCompleteSourceWindow) {
        media = sourceMedia ?? await probeMediaStreams(source.absolutePath, runner, ffprobeExecutable);
        clipSha256 = source.sha256;
      } else {
        const cut = await runner(ffmpegExecutable, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-ss', String(window.startSec), '-i', source.absolutePath, '-t', String(window.durationSec),
          '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', absoluteClip
        ]);
        if (cut.code !== 0) throw new Error(`${window.id} deterministic split failed: ${String(cut.stderr || cut.stdout || '').trim()}`);
        const clipStat = await stat(absoluteClip);
        if (!clipStat.isFile() || clipStat.size === 0) throw new Error(`${window.id} split did not create readable media`);
        media = await verifyClipMedia(absoluteClip, window.durationSec, runner, ffprobeExecutable);
        clipSha256 = await sha256File(absoluteClip);
      }
      const promptPath = `${packageRoot}/prompts/${window.id}.source.txt`;
      const executionPromptPath = `${packageRoot}/prompts/${window.id}.execution.txt`;
      const prompt = sourcePrompt({
        clipId,
        replacementAssetId: replacementAsset.id,
        replacementAssetType: replacementAsset.assetType,
        durationSec: window.durationSec,
        faceIdentityDescription: normalizedFaceIdentityDescription,
        audioExternal: requiresExternalAudioAssembly,
        sourceFaceIdentityScrubbed
      });
      await writeTextAtomic(inside(root, promptPath, `${window.id}.promptPath`), `${prompt}\n`);
      const compiledBase = {
      imageInputs: [{ id: replacementAsset.id, path: replacementAsset.path, sha256: replacementAsset.sha256 }],
      videoInputs: [{ id: clipId, path: clipPath, sha256: clipSha256 }],
      audioInputs: [],
      responsibilityMap: {
        [replacementAsset.id]: replacementAsset.assetType === 'character_identity_single_view' ? {
          controls: ['替换后人脸的完整身份与全脸几何特征'],
          mustNotControl: ['原表情、口型、发型、身体、服装、动作、场景、构图、镜头、声音和人脸图背景']
        } : {
          controls: ['替换后产品的轮廓、结构、材质、颜色和比例'],
          mustNotControl: ['人物、动作、场景、构图、镜头、声音、白底和产品图摆放姿势']
        },
        [clipId]: {
          controls: replacementAsset.assetType === 'character_identity_single_view'
            ? [
              '头部角度、粗略视线方向、说话与表情节奏和强度、发型、身体、服装、动作、场景、构图、镜头运动、光线和节奏',
              ...(requiresExternalAudioAssembly ? [] : ['原有声音'])
            ]
            : ['人物身份、动作、表情、口型、场景、构图、镜头运动、光线、节奏和原有声音'],
          mustNotControl: replacementAsset.assetType === 'character_identity_single_view'
            ? ['原片人物的脸部身份特征']
            : ['原产品的外观、结构、材质、颜色和文字']
        }
      }
      };
      const canonicalSourceBody = `${prompt}\n`;
      const compiled = compileSeedanceMediaBoundPrompt(canonicalSourceBody, compiledBase);
      requireCleanSeedanceExecutionPrompt(compiled.text, {
        bindings: compiled.bindings,
        narrativePerformance: { sourceControlledPerformance: true }
      });
      await writeTextAtomic(inside(root, executionPromptPath, `${window.id}.executionPromptPath`), compiled.text);
      segments.push({
        ...window,
        sourceVideoId: source.id,
        sourceVideoSha256: source.sha256,
        clip: { id: clipId, path: clipPath, sha256: clipSha256, verifiedDurationSec: media.durationSec, hasAudio: media.hasAudio },
        sourcePrompt: { path: promptPath, sha256: sha256Text(`${prompt}\n`) },
        executionPrompt: { path: executionPromptPath, sha256: sha256Text(compiled.text) },
        sourceBodySha256: sha256Text(canonicalSourceBody),
        compiledBodySha256: sha256Text(compiled.text),
        mediaTokenMappingManifest: compiled.mediaTokenMappingManifest,
        mediaBindingContractVersion: compiled.contractVersion,
        mediaBindings: compiled.bindings,
        generationSettings: {
          model: 'Seedance 2.0 VIP', modeType: 'mixed2video', ratio: '9:16', resolution: '480p',
          duration: Math.ceil(window.durationSec), enableSound: requiresExternalAudioAssembly ? 'off' : 'on', count: 1, search_enabled: 0
        }
      });
    }
  }

  const packageValue = {
    schemaVersion: 1,
    kind: PACKAGE_KIND,
    status: 'READY_FOR_LIBTV_CANVAS_PREPARATION',
    executionClass: 'mechanical_asset_prompt',
    promptMethod,
    skillsApplied: ['seedance2-prompt'],
    sourceVideos: sourcePlans.map(plan => ({
      id: plan.source.id,
      path: plan.source.path,
      sha256: plan.source.sha256,
      actualDurationSec: plan.actualDuration,
      effectiveDurationSec: plan.effectiveDurationSec
    })),
    ...(sourcePlans.length === 1 ? {
      sourceVideo: {
        id: sourcePlans[0].source.id,
        path: sourcePlans[0].source.path,
        sha256: sourcePlans[0].source.sha256,
        actualDurationSec: sourcePlans[0].actualDuration
      }
    } : {}),
    replacementAsset: {
      id: replacementAsset.id,
      assetType: replacementAsset.assetType,
      path: replacementAsset.path,
      sha256: replacementAsset.sha256
    },
    ...(normalizedFaceIdentityDescription ? {
      faceIdentityDescription: normalizedFaceIdentityDescription,
      faceIdentityDescriptionRole: 'image-grounded-readable-feature-anchor_not_an_independent_identity_source'
    } : {}),
    sourceFaceIdentityScrubbed,
    segmentDurationSec,
    effectiveDurationSec,
    segmentCount: segments.length,
    ...(requiresExternalAudioAssembly ? {
      postGenerationAssembly: {
        required: true,
        strategy: 'deterministic_original_audio_mux_and_frame_exact_trim_v1',
        generatedAudioPolicy: 'disabled',
        originalAudioAsset: { id: originalAudio.id, path: originalAudio.path, sha256: originalAudio.sha256 },
        generatedContainerDurationSec: Math.ceil(effectiveDurationSec),
        finalVisualFrameCount: Math.round(effectiveDurationSec * 30),
        finalVisualFrameRate: 30,
        finalContentDurationSec: effectiveDurationSec,
        requiredBeforeDelivery: ['trim the generated video to the locked visual frame count', 'mux the separately locked original audio without model-generated sound', 'verify video starts at frame 0 and audio starts at sample 0']
      }
    } : {}),
    segments,
    reviewSurface: 'libtv_canvas',
    assistantMaySubmitPaidGeneration: false,
    packageFingerprint
  };
  const packagePath = `${packageRoot}/mechanical-package.json`;
  await writeJsonAtomic(inside(root, packagePath, 'packagePath'), packageValue);
  const packageId = `mechanical-package-${packageFingerprint.slice(0, 16)}`;
  const revision = 1 + Math.max(0, ...state.artifacts
    .filter(item => item.type === 'execution_package' && item.executionClass === 'mechanical_asset_prompt')
    .map(item => item.revision));
  const artifact = await registerArtifact(root, {
    id: packageId,
    type: 'execution_package',
    revision,
    status: 'draft',
    path: packagePath,
    executionClass: 'mechanical_asset_prompt',
    packageFingerprint,
    sourceVideoIds: sourcePlans.map(plan => plan.source.id),
    sourceVideoShas256: sourcePlans.map(plan => plan.source.sha256),
    ...(sourcePlans.length === 1 ? {
      sourceVideoId: sourcePlans[0].source.id,
      sourceVideoSha256: sourcePlans[0].source.sha256
    } : {}),
    replacementAssetId: replacementAsset.id,
    replacementAssetSha256: replacementAsset.sha256,
    replacementAssetType: replacementAsset.assetType,
    segmentCount: segments.length
  });
  await autoLockArtifact(root, artifact.id,
    'auto-locked: deterministic source slicing, exact replacement binding, prompt compilation and zero-context lint all passed');
  const refreshed = assertProjectState(await readJson(join(root, 'project-state.json')));
  return { artifact: refreshed.artifacts.find(item => item.id === artifact.id), package: packageValue, reused: false };
}

async function queryNode(runner, projectUuid, name) {
  const result = await runner('libtv', ['node', name, '-p', projectUuid]);
  if (result.code === 0) {
    const value = parseCliJson(result, `LibTV node query ${name}`);
    if (value?.count === 0 && Array.isArray(value.matches) && value.matches.length === 0) return null;
    return value;
  }
  const message = String(result.stderr || result.stdout || '').trim();
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|not logged in|未登录|未授权|无权限/i.test(message)) {
    throw new Error(`LibTV authentication or project access failed for ${projectUuid}: ${message}`);
  }
  return null;
}

async function ensureUpload(runner, projectUuid, name, type, absolutePath) {
  const existing = await queryNode(runner, projectUuid, name);
  const verify = value => {
    if (value?.data?.name !== name || value?.data?.type !== type) {
      throw new Error(`LibTV uploaded resource readback mismatch for ${name}`);
    }
  };
  if (existing) {
    verify(existing);
    return { nodeKey: nodeKey(existing, name), readback: existing, reused: true };
  }
  const created = parseCliJson(await runner('libtv', [
    'upload', name, '-p', projectUuid, '-t', type, '-f', absolutePath
  ]), `LibTV upload ${name}`);
  const key = nodeKey(created, name);
  const readback = parseCliJson(await runner('libtv', ['node', key, '-p', projectUuid]), `LibTV upload readback ${name}`);
  verify(readback);
  return { nodeKey: key, readback, reused: false };
}

async function ensureGeneratorNode(runner, projectUuid, name, clipKey, productKey, prompt, settings) {
  const existing = await queryNode(runner, projectUuid, name);
  if (existing) {
    verifyGeneratorReadback(existing, { name, clipKey, productKey, prompt, settings });
    return { nodeKey: nodeKey(existing, name), readback: existing, reused: true };
  }
  const args = [
    'node', 'create', name, '-p', projectUuid, '-t', 'video',
    '--left', clipKey, '--left', productKey, '--prompt', prompt.trim(),
    '-s', `model=${settings.model}`,
    '-s', `modeType=${settings.modeType}`,
    '-s', `ratio=${settings.ratio}`,
    '-s', `resolution=${settings.resolution}`,
    '-s', `duration=${settings.duration}`,
    '-s', `enableSound=${settings.enableSound}`,
    '-s', `count=${settings.count}`,
    '-s', `search_enabled=${settings.search_enabled}`
  ];
  const created = parseCliJson(await runner('libtv', args), `LibTV generator create ${name}`);
  const key = nodeKey(created, name);
  const readback = parseCliJson(await runner('libtv', ['node', key, '-p', projectUuid]), `LibTV generator readback ${name}`);
  verifyGeneratorReadback(readback, { name, clipKey, productKey, prompt, settings });
  return { nodeKey: key, readback, reused: false };
}

export async function prepareMechanicalLibTvCanvas(root, {
  projectUuid,
  runner = runProcess
} = {}) {
  root = resolve(root);
  if (!/^[a-f0-9]{32}$/.test(projectUuid ?? '')) throw new TypeError('projectUuid must be a 32-character lowercase LibTV UUID');
  let state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const packages = state.artifacts.filter(item => item.type === 'execution_package'
    && item.executionClass === 'mechanical_asset_prompt' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id));
  const artifact = packages[0];
  if (!artifact) throw new Error('a locked mechanical package is required before LibTV canvas preparation');
  await verifyLockedArtifact(root, artifact);
  const packageValue = await readJson(join(root, safeRelative(artifact.path, 'execution package path')));
  if (packageValue.kind !== PACKAGE_KIND || packageValue.packageFingerprint !== artifact.packageFingerprint) {
    throw new Error('mechanical execution package metadata does not match its locked artifact');
  }
  const priorCanvas = state.mechanicalCanvas?.packageArtifactId === artifact.id
    && state.mechanicalCanvas?.projectUuid === projectUuid
    && state.mechanicalCanvas?.status === 'READY_FOR_USER_CANVAS_GENERATION'
    ? state.mechanicalCanvas
    : null;
  const replacementAssetValue = packageValue.replacementAsset ?? packageValue.productAsset;
  const replacementFile = await inspectArtifactFile(root, replacementAssetValue.path);
  if (replacementFile.sha256 !== replacementAssetValue.sha256) throw new Error('mechanical replacement asset changed after package lock');
  const stem = `${state.projectId}-${artifact.packageFingerprint.slice(0, 10)}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  const replacementLabel = replacementAssetValue.assetType === 'character_identity_single_view' ? 'face' : 'product';
  const replacementName = `${stem}-${replacementLabel}`;
  const replacementNode = await ensureUpload(runner, projectUuid, replacementName, 'image', replacementFile.path);
  const nodes = [];
  for (const segment of packageValue.segments) {
    const [clipFile, promptFile] = await Promise.all([
      inspectArtifactFile(root, segment.clip.path),
      inspectArtifactFile(root, segment.executionPrompt.path)
    ]);
    if (clipFile.sha256 !== segment.clip.sha256 || promptFile.sha256 !== segment.executionPrompt.sha256) {
      throw new Error(`${segment.id} package inputs changed after package lock`);
    }
    const prompt = await readFile(promptFile.path, 'utf8');
    requireCleanSeedanceExecutionPrompt(prompt, {
      bindings: segment.mediaBindings,
      narrativePerformance: { sourceControlledPerformance: true }
    });
    const clipName = `${stem}-${segment.id}-source`;
    const generatorName = `${stem}-${segment.id}-replace-${replacementLabel}`;
    const clipNode = await ensureUpload(runner, projectUuid, clipName, 'video', clipFile.path);
    const canvasPrompt = bindPromptToCanvasNodes(prompt, {
      clipKey: clipNode.nodeKey,
      replacementKey: replacementNode.nodeKey
    });
    const generator = await ensureGeneratorNode(
      runner, projectUuid, generatorName, clipNode.nodeKey, replacementNode.nodeKey, canvasPrompt, segment.generationSettings
    );
    nodes.push({
      segmentId: segment.id,
      sourceNode: { name: clipName, nodeKey: clipNode.nodeKey },
      replacementNode: { name: replacementName, nodeKey: replacementNode.nodeKey },
      generatorNode: { name: generatorName, nodeKey: generator.nodeKey },
      promptSha256: segment.executionPrompt.sha256,
      canvasPromptSha256: sha256Text(canvasPrompt),
      readbackSha256: sha256Text(JSON.stringify(generator.readback))
    });
  }
  const mechanicalCanvas = {
    status: 'READY_FOR_USER_CANVAS_GENERATION',
    executionClass: 'mechanical_asset_prompt',
    packageArtifactId: artifact.id,
    packageSha256: artifact.sha256,
    projectUuid,
    nodes,
    requiresUserCanvasGeneration: true,
    paidGenerationTriggered: false,
    assistantMaySubmitPaidGeneration: false,
    preparedAt: new Date().toISOString()
  };
  await withProjectLock(root, async () => {
    state = assertProjectState(await readJson(join(root, 'project-state.json')));
    state.mechanicalCanvas = mechanicalCanvas;
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);
    await writeJsonAtomic(join(root, 'project-state.json'), state);
  });
  const reused = Boolean(priorCanvas)
    && nodes.length === priorCanvas.nodes?.length
    && nodes.every((node, index) => node.sourceNode.nodeKey === priorCanvas.nodes[index]?.sourceNode?.nodeKey
      && node.replacementNode.nodeKey === (priorCanvas.nodes[index]?.replacementNode ?? priorCanvas.nodes[index]?.productNode)?.nodeKey
      && node.generatorNode.nodeKey === priorCanvas.nodes[index]?.generatorNode?.nodeKey);
  return { ...structuredClone(mechanicalCanvas), reused };
}

export const mechanicalAssetPromptInternals = Object.freeze({
  PACKAGE_KIND,
  PROMPT_METHODS,
  buildWindows,
  sourcePrompt,
  parseCliJson,
  nodeKey,
  bindPromptToCanvasNodes
});
