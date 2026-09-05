import { randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_NAME = '.review-mutation.lock';
const RETRY_INTERVAL_MS = 10;
const ACQUIRE_TIMEOUT_MS = 10_000;

function defaultSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function describeOwner(contents) {
  try {
    const owner = JSON.parse(contents);
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return 'malformed';
    const fields = [];
    if (Number.isInteger(owner.pid)) fields.push(`pid=${owner.pid}`);
    if (typeof owner.token === 'string') fields.push(`token=${owner.token}`);
    if (typeof owner.createdAt === 'string') fields.push(`createdAt=${owner.createdAt}`);
    return fields.length > 0 ? fields.join(', ') : 'parseable but empty';
  } catch {
    return 'malformed';
  }
}

async function blockedError(path, fs) {
  let owner = 'unavailable';
  try {
    owner = describeOwner(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return new Error(
    `blocked waiting for project mutation lock: ${path}; owner metadata: ${owner}; ` +
    'manually verify no process is using the project, then remove the lock file'
  );
}

async function release(path, token, fs) {
  try {
    const owner = JSON.parse(await fs.readFile(path, 'utf8'));
    if (owner.token === token) await fs.unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function cleanFailedAcquisition(path, handle, fs, originalError) {
  try {
    await handle?.close();
  } catch {
    // The lock pathname is still exclusively ours even if closing its handle fails.
  }
  try {
    await fs.unlink(path);
  } catch (cleanupError) {
    if (cleanupError.code !== 'ENOENT') {
      throw new AggregateError([originalError, cleanupError], 'project lock initialization and cleanup both failed');
    }
  }
}

export async function withProjectLock(root, operation, options = {}) {
  const fs = { open, readFile, unlink, ...options.fs };
  const retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const path = join(root, LOCK_NAME);
  const token = randomUUID();
  const deadline = now() + acquireTimeoutMs;

  while (true) {
    let handle;
    let created = false;
    try {
      handle = await fs.open(path, 'wx', 0o600);
      created = true;
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      await handle.close();
      handle = undefined;
      break;
    } catch (error) {
      if (created) await cleanFailedAcquisition(path, handle, fs, error);
      if (error.code !== 'EEXIST') throw error;
      if (now() >= deadline) throw await blockedError(path, fs);
      await sleep(retryIntervalMs);
    }
  }

  try {
    return await operation();
  } finally {
    await release(path, token, fs);
  }
}
