import { appendFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { isProjectSlug } from '../domain/project-id.js';

const OWNER_ID = 'owner';
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const RESIDENT_LIFETIME_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
let mutationTail = Promise.resolve();

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

function statePath(root) {
  return join(resolve(root), 'team-access.json');
}

function initialState(now = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    owner: { id: OWNER_ID, label: '项目所有者', role: 'owner', status: 'active', createdAt: now },
    principals: [],
    invites: [],
    sessions: [],
    projectOwners: {},
    settings: { defaultLibTvProjectUuid: null, paidGenerationEnabled: true },
    updatedAt: now
  };
}

function assertState(value) {
  if (!value || value.schemaVersion !== 1 || value.owner?.id !== OWNER_ID
    || !Array.isArray(value.principals) || !Array.isArray(value.invites)
    || !Array.isArray(value.sessions) || !value.projectOwners || typeof value.projectOwners !== 'object') {
    throw new TypeError('Studio team access state is invalid');
  }
  return value;
}

async function readState(root) {
  try {
    return assertState(await readJson(statePath(root)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = initialState();
    await mkdir(resolve(root), { recursive: true });
    await writeJsonAtomic(statePath(root), state);
    return state;
  }
}

function serializeMutation(work) {
  const result = mutationTail.then(work, work);
  mutationTail = result.catch(() => {});
  return result;
}

async function mutate(root, mutator) {
  return serializeMutation(async () => {
    const state = await readState(root);
    const result = await mutator(state);
    state.updatedAt = new Date().toISOString();
    assertState(state);
    await writeJsonAtomic(statePath(root), state);
    return result;
  });
}

function publicPrincipal(value) {
  return value ? { id: value.id, label: value.label, role: value.role, status: value.status } : null;
}

function principalOf(state, id) {
  if (id === OWNER_ID) return state.owner;
  return state.principals.find(item => item.id === id) ?? null;
}

function activePrincipalOf(state, id) {
  const principal = principalOf(state, id);
  return principal?.status === 'active' ? principal : null;
}

function createSessionRecord(principalId, nowMs = Date.now()) {
  const token = newToken();
  return {
    token,
    record: {
      id: `session-${randomUUID()}`,
      principalId,
      tokenSha256: hashToken(token),
      csrfToken: randomUUID(),
      status: 'active',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + SESSION_LIFETIME_MS).toISOString()
    }
  };
}

export async function initializeStudioTeamAccess(root) {
  return readState(root);
}

export async function issueOwnerSession(root) {
  return mutate(root, state => {
    const { token, record } = createSessionRecord(OWNER_ID);
    state.sessions.push(record);
    return { token, session: structuredClone(record), principal: publicPrincipal(state.owner) };
  });
}

export async function authenticateStudioSession(root, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const state = await readState(root);
  const digest = hashToken(token);
  const session = state.sessions.find(item => item.tokenSha256 === digest && item.status === 'active');
  if (!session || Date.parse(session.expiresAt) <= nowMs) return null;
  const principal = activePrincipalOf(state, session.principalId);
  if (!principal) return null;
  return { session: structuredClone(session), principal: publicPrincipal(principal) };
}

export async function createStudioInvite(root, label, options = {}) {
  if (typeof label !== 'string' || label.trim().length < 1 || label.trim().length > 80) {
    throw new TypeError('member label must contain 1 to 80 characters');
  }
  return mutate(root, state => {
    const nowMs = options.nowMs ?? Date.now();
    const principal = {
      id: `member-${randomUUID()}`,
      label: label.trim(),
      role: 'member',
      status: 'invited',
      createdAt: new Date(nowMs).toISOString()
    };
    const token = newToken();
    const invite = {
      id: `invite-${randomUUID()}`,
      principalId: principal.id,
      tokenSha256: hashToken(token),
      status: 'pending',
      resident: options.resident === true,
      createdAt: principal.createdAt,
      expiresAt: new Date(nowMs + (options.resident === true ? RESIDENT_LIFETIME_MS : INVITE_LIFETIME_MS)).toISOString(),
      consumedAt: null
    };
    state.principals.push(principal);
    state.invites.push(invite);
    return { token, invite: structuredClone(invite), principal: publicPrincipal(principal) };
  });
}

export async function reissueStudioInvite(root, principalId, options = {}) {
  if (typeof principalId !== 'string' || !/^member-[a-f0-9-]+$/.test(principalId)) throw new TypeError('member id is invalid');
  return mutate(root, state => {
    const nowMs = options.nowMs ?? Date.now();
    const principal = state.principals.find(item => item.id === principalId);
    if (!principal || principal.status === 'revoked') throw new Error('member is unavailable for invite reissue');
    for (const invite of state.invites.filter(item => item.principalId === principalId && item.status === 'pending')) {
      invite.status = 'replaced';
      invite.replacedAt = new Date(nowMs).toISOString();
    }
    const token = newToken();
    const invite = {
      id: `invite-${randomUUID()}`,
      principalId: principal.id,
      tokenSha256: hashToken(token),
      status: 'pending',
      resident: options.resident === true,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + (options.resident === true ? RESIDENT_LIFETIME_MS : INVITE_LIFETIME_MS)).toISOString(),
      consumedAt: null
    };
    state.invites.push(invite);
    return { token, invite: structuredClone(invite), principal: publicPrincipal(principal) };
  });
}

