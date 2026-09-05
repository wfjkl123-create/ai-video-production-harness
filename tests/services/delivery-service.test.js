import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';
import { persistSegmentation } from '../../src/services/segmentation-workflow-service.js';
import { inspectVideoPackage } from '../../src/services/video-generation-service.js';
import { assertFinalEditContract, finalizeDelivery, verifyDelivery } from '../../src/services/delivery-service.js';
import { determineNextActions } from '../../src/services/next-action-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { lockPassingIndependentAudit } from '../helpers/independent-creative-audit-fixture.js';
import { recordQualityReview } from '../../src/services/quality-review-service.js';
import {
  executionLedgerProjectionPath,
  readExecutionEvents,
  readExecutionLedgerStatus
} from '../../src/services/execution-ledger-service.js';

const deliveryRubric = {
  id: 'delivery-rubric-v1', version: 1, threshold: 80,
  dimensions: [{ id: 'final_quality', label: '最终质量', weight: 100, minimum: 80, critical: true }],
  vetoes: []
};

async function readyDeliveryProject() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-service-'));
  await initializeProject(root, { projectId: 'DELIVERY-TEST' });
  const segmentation = await persistSegmentation(root, {
    id: 'segmentation-v1', path: 'segments/segmentation-v1.json',
    segments: [{ id: 'segment-001', duration: 12, status: 'awaiting_review', lockedByReviewId: null,
      previousSegmentId: null, nextSegmentId: null, projectAssetIds: [], segmentAssetRequirements: [] }]
  });
  await submitForReview(root, segmentation.id);
  await approveArtifact(root, segmentation.id, 'human approved canonical segment');
  await mkdir(join(root, 'prompts/segment-001'), { recursive: true });
  await mkdir(join(root, 'outputs/segment-001'), { recursive: true });
  await writeFile(join(root, 'prompts/segment-001.txt'), 'locked generation prompt');
  await writeJsonAtomic(join(root, 'prompts/segment-001/seedance-package.json'), {
    segmentId: 'segment-001', duration: 12, ratio: '9:16', resolution: '720p',
    promptPath: 'prompts/segment-001.txt', imageInputs: [], videoInputs: [], audioInputs: []
  });
  await lockPassingIndependentAudit(root, 'segment-001');
  await writeFile(join(root, 'outputs/segment-001/result-1.mp4'), 'approved generated video');
  await writeJsonAtomic(join(root, 'brief/delivery-rubric-v1.json'), deliveryRubric);
  const rubricArtifact = await registerArtifact(root, {
    id: deliveryRubric.id, type: 'quality_rubric', revision: 1, status: 'draft', path: 'brief/delivery-rubric-v1.json'
  });
  await submitForReview(root, rubricArtifact.id);
  await approveArtifact(root, rubricArtifact.id, 'human approved delivery rubric');
  const video = await registerArtifact(root, {
    id: 'video-segment-001', type: 'video_segment', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'outputs/segment-001/result-1.mp4'
  });
  await submitForReview(root, video.id);
  await recordQualityReview(root, {
    artifactId: video.id, rubricId: rubricArtifact.id, decision: 'approved', note: 'human approved final segment video',
    scores: { final_quality: 100 }, triggeredVetoIds: []
  });
  const state = await readJson(join(root, 'project-state.json'));
  const lockedVideo = state.artifacts.find(({ id }) => id === video.id);
  const inspected = await inspectVideoPackage(root, 'segment-001');
  await writeJsonAtomic(join(root, 'runs/runninghub-success.json'), {
    id: 'runninghub-success', kind: 'runninghub_video', segmentId: 'segment-001', status: 'SUCCESS',
    taskId: 'task-safe-001', fingerprint: inspected.fingerprint,
    outputs: [{ path: lockedVideo.path, sha256: lockedVideo.sha256 }]
  });
  return { root, lockedVideo };
}

test('lists a segment only when human review, package fingerprint, SUCCESS run and output SHA all bind', async () => {
  const { root, lockedVideo } = await readyDeliveryProject();
  const report = await verifyDelivery(root);
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.deliverable, [{
    segmentId: 'segment-001', videoArtifactId: lockedVideo.id, path: lockedVideo.path,
    sha256: lockedVideo.sha256, runId: 'runninghub-success', taskId: 'task-safe-001', provider: 'runninghub',
    packageFingerprint: report.deliverable[0].packageFingerprint
  }]);
  assert.match(report.deliverable[0].packageFingerprint, /^[a-f0-9]{64}$/);
});

