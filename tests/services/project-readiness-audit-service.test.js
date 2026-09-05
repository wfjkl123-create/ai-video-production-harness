import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relative } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { auditProjectReadiness, reconcileProjectPhase } from '../../src/services/project-readiness-audit-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { prepareGate5ReworkWorkOrder } from '../../src/services/gate5-rework-work-order-service.js';

async function fixture(state) {
  const root = await mkdtemp(join(tmpdir(), 'project-readiness-'));
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  return root;
}

function state(overrides = {}) {
  return {
    projectId: 'AUDIT-1', phase: 'intake', activeSegmentId: null, blockedReason: null,
    artifacts: [], updatedAt: '2026-08-02T00:00:00Z', ...overrides
  };
}

test('unregistered generated video and stale phase block further production', async () => {
  const root = await fixture(state());
  await writeFile(join(root, 'outputs', 'take.mp4'), 'video');
  const report = await auditProjectReadiness(root);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.derivedPhase, 'generation_unregistered');
  assert.ok(report.findings.some(item => item.id === 'PHASE_DRIFT'));
  assert.ok(report.findings.some(item => item.id === 'UNREGISTERED_VIDEO_OUTPUTS'));
});

test('latest singleton suppresses stale pending review in the audit', async () => {
  const root = await fixture(state({ phase: 'asset_planning', artifacts: [
    { id: 'story-v1', type: 'story_plan', revision: 1, status: 'awaiting_review', path: 'story-v1.json' },
    { id: 'story-v2', type: 'story_plan', revision: 2, status: 'locked', lockedByReviewId: 'r2', path: 'story-v2.json' }
  ] }));
  await writeJsonAtomic(join(root, 'story-v2.json'), {
    directorPlan: { projectType: 'product_demo', transformMode: 'local_edit' }, characters: [], videoSegments: [],
    shotPlanning: { mode: 'shotlist', shots: [] }
  });
  const report = await auditProjectReadiness(root);
  assert.ok(report.supersededArtifactIds.includes('story-v1'));
  assert.ok(report.findings.some(item => item.id === 'STALE_PENDING_REVIEW'));
});

test('a reopened upstream creative or story gate takes precedence over stale downstream prompts', async () => {
  const root = await fixture(state({ phase: 'creative_review', artifacts: [
    { id: 'creative-v1', type: 'creative_brief', revision: 1, status: 'locked', lockedByReviewId: 'r1', path: 'creative-v1.json' },
    { id: 'creative-v2', type: 'creative_brief', revision: 2, status: 'draft', path: 'creative-v2.json' },
    { id: 'prompt-v1', type: 'seedance_prompt', segmentId: 'segment-001', revision: 1, status: 'locked', lockedByReviewId: 'r2', path: 'prompt-v1.txt' }
  ] }));
  let report = await auditProjectReadiness(root);
  assert.equal(report.derivedPhase, 'creative_review');
  assert.equal(report.status, 'PASS');

  const project = await readJson(join(root, 'project-state.json'));
  project.artifacts[1].status = 'locked';
  project.artifacts[1].lockedByReviewId = 'r3';
  project.artifacts.push({ id: 'story-v2', type: 'story_plan', revision: 2, status: 'draft', path: 'story-v2.json' });
  project.phase = 'story_plan_review';
  await writeJsonAtomic(join(root, 'project-state.json'), project);
  report = await auditProjectReadiness(root);
  assert.equal(report.derivedPhase, 'story_plan_review');
  assert.equal(report.status, 'PASS');
});

test('unfinished current assets take precedence over stale locked prompts', async () => {
  const root = await fixture(state({ phase: 'asset_production', artifacts: [
    { id: 'prompt-v1', type: 'seedance_prompt', segmentId: 'segment-001', revision: 1, status: 'locked', lockedByReviewId: 'r1', path: 'prompt-v1.txt' },
    { id: 'timing-v2', type: 'segment_asset', assetType: 'timing_audio_reference', segmentId: 'segment-001', mediaKind: 'audio', revision: 2, status: 'draft', path: 'timing-v2.wav', sha256: 'a'.repeat(64) }
  ] }));
  const report = await auditProjectReadiness(root);
  assert.equal(report.derivedPhase, 'asset_production');
  assert.equal(report.status, 'PASS');
});

