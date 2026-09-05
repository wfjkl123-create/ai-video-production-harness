import { createHash, randomUUID } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export const TASK_CHECKPOINT_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'blocked']);
const STATUSES = new Set(TASK_CHECKPOINT_STATUSES);

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function id(value, field) {
  const result = text(value, field);
  if (!SAFE_ID.test(result)) throw new TypeError(`${field} must be a safe identifier`);
  return result;
}

function timestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${field} must be a date-time`);
  return result;
}

function jsonValue(value, field) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${field} must contain only finite JSON values`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${field}[${index}]`));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`${field}.${key} must not be undefined`);
      result[key] = jsonValue(value[key], `${field}.${key}`);
    }
    return result;
  }
  throw new TypeError(`${field} must contain only JSON values`);
}

function optionalIdentity(value, field) {
  if (value === undefined || value === null) return null;
  return jsonValue(value, field);
}

function dependencyKeys(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('dependencyKeys must be an array');
  const normalized = value.map((item, index) => text(item, `dependencyKeys[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError('dependencyKeys must be unique');
  return normalized.sort();
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeTaskIdentity(input) {
  object(input, 'task identity');
  const paid = input.policy?.paid ?? input.paid ?? false;
  const idempotent = input.policy?.idempotent ?? input.idempotent ?? (input.nonIdempotent === true ? false : true);
  if (typeof paid !== 'boolean') throw new TypeError('policy.paid must be a boolean');
  if (typeof idempotent !== 'boolean') throw new TypeError('policy.idempotent must be a boolean');
  return {
    taskType: id(input.taskType, 'taskType'),
    inputs: jsonValue(input.inputs ?? {}, 'inputs'),
    dependencyKeys: dependencyKeys(input.dependencyKeys ?? input.dependencies),
    sourceFact: optionalIdentity(input.sourceFact ?? input.sourceFactKey, 'sourceFact'),
    storyPlan: optionalIdentity(input.storyPlan ?? input.storyPlanKey, 'storyPlan'),
    template: optionalIdentity(input.template ?? input.templateKey, 'template'),
    skill: optionalIdentity(input.skill ?? input.skillKey, 'skill'),
    model: optionalIdentity(input.model, 'model'),
    params: jsonValue(input.params ?? {}, 'params'),
    codeVersion: text(input.codeVersion, 'codeVersion'),
    policy: { paid, idempotent }
  };
}

export function taskKeyFor(input) {
  return sha256(normalizeTaskIdentity(input));
}

function normalizeOutputs(outputs) {
  if (!Array.isArray(outputs)) throw new TypeError('outputs must be an array');
  return outputs.map((output, index) => {
    object(output, `outputs[${index}]`);
    if (!SHA256.test(output.sha256 ?? '')) throw new TypeError(`outputs[${index}].sha256 must be a lowercase SHA-256`);
    return jsonValue(output, `outputs[${index}]`);
  });
}

function attempt(checkpoint, attemptNumber) {
  const result = checkpoint.attempts.find(item => item.attempt === attemptNumber);
  if (!result) throw new Error(`attempt ${attemptNumber} does not exist`);
  return result;
}

function authorizeRunning(checkpoint, input) {
  if (checkpoint.status !== 'running') throw new Error('checkpoint is not running');
  const current = attempt(checkpoint, checkpoint.currentAttempt);
  if (current.status !== 'running') throw new Error('current attempt is not running');
  if (current.ownerId !== input.ownerId || current.claimToken !== input.claimToken) {
    throw new Error('checkpoint transition requires the current owner and claim token');
  }
  return current;
}

export function createTaskCheckpoint(input, options = {}) {
  const identity = normalizeTaskIdentity(input);
  const createdAt = timestamp(options.createdAt, 'createdAt');
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  const taskKey = sha256(identity);
  return {
    schemaVersion: 1,
    kind: 'task_checkpoint',
    taskKey,
    contentFingerprintSha256: taskKey,
    taskType: identity.taskType,
    identity,
    status: 'queued',
    maxAttempts,
    currentAttempt: null,
    attempts: [],
    outputs: [],
    createdAt,
    updatedAt: createdAt
  };
}

export function claimTask(checkpoint, input) {
  assertTaskCheckpoint(checkpoint);
  object(input, 'claim input');
  const ownerId = id(input.ownerId, 'ownerId');
  const claimedAt = timestamp(input.claimedAt, 'claimedAt');
  if (checkpoint.status === 'succeeded') return { checkpoint, disposition: 'reuse' };
  if (checkpoint.status === 'running') return { checkpoint, disposition: 'already_running' };
  const hasAttempt = checkpoint.attempts.length > 0;
  if (hasAttempt && (checkpoint.identity.policy.paid || !checkpoint.identity.policy.idempotent)) {
    return { checkpoint, disposition: 'blocked_non_repeatable' };
  }
  if (checkpoint.status === 'blocked') return { checkpoint, disposition: 'blocked' };
  if (hasAttempt && checkpoint.status !== 'failed') throw new Error('only a failed repeatable task may be reclaimed');
  if (checkpoint.attempts.length >= checkpoint.maxAttempts) return { checkpoint, disposition: 'attempt_limit' };
  const number = checkpoint.attempts.length + 1;
  const claimToken = input.claimToken ?? randomUUID();
  id(claimToken, 'claimToken');
  const nextAttempt = {
    attempt: number,
    ownerId,
    claimToken,
    status: 'running',
    startedAt: claimedAt,
    endedAt: null,
    outputs: [],
    error: null,
    blockReason: null
  };
  const updated = {
    ...checkpoint,
    status: 'running',
    currentAttempt: number,
    attempts: [...checkpoint.attempts, nextAttempt],
    updatedAt: claimedAt
  };
  assertTaskCheckpoint(updated);
  return { checkpoint: updated, disposition: 'claimed', attempt: number, claimToken };
}

function finish(checkpoint, input, status) {
  assertTaskCheckpoint(checkpoint);
  object(input, `${status} input`);
  authorizeRunning(checkpoint, input);
  const endedAt = timestamp(input.endedAt, 'endedAt');
  const index = checkpoint.currentAttempt - 1;
  const current = checkpoint.attempts[index];
  if (Date.parse(endedAt) < Date.parse(current.startedAt)) throw new Error('endedAt must not precede startedAt');
  const outputs = status === 'succeeded' ? normalizeOutputs(input.outputs ?? []) : [];
  const next = {
    ...current,
    status,
    endedAt,
    outputs,
    error: status === 'failed' ? text(input.error, 'error') : null,
    blockReason: status === 'blocked' ? text(input.reason, 'reason') : null
  };
  const updated = {
    ...checkpoint,
    status,
    attempts: checkpoint.attempts.map((item, attemptIndex) => attemptIndex === index ? next : item),
    outputs,
    updatedAt: endedAt
  };
  assertTaskCheckpoint(updated);
  return updated;
}

export function succeedTask(checkpoint, input) { return finish(checkpoint, input, 'succeeded'); }
export function failTask(checkpoint, input) { return finish(checkpoint, input, 'failed'); }
export function blockTask(checkpoint, input) { return finish(checkpoint, input, 'blocked'); }

export function assertTaskCheckpoint(value) {
  object(value, 'task checkpoint');
  if (value.schemaVersion !== 1 || value.kind !== 'task_checkpoint') throw new TypeError('invalid task checkpoint version or kind');
  if (!SHA256.test(value.taskKey ?? '') || value.contentFingerprintSha256 !== value.taskKey) throw new TypeError('taskKey must be the content SHA-256');
  const identity = normalizeTaskIdentity(value.identity);
  if (sha256(identity) !== value.taskKey || value.taskType !== identity.taskType) throw new TypeError('taskKey does not match normalized task identity');
  if (!STATUSES.has(value.status)) throw new TypeError('status is invalid');
  if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (!Array.isArray(value.attempts) || value.attempts.length > value.maxAttempts) throw new TypeError('attempts are invalid');
  if (value.currentAttempt !== null && (!Number.isInteger(value.currentAttempt) || value.currentAttempt < 1)) throw new TypeError('currentAttempt is invalid');
  timestamp(value.createdAt, 'createdAt');
  timestamp(value.updatedAt, 'updatedAt');
  normalizeOutputs(value.outputs);
  value.attempts.forEach((item, index) => {
    object(item, `attempts[${index}]`);
    if (item.attempt !== index + 1) throw new TypeError('attempt numbers must be contiguous');
    id(item.ownerId, `attempts[${index}].ownerId`);
    id(item.claimToken, `attempts[${index}].claimToken`);
    if (!STATUSES.has(item.status) || item.status === 'queued') throw new TypeError(`attempts[${index}].status is invalid`);
    timestamp(item.startedAt, `attempts[${index}].startedAt`);
    timestamp(item.endedAt, `attempts[${index}].endedAt`, { nullable: true });
    normalizeOutputs(item.outputs);
  });
  const running = value.attempts.filter(item => item.status === 'running');
  if (value.status === 'queued' && (value.attempts.length !== 0 || value.currentAttempt !== null)) throw new Error('queued checkpoint cannot have attempts');
  if (value.status === 'running' && (running.length !== 1 || running[0].attempt !== value.currentAttempt)) throw new Error('running checkpoint must have one current owner');
  if (value.status !== 'running' && running.length !== 0) throw new Error('finished checkpoint cannot contain a running attempt');
  if (value.status !== 'queued' && value.currentAttempt !== value.attempts.length) throw new Error('currentAttempt must identify the latest attempt');
  const latest = value.attempts.at(-1);
  if (latest && latest.status !== value.status) throw new Error('checkpoint status must match its latest attempt');
  if (value.status === 'succeeded' && JSON.stringify(value.outputs) !== JSON.stringify(latest.outputs)) throw new Error('checkpoint outputs must match the successful attempt');
  return value;
}

// Explicit aliases make the domain API readable to callers using checkpoint terminology.
export const buildTaskKey = taskKeyFor;
export const claimTaskCheckpoint = claimTask;
export const succeedTaskCheckpoint = succeedTask;
export const failTaskCheckpoint = failTask;
export const blockTaskCheckpoint = blockTask;
