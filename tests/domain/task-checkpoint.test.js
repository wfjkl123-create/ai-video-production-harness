import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockTask,
  claimTask,
  createTaskCheckpoint,
  failTask,
  succeedTask,
  taskKeyFor
} from '../../src/domain/task-checkpoint.js';

const identity = (overrides = {}) => ({
  taskType: 'compile_asset', inputs: { b: 2, a: 1 }, dependencyKeys: ['dep-b', 'dep-a'],
  sourceFact: { id: 'facts-v1', sha256: 'a'.repeat(64) }, storyPlan: { id: 'story-v2', sha256: 'b'.repeat(64) },
  template: { id: 'template-v3', sha256: 'c'.repeat(64) }, skill: { id: 'skill-v4', sha256: 'd'.repeat(64) },
  model: 'gpt-image-2', params: { quality: 'high' }, codeVersion: 'git:abc123', ...overrides
});

test('task key is canonical and covers every durable input identity field', () => {
  const base = identity();
  const reordered = { ...base, inputs: { a: 1, b: 2 }, dependencyKeys: ['dep-a', 'dep-b'] };
  assert.equal(taskKeyFor(base), taskKeyFor(reordered));
  for (const [field, value] of Object.entries({
    taskType: 'other', inputs: { a: 9 }, dependencyKeys: ['dep-c'], sourceFact: { id: 'facts-v2' },
    storyPlan: { id: 'story-v3' }, template: { id: 'template-v4' }, skill: { id: 'skill-v5' },
    model: 'other-model', params: { quality: 'low' }, codeVersion: 'git:def456'
  })) assert.notEqual(taskKeyFor(base), taskKeyFor({ ...base, [field]: value }), field);
});

test('checkpoint lifecycle reuses success, bounds failed attempts, and binds output SHA', () => {
  let checkpoint = createTaskCheckpoint(identity(), { createdAt: '2026-08-08T00:00:00Z', maxAttempts: 2 });
  const first = claimTask(checkpoint, { ownerId: 'worker-a', claimToken: 'token-a', claimedAt: '2026-08-08T00:00:01Z' });
  checkpoint = failTask(first.checkpoint, { ownerId: 'worker-a', claimToken: 'token-a', error: 'transient', endedAt: '2026-08-08T00:00:02Z' });
  const second = claimTask(checkpoint, { ownerId: 'worker-b', claimToken: 'token-b', claimedAt: '2026-08-08T00:00:03Z' });
  checkpoint = succeedTask(second.checkpoint, { ownerId: 'worker-b', claimToken: 'token-b', outputs: [{ path: 'out.bin', sha256: 'e'.repeat(64) }], endedAt: '2026-08-08T00:00:04Z' });
  assert.equal(claimTask(checkpoint, { ownerId: 'worker-c', claimedAt: '2026-08-08T00:00:05Z' }).disposition, 'reuse');
  assert.equal(checkpoint.outputs[0].sha256, 'e'.repeat(64));
  assert.throws(() => succeedTask(second.checkpoint, { ownerId: 'worker-b', claimToken: 'token-b', outputs: [{ path: 'x' }], endedAt: '2026-08-08T00:00:04Z' }), /SHA-256/);
});

test('running, paid, non-idempotent, and explicitly blocked work cannot be duplicate claimed', () => {
  const created = createTaskCheckpoint(identity(), { createdAt: '2026-08-08T00:00:00Z' });
  const running = claimTask(created, { ownerId: 'owner-a', claimToken: 'claim-a', claimedAt: '2026-08-08T00:00:01Z' });
  assert.equal(claimTask(running.checkpoint, { ownerId: 'owner-b', claimedAt: '2026-08-08T00:00:01Z' }).disposition, 'already_running');
  for (const policy of [{ paid: true }, { idempotent: false }]) {
    const initial = createTaskCheckpoint(identity(policy), { createdAt: '2026-08-08T00:00:00Z' });
    const claim = claimTask(initial, { ownerId: 'owner-a', claimToken: 'claim-a', claimedAt: '2026-08-08T00:00:01Z' });
    const failed = failTask(claim.checkpoint, { ownerId: 'owner-a', claimToken: 'claim-a', error: 'uncertain', endedAt: '2026-08-08T00:00:02Z' });
    assert.equal(claimTask(failed, { ownerId: 'owner-b', claimedAt: '2026-08-08T00:00:03Z' }).disposition, 'blocked_non_repeatable');
  }
  const blocked = blockTask(running.checkpoint, { ownerId: 'owner-a', claimToken: 'claim-a', reason: 'dependency missing', endedAt: '2026-08-08T00:00:02Z' });
  assert.equal(claimTask(blocked, { ownerId: 'owner-b', claimedAt: '2026-08-08T00:00:03Z' }).disposition, 'blocked');
});
