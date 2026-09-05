import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { sha256File } from '../storage/checksum.js';
import { withProjectLock } from '../storage/project-lock.js';
import {
  assertTaskCheckpoint,
  blockTask,
  claimTask,
  createTaskCheckpoint,
  failTask,
  succeedTask,
  taskKeyFor
} from '../domain/task-checkpoint.js';

function safeKey(taskKey) {
  if (typeof taskKey !== 'string' || !/^[a-f0-9]{64}$/.test(taskKey)) throw new TypeError('taskKey must be a lowercase SHA-256');
  return taskKey;
}

function nowIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must produce a valid date');
  return date.toISOString();
}

function missing(error) { return error?.code === 'ENOENT'; }

export function taskCheckpointPath(root, taskKey) {
  return join(resolve(root), 'runs', 'checkpoints', `${safeKey(taskKey)}.json`);
}

async function readCheckpoint(root, taskKey, options = {}) {
  return assertTaskCheckpoint(await (options.read ?? readJson)(taskCheckpointPath(root, taskKey)));
}

export async function getTaskCheckpoint(root, taskKey, options = {}) {
  return readCheckpoint(root, taskKey, options);
}

export async function queueTaskCheckpoint(root, identity, options = {}) {
  root = resolve(root);
  const taskKey = taskKeyFor(identity);
  return withProjectLock(root, async () => {
    const existing = await readCheckpoint(root, taskKey, options).catch(error => missing(error) ? null : Promise.reject(error));
    if (existing) return { checkpoint: existing, taskKey, created: false };
    const checkpoint = createTaskCheckpoint(identity, {
      createdAt: nowIso(options.now ?? (() => new Date())),
      maxAttempts: options.maxAttempts
    });
    await (options.write ?? writeJsonAtomic)(taskCheckpointPath(root, taskKey), checkpoint);
    return { checkpoint, taskKey, created: true };
  }, options.lockOptions);
}

export async function claimTaskCheckpoint(root, identity, options = {}) {
  root = resolve(root);
  const taskKey = taskKeyFor(identity);
  return withProjectLock(root, async () => {
    let checkpoint = await readCheckpoint(root, taskKey, options).catch(error => missing(error) ? null : Promise.reject(error));
    let created = false;
    const claimedAt = nowIso(options.now ?? (() => new Date()));
    if (!checkpoint) {
      checkpoint = createTaskCheckpoint(identity, { createdAt: claimedAt, maxAttempts: options.maxAttempts });
      created = true;
    }
    const result = claimTask(checkpoint, {
      ownerId: options.ownerId ?? `process-${process.pid}`,
      claimedAt,
      ...(options.claimToken ? { claimToken: options.claimToken } : {})
    });
    if (result.disposition === 'reuse') {
      for (const output of result.checkpoint.outputs) await verifyOutput(root, output);
    }
    if (result.checkpoint !== checkpoint || created) {
      await (options.write ?? writeJsonAtomic)(taskCheckpointPath(root, taskKey), result.checkpoint);
    }
    return { ...result, taskKey, created };
  }, options.lockOptions);
}

function inside(root, candidate) {
  const value = relative(root, candidate);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function verifyOutput(root, output) {
  if (output.path === undefined) return;
  if (typeof output.path !== 'string' || output.path.trim() === '' || isAbsolute(output.path)) throw new Error('output.path must be project-relative');
  const path = resolve(root, output.path);
  if (!inside(root, path)) throw new Error('output.path must stay inside project root');
  await access(path, constants.R_OK);
  const [actualRoot, actual] = await Promise.all([realpath(root), realpath(path)]);
  if (!inside(actualRoot, actual)) throw new Error('output.path must not escape project root');
  if (await sha256File(actual) !== output.sha256) throw new Error(`output SHA changed: ${output.path}`);
}

async function transition(root, taskKey, claim, operation, options = {}) {
  root = resolve(root);
  safeKey(taskKey);
  return withProjectLock(root, async () => {
    const checkpoint = await readCheckpoint(root, taskKey, options);
    const updated = operation(checkpoint, {
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
      endedAt: nowIso(options.now ?? (() => new Date())),
      ...claim
    });
    await (options.write ?? writeJsonAtomic)(taskCheckpointPath(root, taskKey), updated);
    return updated;
  }, options.lockOptions);
}

export async function succeedTaskCheckpoint(root, taskKey, claim, options = {}) {
  for (const output of claim.outputs ?? []) await verifyOutput(resolve(root), output);
  return transition(root, taskKey, claim, succeedTask, options);
}

export async function failTaskCheckpoint(root, taskKey, claim, options = {}) {
  return transition(root, taskKey, claim, failTask, options);
}

export async function blockTaskCheckpoint(root, taskKey, claim, options = {}) {
  return transition(root, taskKey, claim, blockTask, options);
}

export const completeTaskCheckpoint = succeedTaskCheckpoint;