test('phase reconciliation records evidence and changes only the factual project phase', async () => {
  const root = await fixture(state({ phase: 'story_plan_review' }));
  const before = await readJson(join(root, 'project-state.json'));
  const result = await reconcileProjectPhase(root);
  assert.equal(result.changed, true);
  assert.equal(result.phase, 'intake');
  const after = await readJson(join(root, 'project-state.json'));
  assert.equal(after.phase, 'intake');
  assert.deepEqual(after.artifacts, before.artifacts);
  const record = await readJson(join(root, result.recordPath));
  assert.equal(record.previousPhase, 'story_plan_review');
  assert.equal(record.reconciledPhase, 'intake');
  assert.equal(record.automaticAction, 'phase_only');
});

test('phase reconciliation resolves a relative project root before journaling', async () => {
  const root = await fixture(state({ phase: 'story_plan_review' }));
  const relativeRoot = relative(process.cwd(), root);
  const result = await reconcileProjectPhase(relativeRoot);
  assert.equal(result.phase, 'intake');
  assert.equal((await readJson(join(root, 'project-state.json'))).phase, 'intake');
});

test('a registered rejected latest take routes to rework instead of unregistered generation', async () => {
  const root = await fixture(state({ phase: 'generation_rework', artifacts: [{
    id: 'failed-take', type: 'video_segment', segmentId: 'segment-001', revision: 1,
    status: 'rejected', path: 'outputs/take.mp4', sha256: 'a'.repeat(64)
  }] }));
  await writeFile(join(root, 'outputs', 'take.mp4'), 'video');
  const report = await auditProjectReadiness(root);
  assert.equal(report.derivedPhase, 'generation_rework');
  assert.equal(report.unregisteredVideoCandidates.length, 0);
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.findings.some(item => item.id === 'GATE5_REJECTION_UNCLASSIFIED'));
});

test('readiness exposes a structured minimal Gate 5 return without treating it as accepted', async () => {
  const root = await fixture(state({ phase: 'generation_rework' }));
  const path = join(root, 'outputs', 'take.mp4');
  await writeFile(path, 'rejected video');
  const sha256 = await sha256File(path);
  const project = await readJson(join(root, 'project-state.json'));
  project.artifacts.push({
    id: 'take-v1', type: 'video_segment', segmentId: 'segment-001', revision: 1,
    status: 'rejected', path: 'outputs/take.mp4', sha256, rejectedByReviewId: 'quality-review-v1'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), project);
  await writeJsonAtomic(join(root, 'reviews', 'quality-review-v1.json'), {
    id: 'quality-review-v1', kind: 'quality_review', actor: 'human', artifactId: 'take-v1', artifactSha256: sha256,
    rubricId: 'rubric-v1', rubricSha256: 'b'.repeat(64), rubricVersion: 1, scores: {}, triggeredVetoIds: [],
    failures: ['veto'], overall: 0, qualifies: false, decision: 'rejected', note: '产品错绑',
    correction: '只回到资产绑定。', createdAt: '2026-08-25T01:00:00.000Z',
    failureObservation: {
      category: 'asset_wrong_binding', rootCauseKey: 'asset-binding-001',
      responsibilityStage: 'assets', returnStage: 'assets', retryKind: 'none'
    }
  });
  const report = await auditProjectReadiness(root);
  assert.equal(report.status, 'WARN');
  assert.equal(report.gate5FailureReturns.open[0].routing.returnStage, 'assets');
  assert.equal(report.gate5FailureReturns.open[0].routing.automaticPaidRetryAllowed, false);
  assert.deepEqual(report.gate5ReworkWorkOrders, []);
  assert.ok(report.findings.some(item => item.id === 'GATE5_FAILURE_RETURN_OPEN'));
  assert.ok(report.findings.some(item => item.id === 'GATE5_REWORK_ORDER_NOT_PREPARED'));
  await prepareGate5ReworkWorkOrder(root, {
    failureReturnId: report.gate5FailureReturns.open[0].id, confirm: true
  });
  const preparedReport = await auditProjectReadiness(root);
  assert.equal(preparedReport.gate5ReworkWorkOrders.length, 1);
  assert.ok(preparedReport.findings.some(item => item.id === 'GATE5_REWORK_ORDER_OPEN'));
});

