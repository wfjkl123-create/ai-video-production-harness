import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import * as handoff from '../../src/services/handoff-service.js';
import { compileAssetManifest } from '../../src/services/asset-service.js';
import { submitForReview } from '../../src/services/review-service.js';
import { loadCanonicalSegments } from '../../src/commands/assets.js';

const videoContents = 'approved local video bytes';
const videoSha256 = createHash('sha256').update(videoContents).digest('hex');

async function approvedVideoProject() {
  const root = await mkdtemp(join(tmpdir(), 'handoff-project-'));
  const relativePath = 'outputs/segment-001/approved.mp4';
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, videoContents);
  return {
    root,
    path,
    artifact: {
      id: 'video-segment-001',
      type: 'video_segment',
      revision: 1,
      status: 'locked',
      path: relativePath,
      sha256: videoSha256,
      lockedByReviewId: 'review-video-segment-001',
      segmentId: 'segment-001',
      duration: 10
    }
  };
}

function fakeMediaTools(calls, duration = 10) {
  return async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === 'ffprobe') return { code: 0, stdout: `${duration}\n`, stderr: '' };
    await writeFile(args.at(-1), `frame at ${args[args.indexOf('-ss') + 1]}`);
    return { code: 0, stdout: '', stderr: '' };
  };
}

test('probes actual duration and extracts six timestamped frames across its final three seconds with shell disabled', async () => {
  const { root, path, artifact } = await approvedVideoProject();
  const calls = [];
  const result = await handoff.extractCandidateFrames(path, join(root, 'outputs/segment-001/handoff-candidates'), {
    projectRoot: root,
    videoArtifact: { ...artifact, duration: 999 },
    runner: fakeMediaTools(calls, 10)
  });

  assert.equal(result.status, 'awaiting_review');
  assert.equal(result.actualDuration, 10);
  assert.deepEqual(result.candidates.map(({ timestamp }) => timestamp), [7.25, 7.75, 8.25, 8.75, 9.25, 9.75]);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0].args.slice(0, 6), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1']);
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.ok(calls.slice(1).every(({ executable, args }) => executable === 'ffmpeg' && args.includes('-frames:v') && args.includes('1') && args.includes('-n')));
  assert.ok(result.candidates.every(({ path: candidatePath }) => !candidatePath.startsWith('/') && candidatePath.endsWith('.jpg')));
  assert.equal(new Set(result.candidates.map(({ path: candidatePath }) => dirname(candidatePath))).size, 1);
});

test('samples six intervals across the complete actual duration when the clip is shorter than three seconds', async () => {
  const { root, path, artifact } = await approvedVideoProject();
  const result = await handoff.extractCandidateFrames(path, join(root, 'outputs/segment-001/handoff-candidates'), {
    projectRoot: root, videoArtifact: artifact, runner: fakeMediaTools([], 2)
  });
  assert.deepEqual(result.candidates.map(({ timestamp }) => timestamp), [0.167, 0.5, 0.833, 1.167, 1.5, 1.833]);
});

test('refuses unlocked, unreviewed, tampered, missing, traversing, and escaping-symlink video inputs', async () => {
  const { root, path, artifact } = await approvedVideoProject();
  const outputDir = join(root, 'outputs/segment-001/handoff-candidates');
  const runner = async () => { throw new Error('runner must not execute'); };
  for (const [changed, pattern] of [
    [{ ...artifact, status: 'awaiting_review' }, /locked by human review/],
    [{ ...artifact, lockedByReviewId: ' ' }, /lockedByReviewId/],
    [{ ...artifact, sha256: '0'.repeat(64) }, /checksum mismatch/],
    [{ ...artifact, path: 'outputs/segment-001/missing.mp4' }, /readable regular file/],
    [{ ...artifact, path: '../outside.mp4' }, /inside project root/]
  ]) {
    await assert.rejects(handoff.extractCandidateFrames(path, outputDir, {
      projectRoot: root, videoArtifact: changed, runner
    }), pattern);
  }

  const outsideRoot = await mkdtemp(join(tmpdir(), 'handoff-outside-'));
  const outside = join(outsideRoot, 'outside.mp4');
  await writeFile(outside, videoContents);
  const linkPath = join(root, 'outputs/segment-001/link.mp4');
  await symlink(outside, linkPath);
  await assert.rejects(handoff.extractCandidateFrames(linkPath, outputDir, {
    projectRoot: root,
    videoArtifact: { ...artifact, path: 'outputs/segment-001/link.mp4' },
    runner
  }), /symlink.*escapes project root/);
});

