import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, posix } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_KINDS = new Set(['image', 'video']);
const EXTENSIONS = Object.freeze({
  image: Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp']),
  video: Object.freeze(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
});

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function kind(value) {
  if (!MEDIA_KINDS.has(value)) throw new TypeError('kind must be image or video');
  return value;
}

function safeRelativePath(value, field) {
  const path = text(value, field).replaceAll('\\', '/');
  if (isAbsolute(path) || /^[A-Za-z]:\//.test(path) || path.startsWith('//')
    || path === '..' || path.startsWith('../') || path.split('/').includes('..')) {
    throw new TypeError(`${field} must stay inside the project root`);
  }
  return path;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function roundTime(value) {
  return Number(value.toFixed(6));
}

function outputStem(path) {
  const raw = basename(path, extname(path)).normalize('NFKC');
  const safe = raw.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return safe || 'source';
}

export function depthExtensions(mediaKind) {
  return [...EXTENSIONS[kind(mediaKind)]];
}

export function resolveUniqueDepthInput(candidatePaths, mediaKind) {
  const requestedKind = kind(mediaKind);
  if (!Array.isArray(candidatePaths)) throw new TypeError('candidatePaths must be an array');
  const allowed = new Set(EXTENSIONS[requestedKind]);
  const candidates = [...new Set(candidatePaths.map((value, index) => safeRelativePath(value, `candidatePaths[${index}]`)))]
    .filter(path => allowed.has(extname(path).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  if (candidates.length === 0) {
    const error = new Error(`no ${requestedKind} input candidate found; accepted extensions: ${[...allowed].join(', ')}`);
    error.code = 'DEPTH_INPUT_NOT_FOUND';
    error.candidates = [];
    throw error;
  }
  if (candidates.length > 1) {
    const error = new Error(`multiple ${requestedKind} input candidates found; choose exactly one: ${candidates.join(', ')}`);
    error.code = 'DEPTH_INPUT_AMBIGUOUS';
    error.candidates = candidates;
    throw error;
  }
  return candidates[0];
}

function validateTemplate(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template) || template.schemaVersion !== 1) {
    throw new TypeError('monocular depth template version 1 is required');
  }
  text(template.id, 'template.id');
  text(template.imagePrompt, 'template.imagePrompt');
  text(template.videoPrompt, 'template.videoPrompt');
  return template;
}

export function detectDepthIntents(requestText, template) {
  const request = text(requestText, 'requestText').toLowerCase();
  const lockedTemplate = validateTemplate(template);
  const triggers = lockedTemplate.triggerTerms;
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) throw new TypeError('template.triggerTerms must be an object');
  for (const field of ['video', 'image', 'ambiguousVideoDefaults', 'ambiguousImageDefaults', 'doNotRouteWhen']) {
    if (!Array.isArray(triggers[field]) || triggers[field].some(value => typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError(`template.triggerTerms.${field} must be a string array`);
    }
  }
  const includesAny = values => values.some(value => request.includes(value.toLowerCase()));
  const explicitVideo = includesAny(triggers.video);
  const explicitImage = includesAny(triggers.image);
  const ambiguousBlocked = includesAny(triggers.doNotRouteWhen);
  const intents = [];
  if (explicitImage || (!ambiguousBlocked && includesAny(triggers.ambiguousImageDefaults))) intents.push('image');
  if (explicitVideo || (!ambiguousBlocked && includesAny(triggers.ambiguousVideoDefaults))) intents.push('video');
  return intents;
}

function validateInput(input, mediaKind) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object');
  const path = safeRelativePath(input.path, 'input.path');
  if (!SHA256.test(input.sha256 ?? '')) throw new TypeError('input.sha256 must be a lowercase SHA-256');
  if (!EXTENSIONS[mediaKind].includes(extname(path).toLowerCase())) throw new TypeError(`input.path is not a supported ${mediaKind} file`);
  return { path, sha256: input.sha256 };
}

function validateMetadata(metadata, mediaKind) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata must be an object');
  const value = {
    width: positiveInteger(metadata.width, 'metadata.width'),
    height: positiveInteger(metadata.height, 'metadata.height')
  };
  if (mediaKind === 'video') {
    if (typeof metadata.durationSec !== 'number' || !Number.isFinite(metadata.durationSec) || metadata.durationSec <= 0) {
      throw new TypeError('metadata.durationSec must be a positive number');
    }
    value.durationSec = roundTime(metadata.durationSec);
    value.frameRate = text(metadata.frameRate, 'metadata.frameRate');
  }
  return value;
}

function instructionText(mediaKind, input, template) {
  const role = mediaKind === 'video'
    ? 'Input1 只提供逐帧空间、遮挡、构图和镜头运动；不允许覆盖或改写源文件。'
    : 'Input1 只提供空间结构、轮廓、姿势、遮挡和构图；不允许覆盖或改写源文件。';
  const lockedPrompt = mediaKind === 'video' ? template.videoPrompt : template.imagePrompt;
  return [
    '【本次唯一输入绑定】',
    `Input1 = ${input.path}`,
    `Input1 SHA-256 = ${input.sha256}`,
    role,
    '',
    '【锁定转换要求】',
    lockedPrompt,
    ''
  ].join('\n');
}

