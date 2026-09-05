import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { isDeepStrictEqual } from 'node:util';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { sha256File } from '../storage/checksum.js';
import { recordObservedHandoff } from '../services/handoff-service.js';
import { createHash } from 'node:crypto';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { verifyLockedArtifact } from '../services/artifact-file-service.js';

function outside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function guardedInput(root, input) {
  const requestedRoot = resolve(root);
  const requested = isAbsolute(input) ? resolve(input) : resolve(requestedRoot, input);
  if (outside(requestedRoot, requested)) throw new Error('handoff review input must stay inside project root');
  const actualRoot = await realpath(requestedRoot);
  let actual;
  let metadata;
  try {
    actual = await realpath(requested);
    if (outside(actualRoot, actual)) throw new Error('handoff review input symlink escapes project root');
    metadata = await stat(actual);
    await access(actual, constants.R_OK);
  } catch (error) {
    if (/symlink escapes project root/.test(error.message)) throw error;
    throw new Error('handoff review input must be a readable regular file');
  }
  if (!metadata.isFile()) throw new Error('handoff review input must be a readable regular file');
  return actual;
}

function preparedFor(project, input) {
  const matches = (project.artifacts ?? []).filter(({ id }) => id === input.preparedHandoffId);
  if (matches.length !== 1) throw new Error('prepared handoff must match exactly one active project artifact');
  return matches[0];
}

async function verifiedFile(root, recordedPath, label) {
  if (typeof recordedPath !== 'string' || isAbsolute(recordedPath) || outside(root, resolve(root, recordedPath))) {
    throw new Error(`${label} must stay inside project root`);
  }
  const actualRoot = await realpath(root);
  let actual;
  let metadata;
  try {
    actual = await realpath(resolve(root, recordedPath));
    if (outside(actualRoot, actual)) throw new Error(`${label} symlink escapes project root`);
    metadata = await stat(actual);
    await access(actual, constants.R_OK);
  } catch (error) {
    if (/symlink escapes project root/.test(error.message)) throw error;
    throw new Error(`${label} must be a readable regular file`);
  }
  if (!metadata.isFile()) throw new Error(`${label} must be a readable regular file`);
  return actual;
}

async function verifyPreparation(root, project, prepared) {
  const persistedPath = await verifiedFile(root, prepared.path, 'prepared handoff record');
  const persisted = await readJson(persistedPath);
  const { sha256, ...preparedPayload } = prepared;
  if (!isDeepStrictEqual(persisted, preparedPayload)) throw new Error('persisted prepared handoff must match project state');
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || await sha256File(persistedPath) !== sha256) {
    throw new Error('prepared handoff record checksum mismatch');
  }
  const source = (project.artifacts ?? []).find(({ id }) => id === prepared.sourceVideoId);
  if (!source || source.type !== 'video_segment' || source.status !== 'locked' || source.sha256?.toLowerCase() !== prepared.sourceVideoSha256) {
    throw new Error('prepared handoff source video must match its active locked artifact and checksum');
  }
  const sourcePath = await verifiedFile(root, source.path, 'prepared source video');
  if (await sha256File(sourcePath) !== prepared.sourceVideoSha256) throw new Error('prepared source video checksum mismatch');
  if (!Array.isArray(prepared.candidateFrames) || prepared.candidateFrames.length !== 6) throw new Error('prepared handoff must contain six candidates');
  for (const candidate of prepared.candidateFrames) {
    const path = await verifiedFile(root, candidate.path, 'prepared candidate');
    if (!/^[a-f0-9]{64}$/.test(candidate.sha256 ?? '') || await sha256File(path) !== candidate.sha256) {
      throw new Error('prepared candidate checksum mismatch');
    }
  }
}

