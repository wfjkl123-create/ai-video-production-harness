import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File } from '../../src/storage/checksum.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { requireSimpleRemakeSystemReview } from '../../src/services/independent-creative-audit-service.js';

async function writeLockedArtifact(root, artifact) {
  const review = {
    id: artifact.lockedByReviewId,
    actor: 'system',
    autoLocked: true,
    decision: 'approved',
    artifactId: artifact.id,
    artifactSha256: artifact.sha256
  };
  await writeJsonAtomic(join(root, 'reviews', `${artifact.lockedByReviewId}.json`), review);
}

test('simple remake accepts its locked system-reviewed narration and source prompt instead of requiring a separate audit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simple-remake-review-'));
  await mkdir(join(root, 'prompts/segment-001'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  const narrationPath = 'prompts/segment-001/narration.json';
  const promptPath = 'prompts/segment-001/source-prompt.txt';
  await writeFile(join(root, narrationPath), '{"shot":"locked"}');
  await writeFile(join(root, promptPath), '独立完整的产品复刻提示。');
  const narration = {
    id: 'narration-r1', type: 'shot_narration', segmentId: 'segment-001', revision: 1,
    status: 'locked', path: narrationPath, sha256: await sha256File(join(root, narrationPath)), lockedByReviewId: 'review-narration-r1'
  };
  const prompt = {
    id: 'prompt-r1', type: 'seedance_prompt', segmentId: 'segment-001', revision: 1,
    status: 'locked', path: promptPath, sha256: await sha256File(join(root, promptPath)), lockedByReviewId: 'review-prompt-r1',
    narrationSourceId: narration.id, narrationSha256: narration.sha256,
    promptSelfAudit: { arrangement: 'PASS', semantics: 'PASS' }
  };
  await writeLockedArtifact(root, narration);
  await writeLockedArtifact(root, prompt);
  await writeJsonAtomic(join(root, 'project-state.json'), {
    workflowProfile: { id: 'simple_remake', selectedBy: 'user', reason: 'test', updatedAt: '2026-08-21T00:00:00.000Z' },
    artifacts: [narration, prompt]
  });

  const review = await requireSimpleRemakeSystemReview(root, 'segment-001', promptPath);
  assert.deepEqual(review, {
    mode: 'simple_remake_system_review', workflowProfileId: 'simple_remake',
    narrationId: narration.id, narrationSha256: narration.sha256,
    promptId: prompt.id, promptSha256: prompt.sha256
  });
});

test('simple remake system review rejects a source prompt that is not the locked prompt artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simple-remake-review-mismatch-'));
  await mkdir(join(root, 'prompts/segment-001'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  const narrationPath = 'prompts/segment-001/narration.json';
  const promptPath = 'prompts/segment-001/source-prompt.txt';
  await writeFile(join(root, narrationPath), '{"shot":"locked"}');
  await writeFile(join(root, promptPath), '锁定提示。');
  const narration = { id: 'narration-r1', type: 'shot_narration', segmentId: 'segment-001', revision: 1, status: 'locked', path: narrationPath, sha256: await sha256File(join(root, narrationPath)), lockedByReviewId: 'review-narration-r1' };
  const prompt = { id: 'prompt-r1', type: 'seedance_prompt', segmentId: 'segment-001', revision: 1, status: 'locked', path: promptPath, sha256: await sha256File(join(root, promptPath)), lockedByReviewId: 'review-prompt-r1', narrationSourceId: narration.id, narrationSha256: narration.sha256, promptSelfAudit: { arrangement: 'PASS', semantics: 'PASS' } };
  await writeLockedArtifact(root, narration); await writeLockedArtifact(root, prompt);
  await writeJsonAtomic(join(root, 'project-state.json'), { workflowProfile: { id: 'simple_remake', selectedBy: 'user', reason: 'test', updatedAt: '2026-08-21T00:00:00.000Z' }, artifacts: [narration, prompt] });

  await assert.rejects(requireSimpleRemakeSystemReview(root, 'segment-001', 'prompts/segment-001/other.txt'), /does not match/);
});
