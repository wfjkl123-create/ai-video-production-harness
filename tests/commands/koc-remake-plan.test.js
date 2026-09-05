import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runKocRemakePlan } from '../../src/commands/koc-remake-plan.js';

test('CLI compiles a SHA-bound KOC parallel plan from an input manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'koc-plan-'));
  const sha = 'b'.repeat(64);
  const inputPath = join(root, 'input.json');
  await writeFile(inputPath, JSON.stringify({
    projectId: 'KOC-CLI-1',
    sourceVideo: { id: 'source', sha256: sha, mediaKind: 'video', durationSec: 10 },
    sourceInventoryAudit: {
      status: 'PASS', sourceVideoSha256: sha, allArollRangesAccountedFor: true,
      brollRangesExcluded: true, auditSha256: sha
    },
    identityReference: { id: 'identity', sha256: sha, mediaKind: 'image' },
    arollSegments: [{
      id: 'A01', startSec: 0, endSec: 10, contentClass: 'aroll', containsBroll: false,
      continuousTakeId: 'take-1', continuousTakeComplete: true, transcript: '完整台词',
      sourceRangeSha256: sha,
      controlVideo: { id: 'control', sha256: sha, mediaKind: 'video' },
      maskAudit: { status: 'PASS', coverage: 'full_head_above_neck', outsideHeadPreserved: true, auditSha256: sha },
      sourceAudioMode: 'embedded_original_track'
    }],
    firstFramePolicy: 'none'
  }));
  const plan = await runKocRemakePlan(['--input', inputPath]);
  assert.equal(plan.kind, 'koc_remake_plan');
  assert.equal(plan.execution.lanes[0].segmentId, 'A01');
});