test('final delivery atomically records the retrospective and archives the completed project', async () => {
  const { root } = await readyDeliveryProject();
  const reflection = {
    outcome: '单段成片已经通过最终质量审核并完成交付。',
    whatWorked: '生成包指纹、人工审片和输出 SHA 保持一致。',
    whatFailed: '本次演练没有遗留失败项，外部等待时间仍需单独记录。',
    nextProjectChange: '下个项目继续在生成前锁定相同的证据边界。',
    ruleCandidates: ['生成结果必须绑定当前生成包指纹后才能交付。']
  };
  const observationRequests = [];
  const deriveExecutionObservation = async (projectRoot, request) => {
    await assert.rejects(access(join(projectRoot, '.review-mutation.lock')), error => error.code === 'ENOENT');
    assert.equal((await readJson(join(projectRoot, 'project-state.json'))).phase, 'archived');
    assert.equal((await readJson(join(projectRoot, 'deliveries', 'final-delivery-receipt.json'))).status, 'COMPLETE');
    observationRequests.push(request);
    return { reused: observationRequests.length > 1 };
  };
  const first = await finalizeDelivery(root, reflection, {
    id: 'delivery-test', now: '2026-08-19T12:00:00.000Z', deriveExecutionObservation
  });
  assert.equal(first.reused, false);
  assert.equal(first.receipt.status, 'COMPLETE');
  assert.equal(first.retrospective.promotionPolicy, 'candidate_only_until_verified_repair_review');
  assert.equal((await readJson(join(root, 'project-state.json'))).phase, 'archived');
  assert.deepEqual((await determineNextActions(root)).actions, []);
  assert.deepEqual((await readExecutionEvents(root)).map(event => event.type), [
    'ledger.bootstrap', 'quality_review.accepted', 'delivery.finalized'
  ]);
  const projection = await readJson(executionLedgerProjectionPath(root));
  assert.equal(projection.delivery.status, 'finalized');
  assert.equal(projection.gate5.status, 'delivery_finalized');
  assert.equal(projection.counts.deliveries, 1);
  assert.deepEqual(observationRequests, [{
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'final_delivery_media'
  }]);

  const repeated = await finalizeDelivery(root, reflection, { deriveExecutionObservation });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.receipt.id, first.receipt.id);
  assert.equal((await readExecutionEvents(root)).filter(event => event.type === 'delivery.finalized').length, 1);
  assert.equal(observationRequests.length, 2);
});

test('delivery transaction recovery preserves one receipt and one finalized event', async () => {
  const { root } = await readyDeliveryProject();
  const reflection = {
    outcome: '故障恢复后仍应保持同一份最终交付。',
    whatWorked: '交付证据已经完整绑定。',
    whatFailed: '在项目归档后注入本地事务中断。',
    nextProjectChange: '继续使用事务恢复而不是重建交付。',
    ruleCandidates: []
  };
  let observationCalls = 0;
  const deriveExecutionObservation = async () => { observationCalls += 1; return { reused: false }; };
  await assert.rejects(finalizeDelivery(root, reflection, {
    id: 'delivery-crash', now: '2026-08-19T13:00:00.000Z',
    transactionOptions: { afterWrite: index => { if (index === 2) throw new Error('delivery-ledger-crash'); } },
    deriveExecutionObservation
  }), /delivery-ledger-crash/);
  assert.equal(observationCalls, 0);
  const recovered = await finalizeDelivery(root, reflection, { deriveExecutionObservation });
  assert.equal(recovered.reused, true);
  assert.equal((await readExecutionEvents(root)).filter(event => event.type === 'delivery.finalized').length, 1);
  assert.equal(observationCalls, 1);
});

test('completed final delivery automatically records locally probed final duration', async () => {
  const { root } = await readyDeliveryProject();
  const reflection = {
    outcome: '最终交付完成后记录同一成片的可追溯时长。',
    whatWorked: '交付回执和视频 SHA 在媒体探测前已经锁定。',
    whatFailed: '没有观察到会阻止本次交付的失败。',
    nextProjectChange: '继续把最终时长只绑定到完整交付回执。',
    ruleCandidates: []
  };
  await finalizeDelivery(root, reflection, {
    id: 'delivery-auto-duration',
    now: '2026-08-19T14:00:00.000Z',
    observationDerivationOptions: {
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ streams: [{ codec_type: 'video', duration: '12.500' }], format: {} }),
        stderr: ''
      })
    }
  });
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.consistency, 'consistent');
  assert.equal(status.observations.derivation.bySourceType.final_delivery_media, 1);
  assert.equal(status.observations.media.byKind.final_delivery.totalDurationMs, 12500);
});

