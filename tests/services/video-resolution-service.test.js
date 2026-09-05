import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { resolveProjectVideoResolution } from '../../src/services/video-resolution-service.js';

test('probes the exact locked reference video and raises the default package to its resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-resolution-'));
  await mkdir(join(root, 'brief'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  const bytes = 'fake source video';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(root, 'brief/reference.mp4'), bytes);
  const artifact = {
    id: 'reference-segment-001', type: 'reference_video', segmentId: 'segment-001', revision: 1,
    status: 'locked', path: 'brief/reference.mp4', sha256, lockedByReviewId: 'review-reference'
  };
  await writeJsonAtomic(join(root, 'reviews/review-reference.json'), {
    id: 'review-reference', artifactId: artifact.id, actor: 'human', decision: 'approved', artifactSha256: sha256
  });
  const runner = async () => ({
    code: 0, stderr: '', stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }] })
  });
  const contract = await resolveProjectVideoResolution(root, { artifacts: [artifact] }, 'segment-001', { runner, includeReferenceVideo: true });
  assert.equal(contract.resolution, '1080p');
  assert.equal(contract.sourceBaseline.artifactId, artifact.id);
  assert.equal(contract.sourceBaseline.sha256, sha256);
});

test('keeps the default 480p contract when a locked source video is analysis-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-resolution-default-'));
  const contract = await resolveProjectVideoResolution(root, {
    artifacts: [{ id: 'reference-segment-001', type: 'reference_video', segmentId: 'segment-001', revision: 1, status: 'locked', path: 'brief/reference.mp4', sha256: 'a'.repeat(64), lockedByReviewId: 'review-reference' }]
  }, 'segment-001', { runner: async () => { throw new Error('analysis-only source must not be probed'); } });
  assert.equal(contract.resolution, '480p');
  assert.equal(contract.sourceBaseline, null);
});
