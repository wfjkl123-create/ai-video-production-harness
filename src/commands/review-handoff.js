import { randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { inspectArtifactFile, verifyArtifactFile } from '../services/artifact-file-service.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';

function preparedFor(project, input) {
  const matches = (project.artifacts ?? []).filter(({ id }) => id === input.preparedHandoffId);
  if (matches.length !== 1) throw new Error('prepared handoff must match exactly one active project artifact');
  const prepared = matches[0];
  if (prepared.type !== 'handoff' || prepared.prepared !== true || prepared.status !== 'awaiting_review') {
    throw new Error('prepared handoff must remain awaiting_review');
  }
  return prepared;
}

export async function runReviewHandoff(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const inputRecordedPath = option(args, 'input');
  const decision = option(args, 'decision');
  const note = option(args, 'note');
  const correction = option(args, 'correction', { required: false });
  if (!['approved', 'rejected'].includes(decision)) throw new Error('--decision must be approved or rejected');
  if (decision === 'rejected' && (!correction || correction.trim() === '')) throw new Error('--correction is required when rejecting a handoff');

  return withProjectLock(root, async () => {
    const project = await readJson(join(root, 'project-state.json'));
    const inputFile = await inspectArtifactFile(root, inputRecordedPath);
    const input = await readJson(inputFile.path);
    const prepared = preparedFor(project, input);
    const preparedFile = await verifyArtifactFile(root, prepared);
    const source = (project.artifacts ?? []).find(({ id }) => id === prepared.sourceVideoId);
    if (!source || source.type !== 'video_segment' || source.status !== 'locked'
      || source.sha256?.toLowerCase() !== prepared.sourceVideoSha256?.toLowerCase()) {
      throw new Error('prepared handoff source video must match its active locked artifact and checksum');
    }
    const sourceFile = await verifyArtifactFile(root, source);
    const id = options.id ?? `review-handoff-${randomUUID()}`;
    const reviewPath = join(root, 'reviews', `${encodeURIComponent(id)}.json`);
    try {
      await readJson(reviewPath);
      throw new Error(`handoff review ${id} already exists`);
    } catch (error) {
      if (/already exists/.test(error.message)) throw error;
    }
    const review = {
      id,
      kind: 'handoff_observation',
      actor: 'human',
      decision,
      note: note.trim(),
      ...(correction ? { correction: correction.trim() } : {}),
      inputPath: relative(root, inputFile.path).split(sep).join('/'),
      inputSha256: inputFile.sha256,
      preparedHandoffId: prepared.id,
      preparedHandoffSha256: preparedFile.sha256,
      sourceVideoId: source.id,
      sourceVideoSha256: sourceFile.sha256,
      reviewedAt: new Date().toISOString()
    };
    await writeJsonAtomic(reviewPath, review);
    return review;
  });
}
