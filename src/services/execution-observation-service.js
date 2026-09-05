import { resolve } from 'node:path';
import { assertExecutionObservation } from '../domain/execution-ledger.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { appendExecutionEvent } from './execution-ledger-service.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function safeId(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object');
  if (input.schemaVersion !== 2 || input.kind !== 'execution_observation_evidence') {
    throw new TypeError('input must be an execution_observation_evidence v2 receipt');
  }
  safeId(input.id, 'id');
  if (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new TypeError('observedAt must be a date-time');
  }
  if (!input.actor || typeof input.actor !== 'object' || Array.isArray(input.actor)) throw new TypeError('actor must be an object');
  if (!['system', 'human', 'delegated_policy'].includes(input.actor.kind)) throw new TypeError('actor.kind is invalid');
  safeId(input.actor.id, 'actor.id', { nullable: true });
  safeId(input.segmentId, 'segmentId', { nullable: true });
  safeId(input.correlationId, 'correlationId', { nullable: true });
  safeId(input.causationId, 'causationId', { nullable: true });
  if (typeof input.evidencePath !== 'string' || input.evidencePath.trim() === '') {
    throw new TypeError('evidencePath must be a project-relative path');
  }
  if (!Array.isArray(input.sourceReferences) || input.sourceReferences.length === 0) {
    throw new TypeError('sourceReferences must contain at least one SHA-bound project evidence file');
  }
  for (const [index, reference] of input.sourceReferences.entries()) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new TypeError(`sourceReferences[${index}] must be an object`);
    }
    safeId(reference.kind, `sourceReferences[${index}].kind`);
    safeId(reference.id, `sourceReferences[${index}].id`);
    if (typeof reference.path !== 'string' || reference.path.trim() === '') {
      throw new TypeError(`sourceReferences[${index}].path is required`);
    }
    if (typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
      throw new TypeError(`sourceReferences[${index}].sha256 must be a lowercase SHA-256`);
    }
  }
  assertExecutionObservation(input.observation);
  if (!input.sourceReferences.some(reference => reference.id === input.observation.subjectId)) {
    throw new TypeError('observation.subjectId must identify one sourceReferences item');
  }
  return input;
}

export async function recordExecutionObservation(root, input, options = {}) {
  const projectRoot = resolve(root);
  validateInput(input);
  const evidence = await inspectArtifactFile(projectRoot, input.evidencePath);
  const storedInput = await readJson(evidence.path);
  if (JSON.stringify(storedInput) !== JSON.stringify(input)) {
    throw new Error('execution observation input must exactly match its persisted evidence receipt');
  }
  for (const reference of input.sourceReferences) {
    const inspected = await inspectArtifactFile(projectRoot, reference.path);
    if (inspected.sha256 !== reference.sha256) throw new Error(`observation evidence checksum changed for ${reference.id}`);
  }
  return appendExecutionEvent(projectRoot, {
    type: 'execution_observation.recorded',
    occurredAt: input.observedAt,
    actor: input.actor,
    segmentId: input.segmentId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: `execution_observation.recorded:${input.id}`,
    references: [{
      kind: 'execution_observation_evidence', id: input.id,
      path: input.evidencePath, sha256: evidence.sha256
    }, ...input.sourceReferences],
    facts: { observationId: input.id },
    observation: input.observation
  }, {
    transactionId: options.transactionId ?? `execution-observation-${input.id}`,
    transactionOptions: options.transactionOptions
  });
}