test('blocks on unavailable probe or ffmpeg and cleans only the unique failed attempt', async () => {
  const { root, path, artifact } = await approvedVideoProject();
  const outputDir = join(root, 'outputs/segment-001/handoff-candidates');
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'preserved.jpg'), 'prior evidence');
  const probeBlocked = await handoff.extractCandidateFrames(path, outputDir, {
    projectRoot: root,
    videoArtifact: artifact,
    runner: async executable => { throw Object.assign(new Error(`spawn ${executable} ENOENT`), { code: 'ENOENT' }); }
  });
  assert.equal(probeBlocked.blockedReason, 'ffprobe is unavailable; install ffmpeg and ensure ffprobe is on PATH');
  assert.deepEqual(await readdir(outputDir), ['preserved.jpg']);

  let frame = 0;
  const ffmpegBlocked = await handoff.extractCandidateFrames(path, outputDir, {
    projectRoot: root, videoArtifact: artifact,
    runner: async (executable, args) => {
      if (executable === 'ffprobe') return { code: 0, stdout: '10', stderr: '' };
      frame += 1;
      if (frame === 3) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      await writeFile(args.at(-1), 'partial');
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(ffmpegBlocked.blockedReason, 'ffmpeg is unavailable; install ffmpeg and ensure it is on PATH');
  assert.deepEqual(await readdir(outputDir), ['preserved.jpg']);
});

test('rejects invalid probed duration and publishes retries as complete collision-free frame sets', async () => {
  const { root, path, artifact } = await approvedVideoProject();
  const outputDir = join(root, 'outputs/segment-001/handoff-candidates');
  for (const value of ['NaN', '0', '-1', 'Infinity']) {
    await assert.rejects(handoff.extractCandidateFrames(path, outputDir, {
      projectRoot: root, videoArtifact: artifact,
      runner: async executable => executable === 'ffprobe' ? { code: 0, stdout: value, stderr: '' } : assert.fail('ffmpeg must not run')
    }), /finite positive duration/);
  }
  const first = await handoff.extractCandidateFrames(path, outputDir, { projectRoot: root, videoArtifact: artifact, runner: fakeMediaTools([], 10) });
  const second = await handoff.extractCandidateFrames(path, outputDir, { projectRoot: root, videoArtifact: artifact, runner: fakeMediaTools([], 10) });
  assert.notEqual(dirname(first.candidates[0].path), dirname(second.candidates[0].path));
  assert.equal((await readdir(join(root, dirname(first.candidates[0].path)))).length, 6);
  assert.equal((await readdir(join(root, dirname(second.candidates[0].path)))).length, 6);
});

const field = (value, basis = 'observed', timestamps = [7.25, 8.75, 9.75]) => ({ value, basis, timestamps });

function observedInput(overrides = {}) {
  return {
    id: 'handoff-segment-001',
    segmentId: 'segment-001',
    reviewId: 'review-handoff-segment-001',
    decision: 'approved',
    acceptDeviation: true,
    preparedHandoffId: 'handoff-prepared-segment-001',
    evidenceTimestamps: [7.25, 8.75, 9.75],
    people: field([{ personId: 'person-1', leftRight: 'left', depth: 'foreground', bodyDirection: 'camera-right', faceDirection: 'toward-person-2', gaze: 'person-2' }]),
    distances: field([{ from: 'person-1', to: 'person-2', distance: 'one arm length' }]),
    productState: field({ description: 'worn and waistband flat' }),
    props: field([{ propId: 'phone', state: 'held upright', holder: 'person-2' }]),
    camera: field({ position: 'front-left medium distance', direction: 'toward room center', shotSize: 'medium' }),
    openMotion: field(['person-1 continues turning right'], 'multi_frame_inference'),
    unknowns: field(['exact lens focal length']),
    ...overrides
  };
}

test('creates a review with preserved evidence timestamps and records the complete observed contract', () => {
  const review = handoff.createHandoffReview(
    { id: 'segment-001', status: 'locked', lockedByReviewId: 'review-segment-001' },
    Array.from({ length: 6 }, (_, index) => ({ path: `outputs/frame-${index + 1}.jpg`, timestamp: 7.25 + index * 0.5 }))
  );
  assert.equal(review.status, 'awaiting_review');
  assert.deepEqual(review.evidenceTimestamps, [7.25, 7.75, 8.25, 8.75, 9.25, 9.75]);

  const result = handoff.recordObservedHandoff(observedInput());
  assert.equal(result.handoff.status, 'locked');
  assert.equal(result.handoff.observed, true);
  assert.equal(result.handoff.lockedByReviewId, 'review-handoff-segment-001');
  assert.equal(result.handoff.openMotion.basis, 'multi_frame_inference');
  assert.equal(result.handoff.productState.basis, 'observed');
  assert.equal(result.segment, null);
});

test('realism v2 observed handoff requires frame-bound light, audio and identity evidence', () => {
  const v2 = observedInput({
    realismContractsVersion: 2,
    light: field({ description: 'window key remains on screen-left' }),
    audio: field({ description: 'room tone and the last breath continue' }),
    identity: field([{ personId: 'person-1', observedContinuity: 'face, hair and proportions remain consistent' }])
  });
  const artifact = handoff.recordObservedHandoff(v2).handoff;
  assert.equal(artifact.realismContractsVersion, 2);
  assert.equal(artifact.identity.value[0].personId, 'person-1');
  const missingAudio = structuredClone(v2);
  delete missingAudio.audio;
  assert.throws(() => handoff.recordObservedHandoff(missingAudio), /audio is required/);
});

test('rejects missing fields, invalid bases, and an inferred field labeled as observed', () => {
  const missing = observedInput();
  delete missing.camera;
  assert.throws(() => handoff.recordObservedHandoff(missing), /camera is required/);
  assert.throws(() => handoff.recordObservedHandoff(observedInput({ people: field([], 'guess') })), /people.*basis/);
  assert.throws(() => handoff.recordObservedHandoff(observedInput({ people: field([{ personId: 'p', leftRight: 'diagonal', depth: 'near' }]) })), /people/);
  assert.throws(() => handoff.recordObservedHandoff(observedInput({ camera: field({ position: '', direction: 'x', shotSize: 'wide' }) })), /camera/);
  assert.throws(() => handoff.recordObservedHandoff(observedInput({ unknowns: field([3]) })), /unknowns/);
  assert.throws(() => handoff.recordObservedHandoff(observedInput({ props: { value: [], basis: 'observed' } })), /props.*timestamps/);
  assert.throws(() => handoff.recordObservedHandoff(observedInput({ evidenceTimestamps: [] })), /evidenceTimestamps/);
});

test('rejects non-canonical derivations and source binding mismatches for hd restoration handoff artifacts', () => {
  const source = { id: 'handoff-segment-001', sha256: 'f'.repeat(64) };
  const base = {
    id: 'handoff-restoration-001',
    type: 'handoff',
    revision: 1,
    status: 'locked',
    path: 'outputs/segment-001/canonical-handoff.json',
    lockedByReviewId: 'review-handoff-restoration-001',
    segmentId: 'segment-001',
    observed: false,
    handoffKind: 'canonical_hd_restoration',
    derivation: 'canonical_hd_reconstruction',
    sourceArtifactId: source.id,
    sourceArtifactSha256: source.sha256,
    sha256: 'e'.repeat(64)
  };

  assert.doesNotThrow(() => handoff.assertCanonicalHdRestorationHandoffArtifact(base));
  assert.throws(() => handoff.assertCanonicalHdRestorationHandoffArtifact({ ...base, derivation: 'upscale' }), /canonical HD restoration handoff derivation/);
  assert.throws(() => handoff.assertCanonicalHdRestorationHandoffArtifact({ ...base, derivation: 'raw_tail_frame' }), /canonical HD restoration handoff derivation/);
  assert.throws(() => handoff.assertCanonicalHdRestorationHandoffArtifact({ ...base, sourceArtifactSha256: base.sha256 }), /fresh sha256 distinct/);
  assert.throws(() => handoff.assertCanonicalHdRestorationHandoffArtifact({ ...base, observed: true }), /observed to false/);
});

test('accepted observed handoff unlocks the next-segment asset gate while rejection returns the segment to rework', () => {
  const approved = {
    ...handoff.recordObservedHandoff(observedInput()).handoff,
    preparedHandoffId: 'handoff-prepared-segment-001',
    preparedHandoffSha256: 'b'.repeat(64),
    sourceVideoId: 'video-segment-001',
    sourceVideoSha256: 'c'.repeat(64),
    sha256: 'd'.repeat(64)
  };
  const prior = { id: 'segment-001', status: 'locked', lockedByReviewId: 'review-segment-001', previousSegmentId: null, nextSegmentId: 'segment-002' };
  const next = { id: 'segment-002', status: 'locked', lockedByReviewId: 'review-segment-002', previousSegmentId: 'segment-001', nextSegmentId: null, projectAssetIds: [], segmentAssetRequirements: [] };
  const baseArtifacts = [
    { id: 'script', type: 'script', revision: 1, status: 'locked', path: 'brief/script.md', lockedByReviewId: 'review-script' },
    { id: 'shotlist', type: 'shotlist', revision: 1, status: 'locked', path: 'brief/shotlist.md', lockedByReviewId: 'review-shotlist' }
  ];
  const restoration = {
    id: 'handoff-restoration-segment-001', type: 'handoff', revision: 1, status: 'locked',
    path: 'outputs/segment-001/canonical-handoff.json', lockedByReviewId: 'review-handoff-restoration-segment-001',
    segmentId: 'segment-001', observed: false, handoffKind: 'canonical_hd_restoration',
    derivation: 'canonical_hd_reconstruction', sourceArtifactId: approved.id, sourceArtifactSha256: approved.sha256,
    sha256: 'e'.repeat(64)
  };
  const reconciliation = {
    id: 'handoff-reconciliation-segment-001-002', type: 'handoff_reconciliation', revision: 1, status: 'locked',
    path: 'outputs/segment-002/handoff-reconciliation.json', lockedByReviewId: 'review-handoff-reconciliation-segment-001-002',
    segmentId: 'segment-002', previousSegmentId: 'segment-001', nextSegmentId: 'segment-002', decision: 'PASS',
    observedHandoffId: approved.id, observedHandoffSha256: approved.sha256,
    sourceSegmentationId: 'segmentation-v2', sourceSegmentationSha256: 'f'.repeat(64),
    canonicalAuthorityArtifactIds: [], sha256: '1'.repeat(64)
  };
  const manifest = compileAssetManifest({
    realismContractsVersion: 2,
    segments: [prior, next], artifacts: [...baseArtifacts, approved, restoration, reconciliation], verifiedObservedHandoffIds: [approved.id]
  }, next);
  assert.equal(manifest.observedHandoffId, approved.id);
  assert.equal(manifest.canonicalHdRestorationHandoffId, restoration.id);

  const rejected = handoff.recordObservedHandoff(observedInput({ decision: 'rejected', correction: 'Ending pose is unusable' }));
  assert.equal(rejected.handoff, null);
  assert.equal(rejected.segment.status, 'rework');
  assert.equal(rejected.segment.id, 'segment-001');
  assert.equal(rejected.segment.correction, 'Ending pose is unusable');
});

test('schema publishes every handoff field and its two allowed evidence bases', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/handoff.schema.json', import.meta.url)));
  assert.deepEqual(schema.required, [
    'id', 'segmentId', 'status', 'observed', 'lockedByReviewId', 'evidenceTimestamps',
    'people', 'distances', 'productState', 'props', 'camera', 'openMotion', 'unknowns'
  ]);
  assert.deepEqual(schema.$defs.evidencedField.properties.basis.enum, ['observed', 'multi_frame_inference']);
  assert.deepEqual(schema.$defs.person.properties.leftRight.enum, ['left', 'center', 'right', 'unknown']);
  assert.deepEqual(schema.$defs.person.properties.depth.enum, ['foreground', 'midground', 'background', 'unknown']);
});

