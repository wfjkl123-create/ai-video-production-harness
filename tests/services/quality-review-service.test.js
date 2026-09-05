import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject, getProjectStatus } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';
import { recordQualityReview } from '../../src/services/quality-review-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { readExecutionEvents, executionLedgerProjectionPath } from '../../src/services/execution-ledger-service.js';
import { readJson } from '../../src/storage/json-store.js';

const rubric = {
  id: 'rubric-v1', version: 1, threshold: 80,
  dimensions: [
    { id: 'identity', label: '人物与产品', weight: 60, minimum: 70, critical: true },
    { id: 'camera', label: '镜头叙事', weight: 40, minimum: 60, critical: false }
  ],
  vetoes: [{ id: 'product_deformed', label: '产品变形' }]
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'quality-review-'));
  await initializeProject(root, { projectId: 'QUALITY-1' });
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'brief', 'quality-rubric.json'), `${JSON.stringify(rubric, null, 2)}\n`);
  await writeFile(join(root, 'outputs', 'video.mp4'), 'video bytes');
  await registerArtifact(root, { id: 'rubric-v1', type: 'quality_rubric', revision: 1, status: 'draft', path: 'brief/quality-rubric.json' });
  await submitForReview(root, 'rubric-v1');
  await approveArtifact(root, 'rubric-v1', '人工批准评分标准');
  await registerArtifact(root, { id: 'video-1', type: 'video_segment', segmentId: 'segment-001', revision: 1, status: 'draft', path: 'outputs/video.mp4' });
  await submitForReview(root, 'video-1');
  return root;
}

async function enableStrictVideoGovernance(root) {
  const path = join(root, 'project-state.json');
  const state = await readJson(path);
  await writeFile(path, `${JSON.stringify({ ...state, videoGovernanceVersion: 2 }, null, 2)}\n`);
}

const gate5Failure = {
  category: 'identity_drift',
  rootCauseKey: 'gate5.identity.character-binding',
  responsibilityStage: 'assets',
  returnStage: 'assets',
  retryKind: 'none'
};

test('quality approval atomically locks the video and binds rubric plus artifact bytes', async () => {
  const root = await setup();
  const review = await recordQualityReview(root, {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'approved',
    scores: { identity: 90, camera: 70 }, triggeredVetoIds: [], note: '达到本版标准'
  });
  assert.equal(review.kind, 'quality_review');
  assert.equal(review.actor, 'human');
  assert.equal(review.overall, 82);
  assert.equal(review.qualifies, true);
  assert.equal(review.rubricSha256, await sha256File(join(root, 'brief', 'quality-rubric.json')));
  assert.equal(review.artifactSha256, await sha256File(join(root, 'outputs', 'video.mp4')));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'reviews', `${review.id}.json`), 'utf8')), review);
  const video = (await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1');
  assert.equal(video.status, 'locked');
  assert.equal(video.lockedByReviewId, review.id);
  const events = await readExecutionEvents(root);
  assert.deepEqual(events.map(event => event.type), ['ledger.bootstrap', 'quality_review.accepted']);
  assert.equal(events.at(-1).facts.artifactSha256, review.artifactSha256);
  const projection = await readJson(executionLedgerProjectionPath(root));
  assert.equal(projection.bySegment['segment-001'].qualityDecision, 'accepted');
  assert.equal(projection.gate5.acceptedSegmentCount, 1);
});

test('uses the same Gate 5 quality evidence for a multi-segment final edit', async () => {
  const root = await setup();
  await writeFile(join(root, 'outputs', 'final.mp4'), 'final edit bytes');
  await registerArtifact(root, {
    id: 'final-edit-1', type: 'final_edit', revision: 1, status: 'draft', path: 'outputs/final.mp4',
    sourceVideoArtifactIds: ['video-a', 'video-b'],
    editContract: { pictureLock: true, soundMix: true, colorContinuity: true, continuityReview: true }
  });
  await submitForReview(root, 'final-edit-1');
  const review = await recordQualityReview(root, {
    artifactId: 'final-edit-1', rubricId: 'rubric-v1', decision: 'approved',
    scores: { identity: 90, camera: 70 }, triggeredVetoIds: [], note: '完整剪辑、声音、色彩和连续性均达到标准'
  });
  assert.equal(review.kind, 'quality_review');
  assert.equal((await getProjectStatus(root)).artifacts.find(({ id }) => id === 'final-edit-1').status, 'locked');
  assert.equal((await readJson(executionLedgerProjectionPath(root))).gate5.finalEditDecision, 'accepted');
});

