import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { executionControlFingerprint } from '../domain/execution-control-contract.js';
import { assertExecutionObservation } from '../domain/execution-ledger.js';
import { sha256Text } from '../storage/checksum.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';
import { deriveExecutionObservationBestEffort } from './authoritative-trace-observation-service.js';
import { assertGenerationFailureCausalAttribution } from '../domain/generation-failure-causal-attribution.js';

const ALLOWED_TYPES = new Set(['third_party_asset_audit_fail', 'third_party_video_audit_fail', 'machine_video_veto']);
const REQUIRED = ['outputId', 'outputSha256', 'failureType', 'observableProblem', 'expectedLockedRequirement', 'mostLikelyCause', 'freeRevisionCompleted'];

function validate(input) {
  for (const field of REQUIRED) if (typeof input?.[field] !== 'string' || input[field].trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  if (!/^[a-f0-9]{64}$/.test(input.outputSha256)) throw new TypeError('outputSha256 must be a lowercase SHA-256');
  if (!ALLOWED_TYPES.has(input.failureType)) throw new TypeError('failureType is not counted by the project policy');
  if (!Array.isArray(input.exactTimestampsOrRegions) || input.exactTimestampsOrRegions.length === 0) throw new TypeError('exactTimestampsOrRegions must be non-empty');
}

function safeKey(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) {
    throw new TypeError(`${field} must be a safe non-empty key`);
  }
  return value;
}