test('schema publishes canonical HD restoration derivation and source binding contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/canonical-hd-restoration-handoff.schema.json', import.meta.url)));
  assert.deepEqual(schema.required, [
    'id', 'type', 'revision', 'status', 'path', 'lockedByReviewId', 'segmentId',
    'observed', 'handoffKind', 'derivation', 'sourceArtifactId', 'sourceArtifactSha256', 'sha256'
  ]);
  assert.equal(schema.properties.type.const, 'handoff');
  assert.equal(schema.properties.observed.const, false);
  assert.equal(schema.properties.handoffKind.const, 'canonical_hd_restoration');
  assert.deepEqual(schema.properties.derivation.enum, ['canonical_hd_reconstruction', 'articulated_mannequin_replacement']);
});

test('prepare and record commands persist blocked extraction and approved observed handoff state', async () => {
  const { root, artifact } = await approvedVideoProject();
  await writeFile(join(root, 'project-state.json'), JSON.stringify({
    projectId: 'handoff-command', phase: 'handoff', activeSegmentId: 'segment-001', blockedReason: null,
    artifacts: [artifact], updatedAt: '2026-07-13T00:00:00.000Z'
  }));
  const { runPrepareHandoff } = await import('../../src/commands/prepare-handoff.js');
  const blocked = await runPrepareHandoff(['--project', root, '--artifact', artifact.id], {
    runner: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  });
  assert.equal(blocked.status, 'blocked');
  const blockedState = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  assert.equal(blockedState.blockedReason, handoff.FFPROBE_UNAVAILABLE_REASON);
  assert.equal(blockedState.artifacts.find(({ type }) => type === 'handoff').status, 'blocked');

  const prepared = await runPrepareHandoff(['--project', root, '--artifact', artifact.id], {
    runner: fakeMediaTools([], 10)
  });
  assert.equal(prepared.status, 'awaiting_review');
  const preparedState = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  const preparedArtifact = preparedState.artifacts.find(({ id }) => id === 'handoff-prepared-segment-001');
  assert.equal(preparedArtifact.status, 'awaiting_review');
  assert.equal(preparedState.artifacts.some(({ id, status }) => id === 'handoff-segment-001' && status === 'blocked'), false);
  assert.equal(preparedArtifact.sourceVideoId, artifact.id);
  assert.equal(preparedArtifact.sourceVideoSha256, artifact.sha256);
  assert.equal(preparedArtifact.candidateFrames.length, 6);

  const inputPath = join(root, 'reviews', 'observed-input.json');
  await mkdir(dirname(inputPath), { recursive: true });
  await writeFile(inputPath, JSON.stringify(observedInput()));
  const { runRecordHandoff } = await import('../../src/commands/record-handoff.js');
  const { runReviewHandoff } = await import('../../src/commands/review-handoff.js');
  await assert.rejects(
    runRecordHandoff(['--project', root, '--input', 'reviews/observed-input.json', '--review', 'forged-review']),
    /handoff review record.*readable regular file/
  );
  const candidatePath = join(root, preparedArtifact.candidateFrames[0].path);
  const originalCandidate = await readFile(candidatePath);
  const review = await runReviewHandoff([
    '--project', root, '--input', 'reviews/observed-input.json', '--decision', 'approved',
    '--note', 'human checked the observed positions and accepted them'
  ], { id: 'review-handoff-command' });
  assert.equal(review.actor, 'human');
  assert.equal(review.preparedHandoffId, preparedArtifact.id);
  assert.equal(review.preparedHandoffSha256, preparedArtifact.sha256);
  assert.equal(review.sourceVideoSha256, artifact.sha256);
  await writeFile(candidatePath, 'tampered candidate');
  await assert.rejects(
    runRecordHandoff(['--project', root, '--input', 'reviews/observed-input.json', '--review', review.id]),
    /prepared candidate checksum mismatch/
  );
  await writeFile(candidatePath, originalCandidate);
  const recorded = await runRecordHandoff([
    '--project', root, '--input', 'reviews/observed-input.json', '--review', review.id
  ]);
  assert.equal(recorded.handoff.status, 'locked');
  const { sha256: recordedSha, ...recordedPayload } = recorded.handoff;
  assert.match(recordedSha, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(join(root, recorded.handoff.path), 'utf8')), recordedPayload);
  const recordedState = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  assert.equal(recordedState.blockedReason, null);
  assert.equal(recordedState.artifacts.find(({ id }) => id === recorded.handoff.id).observed, true);
});

