import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withProjectLock } from '../../src/storage/project-lock.js';

const quickTiming = {
  acquireTimeoutMs: 0,
  retryIntervalMs: 0,
  now: () => 1_000,
  sleep: async () => {}
};

test('does not delete a stale lock and reports its owner plus manual recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-lock-'));
  const lockPath = join(root, '.review-mutation.lock');
  const contents = JSON.stringify({ pid: 2_147_483_647, token: 'abandoned', createdAt: '2000-01-01T00:00:00.000Z' });
  await writeFile(lockPath, contents);

  await assert.rejects(
    withProjectLock(root, async () => {}, quickTiming),
    error => {
      assert.match(error.message, /blocked waiting for project mutation lock/);
      assert.match(error.message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(error.message, /pid=2147483647/);
      assert.match(error.message, /token=abandoned/);
      assert.match(error.message, /manually verify no process is using the project, then remove the lock file/);
      return true;
    }
  );
  assert.equal(await readFile(lockPath, 'utf8'), contents);
});

test('does not delete a malformed lock and identifies unparseable owner metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-lock-'));
  const lockPath = join(root, '.review-mutation.lock');
  await writeFile(lockPath, '{not-json');

  await assert.rejects(
    withProjectLock(root, async () => {}, quickTiming),
    error => {
      assert.match(error.message, /owner metadata: malformed/);
      assert.match(error.message, /manually verify no process is using the project/);
      return true;
    }
  );
  assert.equal(await readFile(lockPath, 'utf8'), '{not-json');
});

test('bounds retries with injected timing options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-lock-'));
  const lockPath = join(root, '.review-mutation.lock');
  await writeFile(lockPath, JSON.stringify({ pid: 42, token: 'owner', createdAt: '2026-07-12T00:00:00.000Z' }));
  let currentTime = 0;
  let sleeps = 0;

  await assert.rejects(
    withProjectLock(root, async () => {}, {
      acquireTimeoutMs: 5,
      retryIntervalMs: 1,
      now: () => currentTime,
      sleep: async milliseconds => {
        sleeps += 1;
        currentTime += milliseconds;
      }
    }),
    /blocked waiting for project mutation lock/
  );
  assert.equal(sleeps, 5);
});

test('cleans up a lock created by this attempt when owner metadata writing fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-lock-'));
  const lockPath = join(root, '.review-mutation.lock');
  let operationRan = false;

  await assert.rejects(
    withProjectLock(root, async () => { operationRan = true; }, {
      fs: {
        open: async (...args) => {
          const handle = await open(...args);
          return {
            writeFile: async () => { throw Object.assign(new Error('injected write failure'), { code: 'EIO' }); },
            close: () => handle.close()
          };
        }
      }
    }),
    /injected write failure/
  );
  assert.equal(operationRan, false);
  await assert.rejects(readFile(lockPath), /ENOENT/);
});

test('cleans up a lock created by this attempt when closing its handle fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-lock-'));
  const lockPath = join(root, '.review-mutation.lock');
  let operationRan = false;

  await assert.rejects(
    withProjectLock(root, async () => { operationRan = true; }, {
      fs: {
        open: async (...args) => {
          const handle = await open(...args);
          return {
            writeFile: value => handle.writeFile(value),
            close: async () => { throw Object.assign(new Error('injected close failure'), { code: 'EIO' }); }
          };
        }
      }
    }),
    /injected close failure/
  );
  assert.equal(operationRan, false);
  await assert.rejects(readFile(lockPath), /ENOENT/);
});