test('accepts the default LibTV SUCCESS run with the same exact fingerprint and output SHA', async () => {
  const { root, lockedVideo } = await readyDeliveryProject();
  const projectUuid = 'a'.repeat(32);
  const nodeName = 'segment-001-seedance-video';
  const inspected = await inspectVideoPackage(root, 'segment-001', {
    executor: 'libtv', libtvProjectUuid: projectUuid, nodeName
  });
  await writeJsonAtomic(join(root, 'runs/runninghub-success.json'), {
    id: 'libtv-success', kind: 'libtv_video', segmentId: 'segment-001', status: 'SUCCESS',
    projectUuid, nodeName, taskId: 'task-safe-001', fingerprint: inspected.fingerprint,
    outputs: [{ path: lockedVideo.path, sha256: lockedVideo.sha256 }]
  });
  const report = await verifyDelivery(root);
  assert.deepEqual(report.blocked, []);
  assert.equal(report.deliverable[0].provider, 'libtv-cli');
  assert.equal(report.deliverable[0].runId, 'libtv-success');
});

test('tampered output, failed run, changed package, missing review, and project blocker never appear deliverable', async () => {
  for (const failure of ['tamper', 'failed-run', 'changed-package', 'missing-review', 'project-blocker']) {
    const { root, lockedVideo } = await readyDeliveryProject();
    if (failure === 'tamper') await writeFile(join(root, lockedVideo.path), 'tampered');
    if (failure === 'failed-run') {
      const run = await readJson(join(root, 'runs/runninghub-success.json'));
      await writeJsonAtomic(join(root, 'runs/runninghub-success.json'), { ...run, status: 'FAILED' });
    }
    if (failure === 'changed-package') {
      const packagePath = join(root, 'prompts/segment-001/seedance-package.json');
      const value = await readJson(packagePath);
      await writeJsonAtomic(packagePath, { ...value, duration: 11 });
    }
    if (failure === 'missing-review') {
      const statePath = join(root, 'project-state.json');
      const state = await readJson(statePath);
      state.artifacts = state.artifacts.map(artifact => artifact.id === lockedVideo.id
        ? { ...artifact, lockedByReviewId: 'missing-review' } : artifact);
      await writeJsonAtomic(statePath, state);
    }
    if (failure === 'project-blocker') {
      const statePath = join(root, 'project-state.json');
      const state = await readJson(statePath);
      await writeJsonAtomic(statePath, { ...state, blockedReason: 'manual blocker' });
    }
    const report = await verifyDelivery(root);
    assert.deepEqual(report.deliverable, [], failure);
    assert.equal(report.blocked[0].segmentId, 'segment-001', failure);
    assert.ok(report.blocked[0].reasons.length > 0, failure);
  }
});

test('a video approved before a newer segment contract is excluded from delivery', async () => {
  const { root } = await readyDeliveryProject();
  await new Promise(resolve => setTimeout(resolve, 2));
  await writeFile(join(root, 'contract-v2.json'), '{}');
  const contract = await registerArtifact(root, {
    id: 'contract-v2', type: 'segment_contract', segmentId: 'segment-001', revision: 2,
    status: 'draft', path: 'contract-v2.json'
  });
  await submitForReview(root, contract.id);
  await approveArtifact(root, contract.id, 'approve revised contract');

  const report = await verifyDelivery(root);
  assert.deepEqual(report.deliverable, []);
  assert.match(report.blocked[0].reasons[0], /current locked video artifact, found 0/);
});

test('multi-segment final edit binds every canonical take and completed picture/sound/color review', () => {
  const artifact = {
    id: 'final-edit-v1', type: 'final_edit', revision: 1, status: 'locked', path: 'outputs/final.mp4',
    lockedByReviewId: 'final-review', sha256: 'a'.repeat(64),
    sourceVideoArtifactIds: ['video-002', 'video-001'],
    editContract: { pictureLock: true, soundMix: true, colorContinuity: true, continuityReview: true }
  };
  assert.equal(assertFinalEditContract(artifact, [
    { videoArtifactId: 'video-001' }, { videoArtifactId: 'video-002' }
  ]), artifact);
  assert.throws(() => assertFinalEditContract({ ...artifact, sourceVideoArtifactIds: ['video-001'] }, [
    { videoArtifactId: 'video-001' }, { videoArtifactId: 'video-002' }
  ]), /every current canonical segment/);
  assert.throws(() => assertFinalEditContract({ ...artifact, editContract: { ...artifact.editContract, soundMix: false } }, [
    { videoArtifactId: 'video-001' }, { videoArtifactId: 'video-002' }
  ]), /soundMix/);
});
