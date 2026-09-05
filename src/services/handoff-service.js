import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertArtifact } from '../domain/artifact.js';
import { runProcess } from '../adapters/process-runner.js';
import { sha256File } from '../storage/checksum.js';

export const FFMPEG_UNAVAILABLE_REASON = 'ffmpeg is unavailable; install ffmpeg and ensure it is on PATH';
export const FFPROBE_UNAVAILABLE_REASON = 'ffprobe is unavailable; install ffmpeg and ensure ffprobe is on PATH';

const BASES = new Set(['observed', 'multi_frame_inference']);
const CANONICAL_HD_RESTORATION_DERIVATIONS = new Set(['canonical_hd_reconstruction', 'articulated_mannequin_replacement']);
const LEFT_RIGHT = new Set(['left', 'center', 'right', 'unknown']);
const DEPTH = new Set(['foreground', 'midground', 'background', 'unknown']);
const BASE_EVIDENCE_FIELDS = Object.freeze(['people', 'distances', 'productState', 'props', 'camera', 'openMotion', 'unknowns']);
const REALISM_V2_EVIDENCE_FIELDS = Object.freeze([...BASE_EVIDENCE_FIELDS, 'light', 'audio', 'identity']);

function evidenceFields(realismContractsVersion) {
  return realismContractsVersion === 2 ? REALISM_V2_EVIDENCE_FIELDS : BASE_EVIDENCE_FIELDS;
}

function isOutside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value;
}

async function approvedVideo(videoPath, options) {
  const artifact = options.videoArtifact;
  if (!artifact || artifact.type !== 'video_segment') throw new Error('videoArtifact must be an approved video_segment');
  assertArtifact(artifact);
  if (artifact.status !== 'locked') throw new Error('video segment must be locked by human review');
  if (typeof artifact.lockedByReviewId !== 'string' || artifact.lockedByReviewId.trim() === '') throw new Error('video segment lockedByReviewId is required');
  if (typeof options.projectRoot !== 'string' || options.projectRoot.trim() === '') throw new Error('projectRoot is required');
  const requestedRoot = resolve(options.projectRoot);
  const projectRoot = await realpath(requestedRoot);
  if (isAbsolute(artifact.path) || isOutside(requestedRoot, resolve(requestedRoot, artifact.path))) throw new Error('approved video must stay inside project root');
  const recordedPath = resolve(projectRoot, relative(requestedRoot, resolve(requestedRoot, artifact.path)));
  let actual;
  let metadata;
  try {
    actual = await realpath(recordedPath);
    if (isOutside(projectRoot, actual)) throw new Error('approved video symlink escapes project root');
    metadata = await stat(actual);
    await access(actual, constants.R_OK);
  } catch (error) {
    if (/symlink escapes project root/.test(error.message)) throw error;
    throw new Error('approved video must be a readable regular file');
  }
  if (!metadata.isFile()) throw new Error('approved video must be a readable regular file');
  let requested;
  try {
    requested = await realpath(resolve(videoPath));
  } catch {
    throw new Error('approved video must be a readable regular file');
  }
  if (requested !== actual) throw new Error('videoPath must match the approved video artifact path');
  if (await sha256File(actual) !== artifact.sha256.toLowerCase()) throw new Error('approved video checksum mismatch');
  return { artifact, actual, projectRoot, requestedRoot };
}

function blocked(artifact, reason) {
  return { status: 'blocked', blockedReason: reason, segmentId: artifact.segmentId, candidates: [] };
}

