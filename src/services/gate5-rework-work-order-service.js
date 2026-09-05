import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { assertProjectState } from '../domain/project-state.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { EXECUTION_OBSERVATION_STAGES } from '../domain/execution-ledger.js';
import {
  artifactResponsibilityStage,
  assertGate5ReworkWorkOrder,
  upgradeGate5ReworkWorkOrder
} from '../domain/gate5-rework-work-order.js';
import { readJson } from '../storage/json-store.js';
import { sha256Text } from '../storage/checksum.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { verifyLockedArtifact } from './artifact-file-service.js';
import { inspectOpenGate5FailureReturns, reworkActionForReturnStage } from './gate5-failure-return-service.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return sha256Text(`${JSON.stringify(canonicalize(value))}\n`);
}

function workOrderDirectory(root) {
  return join(root, 'reviews', 'gate5-rework');
}

function workOrderPath(root, id) {
  return join(workOrderDirectory(root), `${encodeURIComponent(id)}.json`);
}

async function frozenEvidence(root, currentArtifacts, failureReturn) {
  const returnIndex = EXECUTION_OBSERVATION_STAGES.indexOf(failureReturn.routing.returnStage);
  const candidates = currentArtifacts
    .filter(artifact => artifact.status === 'locked')
    .map(artifact => ({ artifact, stage: artifactResponsibilityStage(artifact) }))
    .filter(item => item.stage && EXECUTION_OBSERVATION_STAGES.indexOf(item.stage) < returnIndex)
    .sort((left, right) => left.artifact.id.localeCompare(right.artifact.id));
  const artifacts = [];
  for (const { artifact, stage } of candidates) {
    const inspected = await verifyLockedArtifact(root, artifact);
    artifacts.push({
      id: artifact.id,
      type: artifact.type,
      stage,
      revision: artifact.revision,
      status: 'locked',
      path: artifact.path,
      sha256: inspected.sha256,
      lockedByReviewId: artifact.lockedByReviewId
    });
  }
  return { artifacts, fingerprintSha256: canonicalSha256(artifacts) };
}

