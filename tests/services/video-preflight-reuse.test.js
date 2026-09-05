import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVideoPreflight } from '../../src/services/video-generation-service.js';
import { initializeProject } from '../../src/services/project-service.js';

function inspected(fingerprintSha256) {
  return {
    fingerprint: { sha256: fingerprintSha256 },
    plan: { segmentId: 'segment-001', executor: 'libtv', requiresPaidApproval: true }
  };
}

test('an identical video package fingerprint reuses the ready preflight instead of creating another record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-reuse-'));
  await initializeProject(root, { projectId: 'PREFLIGHT-REUSE' });
  const first = await createVideoPreflight(root, 'segment-001', {
    id: 'preflight-first',
    inspect: async () => inspected('a'.repeat(64))
  });
  const second = await createVideoPreflight(root, 'segment-001', {
    id: 'preflight-second',
    inspect: async () => inspected('a'.repeat(64))
  });

  assert.equal(first.preflightId, 'preflight-first');
  assert.equal(first.reused, false);
  assert.equal(second.preflightId, 'preflight-first');
  assert.equal(second.reused, true);
  assert.deepEqual((await readdir(join(root, 'runs'))).filter(name => name.endsWith('.json')), ['preflight-first.json']);
});

test('a changed package fingerprint creates a distinct preflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-invalidate-'));
  await initializeProject(root, { projectId: 'PREFLIGHT-INVALIDATE' });
  await createVideoPreflight(root, 'segment-001', {
    id: 'preflight-first', inspect: async () => inspected('a'.repeat(64))
  });
  const changed = await createVideoPreflight(root, 'segment-001', {
    id: 'preflight-changed', inspect: async () => inspected('b'.repeat(64))
  });
  assert.equal(changed.preflightId, 'preflight-changed');
  assert.equal(changed.reused, false);
  assert.equal((await readdir(join(root, 'runs'))).filter(name => name.endsWith('.json')).length, 2);
});
