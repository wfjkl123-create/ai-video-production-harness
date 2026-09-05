import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { generateSegmentSummary } from '../../src/services/segment-summary-service.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';

function artifact(id, type, revision, extra = {}) {
  return {
    id, type, revision, status: 'locked', path: `${type}/${id}`,
    lockedByReviewId: `review-${id}`,
    ...(type === 'video_segment' ? { sha256: String(revision).repeat(64).slice(0, 64) } : {}),
    ...extra
  };
}

test('segment summary selects the latest locked evidence and only an observed handoff', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'segment-summary-'));
  const root = join(parent, 'project');
  const initial = await initializeProject(root, { projectId: 'SUMMARY-1' });
  const artifacts = [
    artifact('prompt-v1', 'seedance_prompt', 1, { sha256: 'a'.repeat(64), segmentId: 'segment-001' }),
    artifact('narration-v1', 'shot_narration', 1, { sha256: 'b'.repeat(64), segmentId: 'segment-001' }),
    artifact('video-v1', 'video_segment', 1, { sha256: 'c'.repeat(64), segmentId: 'segment-001' }),
    artifact('prompt-v3', 'seedance_prompt', 3, {
      sha256: 'd'.repeat(64), segmentId: 'segment-001',
      narrationSourceId: 'narration-v1', narrationSha256: 'b'.repeat(64)
    }),
    artifact('narration-v2', 'shot_narration', 2, { sha256: 'e'.repeat(64), segmentId: 'segment-001' }),
    artifact('handoff-prepared-v4', 'handoff', 4, { sha256: 'f'.repeat(64), segmentId: 'segment-001', observed: false }),
    artifact('handoff-observed-v1', 'handoff', 1, { sha256: '1'.repeat(64), segmentId: 'segment-001', observed: true }),
    artifact('audit-v1', 'independent_creative_audit', 1, { sha256: '2'.repeat(64), segmentId: 'segment-001', decision: 'PASS' }),
    artifact('audit-v3', 'independent_creative_audit', 3, { sha256: '3'.repeat(64), segmentId: 'segment-001', decision: 'PASS' }),
    artifact('video-v2-old-alias', 'video_segment', 2, { sha256: '4'.repeat(64), segmentId: 'segment-001' }),
    artifact('video-v2-adopted', 'video_segment', 2, { sha256: '5'.repeat(64), segmentId: 'segment-001' })
  ];
  await writeJsonAtomic(join(root, 'project-state.json'), { ...initial, artifacts, updatedAt: '2026-07-31T02:00:00Z' });

  const summary = await generateSegmentSummary(root, 'segment-001');
  assert.equal(summary.videoArtifactId, 'video-v2-adopted');
  assert.equal(summary.videoRevision, 2);
  assert.equal(summary.videoSha256, '5'.repeat(64));
  assert.equal(summary.promptArtifactId, 'prompt-v3');
  assert.equal(summary.promptRevision, 3);
  assert.equal(summary.narrationArtifactId, 'narration-v1');
  assert.equal(summary.narrationRevision, 1);
  assert.equal(summary.handoffArtifactId, 'handoff-observed-v1');
  assert.equal(summary.handoffRevision, 1);
  assert.equal(summary.auditArtifactId, 'audit-v3');
  assert.equal(summary.auditRevision, 3);
  assert.equal(summary.artifactCount, artifacts.length);
});
