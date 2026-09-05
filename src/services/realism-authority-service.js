import { resolve, join } from 'node:path';
import {
  AUTHORITY_ARTIFACT_TYPE_BY_KIND,
  assertRealismAuthority,
  realismAuthoritySourceBindings
} from '../domain/realism-authority.js';
import { assertProjectState } from '../domain/project-state.js';
import { currentArtifactsOf } from '../domain/current-artifact.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { verifyLockedArtifact } from './artifact-file-service.js';
import { registerArtifact } from './intake-service.js';
import { autoLockArtifact } from './review-service.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function scopeMatches(artifact, payload) {
  if (payload.kind === 'scene_geometry_v2') return artifact.sceneId === payload.sceneId;
  if (payload.kind === 'character_story_state_v1') {
    return artifact.characterId === payload.characterId && artifact.scopeKey === payload.scopeKey;
  }
  return artifact.characterId === payload.characterId;
}

export async function registerRealismAuthority(root, input) {
  root = resolve(root);
  const payload = structuredClone(assertRealismAuthority(input?.payload));
  if (!SAFE_ID.test(payload.id)) throw new TypeError('payload.id must be a safe identifier');
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  if ((state.realismContractsVersion ?? 1) !== 2 || state.realismContractsWriteMode === 'read_only') {
    throw new Error('realism authority writes require realismContractsVersion 2 with write mode enabled');
  }
  if (payload.projectId !== state.projectId) throw new Error('realism authority projectId must match project state');
  const current = currentArtifactsOf(state.artifacts);
  const currentById = new Map(current.map(artifact => [artifact.id, artifact]));
  for (const binding of realismAuthoritySourceBindings(payload)) {
    const artifact = currentById.get(binding.id);
    if (!artifact || artifact.status !== 'locked' || artifact.revision !== binding.revision || artifact.sha256 !== binding.sha256) {
      throw new Error(`realism authority source binding is stale or unlocked: ${binding.id}`);
    }
    await verifyLockedArtifact(root, artifact);
  }
  if (payload.kind === 'character_acting_master_v1') {
    const storyBindings = payload.sourceBindings.filter(binding => currentById.get(binding.id)?.type === 'story_plan');
    if (storyBindings.length !== 1) {
      throw new Error('character acting Master Profile requires exactly one current locked Gate 2 Story Plan source binding');
    }
    const storyArtifact = currentById.get(storyBindings[0].id);
    const review = await readJson(join(root, 'reviews', `${storyArtifact.lockedByReviewId}.json`));
    if (review.actor !== 'human' || review.decision !== 'approved' || review.artifactId !== storyArtifact.id
      || review.artifactSha256 !== storyArtifact.sha256) {
      throw new Error('character acting Master Profile must descend from the exact human-approved Gate 2 Story Plan');
    }
  }
  const artifactType = AUTHORITY_ARTIFACT_TYPE_BY_KIND[payload.kind];
  const prior = current.filter(artifact => artifact.type === artifactType && scopeMatches(artifact, payload));
  if (prior.length > 1) throw new Error(`multiple current ${artifactType} artifacts already exist for this scope`);
  const supersedesArtifactId = input.supersedesArtifactId;
  if (prior.length === 1 && supersedesArtifactId !== prior[0].id) {
    throw new Error(`${artifactType} already exists for this scope; explicit supersedesArtifactId is required`);
  }
  if (prior.length === 0 && supersedesArtifactId !== undefined) throw new Error('supersedesArtifactId does not match a current authority artifact');
  const revision = (prior[0]?.revision ?? 0) + 1;
  const path = `authority/${artifactType}/${payload.id}-r${revision}.json`;
  if (state.artifacts.some(artifact => artifact.id === payload.id || artifact.path === path)) {
    throw new Error(`realism authority artifact already exists: ${payload.id}`);
  }
  await writeJsonAtomic(join(root, path), payload);
  const descriptor = {
    id: payload.id,
    type: artifactType,
    authorityKind: payload.kind,
    revision,
    status: 'draft',
    path,
    ...(payload.characterId ? { characterId: payload.characterId } : {}),
    ...(payload.sceneId ? { sceneId: payload.sceneId } : {}),
    ...(payload.scopeKey ? { scopeKey: payload.scopeKey } : {}),
    ...(payload.applicability ? { applicability: payload.applicability } : {}),
    ...(supersedesArtifactId ? { supersedesArtifactId } : {})
  };
  const artifact = await registerArtifact(root, descriptor);
  await autoLockArtifact(root, artifact.id, 'auto-locked: realism authority structure and all current source bindings verified');
  const refreshed = assertProjectState(await readJson(join(root, 'project-state.json')));
  return refreshed.artifacts.find(item => item.id === artifact.id);
}