function lockedSegmentation(project) {
  const items = (project.artifacts ?? [])
    .filter(({ type, status }) => type === 'segmentation' && status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (items.length === 0) throw new Error('a locked canonical segmentation artifact is required for handoff rejection');
  if (items.length > 1 && items[0].revision === items[1].revision) throw new Error(`multiple locked segmentation artifacts have revision ${items[0].revision}`);
  return items[0];
}

async function rejectHandoff(root, project, input, result) {
  const source = lockedSegmentation(project);
  await verifyLockedArtifact(root, source);
  if (isAbsolute(source.path) || outside(root, resolve(root, source.path))) throw new Error('canonical segmentation path must stay inside project root');
  const canonical = await readJson(resolve(root, source.path));
  const segments = Array.isArray(canonical) ? canonical : canonical.segments;
  if (!Array.isArray(segments)) throw new Error('canonical segmentation must contain segments');
  const matches = segments.filter(({ id }) => id === result.segment.id);
  if (matches.length !== 1) throw new Error(`canonical segment ${result.segment.id} must appear exactly once`);
  const revisedSegments = segments.map(segment => segment.id === result.segment.id
    ? { ...segment, status: 'rework', correction: result.segment.correction, rejectedByReviewId: input.reviewId }
    : segment);
  const revision = source.revision + 1;
  const segmentationId = `segmentation-${result.segment.id}-rework-r${revision}`;
  const artifactReviewId = `review-${segmentationId}`;
  const segmentation = {
    id: segmentationId,
    type: 'segmentation', revision, status: 'locked',
    path: `segments/versions/${segmentationId}.json`,
    lockedByReviewId: artifactReviewId
  };
  const segmentationPayload = { segments: revisedSegments };
  const segmentationSha256 = createHash('sha256').update(`${JSON.stringify(segmentationPayload, null, 2)}\n`).digest('hex');
  segmentation.sha256 = segmentationSha256;
  const artifactReview = {
    id: artifactReviewId, artifactId: segmentation.id, actor: 'human', decision: 'approved',
    note: 'immutable rework segmentation derived from human handoff rejection',
    artifactSha256: segmentationSha256, derivedFromReviewId: input.reviewId, createdAt: new Date().toISOString()
  };
  const rejectionPath = join(root, 'reviews', `${result.segment.id}-handoff-rejection.json`);
  project.artifacts = (project.artifacts ?? []).map(artifact => artifact.type === 'handoff' && artifact.segmentId === result.segment.id
    ? { ...artifact, status: 'rejected', rejectedByReviewId: input.reviewId }
    : artifact);
  project.artifacts.push(segmentation);
  project.phase = 'rework';
  project.activeSegmentId = result.segment.id;
  project.blockedReason = null;
  project.updatedAt = new Date().toISOString();
  await commitJsonTransaction(root, `handoff-reject-${input.reviewId}`, [
    { path: join(root, segmentation.path), value: segmentationPayload },
    { path: rejectionPath, value: result.segment },
    { path: join(root, 'reviews', `${artifactReviewId}.json`), value: artifactReview },
    { path: join(root, 'project-state.json'), value: project }
  ]);
  return { ...result, path: rejectionPath, segmentation };
}

async function verifiedReview(root, reviewId, inputFile, prepared) {
  let review;
  try {
    review = await readJson(join(root, 'reviews', `${encodeURIComponent(reviewId)}.json`));
  } catch {
    throw new Error('handoff review record must be a readable regular file');
  }
  if (review.kind !== 'handoff_observation' || review.actor !== 'human'
    || !['approved', 'rejected'].includes(review.decision)
    || review.inputSha256 !== inputFile.sha256
    || review.preparedHandoffId !== prepared.id
    || review.preparedHandoffSha256 !== prepared.sha256
    || review.sourceVideoId !== prepared.sourceVideoId
    || review.sourceVideoSha256 !== prepared.sourceVideoSha256) {
    throw new Error('handoff review record binding does not match the prepared input and source video');
  }
  return review;
}

export async function runRecordHandoff(args) {
  const root = resolve(option(args, 'project'));
  const reviewId = option(args, 'review');
  const inputPath = await guardedInput(root, option(args, 'input'));
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const statePath = join(root, 'project-state.json');
    const project = await readJson(statePath);
    const input = await readJson(inputPath);
    const prepared = preparedFor(project, input);
    await verifyPreparation(root, project, prepared);
    const inputFile = { path: inputPath, sha256: await sha256File(inputPath) };
    const review = await verifiedReview(root, reviewId, inputFile, prepared);
    const reviewedInput = {
      ...input,
      realismContractsVersion: project.realismContractsVersion === 2 ? 2 : 1,
      reviewId: review.id,
      decision: review.decision,
      ...(review.correction ? { correction: review.correction } : {})
    };
    const result = recordObservedHandoff(reviewedInput, prepared);
    if (!result.handoff) return rejectHandoff(root, project, reviewedInput, result);

    const handoffPayload = result.handoff;
    const handoffSha256 = createHash('sha256').update(`${JSON.stringify(handoffPayload, null, 2)}\n`).digest('hex');
    const handoff = { ...handoffPayload, sha256: handoffSha256 };
    const handoffPath = join(root, handoff.path);
    const boundReview = { ...review, handoffArtifactId: handoff.id, handoffSha256 };
    const reviewedPreparation = { ...prepared, status: 'locked', lockedByReviewId: review.id };
    project.artifacts = (project.artifacts ?? []).filter(({ id }) => id !== handoff.id && id !== prepared.id);
    project.artifacts.push(reviewedPreparation, handoff);
    project.blockedReason = null;
    project.updatedAt = new Date().toISOString();
    await commitJsonTransaction(root, `handoff-approve-${review.id}`, [
      { path: handoffPath, value: handoffPayload },
      { path: join(root, 'reviews', `${encodeURIComponent(review.id)}.json`), value: boundReview },
      { path: statePath, value: project }
    ]);
    return { ...result, handoff };
  });
}
