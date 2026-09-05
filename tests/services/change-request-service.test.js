import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { loadChangeImpactPreview, recordChangeRequest, listChangeRequests } from '../../src/services/change-request-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-change-request-'));
  const state = { projectId: 'p', phase: 'creative', activeSegmentId: null, blockedReason: null,
    artifacts: [], updatedAt: '2026-09-05T00:00:00Z' };
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  return { root, state };
}
test('unknown change saves and reads back without touching state or implying automatic execution', async () => {
  const { root } = await fixture();
  const before = await readFile(join(root, 'project-state.json'), 'utf8');
  const input = { scope: 'unknown', description: '产品颜色稍微变暖，其他可能继续' };
  const preview = await loadChangeImpactPreview(root, input);
  const result = await recordChangeRequest(root, { ...input, snapshotSha256: preview.snapshotSha256, confirm: true });
  assert.equal(result.request.status, 'awaiting_analysis');
  assert.ok(result.request.preview.unknowns.length);
  assert.equal(result.request.execution.applied, false);
  assert.equal(result.request.execution.paidSubmissionAllowed, false);
  assert.deepEqual(await listChangeRequests(root), [result.request]);
  assert.equal(await readFile(join(root, 'project-state.json'), 'utf8'), before);
});
test('repeated save is idempotent, including concurrent submission', async () => {
  const { root } = await fixture();
  const input = { scope: 'project', description: '调整方向' };
  const preview = await loadChangeImpactPreview(root, input);
  const args = { ...input, snapshotSha256: preview.snapshotSha256, confirm: true };
  const [first, second] = await Promise.all([recordChangeRequest(root, args), recordChangeRequest(root, args)]);
  assert.equal(first.request.id, second.request.id);
  assert.equal(Number(first.reused) + Number(second.reused), 1);
  assert.equal((await listChangeRequests(root)).length, 1);
});
test('stale snapshot is rejected and no request is written', async () => {
  const { root, state } = await fixture();
  const input = { scope: 'project', description: '调整方向' };
  const preview = await loadChangeImpactPreview(root, input);
  await writeJsonAtomic(join(root, 'project-state.json'), { ...state, updatedAt: '2026-09-05T01:00:00Z' });
  await assert.rejects(recordChangeRequest(root, { ...input, snapshotSha256: preview.snapshotSha256, confirm: true }), /过期/);
  assert.deepEqual(await listChangeRequests(root), []);
  assert.deepEqual(await readdir(root), ['project-state.json']);
});
test('save needs explicit confirmation and rejects malformed target lists', async () => {
  const { root } = await fixture();
  await assert.rejects(recordChangeRequest(root, {}), /确认/);
  await assert.rejects(recordChangeRequest(root, { confirm: true, description: 'x', snapshotSha256: 'a'.repeat(64), segmentIds: 's1' }), /array/);
});
