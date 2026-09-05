import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File } from '../../src/storage/checksum.js';
import { compileKocSourceLedger } from '../../src/services/koc-source-ledger-service.js';
import { buildKocReinsertionPlan, executeKocReinsertion } from '../../src/services/koc-reinsertion-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'koc-reinsert-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  const source = join(root, 'assets', 'source.mp4');
  const first = join(root, 'assets', 'first.mp4');
  const second = join(root, 'assets', 'second.mp4');
  await Promise.all([writeFile(source, 'source'), writeFile(first, 'first'), writeFile(second, 'second')]);
  const sourceSha256 = await sha256File(source);
  const ledger = compileKocSourceLedger({
    projectId: 'koc-p1',
    sourceVideo: { id: 'source', sha256: sourceSha256, durationSec: 10 },
    timeline: [
      { id: 'R1', startSec: 0, endSec: 4, shotClass: 'aroll_speaking_lead', spokenLine: '第一段', continuousTakeId: 'take-1', expectedFaceCount: 1 },
      { id: 'R2', startSec: 4, endSec: 6, shotClass: 'broll_preserve_source' },
      { id: 'R3', startSec: 6, endSec: 10, shotClass: 'aroll_speaking_lead', spokenLine: '第二段', continuousTakeId: 'take-2', expectedFaceCount: 1 }
    ]
  });
  const input = {
    schemaVersion: 1, kind: 'koc_reinsertion_job', projectId: 'koc-p1', ledger,
    sourceVideo: { path: 'assets/source.mp4', sha256: sourceSha256 },
    replacements: [
      { segmentId: ledger.arollSegments[0].id, finalDisposition: 'accepted_for_reinsertion', parts: [{ sourceStartSec: 0, sourceEndSec: 4, generatedStartSec: 0, generatedEndSec: 4, path: 'assets/first.mp4', sha256: await sha256File(first) }] },
      { segmentId: ledger.arollSegments[1].id, finalDisposition: 'accepted_for_reinsertion', parts: [{ sourceStartSec: 6, sourceEndSec: 10, generatedStartSec: 0, generatedEndSec: 4, path: 'assets/second.mp4', sha256: await sha256File(second) }] }
    ],
    workDirectory: 'work/reinsert', outputPath: 'deliverables/final.mp4'
  };
  return { root, input };
}

function probeResult(path) {
  return JSON.stringify({
    streams: [
      { codec_type: 'video', width: path.endsWith('final.mp4') ? 480 : 540, height: path.endsWith('final.mp4') ? 854 : 960, avg_frame_rate: '30/1', ...(path.endsWith('final.mp4') ? { nb_read_frames: '300' } : {}) },
      { codec_type: 'audio', codec_name: 'aac' }
    ],
    format: { duration: 10 }
  });
}

test('builds a complete 480p timeline from every accepted A-roll and locked source gaps', async () => {
  const { root, input } = await fixture();
  const plan = await buildKocReinsertionPlan(root, input, {
    runner: async (_command, args) => ({ stdout: probeResult(args.at(-1)), stderr: '' })
  });
  assert.deepEqual(plan.pieces.map(piece => piece.kind), ['replacement', 'source', 'replacement']);
  assert.deepEqual(plan.pieces.map(piece => piece.frameCount), [120, 60, 120]);
  assert.equal(plan.coverage.complete, true);
  assert.equal(plan.audioPolicy, 'copy_full_original_source_track');
  assert.equal(plan.paidGenerationTriggered, false);
});

test('rejects any A-roll segment without exact accepted source-range coverage', async () => {
  const { root, input } = await fixture();
  input.replacements.pop();
  await assert.rejects(buildKocReinsertionPlan(root, input, {
    runner: async (_command, args) => ({ stdout: probeResult(args.at(-1)), stderr: '' })
  }), /has no accepted generated coverage/);
});

test('executes deterministic assembly and verifies original audio plus unchanged source-gap frames', async () => {
  const { root, input } = await fixture();
  const hash = '9'.repeat(64);
  const runner = async (command, args) => {
    if (command === 'ffprobe') return { stdout: probeResult(args.at(-1)), stderr: '' };
    if (args.includes('-f') && args.includes('hash')) return { stdout: `SHA256=${hash}\n`, stderr: '' };
    const output = args.at(-1);
    if (output !== '-') await writeFile(output, `media-${args.join(' ')}`);
    return { stdout: '', stderr: '' };
  };
  const result = await executeKocReinsertion(root, input, { runner });
  assert.equal(result.status, 'ASSEMBLED_AND_AUDITED');
  assert.equal(result.audit.audioIntegrity, 'PASS');
  assert.equal(result.audit.brollPolicy.status, 'PASS');
  assert.equal(result.audit.brollPolicy.sourceGapAudits.length, 1);
  assert.equal(result.paidGenerationTriggered, false);
});