function videoSegments(baseDirectory, durationSec) {
  const count = Math.ceil(durationSec / 15);
  return Array.from({ length: count }, (_, index) => {
    const startSec = roundTime(index * 15);
    const endSec = roundTime(Math.min(durationSec, (index + 1) * 15));
    return {
      index: index + 1,
      startSec,
      endSec,
      durationSec: roundTime(endSec - startSec),
      outputPath: posix.join(baseDirectory, `segment-${String(index + 1).padStart(3, '0')}.mp4`)
    };
  });
}

export function buildDepthConversionPlan({
  projectId, mediaKind, input, metadata, template,
  instructionPath, outputRoot = 'outputs/depth', createdAt = new Date().toISOString()
}) {
  const requestedKind = kind(mediaKind);
  const project = text(projectId, 'projectId');
  const source = validateInput(input, requestedKind);
  const sourceMetadata = validateMetadata(metadata, requestedKind);
  const lockedTemplate = validateTemplate(template);
  const safeInstructionPath = safeRelativePath(instructionPath, 'instructionPath');
  const safeOutputRoot = safeRelativePath(outputRoot, 'outputRoot');
  if (Number.isNaN(Date.parse(createdAt))) throw new TypeError('createdAt must be a date-time');

  const instruction = instructionText(requestedKind, source, lockedTemplate);
  const instructionSha256 = createHash('sha256').update(instruction).digest('hex');
  const shortSha = source.sha256.slice(0, 12);
  const stem = outputStem(source.path);
  const outputBase = posix.join(safeOutputRoot, `${stem}-depth-${shortSha}`);
  const outputs = requestedKind === 'video'
    ? videoSegments(outputBase, sourceMetadata.durationSec)
    : [{ index: 1, outputPath: `${outputBase}.png`, width: sourceMetadata.width, height: sourceMetadata.height }];

  const contract = {
    schemaVersion: 1,
    id: `depth-${requestedKind}-${source.sha256.slice(0, 16)}-v1`,
    kind: 'monocular_depth_conversion_plan',
    projectId: project,
    mediaKind: requestedKind,
    templateId: lockedTemplate.id,
    templateSource: `knowledge/capabilities/monocular-depth-templates.json#${requestedKind}Prompt`,
    capabilitySource: 'knowledge/capabilities/monocular-depth-conversion.md',
    input: { ...source, ...sourceMetadata, readOnly: true },
    instructionPath: safeInstructionPath,
    instructionSha256,
    modelPolicy: {
      task: requestedKind === 'video' ? 'monocular_video_depth_estimation' : 'monocular_image_depth_estimation',
      availability: 'resolve_and_verify_at_execution',
      sameModelForAllFrames: requestedKind === 'video',
      samePreprocessingForAllFrames: requestedKind === 'video',
      grayscaleDesaturationIsNotDepth: true
    },
    depthContract: {
      near: 'white',
      far: 'black',
      intermediate: 'continuous_grayscale',
      preserveOcclusionAndContours: true,
      normalizationScope: requestedKind === 'video' ? 'entire_source_video' : 'single_source_image',
      normalizationMode: requestedKind === 'video' ? 'single_fixed_robust_range_p2_p98' : 'single_fixed_range',
      perFrameContrastStretch: false,
      temporalStabilization: requestedKind === 'video' ? 'moderate_edge_preserving' : 'not_applicable',
      motionCompensated: requestedKind === 'video',
      maxPreviousFrameWeight: requestedKind === 'video' ? 0.25 : 0,
      flickerControl: requestedKind === 'video' ? 'optical_flow_aligned_light_blend_with_reset_on_low_confidence' : 'not_applicable',
      burnedInOverlayPolicy: requestedKind === 'video' ? 'prioritize_continuity; do_not_create_blocking_masks_without_clean_plate' : 'not_applicable'
    },
    output: requestedKind === 'video' ? {
      container: 'mp4',
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      resolutionPolicy: '720p_short_edge_720_preserve_aspect_even_dimensions_no_crop_no_pad',
      frameRate: { mode: 'preserve_exact', value: sourceMetadata.frameRate },
      durationSec: sourceMetadata.durationSec,
      frameOrder: 'preserve_exactly_once',
      audio: false,
      maxSegmentDurationSec: 15,
      segments: outputs,
      overwrite: false
    } : {
      format: 'png',
      colorMode: 'pure_grayscale_depth_only',
      width: sourceMetadata.width,
      height: sourceMetadata.height,
      preserveComposition: true,
      outputPath: outputs[0].outputPath,
      overwrite: false
    }
  };
  const planFingerprint = stableHash(contract);
  return {
    plan: { ...contract, planFingerprint, createdAt },
    instructionText: instruction
  };
}