async function probeDuration(actual, artifact, runner, options, projectRoot) {
  const executable = options.ffprobeExecutable ?? 'ffprobe';
  let result;
  try {
    result = await runner(executable, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', actual
    ], { cwd: projectRoot, shell: false });
  } catch (error) {
    if (error.code === 'ENOENT') return blocked(artifact, FFPROBE_UNAVAILABLE_REASON);
    throw error;
  }
  if (result.code === 127) return blocked(artifact, FFPROBE_UNAVAILABLE_REASON);
  if (result.code !== 0) throw new Error(`ffprobe duration probe failed (${result.code}): ${result.stderr ?? ''}`.trim());
  const duration = Number(String(result.stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe must return a finite positive duration');
  return duration;
}

function candidateTimestamps(duration) {
  const window = Math.min(3, duration);
  const start = duration - window;
  return Array.from({ length: 6 }, (_, index) => Number((start + window * (index + 0.5) / 6).toFixed(3)));
}

export async function extractCandidateFrames(videoPath, outputDir, options = {}) {
  const { artifact, actual, projectRoot, requestedRoot } = await approvedVideo(videoPath, options);
  const requestedOutput = resolve(outputDir);
  if (isOutside(requestedRoot, requestedOutput)) throw new Error('handoff output directory must stay inside project root');
  const output = resolve(projectRoot, relative(requestedRoot, requestedOutput));
  await mkdir(output, { recursive: true });
  const actualOutput = await realpath(output);
  if (isOutside(projectRoot, actualOutput)) throw new Error('handoff output directory symlink escapes project root');
  const runner = options.runner ?? runProcess;
  const probed = await probeDuration(actual, artifact, runner, options, projectRoot);
  if (typeof probed !== 'number') return probed;

  const attemptId = options.attemptId ?? randomUUID();
  const temporaryDirectory = join(actualOutput, `.attempt-${attemptId}`);
  const publishedDirectory = join(actualOutput, `attempt-${attemptId}`);
  await mkdir(temporaryDirectory);
  const timestamps = candidateTimestamps(probed);
  const candidates = [];
  try {
    for (const [index, timestamp] of timestamps.entries()) {
      const name = `candidate-${String(index + 1).padStart(2, '0')}-${timestamp.toFixed(3)}s.jpg`;
      const framePath = join(temporaryDirectory, name);
      const args = [
        '-hide_banner', '-loglevel', 'error', '-ss', timestamp.toFixed(3), '-i', actual,
        '-frames:v', '1', '-q:v', '2', '-n', framePath
      ];
      let result;
      try {
        result = await runner(options.ffmpegExecutable ?? 'ffmpeg', args, { cwd: projectRoot, shell: false });
      } catch (error) {
        if (error.code === 'ENOENT') return blocked(artifact, FFMPEG_UNAVAILABLE_REASON);
        throw error;
      }
      if (result.code === 127) return blocked(artifact, FFMPEG_UNAVAILABLE_REASON);
      if (result.code !== 0) throw new Error(`ffmpeg frame extraction failed (${result.code}): ${result.stderr ?? ''}`.trim());
      let metadata;
      try {
        metadata = await stat(framePath);
        await access(framePath, constants.R_OK);
      } catch {
        throw new Error(`ffmpeg did not create readable candidate frame ${index + 1}`);
      }
      if (!metadata.isFile()) throw new Error(`ffmpeg did not create readable candidate frame ${index + 1}`);
      candidates.push({ timestamp, name, sha256: await sha256File(framePath) });
    }
    await rename(temporaryDirectory, publishedDirectory);
    return {
      status: 'awaiting_review',
      blockedReason: null,
      segmentId: artifact.segmentId,
      actualDuration: probed,
      sourceVideoId: artifact.id,
      sourceVideoSha256: artifact.sha256.toLowerCase(),
      candidates: candidates.map(({ timestamp, name, sha256 }) => ({
        timestamp,
        path: relative(projectRoot, join(publishedDirectory, name)).split(sep).join('/'),
        sha256
      }))
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function createHandoffReview(segment, candidates) {
  if (!segment || segment.status !== 'locked' || typeof segment.lockedByReviewId !== 'string' || segment.lockedByReviewId.trim() === '') {
    throw new Error('segment must be locked by human review before handoff review');
  }
  if (!Array.isArray(candidates) || candidates.length !== 6) throw new Error('exactly six handoff candidates are required');
  const evidenceTimestamps = candidates.map(candidate => candidate.timestamp);
  if (evidenceTimestamps.some(value => !Number.isFinite(value) || value < 0)) throw new Error('candidate timestamps must be non-negative numbers');
  return {
    id: `handoff-prepared-${segment.id}`,
    type: 'handoff',
    revision: 1,
    segmentId: segment.id,
    status: 'awaiting_review',
    path: `outputs/${segment.id}/handoff-prepared.json`,
    prepared: true,
    candidateFrames: candidates.map(candidate => ({ ...candidate })),
    evidenceTimestamps
  };
}

function stringArray(value, name, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
}

function validateValue(name, value) {
  if (name === 'people') {
    if (!Array.isArray(value) || value.length === 0) throw new Error('people must be a non-empty array');
    for (const person of value) {
      if (!person || typeof person !== 'object' || !LEFT_RIGHT.has(person.leftRight) || !DEPTH.has(person.depth)) throw new Error('people contains an invalid position');
      for (const key of ['personId', 'bodyDirection', 'faceDirection', 'gaze']) nonEmpty(person[key], `people.${key}`);
    }
  } else if (name === 'distances') {
    if (!Array.isArray(value)) throw new Error('distances must be an array');
    for (const item of value) for (const key of ['from', 'to', 'distance']) nonEmpty(item?.[key], `distances.${key}`);
  } else if (name === 'productState') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('productState must be an object');
    nonEmpty(value.description, 'productState.description');
  } else if (name === 'props') {
    if (!Array.isArray(value)) throw new Error('props must be an array');
    for (const item of value) {
      nonEmpty(item?.propId, 'props.propId');
      nonEmpty(item?.state, 'props.state');
      if (item.holder !== null && item.holder !== undefined) nonEmpty(item.holder, 'props.holder');
    }
  } else if (name === 'camera') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('camera must be an object');
    for (const key of ['position', 'direction', 'shotSize']) nonEmpty(value[key], `camera.${key}`);
  } else if (name === 'openMotion' || name === 'unknowns') {
    stringArray(value, name);
  } else if (name === 'light' || name === 'audio') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
    nonEmpty(value.description, `${name}.description`);
  } else if (name === 'identity') {
    if (!Array.isArray(value) || value.length === 0) throw new Error('identity must be a non-empty array');
    for (const item of value) {
      nonEmpty(item?.personId, 'identity.personId');
      nonEmpty(item?.observedContinuity, 'identity.observedContinuity');
    }
  }
}

function containsInferenceFlag(value) {
  if (Array.isArray(value)) return value.some(containsInferenceFlag);
  return Boolean(value && typeof value === 'object' && (Object.hasOwn(value, 'inferred') || Object.values(value).some(containsInferenceFlag)));
}

function evidencedField(input, name, allowedTimestamps) {
  const field = input[name];
  if (!field || typeof field !== 'object' || Array.isArray(field) || !Object.hasOwn(field, 'value')) throw new Error(`${name} is required as an evidenced field`);
  if (!BASES.has(field.basis)) throw new Error(`${name} basis must be observed or multi_frame_inference`);
  if (containsInferenceFlag(field.value)) throw new Error(`${name} must represent inference only through basis`);
  if (!Array.isArray(field.timestamps) || field.timestamps.length === 0 || field.timestamps.some(value => !allowedTimestamps.has(value))) {
    throw new Error(`${name} timestamps must reference evidenceTimestamps`);
  }
  validateValue(name, field.value);
  return { value: structuredClone(field.value), basis: field.basis, timestamps: [...field.timestamps] };
}

function assertPrepared(input, prepared) {
  nonEmpty(input.preparedHandoffId, 'preparedHandoffId');
  if (!prepared) return;
  if (prepared.id !== input.preparedHandoffId || prepared.status !== 'awaiting_review' || prepared.prepared !== true || prepared.segmentId !== input.segmentId) {
    throw new Error('prepared handoff must match the review input and remain awaiting_review');
  }
  const candidateTimestamps = new Set((prepared.candidateFrames ?? []).map(({ timestamp }) => timestamp));
  if (candidateTimestamps.size !== 6 || input.evidenceTimestamps.some(value => !candidateTimestamps.has(value))) {
    throw new Error('review evidence timestamps must match the prepared handoff candidates');
  }
}

export function recordObservedHandoff(reviewInput, prepared) {
  if (!reviewInput || typeof reviewInput !== 'object' || Array.isArray(reviewInput)) throw new TypeError('reviewInput must be an object');
  const id = nonEmpty(reviewInput.id, 'id');
  const segmentId = nonEmpty(reviewInput.segmentId, 'segmentId');
  const reviewId = nonEmpty(reviewInput.reviewId, 'reviewId');
  if (!Array.isArray(reviewInput.evidenceTimestamps) || reviewInput.evidenceTimestamps.length === 0
    || reviewInput.evidenceTimestamps.some(value => !Number.isFinite(value) || value < 0)) throw new Error('evidenceTimestamps must contain non-negative numbers');
  assertPrepared(reviewInput, prepared);
  if (reviewInput.decision === 'rejected') {
    return { handoff: null, segment: { id: segmentId, status: 'rework', correction: nonEmpty(reviewInput.correction, 'correction'), rejectedByReviewId: reviewId } };
  }
  if (reviewInput.decision !== 'approved') throw new Error('decision must be approved or rejected');
  const realismContractsVersion = reviewInput.realismContractsVersion === 2 ? 2 : 1;
  const allowedTimestamps = new Set(reviewInput.evidenceTimestamps);
  const fields = Object.fromEntries(evidenceFields(realismContractsVersion).map(name => [name, evidencedField(reviewInput, name, allowedTimestamps)]));
  const artifact = {
    id, type: 'handoff', revision: Number.isInteger(reviewInput.revision) && reviewInput.revision > 0 ? reviewInput.revision : 1,
    status: 'locked', path: `outputs/${segmentId}/observed-handoff.json`, lockedByReviewId: reviewId,
    segmentId, observed: true, realismContractsVersion, acceptedDeviation: reviewInput.acceptDeviation === true,
    preparedHandoffId: reviewInput.preparedHandoffId,
    preparedHandoffSha256: prepared?.sha256,
    sourceVideoId: prepared?.sourceVideoId,
    sourceVideoSha256: prepared?.sourceVideoSha256,
    evidenceTimestamps: [...reviewInput.evidenceTimestamps], ...fields
  };
  assertArtifact(artifact);
  return { handoff: artifact, segment: null };
}

export function assertObservedHandoffArtifact(artifact) {
  if (!artifact || artifact.type !== 'handoff' || artifact.status !== 'locked' || artifact.observed !== true) {
    throw new Error('observed handoff artifact must be locked and observed');
  }
  assertArtifact(artifact);
  nonEmpty(artifact.preparedHandoffId, 'preparedHandoffId');
  nonEmpty(artifact.sourceVideoId, 'sourceVideoId');
  for (const field of ['preparedHandoffSha256', 'sourceVideoSha256']) {
    if (!/^[a-f0-9]{64}$/.test(artifact[field] ?? '')) throw new Error(`${field} must be a SHA-256 checksum`);
  }
  if (!Array.isArray(artifact.evidenceTimestamps) || artifact.evidenceTimestamps.length === 0) {
    throw new Error('evidenceTimestamps must contain non-negative numbers');
  }
  const allowed = new Set(artifact.evidenceTimestamps);
  for (const name of evidenceFields(artifact.realismContractsVersion === 2 ? 2 : 1)) evidencedField(artifact, name, allowed);
  return artifact;
}

export function assertCanonicalHdRestorationHandoffArtifact(artifact) {
  if (!artifact || artifact.type !== 'handoff' || artifact.status !== 'locked') {
    throw new Error('canonical HD restoration handoff artifact must be locked');
  }
  assertArtifact(artifact);
  if (artifact.observed !== false) throw new Error('canonical HD restoration handoff artifact must set observed to false');
  if (artifact.handoffKind !== 'canonical_hd_restoration') {
    throw new Error('canonical HD restoration handoff artifact must declare handoffKind canonical_hd_restoration');
  }
  if (!CANONICAL_HD_RESTORATION_DERIVATIONS.has(artifact.derivation)) {
    throw new Error(`canonical HD restoration handoff derivation must be one of ${[...CANONICAL_HD_RESTORATION_DERIVATIONS].join(', ')}`);
  }
  nonEmpty(artifact.sourceArtifactId, 'sourceArtifactId');
  if (!/^[a-f0-9]{64}$/.test(artifact.sourceArtifactSha256 ?? '')) {
    throw new Error('sourceArtifactSha256 must be a SHA-256 checksum');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
    throw new Error('sha256 must be a SHA-256 checksum');
  }
  if (artifact.sha256 === artifact.sourceArtifactSha256) {
    throw new Error('canonical HD restoration handoff must have a fresh sha256 distinct from the source artifact');
  }
  return artifact;
}
