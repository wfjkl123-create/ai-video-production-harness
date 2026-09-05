import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { assertBatchGenerationApproval, authorizeDerivedSegment } from '../domain/batch-generation.js';
import { assertExternalAuditAttestation } from '../domain/external-audit-attestation.js';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { assertGenerationFailureGate } from './generation-failure-service.js';
import { withProjectLock } from '../storage/project-lock.js';
import { inspectVideoPackage } from './video-generation-service.js';
import { auditProjectReadiness } from './project-readiness-audit-service.js';
import { requireExecutionControlEvidence } from './execution-control-evidence-service.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';

async function assertStrictReadiness(root) {
  const state = await readJson(join(root, 'project-state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (state?.videoGovernanceVersion !== 2) return;
  const audit = await auditProjectReadiness(root);
  const blockers = audit.findings.filter(item => item.severity === 'error');
  if (blockers.length) throw new Error(`strict video governance readiness BLOCKED: ${blockers.map(item => item.id).join(', ')}`);
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function listRunRecords(root) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(join(root, 'runs'), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
    records.push(await readJson(join(root, 'runs', entry.name)));
  }
  return records;
}

async function batchEvidence(root) {
  const records = await listRunRecords(root);
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(join(root, 'reviews'), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
    const review = await readJson(join(root, 'reviews', entry.name));
    if (review?.kind === 'external_audit_attestation' && review.auditStage === 'post_generation') {
      records.push({ segmentId: review.segmentId, qualityDecision: review.decision });
    }
  }
  return records;
}

export async function persistBatchGenerationApproval(root, approval) {
  assertBatchGenerationApproval(approval);
  const state = await readJson(join(root, 'project-state.json'));
  if (approval.projectId !== state.projectId) throw new Error('batch approval projectId does not match the project');
  if (approval.executor !== 'libtv') throw new Error('this harness defaults to LibTV; RunningHub requires a separate explicit generation selection');
  if (approval.budget.unit !== 'tasks') throw new Error('LibTV does not expose verifiable CNY or credit consumption; use a task-count budget');
  return withProjectLock(root, async () => {
    const path = join(root, 'reviews', `${encodeURIComponent(approval.id)}.json`);
    await readJson(path).then(() => { throw new Error(`batch approval already exists: ${approval.id}`); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await writeJsonAtomic(path, approval);
    return approval;
  });
}

export async function persistExternalAuditAttestation(root, { attestation, reportPath }) {
  assertExternalAuditAttestation(attestation);
  const auditRun = await readJson(join(root, 'runs', `${encodeURIComponent(attestation.auditRunId)}.json`));
  if (auditRun.kind !== 'external_model_audit' || auditRun.status !== 'SUCCESS' || auditRun.attestationId !== attestation.id
    || auditRun.sessionId !== attestation.providerTaskId || auditRun.model !== attestation.model
    || auditRun.segmentId !== attestation.segmentId || auditRun.auditStage !== attestation.auditStage
    || auditRun.fingerprintSha256 !== attestation.fingerprintSha256) {
    throw new Error('external audit attestation requires matching successful OpenCodex run evidence');
  }
  const absoluteReport = resolve(root, reportPath);
  if (isAbsolute(reportPath) || !inside(resolve(root), absoluteReport)) throw new Error('external audit report must stay inside the project');
  if (await sha256File(absoluteReport) !== attestation.reportSha256) throw new Error('external audit report checksum does not match the attestation');
  return withProjectLock(root, async () => {
    const path = join(root, 'reviews', `${encodeURIComponent(attestation.id)}.json`);
    await readJson(path).then(() => { throw new Error(`external audit attestation already exists: ${attestation.id}`); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    const record = { ...attestation, reportPath };
    await writeJsonAtomic(path, record);
    return record;
  });
}

export async function createDerivedPaidGenerationApproval(root, input, { id = `review-${randomUUID()}` } = {}) {
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    await assertStrictReadiness(root);
    const batch = assertBatchGenerationApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(input.batchApprovalId)}.json`)));
    const audit = await readJson(join(root, 'reviews', `${encodeURIComponent(input.externalAuditAttestationId)}.json`));
    const auditRun = await readJson(join(root, 'runs', `${encodeURIComponent(audit.auditRunId)}.json`));
    if (auditRun.kind !== 'external_model_audit' || auditRun.status !== 'SUCCESS' || auditRun.attestationId !== audit.id
      || auditRun.sessionId !== audit.providerTaskId || auditRun.model !== audit.model || auditRun.segmentId !== audit.segmentId
      || auditRun.auditStage !== audit.auditStage || auditRun.fingerprintSha256 !== audit.fingerprintSha256) {
      throw new Error('external audit attestation has no matching successful OpenCodex run evidence');
    }
    const preflight = await readJson(join(root, 'runs', `${encodeURIComponent(input.preflightId)}.json`));
    if (preflight.kind !== 'video_preflight' || preflight.status !== 'READY' || preflight.segmentId !== input.segmentId) {
      throw new Error('derived approval requires a matching ready video preflight');
    }
    const contract = preflight.fingerprint?.generationContract;
    if (contract?.provider !== batch.executor) throw new Error('video preflight executor does not match the approved batch executor');
    if (batch.executor === 'libtv' && (contract.projectUuid !== batch.libtvProjectUuid || typeof contract.nodeName !== 'string')) {
      throw new Error('LibTV preflight canvas or node name does not match the approved batch');
    }
    const current = await inspectVideoPackage(root, input.segmentId, batch.executor === 'libtv' ? {
      executor: 'libtv', libtvProjectUuid: batch.libtvProjectUuid, nodeName: contract.nodeName
    } : { executor: 'runninghub' });
    if (current.fingerprint.sha256 !== preflight.fingerprint.sha256) throw new Error('video preflight fingerprint changed');
    await assertGenerationFailureGate(root, current.fingerprint);
    const executionControlEvidence = await requireExecutionControlEvidence(root, current.fingerprint);
    const priorRuns = await batchEvidence(root);
    const derived = authorizeDerivedSegment({
      batch, segmentId: input.segmentId, fingerprintSha256: current.fingerprint.sha256, audit, priorRuns
    });
    const approval = {
      id, kind: 'paid_generation_approval', actor: 'delegated_batch_policy', decision: 'approved',
      segmentId: input.segmentId, preflightId: preflight.id, fingerprint: current.fingerprint,
      parentBatchApprovalId: batch.id, externalAuditAttestationId: audit.id,
      executor: derived.executor, libtvProjectUuid: batch.libtvProjectUuid, nodeName: contract.nodeName,
      executionControlEvidence,
      maxPaidAttempts: 1, consumedByRunId: null, consumedAt: null,
      createdAt: new Date().toISOString()
    };
    const path = join(root, 'reviews', `${encodeURIComponent(id)}.json`);
    await readJson(path).then(() => { throw new Error(`paid approval already exists: ${id}`); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'paid_approval.granted', occurredAt: approval.createdAt,
      actor: { kind: 'delegated_policy', id: null }, segmentId: input.segmentId,
      correlationId: approval.id, causationId: batch.id,
      idempotencyKey: `paid_approval.granted:${approval.id}`,
      references: [
        { kind: 'paid_generation_approval', id: approval.id, path: `reviews/${encodeURIComponent(approval.id)}.json` },
        { kind: 'batch_generation_approval', id: batch.id, path: `reviews/${encodeURIComponent(batch.id)}.json` },
        { kind: 'external_audit_attestation', id: audit.id, path: `reviews/${encodeURIComponent(audit.id)}.json` },
        { kind: 'video_preflight', id: preflight.id, path: `runs/${encodeURIComponent(preflight.id)}.json` }
      ],
      facts: {
        approvalId: approval.id, preflightId: preflight.id,
        fingerprintSha256: approval.fingerprint.sha256, executor: approval.executor,
        maxPaidAttempts: approval.maxPaidAttempts, delegatedByBatchId: batch.id
      }
    });
    await commitJsonTransaction(root, `paid-approval-derived-${approval.id}`, [
      { path, value: approval },
      ...ledger.writes
    ]);
    return approval;
  });
}
