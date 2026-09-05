import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { inspectArtifactFile } from './artifact-file-service.js';
import { compileSeedanceMediaBoundPrompt, verifySeedanceMediaTokenMapping } from './seedance-media-binding-service.js';
import { requireCleanSeedanceExecutionPrompt } from './seedance-prompt-lint-service.js';
import { assertShotNarration } from '../domain/shot-narration.js';
import {
  assertPromptContainsEmotionPerformanceContinuity,
  assertPromptExcludesEmotionPerformanceCapsule,
  renderEmotionPerformanceContinuityBlocks
} from '../domain/emotion-performance.js';

const SHA256 = /^[a-f0-9]{64}$/;
const KINDS = new Set(['image', 'video', 'audio']);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function projectPath(value, field) {
  text(value, field);
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`);
}

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertMedia(item, field) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`${field} must be an object`);
  text(item.id, `${field}.id`);
  if (!KINDS.has(item.mediaKind)) throw new TypeError(`${field}.mediaKind must be image, video, or audio`);
  projectPath(item.path, `${field}.path`);
  if (!SHA256.test(item.sha256 ?? '')) throw new TypeError(`${field}.sha256 must be a lowercase SHA-256`);
  if (!Array.isArray(item.controls) || item.controls.length === 0) throw new TypeError(`${field}.controls must be non-empty`);
  if (!Array.isArray(item.mustNotControl) || item.mustNotControl.length === 0) throw new TypeError(`${field}.mustNotControl must be non-empty`);
  item.controls.forEach((entry, index) => text(entry, `${field}.controls[${index}]`));
  item.mustNotControl.forEach((entry, index) => text(entry, `${field}.mustNotControl[${index}]`));
  if (item.derived !== true) text(item.lockedByReviewId, `${field}.lockedByReviewId`);
  if (item.derived === true) {
    text(item.derivedFromArtifactId, `${field}.derivedFromArtifactId`);
    text(item.derivedFromReviewId, `${field}.derivedFromReviewId`);
    if (!item.trim || typeof item.trim.start !== 'number' || typeof item.trim.end !== 'number' || item.trim.start < 0 || item.trim.end <= item.trim.start) {
      throw new TypeError(`${field}.trim must contain a valid numeric start/end range`);
    }
  }
}

export function assertSeedanceClipPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('clip plan must be an object');
  text(value.id, 'id');
  text(value.parentSegmentId, 'parentSegmentId');
  if (!Array.isArray(value.clips) || value.clips.length !== 2) throw new TypeError('clip plan requires exactly two clips');
  const ids = new Set();
  for (const [index, clip] of value.clips.entries()) {
    text(clip.id, `clips[${index}].id`);
    if (ids.has(clip.id)) throw new TypeError(`duplicate clip id: ${clip.id}`);
    ids.add(clip.id);
    if (clip.parentSegmentId !== value.parentSegmentId) throw new TypeError(`${clip.id} parentSegmentId must match the plan`);
    if (typeof clip.start !== 'number' || typeof clip.end !== 'number' || clip.start < 0 || clip.end <= clip.start || clip.end - clip.start > 15) {
      throw new TypeError(`${clip.id} requires a valid range no longer than 15 seconds`);
    }
    if (!Number.isInteger(clip.generationDuration) || clip.generationDuration < Math.ceil(clip.end - clip.start) || clip.generationDuration > 15) {
      throw new TypeError(`${clip.id}.generationDuration must be an integer covering the editorial duration and no longer than 15 seconds`);
    }
    projectPath(clip.promptPath, `${clip.id}.promptPath`);
    projectPath(clip.narrationPath, `${clip.id}.narrationPath`);
    projectPath(clip.outputDirectory, `${clip.id}.outputDirectory`);
    if (!Array.isArray(clip.media) || clip.media.length === 0) throw new TypeError(`${clip.id}.media must be non-empty`);
    clip.media.forEach((item, mediaIndex) => assertMedia(item, `${clip.id}.media[${mediaIndex}]`));
    const audio = clip.media.filter(item => item.mediaKind === 'audio');
    if (audio.length !== 1 || audio[0].derived !== true) throw new TypeError(`${clip.id} requires exactly one derived clip audio input`);
    if (Math.abs(audio[0].trim.start - clip.start) > 0.000001 || Math.abs(audio[0].trim.end - clip.end) > 0.000001) {
      throw new TypeError(`${clip.id} derived audio trim must exactly match the clip range`);
    }
  }
  const ordered = [...value.clips].sort((a, b) => a.start - b.start);
  if (Math.abs(ordered[0].end - ordered[1].start) > 0.000001) throw new TypeError('clip ranges must be contiguous');
  return value;
}

// Clip prompts may place exact performance-continuity blocks immediately after the
// shot they constrain. Preserve that director-authored placement. Older clip plans
// that omit the blocks keep the legacy append-at-tail behavior for compatibility.
export function composeClipPrompt(sourcePrompt, narration) {
  const source = `${sourcePrompt.trim()}\n`;
  const continuity = renderEmotionPerformanceContinuityBlocks(narration);
  if (!continuity) return source;
  try {
    assertPromptContainsEmotionPerformanceContinuity(source, narration);
    return source;
  } catch {
    return `${sourcePrompt.trim()}\n\n${continuity}\n`;
  }
}

async function verifyFile(root, item) {
  const inspected = await inspectArtifactFile(root, item.path);
  if (inspected.sha256 !== item.sha256) throw new Error(`clip media checksum changed for ${item.id}`);
}

function selectedMedia(clip) {
  const grouped = { imageInputs: [], videoInputs: [], audioInputs: [] };
  const field = { image: 'imageInputs', video: 'videoInputs', audio: 'audioInputs' };
  for (const item of clip.media) grouped[field[item.mediaKind]].push({ id: item.id, path: item.path, sha256: item.sha256, status: 'locked' });
  return grouped;
}

function responsibilities(clip) {
  return Object.fromEntries(clip.media.map(item => [item.id, { controls: [...item.controls], mustNotControl: [...item.mustNotControl] }]));
}

export async function compileSeedanceClips(root, state, rawPlan, options = {}) {
  const plan = assertSeedanceClipPlan(rawPlan);
  const parent = (state.artifacts ?? []).find(item => item.type === 'segmentation' && item.status === 'locked');
  if (!parent) throw new Error('a locked segmentation artifact is required');
  const outputs = [];
  for (const clip of plan.clips) {
    const videoInputs = clip.media.filter(item => item.mediaKind === 'video');
    if (videoInputs.length > 0 && options.allowVideoInputs !== true) {
      throw new Error(`video inputs are disabled by default because they increase credit consumption; explicit user confirmation is required before uploading: ${videoInputs.map(item => item.id).join(', ')}`);
    }
    for (const item of clip.media) {
      await verifyFile(root, item);
      if (item.derived === true) {
        const source = (state.artifacts ?? []).find(candidate => candidate.id === item.derivedFromArtifactId);
        if (!source || source.status !== 'locked' || source.lockedByReviewId !== item.derivedFromReviewId) throw new Error(`derived media source is not locked for ${item.id}`);
      } else {
        const source = (state.artifacts ?? []).find(candidate => candidate.id === item.id);
        if (!source || source.status !== 'locked' || source.lockedByReviewId !== item.lockedByReviewId || source.sha256 !== item.sha256) {
          throw new Error(`clip media is not locked at the declared SHA for ${item.id}`);
        }
      }
    }
    const sourcePrompt = await readFile(resolve(root, clip.promptPath), 'utf8');
    const narration = assertShotNarration(JSON.parse(await readFile(resolve(root, clip.narrationPath), 'utf8')));
    if (narration.segmentId !== clip.id || narration.sourceSegmentId !== plan.parentSegmentId) throw new Error(`narration identity mismatch for ${clip.id}`);
    const prompt = composeClipPrompt(sourcePrompt, narration);
    assertPromptExcludesEmotionPerformanceCapsule(prompt);
    assertPromptContainsEmotionPerformanceContinuity(prompt, narration);
    const selected = selectedMedia(clip);
    const responsibilityMap = responsibilities(clip);
    const base = {
      clipId: clip.id,
      parentSegmentId: plan.parentSegmentId,
      start: clip.start,
      end: clip.end,
      duration: clip.generationDuration,
      editorialDuration: Number((clip.end - clip.start).toFixed(6)),
      postGenerationTrim: { start: 0, end: Number((clip.end - clip.start).toFixed(6)) },
      ratio: '9:16',
      resolution: clip.resolution ?? '480p',
      sourcePromptPath: clip.promptPath,
      promptPath: `${clip.outputDirectory}/execution-prompt.txt`,
      ...selected,
      responsibilityMap,
      excludedInputs: [],
      hardRuleIds: []
    };
    const bound = compileSeedanceMediaBoundPrompt(prompt, base);
    verifySeedanceMediaTokenMapping(prompt, bound.text, bound.mediaTokenMappingManifest);
    requireCleanSeedanceExecutionPrompt(bound.text, { bindings: bound.bindings });
    const promptSha256 = digest(bound.text);
    const packagePayload = {
      ...base,
      mediaBindingContractVersion: bound.contractVersion,
      mediaBindings: bound.bindings,
      sourceBodySha256: digest(prompt),
      compiledBodySha256: promptSha256,
      mediaTokenMappingManifest: bound.mediaTokenMappingManifest,
      promptSha256,
      governanceBindings: {
        parentSegmentation: { id: parent.id, sha256: parent.sha256, lockedByReviewId: parent.lockedByReviewId },
        narration: { id: narration.id, sha256: digest(`${JSON.stringify(narration, null, 2)}\n`) },
        derivedMedia: clip.media.filter(item => item.derived === true).map(item => ({ id: item.id, sha256: item.sha256, derivedFromArtifactId: item.derivedFromArtifactId, derivedFromReviewId: item.derivedFromReviewId, trim: item.trim }))
      }
    };
    packagePayload.packageFingerprint = digest(`${JSON.stringify(packagePayload, null, 2)}\n`);
    outputs.push({ clip, executionPrompt: bound.text, packagePayload });
  }
  return outputs;
}