export async function consumeStudioInvite(root, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) throw new Error('invite link is invalid');
  return mutate(root, state => {
    const digest = hashToken(token);
    const invite = state.invites.find(item => item.tokenSha256 === digest && item.status === 'pending');
    if (!invite || (invite.resident !== true && Date.parse(invite.expiresAt) <= nowMs)) throw new Error('invite link is invalid, expired, or already used');
    const principal = principalOf(state, invite.principalId);
    if (!principal || !['invited', 'active'].includes(principal.status)) throw new Error('invite member is unavailable');
    principal.status = 'active';
    principal.activatedAt ??= new Date(nowMs).toISOString();
    if (invite.resident !== true) {
      invite.status = 'consumed';
      invite.consumedAt = new Date(nowMs).toISOString();
    }
    const { token: sessionToken, record } = createSessionRecord(principal.id, nowMs);
    state.sessions.push(record);
    return { token: sessionToken, session: structuredClone(record), principal: publicPrincipal(principal) };
  });
}

export async function listStudioTeam(root) {
  const state = await readState(root);
  return {
    owner: publicPrincipal(state.owner),
    members: state.principals.map(publicPrincipal),
    settings: { defaultLibTvProjectUuid: null, paidGenerationEnabled: true, ...(state.settings ?? {}) },
    invites: state.invites.map(item => ({
      id: item.id,
      principalId: item.principalId,
      status: item.status,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      consumedAt: item.consumedAt
    }))
  };
}

export async function updateStudioTeamSettings(root, input) {
  const value = input.defaultLibTvProjectUuid;
  if (value !== null && !/^[a-f0-9]{32}$/.test(value ?? '')) throw new TypeError('default LibTV project UUID must be 32 lowercase hexadecimal characters');
  if (typeof input.paidGenerationEnabled !== 'boolean') throw new TypeError('paidGenerationEnabled must be boolean');
  return mutate(root, state => {
    state.settings = { ...(state.settings ?? {}), defaultLibTvProjectUuid: value, paidGenerationEnabled: input.paidGenerationEnabled };
    return structuredClone(state.settings);
  });
}

export async function revokeStudioMember(root, principalId) {
  if (principalId === OWNER_ID) throw new Error('owner cannot be revoked');
  return mutate(root, state => {
    const principal = state.principals.find(item => item.id === principalId);
    if (!principal) throw new Error('member not found');
    const now = new Date().toISOString();
    principal.status = 'revoked';
    principal.revokedAt = now;
    for (const invite of state.invites.filter(item => item.principalId === principalId && item.status === 'pending')) {
      invite.status = 'revoked';
    }
    for (const session of state.sessions.filter(item => item.principalId === principalId && item.status === 'active')) {
      session.status = 'revoked';
      session.revokedAt = now;
    }
    return publicPrincipal(principal);
  });
}

export async function assignStudioProjectOwner(root, projectSlug, principalId) {
  if (!isProjectSlug(projectSlug)) throw new TypeError('project slug is invalid');
  return mutate(root, state => {
    const principal = principalOf(state, principalId);
    if (!principal || !['active', 'invited'].includes(principal.status)) throw new Error('project owner is unavailable');
    const current = state.projectOwners[projectSlug];
    if (current && current !== principalId) throw new Error('project already belongs to another member');
    state.projectOwners[projectSlug] = principalId;
    return { projectSlug, principalId };
  });
}

export async function studioProjectOwner(root, projectSlug) {
  const state = await readState(root);
  return state.projectOwners[projectSlug] ?? OWNER_ID;
}

export async function canAccessStudioProject(root, projectSlug, principal) {
  if (!principal || principal.status !== 'active') return false;
  if (principal.role === 'owner') return true;
  return (await studioProjectOwner(root, projectSlug)) === principal.id;
}

export async function recordStudioTeamAudit(root, event) {
  const value = {
    schemaVersion: 1,
    id: `team-audit-${randomUUID()}`,
    principalId: event.principalId,
    method: event.method,
    path: event.path,
    statusCode: event.statusCode,
    occurredAt: event.occurredAt ?? new Date().toISOString()
  };
  await mkdir(resolve(root), { recursive: true });
  await appendFile(join(resolve(root), 'team-audit.jsonl'), `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  return value;
}

export const STUDIO_OWNER_ID = OWNER_ID;