async function matchingWorkOrders(root, failureReturnId) {
  const names = await readdir(workOrderDirectory(root)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const matches = [];
  for (const name of names.filter(value => value.endsWith('.json') && !value.startsWith('._')).sort()) {
    const value = assertGate5ReworkWorkOrder(await readJson(join(workOrderDirectory(root), name)));
    if (value.failureReturnId === failureReturnId) matches.push(value);
  }
  if (matches.length > 1) throw new Error(`multiple Gate 5 rework work orders bind ${failureReturnId}`);
  return matches;
}

export async function inspectGate5ReworkWorkOrder(root, stateInput, currentArtifacts, failureReturn) {
  const projectRoot = resolve(root);
  const state = assertProjectState(stateInput);
  const matches = await matchingWorkOrders(projectRoot, failureReturn.id);
  if (matches.length === 0) return null;
  const workOrder = matches[0];
  if (workOrder.projectId !== state.projectId) throw new Error('Gate 5 rework work order project binding changed');
  if (workOrder.failureReturnSha256 !== canonicalSha256(failureReturn)) {
    throw new Error('Gate 5 failure return changed after its work order was prepared');
  }
  await validateFrozenWorkOrderEvidence(projectRoot, state, currentArtifacts, workOrder);
  return workOrder;
}

async function validateFrozenWorkOrderEvidence(projectRoot, state, currentArtifacts, workOrder) {
  if (workOrder.projectId !== state.projectId) throw new Error('Gate 5 rework work order project binding changed');
  const currentById = new Map(currentArtifacts.map(artifact => [artifact.id, artifact]));
  for (const frozen of workOrder.frozenEvidence.artifacts) {
    const artifact = currentById.get(frozen.id);
    if (!artifact || artifact.status !== 'locked' || artifact.type !== frozen.type
      || artifact.revision !== frozen.revision || artifact.path !== frozen.path
      || artifact.sha256 !== frozen.sha256 || artifact.lockedByReviewId !== frozen.lockedByReviewId) {
      throw new Error(`frozen upstream evidence drifted during Gate 5 rework: ${frozen.id}`);
    }
    await verifyLockedArtifact(projectRoot, artifact);
  }
  if (canonicalSha256(workOrder.frozenEvidence.artifacts) !== workOrder.frozenEvidence.fingerprintSha256) {
    throw new Error('Gate 5 rework frozen-evidence fingerprint is invalid');
  }
}

const REQUIRED_COMPLETION_EVIDENCE = Object.freeze({
  generation: 'generation_output',
  editing: 'final_edit',
  technical_review: 'machine_video_audit',
  gate5: 'gate5_review'
});

function progressRequestSha256(input) {
  return canonicalSha256({
    action: input.action ?? null,
    stage: input.stage ?? null,
    reason: input.reason ?? null,
    note: input.note ?? null,
    evidence: input.evidence ?? []
  });
}

function validateCheckpointEvidence(workOrder, stage, input) {
  if (typeof input.note !== 'string' || input.note.trim() === '') throw new TypeError('completion note must be non-empty');
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw new TypeError('completion evidence must be non-empty');
  for (const evidence of input.evidence) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('completion evidence must be objects');
    if (typeof evidence.kind !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(evidence.kind)) throw new TypeError('completion evidence kind is invalid');
    if (typeof evidence.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(evidence.id)) throw new TypeError('completion evidence id is invalid');
    if (typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new TypeError('completion evidence sha256 is invalid');
    if (evidence.path != null && (typeof evidence.path !== 'string' || evidence.path.trim() === '')) throw new TypeError('completion evidence path is invalid');
  }
  const kinds = new Set(input.evidence.map(item => item.kind));
  const required = stage === 'paid_approval' && workOrder.paidBoundary.newAuthorizationRequired
    ? 'new_paid_authorization' : REQUIRED_COMPLETION_EVIDENCE[stage];
  if (required && !kinds.has(required)) throw new Error(`${stage} completion requires ${required} evidence`);
}

function transitionWorkOrder(workOrderInput, input, now) {
  const workOrder = upgradeGate5ReworkWorkOrder(workOrderInput, now);
  if (!['start', 'complete', 'pause', 'resume'].includes(input.action)) throw new TypeError('action must be start, complete, pause or resume');
  const requestSha256 = progressRequestSha256(input);
  if (workOrder.lastTransition?.requestSha256 === requestSha256) return { workOrder, reused: true };
  if (workOrder.status === 'COMPLETED') throw new Error('completed Gate 5 rework work order cannot transition again');
  const next = structuredClone(workOrder);
  if (input.action === 'pause') {
    if (!['READY', 'IN_PROGRESS'].includes(next.status)) throw new Error('only an active Gate 5 rework work order can pause');
    if (typeof input.reason !== 'string' || input.reason.trim() === '') throw new TypeError('pause reason must be non-empty');
    next.status = 'PAUSED';
    next.pause = { reason: input.reason.trim(), pausedAt: now };
  } else if (input.action === 'resume') {
    if (next.status !== 'PAUSED') throw new Error('only a paused Gate 5 rework work order can resume');
    next.pause = null;
    next.status = next.steps.some(step => step.status !== 'pending') ? 'IN_PROGRESS' : 'READY';
  } else {
    if (next.status === 'PAUSED') throw new Error('resume the Gate 5 rework work order before changing a stage');
    if (typeof input.stage !== 'string' || !next.allowedMutationStages.includes(input.stage)) throw new TypeError('stage must belong to the work order');
    const firstIncomplete = next.steps.find(step => step.status !== 'completed');
    if (!firstIncomplete || firstIncomplete.stage !== input.stage) throw new Error('Gate 5 rework stages cannot be skipped or completed out of order');
    if (input.action === 'start') {
      if (firstIncomplete.status === 'in_progress') return { workOrder, reused: true };
      if (firstIncomplete.status !== 'pending') throw new Error('only a pending stage can start');
      firstIncomplete.status = 'in_progress';
      firstIncomplete.startedAt = now;
      next.status = 'IN_PROGRESS';
    } else {
      if (firstIncomplete.status !== 'in_progress') throw new Error('start the stage before completing it');
      validateCheckpointEvidence(next, input.stage, input);
      firstIncomplete.status = 'completed';
      firstIncomplete.completedAt = now;
      firstIncomplete.checkpoint = {
        note: input.note.trim(),
        evidence: input.evidence.map(item => ({
          kind: item.kind, id: item.id, sha256: item.sha256, path: item.path ?? null
        }))
      };
      next.status = next.steps.every(step => step.status === 'completed') ? 'COMPLETED' : 'IN_PROGRESS';
    }
  }
  next.progressRevision += 1;
  next.updatedAt = now;
  next.lastTransition = {
    action: input.action,
    stage: ['start', 'complete'].includes(input.action) ? input.stage : null,
    requestSha256,
    occurredAt: now
  };
  return { workOrder: assertGate5ReworkWorkOrder(next), reused: false };
}

export async function updateGate5ReworkWorkOrderProgress(root, input = {}, options = {}) {
  if (input.confirm !== true) throw new Error('explicit local rework progress confirmation is required');
  if (typeof input.workOrderId !== 'string' || input.workOrderId.trim() === '') throw new TypeError('workOrderId must be non-empty');
  const projectRoot = resolve(root);
  return withProjectLock(projectRoot, async () => {
    await recoverJsonTransactions(projectRoot);
    const state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
    const currentArtifacts = resolveCurrentArtifacts(state.artifacts).current;
    const path = workOrderPath(projectRoot, input.workOrderId);
    const existing = assertGate5ReworkWorkOrder(await readJson(path));
    await validateFrozenWorkOrderEvidence(projectRoot, state, currentArtifacts, existing);
    const now = options.now ?? new Date().toISOString();
    const transitioned = transitionWorkOrder(existing, input, now);
    if (transitioned.reused && existing.schemaVersion === 2) {
      return { ...transitioned, path: `reviews/gate5-rework/${encodeURIComponent(input.workOrderId)}.json` };
    }
    const upgradedChanged = existing.schemaVersion !== 2;
    if (!transitioned.reused || upgradedChanged) {
      await commitJsonTransaction(projectRoot,
        `progress-${input.workOrderId}-${transitioned.workOrder.progressRevision}`,
        [{ path, value: transitioned.workOrder }], options.transactionOptions);
    }
    return { ...transitioned, path: `reviews/gate5-rework/${encodeURIComponent(input.workOrderId)}.json` };
  }, options.lockOptions);
}

export async function prepareGate5ReworkWorkOrder(root, input = {}, options = {}) {
  if (input.confirm !== true) throw new Error('explicit local rework preparation confirmation is required');
  if (typeof input.failureReturnId !== 'string' || input.failureReturnId.trim() === '') {
    throw new TypeError('failureReturnId must be a non-empty string');
  }
  const projectRoot = resolve(root);
  return withProjectLock(projectRoot, async () => {
    await recoverJsonTransactions(projectRoot);
    const state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
    const currentArtifacts = resolveCurrentArtifacts(state.artifacts).current;
    const returns = await inspectOpenGate5FailureReturns(projectRoot, state, currentArtifacts);
    const failureReturn = returns.open.find(item => item.id === input.failureReturnId);
    if (!failureReturn) throw new Error('the requested Gate 5 failure return is not current and open');
    const failureReturnSha256 = canonicalSha256(failureReturn);
    const frozen = await frozenEvidence(projectRoot, currentArtifacts, failureReturn);
    const id = `gate5-rework-${sha256Text(`${state.projectId}\0${failureReturn.id}\0${failureReturnSha256}\0${frozen.fingerprintSha256}`).slice(0, 32)}`;
    const path = workOrderPath(projectRoot, id);
    const existing = await readJson(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      const workOrder = assertGate5ReworkWorkOrder(existing);
      if (workOrder.failureReturnSha256 !== failureReturnSha256
        || workOrder.frozenEvidence.fingerprintSha256 !== frozen.fingerprintSha256) {
        throw new Error('existing Gate 5 rework work order does not match current evidence');
      }
      return { workOrder, reused: true, path: `reviews/gate5-rework/${encodeURIComponent(id)}.json` };
    }
    const createdAt = options.now ?? new Date().toISOString();
    const workOrder = assertGate5ReworkWorkOrder({
      schemaVersion: 2,
      kind: 'gate5_rework_work_order',
      id,
      status: 'READY',
      projectId: state.projectId,
      failureReturnId: failureReturn.id,
      failureReturnSha256,
      scope: failureReturn.scope,
      segmentId: failureReturn.segmentId,
      rejection: {
        reviewId: failureReturn.rejection.reviewId,
        artifactId: failureReturn.rejection.artifactId,
        artifactSha256: failureReturn.rejection.artifactSha256
      },
      returnStage: failureReturn.routing.returnStage,
      responsibilityStage: failureReturn.routing.responsibilityStage,
      reworkAction: reworkActionForReturnStage(failureReturn.routing.returnStage),
      frozenEvidence: frozen,
      allowedMutationStages: [...failureReturn.routing.reworkStages],
      replacementContract: {
        mustSupersedeArtifactId: failureReturn.routing.replacementMustSupersedeArtifactId,
        minimumRevision: failureReturn.routing.minimumReplacementRevision,
        mustReturnToGate5: true
      },
      paidBoundary: {
        newAuthorizationRequired: failureReturn.routing.newPaidAuthorizationRequired,
        automaticRetryAllowed: false,
        existingApprovalReusable: false
      },
      steps: failureReturn.routing.reworkStages.map(stage => ({
        stage, status: 'pending', startedAt: null, completedAt: null, checkpoint: null
      })),
      progressRevision: 0,
      pause: null,
      lastTransition: null,
      createdAt,
      updatedAt: createdAt
    });
    await commitJsonTransaction(projectRoot, `prepare-${id}`, [{ path, value: workOrder }], options.transactionOptions);
    return { workOrder, reused: false, path: `reviews/gate5-rework/${encodeURIComponent(id)}.json` };
  }, options.lockOptions);
}

export { canonicalSha256 as gate5ReworkEvidenceSha256 };
