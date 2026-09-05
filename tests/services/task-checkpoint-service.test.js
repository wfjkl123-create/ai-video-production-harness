import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File } from '../../src/storage/checksum.js';
import {
  claimTaskCheckpoint,
  failTaskCheckpoint,
  getTaskCheckpoint,
  succeedTaskCheckpoint,
  taskCheckpointPath
} from '../../src/services/task-checkpoint-service.js';

const identity = (overrides = {}) => ({
  taskType: 'local_compile', inputs: { source: 'a' }, dependencyKeys: ['dep-1'],
  sourceFact: 'facts-a', storyPlan: 'story-a', template: 'template-a', skill: 'skill-a',
  model: 'local-model', params: { temperature: 0 }, codeVersion: 'test-v1', ...overrides
});

test('concurrent durable claims have exactly one owner and an atomic checkpoint file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-checkpoint-claim-'));
  const now = () => new Date('2026-08-08T01:00:00Z');
  const [left, right] = await Promise.all([
    claimTaskCheckpoint(root, identity(), { ownerId: 'worker-left', claimToken: 'left-token', now }),
    claimTaskCheckpoint(root, identity(), { ownerId: 'worker-right', claimToken: 'right-token', now })
  ]);
  assert.deepEqual([left.disposition, right.disposition].sort(), ['already_running', 'claimed']);
  const winner = [left, right].find(item => item.disposition === 'claimed');
  const persisted = await getTaskCheckpoint(root, winner.taskKey);
  assert.equal(persisted.attempts.length, 1);
  assert.equal(persisted.attempts[0].claimToken, winner.claimToken);
  const persistedText = await readFile(taskCheckpointPath(root, winner.taskKey), 'utf8');
  assert.doesNotThrow(() => JSON.parse(persistedText));
  assert.deepEqual(await readdir(join(root, 'runs', 'checkpoints')), [`${winner.taskKey}.json`]);
});

test('successful outputs are byte-verified and exact input repeats reuse them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-checkpoint-output-'));
  await writeFile(join(root, 'result.txt'), 'durable result');
  const output = { id: 'result', path: 'result.txt', sha256: await sha256File(join(root, 'result.txt')) };
  const claimed = await claimTaskCheckpoint(root, identity(), { ownerId: 'worker-a', claimToken: 'claim-a' });
  const succeeded = await succeedTaskCheckpoint(root, claimed.taskKey, { ownerId: 'worker-a', claimToken: 'claim-a', outputs: [output] });
  assert.equal(succeeded.status, 'succeeded');
  const reused = await claimTaskCheckpoint(root, identity(), { ownerId: 'worker-b' });
  assert.equal(reused.disposition, 'reuse');
  assert.deepEqual(reused.checkpoint.outputs, [output]);
  await writeFile(join(root, 'result.txt'), 'changed');
  await assert.rejects(
    () => claimTaskCheckpoint(root, identity(), { ownerId: 'worker-b' }),
    /output SHA changed/
  );
  const another = await claimTaskCheckpoint(root, identity({ inputs: { source: 'b' } }), { ownerId: 'worker-b', claimToken: 'claim-b' });
  await assert.rejects(() => succeedTaskCheckpoint(root, another.taskKey, { ownerId: 'worker-b', claimToken: 'claim-b', outputs: [output] }), /SHA changed/);
});

test('failed free idempotent work gets only the configured number of attempts and changed input gets a new key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-checkpoint-retry-'));
  const first = await claimTaskCheckpoint(root, identity(), { ownerId: 'worker-a', claimToken: 'claim-a', maxAttempts: 2 });
  await failTaskCheckpoint(root, first.taskKey, { ownerId: 'worker-a', claimToken: 'claim-a', error: 'first failure' });
  const second = await claimTaskCheckpoint(root, identity(), { ownerId: 'worker-b', claimToken: 'claim-b', maxAttempts: 99 });
  assert.equal(second.attempt, 2);
  await failTaskCheckpoint(root, first.taskKey, { ownerId: 'worker-b', claimToken: 'claim-b', error: 'second failure' });
  assert.equal((await claimTaskCheckpoint(root, identity(), { ownerId: 'worker-c' })).disposition, 'attempt_limit');
  const changed = await claimTaskCheckpoint(root, identity({ storyPlan: 'story-b' }), { ownerId: 'worker-c' });
  assert.notEqual(changed.taskKey, first.taskKey);
  assert.equal(changed.disposition, 'claimed');
});