test('record command rejects mismatched preparation and atomically disables the next gate on rejection', async () => {
  const { root, artifact } = await approvedVideoProject();
  const prior = { id: 'segment-001', status: 'locked', lockedByReviewId: 'review-segment-001', previousSegmentId: null, nextSegmentId: 'segment-002' };
  const next = { id: 'segment-002', status: 'locked', lockedByReviewId: 'review-segment-002', previousSegmentId: 'segment-001', nextSegmentId: null, projectAssetIds: [], segmentAssetRequirements: [] };
  await mkdir(join(root, 'segments'), { recursive: true });
  const approvedSegmentationContents = JSON.stringify({ segments: [prior, next] });
  await writeFile(join(root, 'segments', 'approved.json'), approvedSegmentationContents);
  const approvedSegmentationSha = createHash('sha256').update(approvedSegmentationContents).digest('hex');
  const segmentation = {
    id: 'segmentation-001', type: 'segmentation', revision: 1, status: 'locked', path: 'segments/approved.json',
    lockedByReviewId: 'review-segmentation-001', sha256: approvedSegmentationSha
  };
  const lockedHandoff = { ...handoff.recordObservedHandoff(observedInput()).handoff, id: 'old-handoff' };
  const preparedCandidates = [];
  await mkdir(join(root, 'outputs', 'segment-001'), { recursive: true });
  for (const [index, timestamp] of [7.25, 7.75, 8.25, 8.75, 9.25, 9.75].entries()) {
    const contents = `candidate-${index + 1}`;
    const path = `outputs/segment-001/f${index + 1}.jpg`;
    await writeFile(join(root, path), contents);
    preparedCandidates.push({ timestamp, path, sha256: createHash('sha256').update(contents).digest('hex') });
  }
  const preparedPayload = {
    id: 'handoff-prepared-segment-001', type: 'handoff', revision: 1, status: 'awaiting_review',
    path: 'outputs/segment-001/handoff-prepared.json', segmentId: 'segment-001', prepared: true,
    sourceVideoId: artifact.id, sourceVideoSha256: artifact.sha256,
    candidateFrames: preparedCandidates
  };
  const preparedContents = JSON.stringify(preparedPayload);
  await writeFile(join(root, preparedPayload.path), preparedContents);
  const prepared = { ...preparedPayload, sha256: createHash('sha256').update(preparedContents).digest('hex') };
  const baseArtifacts = [
    artifact, segmentation, prepared, lockedHandoff,
    { id: 'script', type: 'script', revision: 1, status: 'locked', path: 'brief/script.md', lockedByReviewId: 'review-script' },
    { id: 'shotlist', type: 'shotlist', revision: 1, status: 'locked', path: 'brief/shotlist.md', lockedByReviewId: 'review-shotlist' }
  ];
  await writeFile(join(root, 'project-state.json'), JSON.stringify({
    projectId: 'handoff-reject', phase: 'handoff', activeSegmentId: 'segment-001', blockedReason: null,
    artifacts: baseArtifacts, updatedAt: '2026-07-13T00:00:00.000Z'
  }));
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(join(root, 'reviews', 'review-segmentation-001.json'), JSON.stringify({
    id: 'review-segmentation-001', artifactId: segmentation.id, actor: 'human', decision: 'approved',
    artifactSha256: approvedSegmentationSha
  }));
  const { runRecordHandoff } = await import('../../src/commands/record-handoff.js');
  const { runReviewHandoff } = await import('../../src/commands/review-handoff.js');
  await writeFile(join(root, 'reviews', 'mismatch.json'), JSON.stringify(observedInput({ preparedHandoffId: 'wrong' })));
  await assert.rejects(runReviewHandoff([
    '--project', root, '--input', 'reviews/mismatch.json', '--decision', 'approved', '--note', 'invalid mismatch'
  ]), /prepared handoff.*match/);

  await writeFile(join(root, 'reviews', 'reject.json'), JSON.stringify(observedInput({ decision: 'rejected', correction: 'Unusable ending' })));
  const rejectionReview = await runReviewHandoff([
    '--project', root, '--input', 'reviews/reject.json', '--decision', 'rejected',
    '--note', 'human rejected ending geometry', '--correction', 'Unusable ending'
  ], { id: 'review-handoff-reject' });
  await runRecordHandoff([
    '--project', root, '--input', 'reviews/reject.json', '--review', rejectionReview.id
  ]);
  const state = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  assert.equal(state.artifacts.find(({ id }) => id === 'old-handoff').status, 'rejected');
  assert.equal(state.artifacts.some(({ type, status, observed }) => type === 'handoff' && status === 'locked' && observed), false);
  const newestSegmentation = state.artifacts.filter(({ type }) => type === 'segmentation').sort((a, b) => b.revision - a.revision)[0];
  const revised = JSON.parse(await readFile(join(root, newestSegmentation.path), 'utf8'));
  assert.equal(revised.segments[0].status, 'rework');
  assert.match(newestSegmentation.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await loadCanonicalSegments(root, state, { requireLockedSegmentation: true }), revised.segments);
  assert.throws(() => compileAssetManifest({ ...state, segments: revised.segments }, revised.segments[1]), /earlier segment.*locked/);
});

