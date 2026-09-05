import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { initializeProject, getProjectStatus } from '../../src/services/project-service.js';
import { submitForReview, approveArtifact, rejectArtifact, rejectArtifactBySystem } from '../../src/services/review-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { persistSegmentation } from '../../src/services/segmentation-workflow-service.js';

async function projectWithDraft() {
  const root = await mkdtemp(join(tmpdir(), 'harness-review-'));
  await initializeProject(root, { projectId: 'QC-001' });
  const path = join(root, 'brief', 'script-v1.md');
  await writeFile(path, 'original script\n');
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.artifacts.push({ id: 'script-v1', type: 'script', revision: 1, status: 'draft', path: 'brief/script-v1.md' });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { root, path };
}

async function addDraft(root, id) {
  const path = join(root, 'brief', `${id}.md`);
  await writeFile(path, `${id}\n`);
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.artifacts.push({ id, type: 'script', revision: 1, status: 'draft', path: `brief/${id}.md` });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], {
      cwd: new URL('../..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`CLI exited ${code}: ${stderr}`));
    });
  });
}

test('submits and approves an artifact with durable human evidence and a pre-lock snapshot', async () => {
  const { root, path } = await projectWithDraft();
  const submitted = await submitForReview(root, 'script-v1');
  assert.equal(submitted.sha256, await sha256File(path));
  assert.deepEqual((await getProjectStatus(root)).pendingHumanGate, ['script-v1']);

  const review = await approveArtifact(root, 'script-v1', 'Approved for production');
  assert.equal(review.artifactId, 'script-v1');
  assert.equal(review.decision, 'approved');
  assert.equal(review.note, 'Approved for production');
  assert.equal(review.correction, null);
  assert.equal(review.actor, 'human');
  assert.equal(review.artifactSha256, await sha256File(path));
  assert.match(review.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'reviews', `${review.id}.json`), 'utf8')), review);

  const status = await getProjectStatus(root);
  const artifact = status.artifacts.find(({ id }) => id === 'script-v1');
  assert.equal(artifact.status, 'locked');
  assert.equal(artifact.lockedByReviewId, review.id);
  assert.equal(artifact.sha256, review.artifactSha256);
  const [snapshotName] = await readdir(join(root, 'versions'));
  const snapshot = JSON.parse(await readFile(join(root, 'versions', snapshotName), 'utf8'));
  assert.equal(snapshot.artifacts[0].status, 'awaiting_review');
  assert.equal(await readFile(path, 'utf8'), 'original script\n');
});

test('rejects approval when any file artifact changes after submission', async () => {
  const { root, path } = await projectWithDraft();
  const submitted = await submitForReview(root, 'script-v1');
  await writeFile(path, 'mutated after submission\n');
  await assert.rejects(approveArtifact(root, 'script-v1', 'must not approve stale bytes'), /checksum|changed/i);
  const artifact = (await getProjectStatus(root)).artifacts.find(({ id }) => id === 'script-v1');
  assert.equal(artifact.status, 'awaiting_review');
  assert.equal(artifact.sha256, submitted.sha256);
  assert.deepEqual(await readdir(join(root, 'reviews')), []);
});

test('segmentation approval publishes an immutable checksum-bound canonical snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'segmentation-immutable-review-'));
  await initializeProject(root, { projectId: 'SEGMENT-IMMUTABLE' });
  const draft = await persistSegmentation(root, {
    id: 'segmentation-v1', path: 'segments/segmentation-v1.json',
    segments: [{ id: 'segment-001', duration: 10, status: 'awaiting_review' }]
  });
  await submitForReview(root, draft.id);
  const review = await approveArtifact(root, draft.id, 'approve immutable canonical segmentation');
  const locked = (await getProjectStatus(root)).artifacts.find(({ id }) => id === draft.id);
  assert.match(locked.path, /^versions\/segmentation\..+\.locked\.json$/);
  assert.equal(locked.sha256, review.artifactSha256);
  assert.equal(await sha256File(join(root, locked.path)), locked.sha256);
  assert.equal((JSON.parse(await readFile(join(root, draft.path), 'utf8'))).segments[0].status, 'awaiting_review');
  assert.equal((JSON.parse(await readFile(join(root, locked.path), 'utf8'))).segments[0].status, 'locked');
});

test('segmentation approval journal rolls forward after every injected cross-file crash', async () => {
  for (const crashIndex of [0, 1, 2, 3]) {
    const root = await mkdtemp(join(tmpdir(), `segmentation-review-crash-${crashIndex}-`));
    await initializeProject(root, { projectId: `SEGMENT-CRASH-${crashIndex}` });
    const draft = await persistSegmentation(root, {
      id: 'segmentation-v1', path: 'segments/segmentation-v1.json',
      segments: [{ id: 'segment-001', duration: 10, status: 'awaiting_review' }]
    });
    await submitForReview(root, draft.id);
    await assert.rejects(approveArtifact(root, draft.id, 'approve with crash injection', {
      transactionOptions: { afterWrite: index => { if (index === crashIndex) throw new Error(`crash-${crashIndex}`); } }
    }), new RegExp(`crash-${crashIndex}`));
    const review = await approveArtifact(root, draft.id, 'recover same decision');
    const locked = (await getProjectStatus(root)).artifacts.find(({ id }) => id === draft.id);
    assert.equal(locked.status, 'locked');
    assert.equal(locked.lockedByReviewId, review.id);
    assert.equal(await sha256File(join(root, locked.path)), locked.sha256);
  }
});

