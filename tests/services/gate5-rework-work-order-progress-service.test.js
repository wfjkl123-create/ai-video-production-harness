import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { determineNextActions } from '../../src/services/next-action-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import {
  prepareGate5ReworkWorkOrder,
  updateGate5ReworkWorkOrderProgress
} from '../../src/services/gate5-rework-work-order-service.js';

async function rejectedProject() {
  const root = await mkdtemp(join(tmpdir(), 'gate5-progress-'));
  await initializeProject(root, { projectId: 'GATE5-PROGRESS', workflowVersion: 1 });
  const videoPath = join(root, 'segment-001-rejected.mp4');
  await writeFile(videoPath, 'rejected Gate 5 video');
  const sha256 = await sha256File(videoPath);
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({
    id: 'video-segment-001-v1', type: 'video_segment', segmentId: 'segment-001', revision: 1,
    status: 'rejected', path: 'segment-001-rejected.mp4', sha256,
    rejectedByReviewId: 'quality-review-rejected-001'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await writeJsonAtomic(join(root, 'reviews', 'quality-review-rejected-001.json'), {
    id: 'quality-review-rejected-001', kind: 'quality_review', actor: 'human',
    artifactId: 'video-segment-001-v1', artifactSha256: sha256,
    rubricId: 'rubric-v1', rubricSha256: 'b'.repeat(64), rubricVersion: 1,
    scores: {}, triggeredVetoIds: [], failures: ['wrong binding'], overall: 0,
    qualifies: false, decision: 'rejected', note: '商品绑定错误',
    correction: '只回到资产绑定。', createdAt: '2026-08-25T01:00:00.000Z',
    failureObservation: {
      category: 'asset_wrong_binding', rootCauseKey: 'asset-binding-001',
      responsibilityStage: 'assets', returnStage: 'assets', retryKind: 'none'
    }
  });
  const action = (await determineNextActions(root)).actions[0];
  const prepared = await prepareGate5ReworkWorkOrder(root, {
    failureReturnId: action.failureReturnId, confirm: true
  }, { now: '2026-08-25T02:00:00.000Z' });
  return { root, workOrderId: prepared.workOrder.id };
}

function checkpoint(kind = 'artifact', id = 'asset-v2', sha = 'c'.repeat(64)) {
  return [{ kind, id, sha256: sha, path: `evidence/${id}.json` }];
}

test('Gate 5 rework progress pauses, resumes and completes only the ordered active stage', async () => {
  const { root, workOrderId } = await rejectedProject();
  let result = await updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'start', stage: 'assets', confirm: true
  }, { now: '2026-08-25T03:00:00.000Z' });
  assert.equal(result.workOrder.status, 'IN_PROGRESS');
  assert.equal(result.workOrder.steps[0].status, 'in_progress');

  result = await updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'pause', reason: '等待新的商品结构证据', confirm: true
  }, { now: '2026-08-25T03:05:00.000Z' });
  assert.equal(result.workOrder.status, 'PAUSED');
  await assert.rejects(updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'complete', stage: 'assets', note: '不应越过暂停',
    evidence: checkpoint(), confirm: true
  }), /resume/);

  result = await updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'resume', confirm: true
  }, { now: '2026-08-25T03:10:00.000Z' });
  assert.equal(result.workOrder.status, 'IN_PROGRESS');
  assert.equal(result.workOrder.steps[0].status, 'in_progress');

  const completionInput = {
    workOrderId, action: 'complete', stage: 'assets', note: '资产绑定已按新 SHA 复核',
    evidence: checkpoint(), confirm: true
  };
  result = await updateGate5ReworkWorkOrderProgress(root, completionInput, {
    now: '2026-08-25T03:15:00.000Z'
  });
  assert.equal(result.workOrder.steps[0].status, 'completed');
  assert.equal(result.workOrder.steps[1].status, 'pending');
  const replayed = await updateGate5ReworkWorkOrderProgress(root, completionInput, {
    now: '2026-08-25T03:16:00.000Z'
  });
  assert.equal(replayed.reused, true);
  assert.equal(replayed.workOrder.progressRevision, result.workOrder.progressRevision);

  await assert.rejects(updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'start', stage: 'paid_approval', confirm: true
  }), /cannot be skipped/);
});

test('paid, generation and Gate 5 checkpoints require their exact evidence kinds', async () => {
  const { root, workOrderId } = await rejectedProject();
  const genericStages = ['assets', 'prompt'];
  for (const [index, stage] of genericStages.entries()) {
    await updateGate5ReworkWorkOrderProgress(root, {
      workOrderId, action: 'start', stage, confirm: true
    }, { now: `2026-08-25T04:0${index}:00.000Z` });
    await updateGate5ReworkWorkOrderProgress(root, {
      workOrderId, action: 'complete', stage, note: `${stage} complete`,
      evidence: checkpoint('artifact', `${stage}-v2`), confirm: true
    }, { now: `2026-08-25T04:1${index}:00.000Z` });
  }
  await updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'start', stage: 'paid_approval', confirm: true
  }, { now: '2026-08-25T04:20:00.000Z' });
  await assert.rejects(updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'complete', stage: 'paid_approval', note: 'wrong evidence',
    evidence: checkpoint('old_paid_authorization', 'old-approval'), confirm: true
  }), /new_paid_authorization/);
  const paid = await updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'complete', stage: 'paid_approval', note: 'new authorization bound',
    evidence: checkpoint('new_paid_authorization', 'approval-v2'), confirm: true
  }, { now: '2026-08-25T04:21:00.000Z' });
  assert.equal(paid.workOrder.paidBoundary.existingApprovalReusable, false);

  await updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'start', stage: 'generation', confirm: true
  }, { now: '2026-08-25T04:30:00.000Z' });
  await assert.rejects(updateGate5ReworkWorkOrderProgress(root, {
    workOrderId, action: 'complete', stage: 'generation', note: 'missing output',
    evidence: checkpoint('provider_task', 'task-v2'), confirm: true
  }), /generation_output/);
});

test('a crash after progress write recovers idempotently without a second transition', async () => {
  const { root, workOrderId } = await rejectedProject();
  const input = { workOrderId, action: 'start', stage: 'assets', confirm: true };
  await assert.rejects(updateGate5ReworkWorkOrderProgress(root, input, {
    now: '2026-08-25T05:00:00.000Z',
    transactionOptions: { afterWrite: async () => { throw new Error('simulated progress crash'); } }
  }), /simulated progress crash/);
  const recovered = await updateGate5ReworkWorkOrderProgress(root, input, {
    now: '2026-08-25T05:01:00.000Z'
  });
  assert.equal(recovered.reused, true);
  assert.equal(recovered.workOrder.progressRevision, 1);
  assert.equal(recovered.workOrder.steps[0].status, 'in_progress');
});
