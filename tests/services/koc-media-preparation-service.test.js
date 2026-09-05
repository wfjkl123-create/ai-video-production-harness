import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File } from '../../src/storage/checksum.js';
import { compileKocSourceLedger } from '../../src/services/koc-source-ledger-service.js';
import { buildKocMediaPreparationPlan, executeKocMediaPreparation } from '../../src/services/koc-media-preparation-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'koc-media-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  const source = join(root, 'assets', 'source.mp4');
  const identity = join(root, 'assets', 'identity.png');
  const model = join(root, 'assets', 'yunet.onnx');
  await Promise.all([
    writeFile(source, 'source-video'), writeFile(identity, 'identity-image'), writeFile(model, 'model'),
    writeFile(join(root, 'scripts', 'derive-multiface-full-head-scrub-v1.py'), '# test')
  ]);
  const sourceSha = await sha256File(source);
  const identitySha = await sha256File(identity);
  const ledger = compileKocSourceLedger({
    projectId: 'KOC-MEDIA-1', sourceVideo: { id: 'source', sha256: sourceSha, durationSec: 10 },
    timeline: [{ id: 'R1', startSec: 0, endSec: 10, shotClass: 'aroll_speaking_lead', spokenLine: '完整口播', continuousTakeId: 'T1' }]
  });
  return {
    root,
    input: {
      schemaVersion: 1, kind: 'koc_media_preparation_job', projectId: 'KOC-MEDIA-1',
      sourceVideo: { path: 'assets/source.mp4', sha256: sourceSha },
      identityReference: { id: 'identity', path: 'assets/identity.png', sha256: identitySha },
      detectorModelPath: 'assets/yunet.onnx', outputDirectory: 'work/koc-media',
      firstFramePolicy: 'none', ledger
    }
  };
}

test('plans one local head-anonymization lane per audited A-roll package', async () => {
  const { root, input } = await fixture();
  const plan = await buildKocMediaPreparationPlan(root, input, {
    runner: async executable => executable === 'ffprobe'
      ? { stdout: JSON.stringify({ streams: [{ avg_frame_rate: '30/1' }] }), stderr: '' }
      : assert.fail(`unexpected executable ${executable}`)
  });
  assert.equal(plan.lanes.length, 1);
  assert.equal(plan.lanes[0].frameCount, 300);
  assert.match(plan.lanes[0].scrubCommand.join(' '), /0:300:1/);
  assert.equal(plan.concurrency, 1);
});

test('executes local lanes and emits a KOC plan input without paid generation', async () => {
  const { root, input } = await fixture();
  const runner = async (executable, args) => {
    if (executable === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ avg_frame_rate: '30/1' }] }), stderr: '' };
    if (executable === 'ffmpeg') {
      await writeFile(args.at(-1), 'source-clip');
      return { stdout: '', stderr: '' };
    }
    if (executable === 'python3') {
      const output = args[3];
      const stats = args[4];
      await writeFile(output, 'control-video');
      await writeFile(stats, JSON.stringify({
        output: { frameCount: 300, audioStreams: 1, durationSec: 10 }, detectedFaceCounts: Array(300).fill(1),
        residualFaceCounts: Array(300).fill(0),
        maskAudit: { geometryStatus: 'PASS', residualFaceDetectionStatus: 'PASS' },
        audioIntegrity: { status: 'PASS', sourceSha256: '8'.repeat(64), outputSha256: '8'.repeat(64) }
      }));
      return { stdout: '', stderr: '' };
    }
    return assert.fail(`unexpected executable ${executable}`);
  };
  const result = await executeKocMediaPreparation(root, input, { runner });
  assert.equal(result.status, 'PREPARED');
  assert.equal(result.preparedSegments, 1);
  assert.equal(result.paidGenerationTriggered, false);
  assert.equal(result.output.arollSegments[0].maskAudit.status, 'PASS');
  assert.equal(result.output.arollSegments[0].sourceAudioMode, 'embedded_original_track');
});