test('final edit rejection is also routed to Gate 5 rework instead of intake', async () => {
  const root = await fixture(state({ phase: 'generation_rework', artifacts: [{
    id: 'final-v1', type: 'final_edit', revision: 1, status: 'rejected', path: 'outputs/final.mp4', sha256: 'a'.repeat(64)
  }] }));
  const report = await auditProjectReadiness(root);
  assert.equal(report.derivedPhase, 'generation_rework');
  assert.ok(report.findings.some(item => item.id === 'GATE5_REJECTION_UNCLASSIFIED'));
});

test('superseded registered video paths remain evidence rather than becoming unregistered again', async () => {
  const root = await fixture(state({ phase: 'generation_rework', artifacts: [
    { id: 'take-v1', type: 'video_segment', segmentId: 'segment-001', revision: 1, status: 'draft', path: 'outputs/take-v1.mp4', sha256: 'a'.repeat(64) },
    { id: 'take-v2', type: 'video_segment', segmentId: 'segment-001', revision: 2, status: 'rejected', path: 'outputs/take-v2.mp4', sha256: 'b'.repeat(64), supersedesArtifactId: 'take-v1' }
  ] }));
  await writeFile(join(root, 'outputs', 'take-v1.mp4'), 'old video');
  await writeFile(join(root, 'outputs', 'take-v2.mp4'), 'new video');
  const report = await auditProjectReadiness(root);
  assert.deepEqual(report.unregisteredVideoCandidates, []);
});

test('checksum-bound non-canonical disposition accounts for rejected or archive-only video evidence', async () => {
  const root = await fixture(state({ phase: 'intake' }));
  const path = join(root, 'outputs', 'take.mp4');
  await writeFile(path, 'video');
  await writeJsonAtomic(join(root, 'reviews', 'readiness', 'unregistered-video-candidates-v1.json'), {
    kind: 'unregistered_video_candidate_inventory',
    candidates: [{ relativePath: 'outputs/take.mp4', sha256: await sha256File(path), humanDecision: 'archive_only' }]
  });
  const report = await auditProjectReadiness(root);
  assert.deepEqual(report.unregisteredVideoCandidates, []);
  assert.equal(report.cataloguedNoncanonicalVideoCandidates[0].decision, 'archive_only');
  assert.equal(report.status, 'PASS');
});

test('an explicitly archived project remains archived after its video evidence is catalogued', async () => {
  const root = await fixture(state({ phase: 'archived' }));
  const path = join(root, 'outputs', 'historical.mp4');
  await writeFile(path, 'historical video');
  await writeJsonAtomic(join(root, 'reviews', 'readiness', 'unregistered-video-candidates-v1.json'), {
    kind: 'unregistered_video_candidate_inventory',
    candidates: [{ relativePath: 'outputs/historical.mp4', sha256: await sha256File(path), humanDecision: 'archive_only' }]
  });
  const report = await auditProjectReadiness(root);
  assert.equal(report.derivedPhase, 'archived');
  assert.equal(report.status, 'PASS');
});

test('changed video bytes invalidate an old non-canonical disposition', async () => {
  const root = await fixture(state());
  const path = join(root, 'outputs', 'take.mp4');
  await writeFile(path, 'old video');
  const sha256 = await sha256File(path);
  await writeJsonAtomic(join(root, 'reviews', 'readiness', 'unregistered-video-candidates-v1.json'), {
    kind: 'unregistered_video_candidate_inventory',
    candidates: [{ relativePath: 'outputs/take.mp4', sha256, humanDecision: 'rejected_evidence' }]
  });
  await writeFile(path, 'changed video');
  const report = await auditProjectReadiness(root);
  assert.deepEqual(report.unregisteredVideoCandidates, ['outputs/take.mp4']);
  assert.ok(report.findings.some(item => item.id === 'VIDEO_DISPOSITION_SHA_MISMATCH'));
  assert.equal(report.status, 'BLOCKED');
});