test('preserves a distinct state snapshot for each sequential approval', async () => {
  const { root } = await projectWithDraft();
  await addDraft(root, 'script-v2');
  await submitForReview(root, 'script-v1');
  const first = await approveArtifact(root, 'script-v1', 'Approve first');
  await submitForReview(root, 'script-v2');
  const second = await approveArtifact(root, 'script-v2', 'Approve second');

  const names = (await readdir(join(root, 'versions'))).sort();
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  const snapshots = await Promise.all(names.map(async name => JSON.parse(await readFile(join(root, 'versions', name), 'utf8'))));
  assert.ok(names.some(name => name.includes(first.id)));
  assert.ok(names.some(name => name.includes(second.id)));
  assert.deepEqual(snapshots.map(state => state.artifacts.filter(({ status }) => status === 'locked').length).sort(), [0, 1]);
});

test('serializes concurrent approvals so updates to different artifacts are not lost', async () => {
  const { root } = await projectWithDraft();
  await addDraft(root, 'script-v2');
  await submitForReview(root, 'script-v1');
  await submitForReview(root, 'script-v2');

  const [first, second] = await Promise.all([
    approveArtifact(root, 'script-v1', 'Approve first'),
    approveArtifact(root, 'script-v2', 'Approve second')
  ]);

  const status = await getProjectStatus(root);
  assert.equal(status.artifacts.find(({ id }) => id === 'script-v1').lockedByReviewId, first.id);
  assert.equal(status.artifacts.find(({ id }) => id === 'script-v2').lockedByReviewId, second.id);
});

test('serializes approvals from separate CLI processes so neither update is lost', async () => {
  const { root } = await projectWithDraft();
  await addDraft(root, 'script-v2');
  await submitForReview(root, 'script-v1');
  await submitForReview(root, 'script-v2');

  // Widen the read-modify-write window without adding production-only test hooks.
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (let index = 0; index < 20_000; index += 1) {
    state.artifacts.push({
      id: `filler-${index}`,
      type: 'script',
      revision: 1,
      status: 'draft',
      path: `brief/filler-${index}.md`
    });
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const [first, second] = await Promise.all([
    runCli(['approve', '--project', root, '--artifact', 'script-v1', '--note', 'Approve first']),
    runCli(['approve', '--project', root, '--artifact', 'script-v2', '--note', 'Approve second'])
  ]);

  const status = await getProjectStatus(root);
  assert.equal(status.artifacts.find(({ id }) => id === 'script-v1').lockedByReviewId, first.id);
  assert.equal(status.artifacts.find(({ id }) => id === 'script-v2').lockedByReviewId, second.id);
});

test('persists rejection correction and transitions the artifact to rejected', async () => {
  const { root } = await projectWithDraft();
  await submitForReview(root, 'script-v1');
  const review = await rejectArtifact(root, 'script-v1', 'Needs a clearer hook', 'Rewrite the first paragraph');
  assert.equal(review.decision, 'rejected');
  assert.equal(review.correction, 'Rewrite the first paragraph');
  const artifact = (await getProjectStatus(root)).artifacts.find(({ id }) => id === 'script-v1');
  assert.equal(artifact.status, 'rejected');
});

test('records a machine-gate rejection without fabricating a human actor', async () => {
  const { root } = await projectWithDraft();
  await submitForReview(root, 'script-v1');
  const review = await rejectArtifactBySystem(
    root,
    'script-v1',
    'clean-context audit failed',
    'replace the stale segment identifiers and resubmit a new revision',
    { auditType: 'clean_zero_context', findingId: 'stale-segment-id' }
  );
  assert.equal(review.decision, 'rejected');
  assert.equal(review.actor, 'system');
  assert.equal(review.machineRejected, true);
  assert.equal(review.auditType, 'clean_zero_context');
  const artifact = (await getProjectStatus(root)).artifacts.find(({ id }) => id === 'script-v1');
  assert.equal(artifact.status, 'rejected');
  assert.deepEqual(await readdir(join(root, 'versions')), []);
});

test('audio assets skip pixel audit but still require normal human review and checksum evidence', async () => {
  const { root } = await projectWithDraft();
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.directorRoutingVersion = 1;
  state.artifacts[0] = {
    ...state.artifacts[0],
    type: 'segment_asset',
    assetType: 'timing_audio_reference',
    mediaKind: 'audio',
    segmentId: 'segment-001'
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await submitForReview(root, 'script-v1');
  const review = await approveArtifact(root, 'script-v1', 'approve exact timing audio bytes');
  assert.equal(review.actor, 'human');
  const artifact = (await getProjectStatus(root)).artifacts.find(({ id }) => id === 'script-v1');
  assert.equal(artifact.status, 'locked');
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
});

test('does not persist approval evidence when the artifact cannot be locked', async () => {
  const { root } = await projectWithDraft();
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.artifacts[0].type = 'video_segment';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await submitForReview(root, 'script-v1');
  const submittedState = JSON.parse(await readFile(statePath, 'utf8'));
  submittedState.artifacts[0].sha256 = '0'.repeat(64);
  await writeFile(statePath, `${JSON.stringify(submittedState, null, 2)}\n`);

  await assert.rejects(approveArtifact(root, 'script-v1', 'Approved'), /checksum/);
  assert.deepEqual(await readdir(join(root, 'reviews')), []);
  assert.deepEqual(await readdir(join(root, 'versions')), []);
  await assert.rejects(readFile(join(root, '.review-mutation.lock')), /ENOENT/);
});
