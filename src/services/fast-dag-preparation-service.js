import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertBatchGenerationApproval } from '../domain/batch-generation.js';
import { appendExecutionSpan, completeExecutionTrace, createExecutionTrace } from '../domain/execution-trace.js';
import { readJson } from '../storage/json-store.js';
import { sha256File } from '../storage/checksum.js';
import { createVideoPreflight, inspectVideoPackage } from './video-generation-service.js';
import { preparePreGenerationAuditBrief } from './external-audit-brief-service.js';
import { planFastDagNext } from './fast-dag-planner-service.js';
import { recordAuthoritativeExecutionObservation } from './authoritative-trace-observation-service.js';
import {
  claimTaskCheckpoint,
  failTaskCheckpoint,
  succeedTaskCheckpoint
} from './task-checkpoint-service.js';

const DEFAULT_OPERATIONS = Object.freeze({
  createPreflight: (root, batch, action) => createVideoPreflight(root, action.segmentId, {
    executor: batch.executor,
    libtvProjectUuid: batch.libtvProjectUuid,
    nodeName: `${action.segmentId}-seedance-video`
  }),
  preparePreAuditBrief: (root, _batch, action) => preparePreGenerationAuditBrief(root, action.preflightId)
});

async function boundedMap(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  async function consume() {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) };
      } catch (error) {
        stopped = true;
        results[index] = { status: 'rejected', error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
  return results;
}

function freeOperation(operations, root, batch, action) {
  if (action.action === 'CREATE_VIDEO_PREFLIGHT') return operations.createPreflight(root, batch, action);
  if (action.action === 'PREPARE_PRE_GENERATION_AUDIT_BRIEF') return operations.preparePreAuditBrief(root, batch, action);
  throw new Error(`fast_dag_v1 free preparation does not implement ${action.action}`);
}

async function checkpointIdentityForAction(root, batch, action) {
  const base = {
    dependencyKeys: [], sourceFact: null, storyPlan: null, template: null, skill: null,
    model: null, params: {}, codeVersion: 'fast-dag-v1-free-prep-v1',
    policy: { paid: false, idempotent: true }
  };
  if (action.action === 'CREATE_VIDEO_PREFLIGHT') {
    const inspected = await inspectVideoPackage(root, action.segmentId, {
      executor: batch.executor,
      libtvProjectUuid: batch.libtvProjectUuid,
      nodeName: `${action.segmentId}-seedance-video`
    });
    return {
      ...base, taskType: 'create_video_preflight',
      inputs: { batchApprovalId: batch.id, segmentId: action.segmentId, packageFingerprintSha256: inspected.fingerprint.sha256 },
      model: inspected.fingerprint.generationContract
    };
  }
  if (action.action === 'PREPARE_PRE_GENERATION_AUDIT_BRIEF') {
    const preflight = await readJson(join(root, 'runs', `${encodeURIComponent(action.preflightId)}.json`));
    return {
      ...base, taskType: 'prepare_pre_generation_audit_brief',
      inputs: { batchApprovalId: batch.id, segmentId: action.segmentId, preflightId: action.preflightId,
        fingerprintSha256: preflight.fingerprint?.sha256 }
    };
  }
  throw new Error(`no checkpoint identity for ${action.action}`);
}

async function checkpointOutputs(root, action, result) {
  if (action.action === 'CREATE_VIDEO_PREFLIGHT') {
    const path = `runs/${encodeURIComponent(result.preflightId)}.json`;
    return [{ id: result.preflightId, path, sha256: await sha256File(join(root, path)) }];
  }
  if (action.action === 'PREPARE_PRE_GENERATION_AUDIT_BRIEF') {
    return [{ id: `${action.segmentId}-pre-generation-audit-brief`, path: result.briefPath, sha256: result.briefSha256 }];
  }
  return [];
}

async function checkpointedFreeOperation(operations, root, batch, action, options) {
  if (options.useCheckpoints === false) return freeOperation(operations, root, batch, action);
  const identity = await (options.checkpointIdentityForAction ?? checkpointIdentityForAction)(root, batch, action);
  const ownerId = `fast-dag-${process.pid}`;
  const claim = await (options.claimTaskCheckpoint ?? claimTaskCheckpoint)(root, identity, {
    ownerId, maxAttempts: 2
  });
  if (claim.disposition === 'reuse') return { reused: true, taskKey: claim.taskKey, outputs: claim.checkpoint.outputs };
  if (claim.disposition !== 'claimed') throw new Error(`checkpoint ${claim.taskKey} is not claimable: ${claim.disposition}`);
  try {
    const result = await freeOperation(operations, root, batch, action);
    const outputs = await (options.checkpointOutputs ?? checkpointOutputs)(root, action, result);
    await (options.succeedTaskCheckpoint ?? succeedTaskCheckpoint)(root, claim.taskKey, {
      ownerId, claimToken: claim.claimToken, outputs
    });
    return { ...result, reused: false, taskKey: claim.taskKey };
  } catch (error) {
    await (options.failTaskCheckpoint ?? failTaskCheckpoint)(root, claim.taskKey, {
      ownerId, claimToken: claim.claimToken, error: error.message
    }).catch(() => {});
    throw error;
  }
}

export async function runFastDagFreePreparation(root, batchApprovalId, options = {}) {
  const batch = assertBatchGenerationApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(batchApprovalId)}.json`)));
  const traceStartedAt = new Date().toISOString();
  const traceId = `fast-dag-free-${randomUUID()}`;
  const traceSpans = [];
  const planner = options.planner ?? planFastDagNext;
  const operations = { ...DEFAULT_OPERATIONS, ...(options.operations ?? {}) };
  const maxConcurrency = options.maxConcurrency ?? 4;
  const maxWaves = options.maxWaves ?? Math.max(8, batch.segments.length * 3);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
    throw new TypeError('free preparation maxConcurrency must be between 1 and 4');
  }
  if (!Number.isInteger(maxWaves) || maxWaves < 1) throw new TypeError('maxWaves must be a positive integer');

  const history = [];
  const completedActions = [];
  async function finish(result) {
    const endedAt = new Date().toISOString();
    try {
      const coverageSpanId = `${traceId}-machine-coverage`;
      let trace = createExecutionTrace({
        id: traceId,
        projectId: batch.projectId,
        startedAt: traceStartedAt,
        metadata: {
          operation: 'fast_dag_free_preparation',
          batchApprovalId: batch.id,
          authoritativeObservation: {
            schemaVersion: 1,
            basis: 'declared_spans',
            spanIds: [coverageSpanId],
            scope: 'project',
            stage: 'generation',
            segmentId: null,
            fields: ['machineExecutionMs']
          }
        }
      });
      const failed = result.status === 'FAILED';
      trace = appendExecutionSpan(trace, {
        id: `${traceId}-project`, kind: 'project', name: 'fast_dag_v1 free preparation',
        startedAt: traceStartedAt, endedAt, status: failed ? 'failed' : 'succeeded',
        activeComputeMs: 0, errorClass: failed ? 'FreePreparationFailed' : null
      });
      trace = appendExecutionSpan(trace, {
        id: coverageSpanId,
        kind: 'task',
        name: 'fast_dag_v1 complete local execution coverage',
        parentSpanId: `${traceId}-project`,
        startedAt: traceStartedAt,
        endedAt,
        status: failed ? 'failed' : 'succeeded',
        activeComputeMs: Date.parse(endedAt) - Date.parse(traceStartedAt),
        errorClass: failed ? 'FreePreparationFailed' : null,
        attributes: { coverage: 'complete_local_execution', paid: false, externalCalls: 0 }
      });
      for (const [index, span] of traceSpans.entries()) {
        trace = appendExecutionSpan(trace, {
          id: `${traceId}-task-${index + 1}`, kind: 'task', name: span.action.action,
          parentSpanId: coverageSpanId, startedAt: span.startedAt, endedAt: span.endedAt,
          status: span.status, activeComputeMs: Date.parse(span.endedAt) - Date.parse(span.startedAt),
          errorClass: span.errorClass, criticalPath: span.criticalPath,
          attributes: { segmentId: span.action.segmentId, lane: span.action.lane }
        });
      }
      trace = completeExecutionTrace(trace, { endedAt, status: failed ? 'failed' : 'succeeded' });
      await recordAuthoritativeExecutionObservation(root, trace, {
        recordExecutionTrace: options.recordExecutionTrace,
        deriveExecutionObservation: options.deriveExecutionObservation
      });
    } catch {
      // Observability is fail-open and cannot change the free preparation outcome.
    }
    return { ...result, traceId };
  }
  for (let wave = 0; wave < maxWaves; wave += 1) {
    const plan = await planner(root, batch.id);
    history.push(plan);
    if (['STOPPED', 'BLOCKED', 'COMPLETE'].includes(plan.status)) {
      return finish({ featureFlag: 'fast_dag_v1', mode: 'free_preparation', status: plan.status, next: plan, completedActions, history });
    }
    const free = (plan.readyActions ?? []).filter(action => action.lane === 'local_preparation');
    if (free.length === 0) return finish({
      featureFlag: 'fast_dag_v1', mode: 'free_preparation', status: 'WAITING_FREE_BOUNDARY',
      next: plan, completedActions, history,
      reason: 'remaining actions require external audit, user canvas review, video terminal state, or continuity evidence'
    });
    const outcomes = await boundedMap(free, maxConcurrency, async action => {
      const startedAt = new Date().toISOString();
      try {
        const value = await checkpointedFreeOperation(operations, root, batch, action, options);
        traceSpans.push({ action, startedAt, endedAt: new Date().toISOString(), status: 'succeeded', errorClass: null, criticalPath: false });
        return value;
      } catch (error) {
        traceSpans.push({ action, startedAt, endedAt: new Date().toISOString(), status: 'failed', errorClass: error.name || 'Error', criticalPath: true });
        throw error;
      }
    });
    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome) continue;
      const action = free[index];
      if (outcome.status === 'fulfilled') completedActions.push({ action, result: outcome.value });
    }
    const failedIndex = outcomes.findIndex(outcome => outcome?.status === 'rejected');
    if (failedIndex !== -1) return finish({
      featureFlag: 'fast_dag_v1', mode: 'free_preparation', status: 'FAILED',
      failedAction: free[failedIndex], error: outcomes[failedIndex].error.message,
      completedActions, history
    });
  }
  return finish({
    featureFlag: 'fast_dag_v1', mode: 'free_preparation', status: 'STOPPED',
    action: 'MAX_WAVES_REACHED', completedActions, history
  });
}
