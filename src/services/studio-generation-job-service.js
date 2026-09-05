import { mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';

let mutationTail = Promise.resolve();

const BLOCKING_GENERATION_JOB_STATUSES = new Set([
  'QUEUED',
  'RUNNING',
  'PAUSED_REQUIRES_CONFIRMATION',
  'NEEDS_RECONCILIATION'
]);

function jobsRoot(root) {
  return join(resolve(root), 'generation-jobs');
}

function jobPath(root, id) {
  if (!/^studio-job-[a-f0-9-]+$/.test(id ?? '')) throw new TypeError('generation job id is invalid');
  return join(jobsRoot(root), `${id}.json`);
}

function serialize(work) {
  const result = mutationTail.then(work, work);
  mutationTail = result.catch(() => {});
  return result;
}

export async function createStudioGenerationJob(root, input) {
  if (!['image', 'video'].includes(input.kind)) throw new TypeError('generation job kind must be image or video');
  if (!input.principalId || !input.projectSlug || !input.fingerprintSha256) throw new TypeError('generation job identity and fingerprint are required');
  if (typeof input.request?.segmentId !== 'string' || input.request.segmentId.trim() === '') throw new TypeError('generation job segmentId is required');
  return serialize(async () => {
    const duplicate = findBlockingStudioGenerationJob(await listStudioGenerationJobs(root), input);
    if (duplicate) throw new Error(`an active or unresolved generation job already owns ${input.kind} ${input.request.segmentId}: ${duplicate.id} (${duplicate.status})`);
    const id = `studio-job-${randomUUID()}`;
    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      id,
      kind: input.kind,
      status: 'QUEUED',
      principalId: input.principalId,
      originalSubmitterId: input.principalId,
      authorizedByPrincipalId: input.principalId,
      projectSlug: input.projectSlug,
      fingerprintSha256: input.fingerprintSha256,
      request: structuredClone(input.request),
      paidApprovalId: input.paidApprovalId ?? null,
      result: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };
    await mkdir(jobsRoot(root), { recursive: true });
    await writeJsonAtomic(jobPath(root, id), job);
    return job;
  });
}

export function findBlockingStudioGenerationJob(jobs, input) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  const segmentId = input?.request?.segmentId ?? input?.segmentId;
  if (typeof input?.projectSlug !== 'string' || typeof input?.kind !== 'string' || typeof segmentId !== 'string') {
    throw new TypeError('projectSlug, kind, and segmentId are required to inspect generation jobs');
  }
  return jobs.find(job => job.projectSlug === input.projectSlug
    && job.kind === input.kind
    && (typeof job.request?.segmentId !== 'string' || job.request.segmentId === segmentId)
    && BLOCKING_GENERATION_JOB_STATUSES.has(job.status)) ?? null;
}

export async function readBlockingStudioGenerationJob(root, input) {
  return findBlockingStudioGenerationJob(await listStudioGenerationJobs(root), input);
}

export async function listStudioGenerationJobs(root) {
  const entries = await readdir(jobsRoot(root), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const jobs = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => readJson(join(jobsRoot(root), entry.name))));
  return jobs.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

export async function readStudioGenerationJob(root, id) {
  return readJson(jobPath(root, id));
}