test('prepare performs extraction outside the lock and preserves a concurrent review mutation when merging', async () => {
  const { root, artifact } = await approvedVideoProject();
  const scriptPath = join(root, 'brief', 'script-v1.md');
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, 'script');
  const script = { id: 'script-v1', type: 'script', revision: 1, status: 'draft', path: 'brief/script-v1.md' };
  await writeFile(join(root, 'project-state.json'), JSON.stringify({
    projectId: 'handoff-concurrent', phase: 'handoff', activeSegmentId: 'segment-001', blockedReason: null,
    artifacts: [artifact, script], updatedAt: '2026-07-13T00:00:00.000Z'
  }));
  let mutated = false;
  const runner = async (executable, args, options) => {
    if (!mutated) {
      mutated = true;
      await submitForReview(root, script.id);
    }
    return fakeMediaTools([], 10)(executable, args, options);
  };
  const { runPrepareHandoff } = await import('../../src/commands/prepare-handoff.js');
  await runPrepareHandoff(['--project', root, '--artifact', artifact.id], { runner });
  const state = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  assert.equal(state.artifacts.find(({ id }) => id === script.id).status, 'awaiting_review');
  assert.equal(state.artifacts.find(({ id }) => id === 'handoff-prepared-segment-001').status, 'awaiting_review');
});

