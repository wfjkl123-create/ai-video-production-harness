import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File } from '../../src/storage/checksum.js';
import { buildKocRemakePlan } from '../../src/services/koc-remake-orchestrator-service.js';
import { buildKocCanvasBatchPlan, executeKocCanvasBatch } from '../../src/services/koc-canvas-batch-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'koc-canvas-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  const identity = join(root, 'assets', 'identity.png');
  const control = join(root, 'assets', 'control.mp4');
  await Promise.all([writeFile(identity, 'identity'), writeFile(control, 'control')]);
  const identitySha = await sha256File(identity);
  const controlSha = await sha256File(control);
  const projectUuid = 'a'.repeat(32);
  const segmentId = 'AR001';
  const nodeName = 'KOC-AR001-480P';
  const plan = buildKocRemakePlan({
    projectId: 'p1', sourceVideo: { id: 'source', sha256: '1'.repeat(64), mediaKind: 'video', durationSec: 10 },
    sourceInventoryAudit: { status: 'PASS', sourceVideoSha256: '1'.repeat(64), allArollRangesAccountedFor: true, brollRangesExcluded: true, auditSha256: '2'.repeat(64) },
    identityReference: { id: 'identity', sha256: identitySha, mediaKind: 'image' }, firstFramePolicy: 'none', firstFrameSegmentIds: [],
    arollSegments: [{ id: segmentId, startSec: 0, endSec: 10, contentClass: 'aroll', containsBroll: false, continuousTakeId: 'T1', continuousTakeComplete: true, transcript: '完整口播', sourceRangeSha256: '3'.repeat(64), controlVideo: { id: 'control', sha256: controlSha, mediaKind: 'video' }, maskAudit: { status: 'PASS', coverage: 'full_head_above_neck', outsideHeadPreserved: true, auditSha256: '4'.repeat(64) }, sourceAudioMode: 'embedded_original_track' }]
  });
  const packageValue = {
    segmentId,
    fingerprint: {
      sha256: '5'.repeat(64),
      generationContract: { provider: 'libtv', transport: 'official_cli', projectUuid, nodeName, model: 'Seedance 2.0 VIP', modeType: 'mixed2video', request: { duration: 10, ratio: '9:16', resolution: '480p', enableSound: true, count: 1 } },
      inputMedia: { image: [{ path: identity, sha256: identitySha }], video: [{ path: control, sha256: controlSha }], audio: [] }
    },
    input: { prompt: '@图1锁定人物身份，@视频1锁定原片动作与原声。', duration: 10, ratio: '9:16', resolution: '480p', generateAudio: true, imageInputs: [identity], videoInputs: [control], audioInputs: [] },
    reviews: { sourceFidelity: { status: 'PASS' }, performanceLiveness: { status: 'PASS' }, deliveryCompleteness: { status: 'PASS' } }
  };
  const packagePath = join(root, 'reviewed-package.json');
  await writeFile(packagePath, `${JSON.stringify(packageValue)}\n`);
  const input = { schemaVersion: 1, kind: 'koc_canvas_batch_job', projectUuid, plan, packages: [{ segmentId, nodeName, path: 'reviewed-package.json', sha256: await sha256File(packagePath) }] };
  return { root, input };
}

test('accepts only exact reviewed 480p KOC lane packages', async () => {
  const { root, input } = await fixture();
  const plan = await buildKocCanvasBatchPlan(root, input);
  assert.equal(plan.concurrency, 1);
  assert.equal(plan.action, 'prepare_canvas_nodes_only');
  assert.equal(plan.paidGenerationTriggered, false);
});

test('prepares every lane without submitting paid generation', async () => {
  const { root, input } = await fixture();
  const result = await executeKocCanvasBatch(root, input, {
    prepare: async (_root, request) => ({ requiresUserCanvasGeneration: true, paidGenerationTriggered: false, run: { status: 'READY_FOR_USER_CANVAS_GENERATION', nodeKey: `${request.segmentId}-key` } })
  });
  assert.equal(result.status, 'READY_FOR_USER_CANVAS_GENERATION');
  assert.equal(result.results[0].nodeKey, 'AR001-key');
  assert.equal(result.paidGenerationTriggered, false);
});

test('rejects a package that would mute the embedded source audio', async () => {
  const { root, input } = await fixture();
  const path = join(root, 'reviewed-package.json');
  const value = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
  value.input.generateAudio = false;
  await writeFile(path, `${JSON.stringify(value)}\n`);
  input.packages[0].sha256 = await sha256File(path);
  await assert.rejects(buildKocCanvasBatchPlan(root, input), /embedded control-video audio/);
});
