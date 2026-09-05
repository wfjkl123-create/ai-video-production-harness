import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimStudioGenerationJob,
  cancelQueuedStudioGenerationJobs,
  cancelRestartPausedStudioGenerationJob,
  completeStudioGenerationJob,
  createStudioGenerationJob,
  listStudioGenerationJobs,
  pauseQueuedStudioGenerationJobs,
  recoverInterruptedStudioGenerationJobs,
  resumeStudioGenerationJob,
  createStudioGenerationResumeApproval,
  createStudioImageGenerationApproval,
  failStudioGenerationJob,
  findBlockingStudioGenerationJob,
  requireStudioGenerationResumeApproval,
  requireStudioImageGenerationApproval
} from '../../src/services/studio-generation-job-service.js';

test('paid generation jobs are persisted and can complete only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  const job = await createStudioGenerationJob(root, { kind: 'video', principalId: 'member-a', projectSlug: 'project-a', fingerprintSha256: 'a'.repeat(64), request: { segmentId: 'segment-001' } });
  assert.equal((await claimStudioGenerationJob(root, job.id)).status, 'RUNNING');
  assert.equal((await completeStudioGenerationJob(root, job.id, { runId: 'run-1' })).status, 'SUCCESS');
  await assert.rejects(claimStudioGenerationJob(root, job.id), /cannot move/);
});

test('an interrupted running paid job is never silently retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  const job = await createStudioGenerationJob(root, { kind: 'image', principalId: 'member-a', projectSlug: 'project-a', fingerprintSha256: 'b'.repeat(64), request: { segmentId: 'segment-001' } });
  await claimStudioGenerationJob(root, job.id);
  await recoverInterruptedStudioGenerationJobs(root);
  assert.equal((await listStudioGenerationJobs(root))[0].status, 'NEEDS_RECONCILIATION');
});

test('revocation cancels queued jobs but never pretends to cancel a running provider call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  const queued = await createStudioGenerationJob(root, { kind: 'image', principalId: 'member-a', projectSlug: 'project-a', fingerprintSha256: 'c'.repeat(64), request: { segmentId: 'segment-001' } });
  const running = await createStudioGenerationJob(root, { kind: 'video', principalId: 'member-a', projectSlug: 'project-a', fingerprintSha256: 'd'.repeat(64), request: { segmentId: 'segment-002' } });
  await claimStudioGenerationJob(root, running.id);
  assert.equal((await cancelQueuedStudioGenerationJobs(root, 'member-a')).length, 1);
  const jobs = await listStudioGenerationJobs(root);
  assert.equal(jobs.find(item => item.id === queued.id).status, 'CANCELED');
  assert.equal(jobs.find(item => item.id === running.id).status, 'RUNNING');
});

test('image execution requires the exact one-attempt operator approval', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'studio-image-approval-'));
  const input = { jobId: 'studio-job-00000000-0000-0000-0000-000000000001', principalId: 'member-a', segmentId: 'segment-001', fingerprintSha256: 'e'.repeat(64), note: 'confirmed exact paid image batch' };
  const approval = await createStudioImageGenerationApproval(projectRoot, input);
  assert.equal((await requireStudioImageGenerationApproval(projectRoot, { ...input, approvalId: approval.id })).maxPaidAttempts, 1);
  await assert.rejects(requireStudioImageGenerationApproval(projectRoot, { ...input, principalId: 'member-b', approvalId: approval.id }), /lost its one-attempt/);
});

test('the same segment and generation kind cannot be queued twice while an earlier job is unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  const input = { kind: 'image', principalId: 'member-a', projectSlug: 'project-a', fingerprintSha256: 'f'.repeat(64), request: { segmentId: 'segment-001' } };
  const first = await createStudioGenerationJob(root, input);
  await assert.rejects(createStudioGenerationJob(root, { ...input, fingerprintSha256: '0'.repeat(64) }), /already owns image segment-001/);
  await createStudioGenerationJob(root, { ...input, fingerprintSha256: '2'.repeat(64), request: { segmentId: 'segment-002' } });
  await createStudioGenerationJob(root, { ...input, kind: 'video', fingerprintSha256: '3'.repeat(64) });
  await claimStudioGenerationJob(root, first.id);
  await failStudioGenerationJob(root, first.id, 'failed before provider submission', { uncertain: false });
  const replacement = await createStudioGenerationJob(root, { ...input, fingerprintSha256: '4'.repeat(64) });
  assert.equal(replacement.request.segmentId, 'segment-001');
});

test('concurrent creates have one winner and legacy unscoped unresolved jobs fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  const base = { kind: 'video', principalId: 'member-a', projectSlug: 'project-a', request: { segmentId: 'segment-001' } };
  const results = await Promise.allSettled([
    createStudioGenerationJob(root, { ...base, fingerprintSha256: 'a'.repeat(64) }),
    createStudioGenerationJob(root, { ...base, fingerprintSha256: 'b'.repeat(64) })
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  const legacy = findBlockingStudioGenerationJob([{
    id: 'legacy-job', projectSlug: 'project-a', kind: 'image', status: 'NEEDS_RECONCILIATION', request: {}
  }], { projectSlug: 'project-a', kind: 'image', segmentId: 'segment-999' });
  assert.equal(legacy.id, 'legacy-job');
});

test('queued paid jobs pause across restart and require a fresh resume decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  const job = await createStudioGenerationJob(root, { kind: 'video', principalId: 'member-a', projectSlug: 'project-a', fingerprintSha256: '1'.repeat(64), request: { segmentId: 'segment-001' } });
  await pauseQueuedStudioGenerationJobs(root);
  assert.equal((await listStudioGenerationJobs(root))[0].status, 'PAUSED_REQUIRES_CONFIRMATION');
  const projectRoot = await mkdtemp(join(tmpdir(), 'studio-resume-approval-'));
  const approval = await createStudioGenerationResumeApproval(projectRoot, {
    authorizationId: 'generation-authorization-00000000-0000-0000-0000-000000000001',
    jobId: job.id,
    kind: 'video',
    originalSubmitterId: 'member-a',
    authorizedByPrincipalId: 'owner',
    fingerprintSha256: '1'.repeat(64),
    note: 'owner rechecked exact fingerprint after restart'
  });
  const resumed = await resumeStudioGenerationJob(root, job.id, {
    authorizedByPrincipalId: 'owner',
    resumeApprovalId: approval.id,
    fingerprintSha256: '1'.repeat(64)
  });
  assert.equal(resumed.status, 'QUEUED');
  assert.equal(resumed.originalSubmitterId, 'member-a');
  assert.equal(resumed.authorizedByPrincipalId, 'owner');
  assert.equal((await requireStudioGenerationResumeApproval(projectRoot, resumed)).id, approval.id);
  await assert.rejects(requireStudioGenerationResumeApproval(projectRoot, { ...resumed, authorizedByPrincipalId: 'member-a' }), /lost its fresh human resume approval/);
});

test('a restart-paused pre-submission job can be explicitly canceled to release the segment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  const input = { kind: 'video', principalId: 'member-a', projectSlug: 'project-a', fingerprintSha256: '9'.repeat(64), request: { segmentId: 'segment-001' } };
  const job = await createStudioGenerationJob(root, input);
  await pauseQueuedStudioGenerationJobs(root);
  assert.equal((await cancelRestartPausedStudioGenerationJob(root, job.id)).status, 'CANCELED');
  assert.equal((await createStudioGenerationJob(root, { ...input, fingerprintSha256: '8'.repeat(64) })).status, 'QUEUED');
});
