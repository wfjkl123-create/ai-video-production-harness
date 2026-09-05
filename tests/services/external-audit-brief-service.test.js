import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { preparePreGenerationAuditBrief } from '../../src/services/external-audit-brief-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pre-audit-brief-'));
  await mkdir(join(root, 'runs')); await mkdir(join(root, 'evidence'));
  const items = [
    ['reference', 'reference_video', 'segment-001'], ['script', 'script', null], ['shotlist', 'shotlist', null],
    ['contract', 'segment_contract', 'segment-001'], ['narration', 'shot_narration', 'segment-001']
  ];
  const artifacts = [];
  for (const [id, type, segmentId] of items) {
    const path = `evidence/${id}.txt`; await writeFile(join(root, path), id);
    artifacts.push({ id, type, segmentId, revision: 1, status: 'locked', path, lockedByReviewId: `review-${id}` });
  }
  await writeJsonAtomic(join(root, 'project-state.json'), { projectId: 'p1', artifacts });
  await writeJsonAtomic(join(root, 'runs', 'preflight-1.json'), {
    id: 'preflight-1', kind: 'video_preflight', status: 'READY', segmentId: 'segment-001',
    fingerprint: {
      sha256: 'a'.repeat(64), packagePath: 'prompts/package.json', packageSha256: 'b'.repeat(64),
      promptPath: 'prompts/prompt.txt', promptSha256: 'c'.repeat(64), inputMedia: { images: [], videos: [], audio: [] },
      generationContract: {
        provider: 'libtv', transport: 'official_cli', projectUuid: 'd'.repeat(32),
        nodeName: 'segment-001-video', model: 'Seedance 2.0 VIP'
      }
    }
  });
  return root;
}

test('binds reference video, plot, narration, prompt, package, and media into one clean audit brief', async () => {
  const root = await fixture();
  await writeFile(join(root, 'evidence/reference-segment-003.txt'), 'wrong later segment');
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({
    id: 'reference-segment-003', type: 'reference_video', segmentId: 'segment-003', revision: 9,
    status: 'locked', path: 'evidence/reference-segment-003.txt', lockedByReviewId: 'review-reference-segment-003'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const brief = await preparePreGenerationAuditBrief(root, 'preflight-1');
  assert.equal(brief.sourceEvidence.some(item => item.type === 'reference_video'), true);
  assert.equal(brief.sourceEvidence.find(item => item.type === 'reference_video').id, 'reference');
  assert.equal(brief.sourceEvidence.some(item => item.type === 'shot_narration'), true);
  assert.equal(brief.generationEvidence.prompt.sha256, 'c'.repeat(64));
  assert.equal(brief.generationEvidence.generationContract.provider, 'libtv');
  assert.equal(brief.generationEvidence.generationContract.projectUuid, 'd'.repeat(32));
  assert.ok(brief.mandatoryCoverage.includes('main_action_before_during_after'));
  const preflight = await readJson(join(root, 'runs', 'preflight-1.json'));
  assert.equal(preflight.externalAuditBrief.sha256.length, 64);
});

test('refuses a brief with no locked reference video', async () => {
  const root = await fixture();
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts = state.artifacts.filter(item => item.type !== 'reference_video');
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await assert.rejects(preparePreGenerationAuditBrief(root, 'preflight-1'), /locked reference video/);
});
