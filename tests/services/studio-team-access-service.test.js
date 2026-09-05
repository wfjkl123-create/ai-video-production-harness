import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assignStudioProjectOwner,
  authenticateStudioSession,
  canAccessStudioProject,
  consumeStudioInvite,
  createStudioInvite,
  reissueStudioInvite,
  issueOwnerSession,
  listStudioTeam,
  recordStudioTeamAudit,
  revokeStudioMember,
  studioProjectOwner,
  updateStudioTeamSettings
} from '../../src/services/studio-team-access-service.js';

async function fixture() {
  return mkdtemp(join(tmpdir(), 'studio-team-access-'));
}

test('a one-time invite creates a passwordless member session without storing raw tokens', async () => {
  const root = await fixture();
  const created = await createStudioInvite(root, '剪辑同事 A', { nowMs: 1_800_000_000_000 });
  const joined = await consumeStudioInvite(root, created.token, 1_800_000_001_000);
  assert.equal(joined.principal.label, '剪辑同事 A');
  assert.equal(joined.principal.status, 'active');
  assert.ok(await authenticateStudioSession(root, joined.token, 1_800_000_002_000));
  await assert.rejects(consumeStudioInvite(root, created.token, 1_800_000_003_000), /already used/);
  const bytes = await readFile(join(root, 'team-access.json'), 'utf8');
  assert.equal(bytes.includes(created.token), false);
  assert.equal(bytes.includes(joined.token), false);
});

test('members see only owned projects while the owner sees every project', async () => {
  const root = await fixture();
  const first = await createStudioInvite(root, '同事 A');
  const second = await createStudioInvite(root, '同事 B');
  const memberA = (await consumeStudioInvite(root, first.token)).principal;
  const memberB = (await consumeStudioInvite(root, second.token)).principal;
  const owner = (await issueOwnerSession(root)).principal;
  await assignStudioProjectOwner(root, 'project-a', memberA.id);
  assert.equal(await studioProjectOwner(root, 'project-a'), memberA.id);
  assert.equal(await canAccessStudioProject(root, 'project-a', memberA), true);
  assert.equal(await canAccessStudioProject(root, 'project-a', memberB), false);
  assert.equal(await canAccessStudioProject(root, 'project-a', owner), true);
  assert.equal(await studioProjectOwner(root, 'legacy-project'), 'owner');
});

test('revocation invalidates passwordless sessions and preserves the project owner record', async () => {
  const root = await fixture();
  const invite = await createStudioInvite(root, '同事 A');
  const joined = await consumeStudioInvite(root, invite.token);
  await assignStudioProjectOwner(root, 'project-a', joined.principal.id);
  await revokeStudioMember(root, joined.principal.id);
  assert.equal(await authenticateStudioSession(root, joined.token), null);
  assert.equal(await studioProjectOwner(root, 'project-a'), joined.principal.id);
  assert.equal((await listStudioTeam(root)).members[0].status, 'revoked');
});

test('reissuing an invite preserves the member identity and replaces pending links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-reissue-'));
  const first = await createStudioInvite(root, '何波');
  const second = await reissueStudioInvite(root, first.principal.id);
  assert.equal(second.principal.id, first.principal.id);
  assert.equal(second.principal.label, '何波');
  await assert.rejects(consumeStudioInvite(root, first.token), /invalid, expired, or already used/);
  const joined = await consumeStudioInvite(root, second.token);
  assert.equal(joined.principal.id, first.principal.id);
  assert.equal((await listStudioTeam(root)).members[0].status, 'active');
});

test('team audit records actor, route and status without request bodies', async () => {
  const root = await fixture();
  await recordStudioTeamAudit(root, { principalId: 'owner', method: 'POST', path: '/api/projects', statusCode: 201 });
  const line = JSON.parse((await readFile(join(root, 'team-audit.jsonl'), 'utf8')).trim());
  assert.equal(line.principalId, 'owner');
  assert.equal(line.path, '/api/projects');
  assert.equal('body' in line, false);
});

test('only a validated shared LibTV project location is stored for zero-config members', async () => {
  const root = await fixture();
  await assert.rejects(updateStudioTeamSettings(root, { defaultLibTvProjectUuid: 'not-a-uuid', paidGenerationEnabled: true }), /32 lowercase/);
  const settings = await updateStudioTeamSettings(root, { defaultLibTvProjectUuid: 'a'.repeat(32), paidGenerationEnabled: true });
  assert.equal(settings.defaultLibTvProjectUuid, 'a'.repeat(32));
  assert.equal((await listStudioTeam(root)).settings.defaultLibTvProjectUuid, 'a'.repeat(32));
  assert.equal((await updateStudioTeamSettings(root, { defaultLibTvProjectUuid: 'a'.repeat(32), paidGenerationEnabled: false })).paidGenerationEnabled, false);
});