test('prepare refuses stale publication when source video changes during extraction and retains candidates as evidence', async () => {
  const { root, artifact } = await approvedVideoProject();
  await writeFile(join(root, 'project-state.json'), JSON.stringify({
    projectId: 'handoff-source-change', phase: 'handoff', activeSegmentId: 'segment-001', blockedReason: null,
    artifacts: [artifact], updatedAt: '2026-07-13T00:00:00.000Z'
  }));
  let changed = false;
  const runner = async (executable, args, options) => {
    const result = await fakeMediaTools([], 10)(executable, args, options);
    if (!changed && executable === 'ffmpeg') {
      changed = true;
      const statePath = join(root, 'project-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      state.artifacts = state.artifacts.map(item => item.id === artifact.id ? { ...item, status: 'rejected' } : item);
      await writeFile(statePath, JSON.stringify(state));
    }
    return result;
  };
  const { runPrepareHandoff } = await import('../../src/commands/prepare-handoff.js');
  await assert.rejects(
    runPrepareHandoff(['--project', root, '--artifact', artifact.id], { runner }),
    error => {
      assert.match(error.message, /source video changed during handoff extraction/);
      assert.match(error.message, /candidates retained at outputs\/segment-001\/handoff-candidates\/attempt-/);
      return true;
    }
  );
  const state = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  assert.equal(state.artifacts.some(({ id }) => id === 'handoff-prepared-segment-001'), false);
  const attempts = (await readdir(join(root, 'outputs', 'segment-001', 'handoff-candidates'))).filter(name => name.startsWith('attempt-'));
  assert.equal(attempts.length, 1);
  assert.equal((await readdir(join(root, 'outputs', 'segment-001', 'handoff-candidates', attempts[0]))).length, 6);
});
