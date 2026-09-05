import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireStudioServerLease } from '../../src/services/studio-server-lease-service.js';

test('only one Studio process may mutate a team state root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-lease-'));
  const first = await acquireStudioServerLease(root, { pid: 100 });
  await assert.rejects(acquireStudioServerLease(root, { pid: 200 }), /already using/);
  await first.release();
  const second = await acquireStudioServerLease(root, { pid: 200 });
  await second.release();
});

test('concurrent Studio lease acquisition has exactly one winner and no stale-lock ABA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-lease-'));
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => acquireStudioServerLease(root, { pid: 200 + index })));
  const winners = attempts.filter(item => item.status === 'fulfilled');
  const losers = attempts.filter(item => item.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 7);
  await winners[0].value.release();
  const afterRelease = await acquireStudioServerLease(root, { pid: 300 });
  await afterRelease.release();
});