test('rejects non-qualifying approval without an explicit human override', async () => {
  const root = await setup();
  await assert.rejects(recordQualityReview(root, {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'approved',
    scores: { identity: 60, camera: 100 }, triggeredVetoIds: [], note: '想批准'
  }), /overrideReason/);
  const video = (await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1');
  assert.equal(video.status, 'awaiting_review');
});

test('rejection records correction and leaves the video rejected', async () => {
  const root = await setup();
  const review = await recordQualityReview(root, {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'rejected',
    scores: { identity: 60, camera: 60 }, triggeredVetoIds: [], note: '人物身份漂移',
    correction: '重做人物资产并重新生成'
  });
  assert.equal(review.decision, 'rejected');
  assert.equal((await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1').status, 'rejected');
  assert.equal((await readExecutionEvents(root)).at(-1).type, 'quality_review.rejected');
});

test('strict Gate 5 rejection requires explicit root cause and automatically records the normalized failure', async () => {
  const root = await setup();
  await enableStrictVideoGovernance(root);
  const base = {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'rejected',
    scores: { identity: 60, camera: 60 }, triggeredVetoIds: [], note: '人物身份漂移',
    correction: '回到人物资产绑定后再生成'
  };
  await assert.rejects(recordQualityReview(root, base), /failureObservation is required/);
  assert.equal((await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1').status, 'awaiting_review');

  const review = await recordQualityReview(root, { ...base, failureObservation: gate5Failure });
  assert.deepEqual(review.failureObservation, gate5Failure);
  const artifact = (await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1');
  assert.equal(artifact.rejectedByReviewId, review.id);
  const events = await readExecutionEvents(root);
  assert.deepEqual(events.slice(-2).map(event => event.type), [
    'quality_review.rejected', 'execution_observation.recorded'
  ]);
  assert.equal(events.at(-1).facts.derivationSourceType, 'gate5_rejection');
  assert.deepEqual(events.at(-1).observation.failure, gate5Failure);
});

test('Gate 5 observation failure is fail-open and cannot erase the committed human rejection', async () => {
  const root = await setup();
  await enableStrictVideoGovernance(root);
  let observedError = null;
  const review = await recordQualityReview(root, {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'rejected',
    scores: { identity: 60, camera: 60 }, triggeredVetoIds: [], note: '人物身份漂移',
    correction: '回到人物资产绑定后再生成', failureObservation: gate5Failure,
    deriveExecutionObservation: async () => { throw new Error('injected-observation-failure'); },
    onObservationError: error => { observedError = error; }
  });
  assert.equal(review.decision, 'rejected');
  assert.match(observedError.message, /injected-observation-failure/);
  assert.equal((await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1').rejectedByReviewId, review.id);
  assert.deepEqual((await readExecutionEvents(root)).map(event => event.type), [
    'ledger.bootstrap', 'quality_review.rejected'
  ]);
});

test('strict Gate 5 acceptance resolves the exact rejected predecessor and preserves both review SHAs', async () => {
  const root = await setup();
  await enableStrictVideoGovernance(root);
  const rejection = await recordQualityReview(root, {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'rejected',
    scores: { identity: 60, camera: 60 }, triggeredVetoIds: [], note: '人物身份漂移',
    correction: '回到人物资产绑定后再生成', failureObservation: gate5Failure
  });
  await writeFile(join(root, 'outputs', 'video-v2.mp4'), 'video bytes v2');
  await registerArtifact(root, {
    id: 'video-2', type: 'video_segment', segmentId: 'segment-001', revision: 2,
    status: 'rework', path: 'outputs/video-v2.mp4', supersedesArtifactId: 'video-1'
  });
  await submitForReview(root, 'video-2');
  const approval = {
    artifactId: 'video-2', rubricId: 'rubric-v1', decision: 'approved',
    scores: { identity: 90, camera: 70 }, triggeredVetoIds: [], note: '人物身份已修复并通过复核'
  };
  await assert.rejects(recordQualityReview(root, approval), /resolvesReviewId/);
  await assert.rejects(recordQualityReview(root, { ...approval, resolvesReviewId: 'review-wrong' }), /exact rejected predecessor/);
  const accepted = await recordQualityReview(root, { ...approval, resolvesReviewId: rejection.id });
  assert.equal(accepted.resolvedRejection.reviewId, rejection.id);
  assert.equal(accepted.resolvedRejection.artifactId, 'video-1');
  assert.equal(accepted.resolvedRejection.reviewSha256, await sha256File(join(root, 'reviews', `${rejection.id}.json`)));
  const event = (await readExecutionEvents(root)).at(-1);
  assert.equal(event.type, 'quality_review.accepted');
  assert.equal(event.facts.resolvesReviewId, rejection.id);
  assert.ok(event.references.some(reference => reference.kind === 'resolved_quality_review'
    && reference.id === rejection.id && reference.sha256 === accepted.resolvedRejection.reviewSha256));
});

test('quality review transaction recovery rolls the Gate 5 event forward without a second decision', async () => {
  const root = await setup();
  const input = {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'approved',
    scores: { identity: 90, camera: 70 }, triggeredVetoIds: [], note: '故障注入审核'
  };
  await assert.rejects(recordQualityReview(root, {
    ...input,
    transactionOptions: { afterWrite: index => { if (index === 2) throw new Error('quality-ledger-crash'); } }
  }), /quality-ledger-crash/);
  const recovered = await recordQualityReview(root, input);
  assert.equal(recovered.decision, 'approved');
  const events = await readExecutionEvents(root);
  assert.equal(events.filter(event => event.type === 'quality_review.accepted').length, 1);
  assert.equal((await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1').status, 'locked');
});

test('recovered Gate 5 rejection remains one decision and still receives one failure observation', async () => {
  const root = await setup();
  await enableStrictVideoGovernance(root);
  const input = {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'rejected',
    scores: { identity: 60, camera: 60 }, triggeredVetoIds: [], note: '人物身份漂移',
    correction: '回到人物资产绑定后再生成', failureObservation: gate5Failure
  };
  await assert.rejects(recordQualityReview(root, {
    ...input,
    transactionOptions: { afterWrite: index => { if (index === 2) throw new Error('quality-rejection-crash'); } }
  }), /quality-rejection-crash/);
  const recovered = await recordQualityReview(root, input);
  const events = await readExecutionEvents(root);
  assert.equal(events.filter(event => event.type === 'quality_review.rejected').length, 1);
  assert.equal(events.filter(event => event.type === 'execution_observation.recorded'
    && event.facts.derivationSourceType === 'gate5_rejection').length, 1);
  assert.equal((await getProjectStatus(root)).artifacts.find(({ id }) => id === 'video-1').rejectedByReviewId, recovered.id);
});

test('refuses an unlocked rubric or a non-video target', async () => {
  const root = await setup();
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.artifacts.find(({ id }) => id === 'rubric-v1').status = 'draft';
  delete state.artifacts.find(({ id }) => id === 'rubric-v1').lockedByReviewId;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(recordQualityReview(root, {
    artifactId: 'video-1', rubricId: 'rubric-v1', decision: 'approved',
    scores: { identity: 90, camera: 70 }, triggeredVetoIds: [], note: '不应成功'
  }), /locked rubric/);
});

test('rubric v2 requires time-or-region evidence bound to canonical visual anchors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-review-v2-'));
  await initializeProject(root, { projectId: 'QUALITY-V2' });
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'brief', 'source-knit-action.json'), '{"action":"fine-thread progressive weaving"}\n');
  const anchorSha256 = await sha256File(join(root, 'brief', 'source-knit-action.json'));
  const rubricV2 = {
    id: 'rubric-v2', version: 2, threshold: 80,
    dimensions: [{
      id: 'weaving_causality', label: '编织因果', weight: 100, minimum: 80, critical: true,
      observableRequirement: '细线必须在未完成边界处连续进入并推进产品成形',
      evidenceType: 'frame_and_motion', timeOrRegion: '00:04-00:12 编织边界',
      canonicalAnchorIds: ['source-knit-action-001'],
      canonicalAnchorSha256ById: { 'source-knit-action-001': anchorSha256 }
    }],
    vetoes: [{ id: 'finished_product_overlay', label: '完成品上贴线' }]
  };
  await writeFile(join(root, 'brief', 'quality-rubric-v2.json'), `${JSON.stringify(rubricV2, null, 2)}\n`);
  await writeFile(join(root, 'outputs', 'video-v2.mp4'), 'video v2 bytes');
  await registerArtifact(root, { id: 'source-knit-action-001', type: 'rule', revision: 1, status: 'draft', path: 'brief/source-knit-action.json' });
  await submitForReview(root, 'source-knit-action-001');
  await approveArtifact(root, 'source-knit-action-001', '批准编织动作权威锚点');
  await registerArtifact(root, { id: 'rubric-v2', type: 'quality_rubric', revision: 1, status: 'draft', path: 'brief/quality-rubric-v2.json' });
  await submitForReview(root, 'rubric-v2');
  await approveArtifact(root, 'rubric-v2', '批准可观察质量合同');
  await registerArtifact(root, { id: 'video-v2', type: 'video_segment', segmentId: 'segment-001', revision: 1, status: 'draft', path: 'outputs/video-v2.mp4' });
  await submitForReview(root, 'video-v2');
  await assert.rejects(recordQualityReview(root, {
    artifactId: 'video-v2', rubricId: 'rubric-v2', decision: 'approved', scores: { weaving_causality: 90 },
    triggeredVetoIds: [], note: '缺证据不应通过'
  }), /evidenceByDimension/);
  const review = await recordQualityReview(root, {
    artifactId: 'video-v2', rubricId: 'rubric-v2', decision: 'approved', scores: { weaving_causality: 90 },
    evidenceByDimension: {
      weaving_causality: {
        observation: '00:04.2 细线与未完成裤腿边界连续接触，00:11.8 成形进度前移',
        timestampsOrRegions: ['00:04.2', '00:11.8'], anchorIds: ['source-knit-action-001'],
        anchorSha256ById: { 'source-knit-action-001': anchorSha256 }
      }
    },
    triggeredVetoIds: [], note: '逐时点证据满足可观察合同'
  });
  assert.equal(review.qualifies, true);
  assert.equal(review.evidenceByDimension.weaving_causality.anchorIds[0], 'source-knit-action-001');
});