async function transition(root, id, allowed, status, patch = {}) {
  return serialize(async () => {
    const file = jobPath(root, id);
    const current = await readJson(file);
    if (!allowed.includes(current.status)) throw new Error(`generation job ${id} cannot move from ${current.status} to ${status}`);
    const updated = { ...current, ...structuredClone(patch), status, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(file, updated);
    return updated;
  });
}

export function claimStudioGenerationJob(root, id) {
  return transition(root, id, ['QUEUED'], 'RUNNING', { startedAt: new Date().toISOString() });
}

export function completeStudioGenerationJob(root, id, result) {
  return transition(root, id, ['RUNNING'], 'SUCCESS', { result, completedAt: new Date().toISOString() });
}

export function failStudioGenerationJob(root, id, errorMessage, { uncertain = true } = {}) {
  return transition(root, id, ['RUNNING'], uncertain ? 'NEEDS_RECONCILIATION' : 'FAILED', {
    errorCode: uncertain ? 'PROVIDER_STATE_UNCERTAIN' : 'PRE_SUBMISSION_VALIDATION_FAILED',
    errorMessage: String(errorMessage).slice(0, 500),
    failedAt: new Date().toISOString()
  });
}

export async function pauseQueuedStudioGenerationJobs(root) {
  const jobs = await listStudioGenerationJobs(root);
  const paused = [];
  for (const job of jobs.filter(item => item.status === 'QUEUED')) {
    paused.push(await transition(root, job.id, ['QUEUED'], 'PAUSED_REQUIRES_CONFIRMATION', {
      errorCode: 'SERVER_RESTART_RECONFIRM_REQUIRED',
      errorMessage: '主机服务已重启；为避免无人值守付费，本任务需要重新确认后才能继续。',
      pausedAt: new Date().toISOString()
    }));
  }
  return paused;
}

export function resumeStudioGenerationJob(root, id, input) {
  return serialize(async () => {
    const file = jobPath(root, id);
    const current = await readJson(file);
    if (current.status !== 'PAUSED_REQUIRES_CONFIRMATION') throw new Error('only a restart-paused job can be resumed');
    if (current.fingerprintSha256 !== input.fingerprintSha256) throw new Error('restart-paused job fingerprint changed');
    const updated = {
      ...current,
      status: 'QUEUED',
      originalSubmitterId: current.originalSubmitterId ?? current.principalId,
      authorizedByPrincipalId: input.authorizedByPrincipalId,
      resumeApprovalId: input.resumeApprovalId,
      resumedAt: new Date().toISOString(),
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(file, updated);
    return updated;
  });
}

export function cancelRestartPausedStudioGenerationJob(root, id, reason = 'operator canceled restart-paused job before provider submission') {
  return transition(root, id, ['PAUSED_REQUIRES_CONFIRMATION'], 'CANCELED', {
    errorCode: 'RESTART_PAUSED_JOB_CANCELED',
    errorMessage: String(reason).slice(0, 500),
    canceledAt: new Date().toISOString()
  });
}

export async function createStudioGenerationResumeApproval(projectRoot, input) {
  if (!/^generation-authorization-[a-f0-9-]+$/.test(input.authorizationId ?? '')) throw new TypeError('resume approval requires a valid authorization id');
  const id = `review-${input.authorizationId}`;
  const approval = {
    id,
    kind: 'paid_generation_resume_approval',
    actor: 'human',
    decision: 'approved',
    jobId: input.jobId,
    generationKind: input.kind,
    originalSubmitterId: input.originalSubmitterId,
    authorizedByPrincipalId: input.authorizedByPrincipalId,
    fingerprintSha256: input.fingerprintSha256,
    maxPaidAttempts: 1,
    automaticRetry: false,
    note: input.note,
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(join(resolve(projectRoot), 'reviews', `${encodeURIComponent(id)}.json`), approval);
  return approval;
}

export async function requireStudioGenerationResumeApproval(projectRoot, job) {
  if (!job.resumeApprovalId) return null;
  const approval = await readJson(join(resolve(projectRoot), 'reviews', `${encodeURIComponent(job.resumeApprovalId)}.json`));
  if (approval.kind !== 'paid_generation_resume_approval' || approval.actor !== 'human' || approval.decision !== 'approved'
    || approval.jobId !== job.id || approval.generationKind !== job.kind
    || approval.originalSubmitterId !== job.originalSubmitterId
    || approval.authorizedByPrincipalId !== job.authorizedByPrincipalId
    || approval.fingerprintSha256 !== job.fingerprintSha256
    || approval.maxPaidAttempts !== 1 || approval.automaticRetry !== false) {
    throw new Error('restart-paused paid job lost its fresh human resume approval');
  }
  return approval;
}

export async function recoverInterruptedStudioGenerationJobs(root) {
  const jobs = await listStudioGenerationJobs(root);
  const recovered = [];
  for (const job of jobs.filter(item => item.status === 'RUNNING')) {
    recovered.push(await failStudioGenerationJob(root, job.id, 'Studio stopped while this paid job was running; reconcile provider state before any retry', { uncertain: true }));
  }
  return recovered;
}

export async function cancelQueuedStudioGenerationJobs(root, principalId = null, reason = 'member access revoked') {
  const jobs = await listStudioGenerationJobs(root);
  const canceled = [];
  for (const job of jobs.filter(item => (principalId === null || item.principalId === principalId) && item.status === 'QUEUED')) {
    canceled.push(await transition(root, job.id, ['QUEUED'], 'CANCELED', {
      errorMessage: reason,
      canceledAt: new Date().toISOString()
    }));
  }
  return canceled;
}

export async function createStudioImageGenerationApproval(projectRoot, input) {
  if (!/^studio-job-[a-f0-9-]+$/.test(input.jobId ?? '')) throw new TypeError('image approval requires a valid Studio job id');
  if (!/^[a-f0-9]{64}$/.test(input.fingerprintSha256 ?? '')) throw new TypeError('image approval requires an exact fingerprint');
  const id = `review-${input.jobId}`;
  const approval = {
    id,
    kind: 'paid_image_generation_approval',
    actor: 'human',
    operatorId: input.principalId,
    decision: 'approved',
    jobId: input.jobId,
    segmentId: input.segmentId,
    fingerprintSha256: input.fingerprintSha256,
    maxPaidAttempts: 1,
    automaticRetry: false,
    note: input.note,
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(join(resolve(projectRoot), 'reviews', `${encodeURIComponent(id)}.json`), approval);
  return approval;
}

export async function requireStudioImageGenerationApproval(projectRoot, input) {
  const approval = await readJson(join(resolve(projectRoot), 'reviews', `${encodeURIComponent(input.approvalId)}.json`));
  if (approval.kind !== 'paid_image_generation_approval' || approval.actor !== 'human' || approval.decision !== 'approved'
    || approval.jobId !== input.jobId || approval.operatorId !== input.principalId
    || approval.segmentId !== input.segmentId || approval.fingerprintSha256 !== input.fingerprintSha256
    || approval.maxPaidAttempts !== 1 || approval.automaticRetry !== false) {
    throw new Error('paid image job lost its one-attempt human approval binding');
  }
  return approval;
}