async function strictGovernance(root) {
  const state = await readJson(join(root, 'project-state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  return state?.videoGovernanceVersion === 2;
}

function normalizedFailureObservation(input, eventId, required) {
  if (input.failureObservation === undefined) {
    if (required) throw new TypeError('failureObservation is required by strict video governance');
    return null;
  }
  if (!input.failureObservation || typeof input.failureObservation !== 'object' || Array.isArray(input.failureObservation)) {
    throw new TypeError('failureObservation must be an object');
  }
  const allowed = new Set(['category', 'responsibilityStage', 'returnStage', 'retryKind']);
  for (const key of Object.keys(input.failureObservation)) {
    if (!allowed.has(key)) throw new TypeError(`failureObservation.${key} is not supported`);
  }
  if (required && input.failureObservation.retryKind !== 'none') {
    throw new TypeError('new generation failures must use retryKind none until a later retry has actually occurred');
  }
  return assertExecutionObservation({
    subjectId: eventId,
    scope: 'generation_attempt',
    stage: 'technical_review',
    failure: { ...input.failureObservation, rootCauseKey: input.rootCauseKey }
  });
}

function failureRecordPath(eventId) {
  return `runs/generation-failures/${encodeURIComponent(eventId)}.json`;
}

function canonicalJsonSha(value) {
  return sha256Text(`${JSON.stringify(value, null, 2)}\n`);
}

async function deriveFailureBestEffort(root, event, options) {
  if (!event?.observation?.failure) return;
  await deriveExecutionObservationBestEffort(root, {
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'generation_failure',
    failureEventId: event.id
  }, {
    deriveExecutionObservation: options.deriveExecutionObservation,
    derivationOptions: options.observationDerivationOptions,
    onError: options.onObservationError
  });
}

export async function recordGeneratedOutputFailure(root, input, options = {}) {
  validate(input);
  const strict = await strictGovernance(root);
  const eventId = options.id ?? `generation-failure-${randomUUID()}`;
  if (strict) {
    const allowed = new Set([
      ...REQUIRED, 'rootCauseKey', 'segmentId', 'failureObservation', 'causalAttribution',
      'controlRouteFingerprint', 'observedEvidence', 'exactTimestampsOrRegions'
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) throw new TypeError(`failure input.${key} is not supported by strict video governance`);
    }
    safeKey(input.rootCauseKey, 'rootCauseKey');
    safeKey(input.segmentId, 'segmentId');
    safeKey(input.outputId, 'outputId');
    if (!/^[a-f0-9]{64}$/.test(input.controlRouteFingerprint ?? '')) throw new TypeError('controlRouteFingerprint must be a lowercase SHA-256');
    if (!Array.isArray(input.observedEvidence) || input.observedEvidence.length === 0) throw new TypeError('observedEvidence must be non-empty');
    input.observedEvidence.forEach((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') throw new TypeError(`observedEvidence[${index}] must be non-empty`);
    });
    input.exactTimestampsOrRegions.forEach((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') throw new TypeError(`exactTimestampsOrRegions[${index}] must be non-empty`);
    });
    if (input.causalAttribution === undefined) throw new TypeError('causalAttribution is required by strict video governance');
  }
  const causalAttribution = input.causalAttribution === undefined
    ? null
    : structuredClone(assertGenerationFailureCausalAttribution(input.causalAttribution, {
      rootCauseKey: input.rootCauseKey,
      requireRegisteredRootCause: strict
    }));
  const observation = normalizedFailureObservation(input, eventId, strict);
  const policy = await readJson(join(root, 'reviews', 'remake-v2-generation-policy.json'));
  if (policy.kind !== 'project_generation_policy' || policy.decision !== 'approved') throw new Error('approved project generation policy is required');
  const limit = policy.qualityFailurePolicy.maxFailedGeneratedOutputs;
  const path = join(root, 'runs', 'generation-failure-ledger.json');
  let event;
  try {
    event = await withProjectLock(root, async () => {
      await recoverJsonTransactions(root);
      const current = await readJson(path).catch(error => error.code === 'ENOENT'
        ? { id: 'generation-failure-ledger', kind: 'generation_failure_ledger', projectId: policy.projectId, events: [] }
        : Promise.reject(error));
      const duplicate = current.events.find(item => item.outputId === input.outputId || item.outputSha256 === input.outputSha256);
      if (duplicate) {
        const error = new Error('generated output failure is already counted');
        error.duplicateEvent = duplicate;
        throw error;
      }
      const failedOutputCount = current.events.length + 1;
      const remainingFailureTolerance = Math.max(0, limit - failedOutputCount);
      const terminal = failedOutputCount >= limit;
      const { failureObservation: _failureObservation, causalAttribution: _causalAttribution, ...recordedInput } = input;
      const next = {
        id: eventId,
        ...recordedInput,
        ...(causalAttribution ? { causalAttribution } : {}),
        ...(observation ? { observation } : {}),
        failedOutputCount,
        remainingFailureTolerance,
        workflowStatus: terminal ? 'TERMINATED_FAILURE_LIMIT_EXCEEDED' : 'AWAITING_HUMAN_REVIEW_AFTER_REWORK',
        humanReviewed: false,
        recordedAt: new Date().toISOString()
      };
      const immutableRecord = observation ? {
        schemaVersion: 1,
        kind: 'generation_failure_record',
        projectId: policy.projectId,
        ...next
      } : null;
      const immutablePath = observation ? failureRecordPath(next.id) : null;
      const updated = { ...current, status: next.workflowStatus, maxFailedGeneratedOutputs: limit, events: [...current.events, next], updatedAt: next.recordedAt };
      const executionLedger = await prepareExecutionLedgerAppend(root, {
        type: 'generation_output_failure.recorded', occurredAt: next.recordedAt,
        actor: { kind: 'system', id: null }, segmentId: next.segmentId ?? null,
        correlationId: next.id, causationId: null,
        idempotencyKey: `generation_output_failure.recorded:${next.id}`,
        references: [
          { kind: 'generation_failure_ledger', id: 'generation-failure-ledger', path: 'runs/generation-failure-ledger.json' },
          ...(immutableRecord ? [{
            kind: 'generation_failure_record', id: next.id,
            path: immutablePath, sha256: canonicalJsonSha(immutableRecord)
          }] : []),
          { kind: 'failed_generated_output', id: next.id, sha256: next.outputSha256 }
        ],
        facts: {
          failureEventId: next.id, outputId: next.outputId, failureType: next.failureType,
          workflowStatus: next.workflowStatus, failedOutputCount: next.failedOutputCount,
          remainingFailureTolerance: next.remainingFailureTolerance,
          ...(next.rootCauseKey ? { rootCauseKey: next.rootCauseKey } : {}),
          ...(next.controlRouteFingerprint ? { controlRouteFingerprint: next.controlRouteFingerprint } : {}),
          ...(observation ? { failureCategory: observation.failure.category } : {})
        }
      });
      await commitJsonTransaction(root, `generation-output-failure-${next.id}`, [
        ...(immutableRecord ? [{ path: join(root, immutablePath), value: immutableRecord }] : []),
        { path, value: updated },
        ...executionLedger.writes
      ], options.transactionOptions);
      return next;
    });
  } catch (error) {
    await deriveFailureBestEffort(root, error.duplicateEvent, options);
    throw error;
  }
  await deriveFailureBestEffort(root, event, options);
  return event;
}

export async function recordGenerationRemediation(root, input, options = {}) {
  safeKey(input.rootCauseKey, 'rootCauseKey');
  for (const field of ['failedControlRouteFingerprint', 'replacementControlRouteFingerprint']) {
    if (!/^[a-f0-9]{64}$/.test(input[field] ?? '')) throw new TypeError(`${field} must be a lowercase SHA-256`);
  }
  if (input.failedControlRouteFingerprint === input.replacementControlRouteFingerprint) {
    throw new Error('generation remediation must change the control route, not only the prompt');
  }
  if (typeof input.note !== 'string' || input.note.trim() === '') throw new TypeError('note must be a non-empty string');
  const id = options.id ?? `generation-remediation-${randomUUID()}`;
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const ledger = await readJson(join(root, 'runs', 'generation-failure-ledger.json'))
      .catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const latest = ledger?.events?.at(-1);
    if (!ledger || ledger.status !== 'AWAITING_HUMAN_REVIEW_AFTER_REWORK'
      || latest?.rootCauseKey !== input.rootCauseKey
      || latest?.controlRouteFingerprint !== input.failedControlRouteFingerprint) {
      throw new Error('generation remediation must bind the latest unresolved generation failure');
    }
    const record = {
      id, kind: 'generation_control_remediation', actor: 'human', decision: 'approved',
      failureEventId: latest.id,
      rootCauseKey: input.rootCauseKey,
      failedControlRouteFingerprint: input.failedControlRouteFingerprint,
      replacementControlRouteFingerprint: input.replacementControlRouteFingerprint,
      note: input.note.trim(), createdAt: new Date().toISOString()
    };
    const path = join(root, 'reviews', `${encodeURIComponent(id)}.json`);
    await readJson(path).then(() => { throw new Error(`generation remediation already exists: ${id}`); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    const executionLedger = await prepareExecutionLedgerAppend(root, {
      type: 'generation_remediation.approved', occurredAt: record.createdAt,
      actor: { kind: 'human', id: null }, segmentId: null,
      correlationId: record.id, causationId: latest.id,
      idempotencyKey: `generation_remediation.approved:${record.id}`,
      references: [
        { kind: 'generation_control_remediation', id: record.id, path: `reviews/${encodeURIComponent(record.id)}.json` },
        { kind: 'generation_failure_event', id: latest.id, path: 'runs/generation-failure-ledger.json' },
        { kind: 'failed_generated_output', id: latest.id, sha256: latest.outputSha256 }
      ],
      facts: {
        remediationId: record.id, failureEventId: latest.id, rootCauseKey: record.rootCauseKey,
        failedControlRouteFingerprint: record.failedControlRouteFingerprint,
        replacementControlRouteFingerprint: record.replacementControlRouteFingerprint
      }
    });
    await commitJsonTransaction(root, `generation-remediation-${record.id}`, [
      { path, value: record },
      ...executionLedger.writes
    ], options.transactionOptions);
    return record;
  });
}

export async function assertGenerationFailureGate(root, fingerprint) {
  const ledger = await readJson(join(root, 'runs', 'generation-failure-ledger.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!ledger) return true;
  if (ledger.status === 'TERMINATED_FAILURE_LIMIT_EXCEEDED') {
    throw new Error('generation failure limit reached; no further paid generation is allowed');
  }
  if (ledger.status !== 'AWAITING_HUMAN_REVIEW_AFTER_REWORK') return true;
  const latest = ledger.events?.at(-1);
  if (!latest?.rootCauseKey || !latest?.controlRouteFingerprint) {
    throw new Error('generation is stopped for human review after failure; legacy failure evidence must be resolved before another paid attempt');
  }
  const currentControlFingerprint = executionControlFingerprint(fingerprint.executionControlContract);
  const reviews = await readdir(join(root, 'reviews'), { withFileTypes: true })
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  let remediation = null;
  for (const entry of reviews) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('._')) continue;
    const candidate = await readJson(join(root, 'reviews', entry.name)).catch(() => null);
    if (candidate?.kind === 'generation_control_remediation'
      && candidate.rootCauseKey === latest.rootCauseKey
      && candidate.failureEventId === latest.id
      && candidate.failedControlRouteFingerprint === latest.controlRouteFingerprint
      && candidate.replacementControlRouteFingerprint === currentControlFingerprint) remediation = candidate;
  }
  if (!remediation) {
    throw new Error(`generation is stopped after root cause ${latest.rootCauseKey}; a human-approved control-route change is required before another paid attempt`);
  }
  return true;
}
