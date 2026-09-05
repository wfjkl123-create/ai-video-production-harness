import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact, autoLockArtifact } from '../../src/services/review-service.js';
import { readSegmentSummary } from '../../src/services/segment-summary-service.js';

test('Gate 5 approval automatically writes a compact segment recovery card', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate5-summary-'));
  await initializeProject(root, { projectId: 'GATE5-SUMMARY', workflowVersion: 1 });
  await writeFile(join(root, 'outputs', 'segment-001.mp4'), 'accepted video bytes');
  await registerArtifact(root, {
    id: 'video-segment-001', type: 'video_segment', segmentId: 'segment-001',
    revision: 1, status: 'draft', path: 'outputs/segment-001.mp4'
  });
  await submitForReview(root, 'video-segment-001');
  await approveArtifact(root, 'video-segment-001', 'Gate 5 accepted');

  const summary = await readSegmentSummary(root, 'segment-001');
  assert.equal(summary.status, 'complete');
  assert.equal(summary.videoArtifactId, 'video-segment-001');
  assert.match(summary.videoSha256, /^[a-f0-9]{64}$/);
});

test('summary generation failure cannot roll back a completed Gate 5 review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate5-summary-fail-open-'));
  await initializeProject(root, { projectId: 'GATE5-SUMMARY-FAIL', workflowVersion: 1 });
  await writeFile(join(root, 'outputs', 'segment-001.mp4'), 'accepted video bytes');
  await registerArtifact(root, {
    id: 'video-segment-001', type: 'video_segment', segmentId: 'segment-001',
    revision: 1, status: 'draft', path: 'outputs/segment-001.mp4'
  });
  await writeFile(join(root, 'prompts', 'segment-001.txt'), 'prompt with stale narration binding');
  await registerArtifact(root, {
    id: 'prompt-segment-001', type: 'seedance_prompt', segmentId: 'segment-001',
    revision: 1, status: 'draft', path: 'prompts/segment-001.txt',
    narrationSourceId: 'missing-narration', narrationSha256: 'a'.repeat(64)
  });
  await autoLockArtifact(root, 'prompt-segment-001', 'machine lint fixture');
  await submitForReview(root, 'video-segment-001');
  const observed = [];
  const review = await approveArtifact(root, 'video-segment-001', 'Gate 5 accepted', {
    onSummaryError: error => observed.push(error.message)
  });
  assert.equal(review.decision, 'approved');
  assert.equal(observed.length, 1);
  assert.match(observed[0], /no exact locked narration binding/);
});
