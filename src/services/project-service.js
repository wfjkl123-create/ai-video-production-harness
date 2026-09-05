import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { directorRouteFingerprint } from './director-interview-service.js';

const directories = [
  'brief', 'planning/creative-briefs', 'planning/story-plans', 'segments', 'assets/project', 'prompts', 'outputs', 'reviews', 'runs', 'versions',
  'ledger/events'
];

function requireProjectId(projectId) {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new TypeError('projectId must be a non-empty string');
  }
}

export async function initializeProject(root, input) {
  requireProjectId(input?.projectId);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  const statePath = join(root, 'project-state.json');

  if (entries.length > 0) {
    let existing;
    try {
      existing = assertProjectState(await readJson(statePath));
    } catch {
      throw new Error('cannot initialize a non-empty target without a valid project state');
    }
    if (existing.projectId !== input.projectId) {
      throw new Error(`projectId mismatch: existing project is ${existing.projectId}`);
    }
    for (const directory of directories) await mkdir(join(root, directory), { recursive: true });
    return existing;
  }

  for (const directory of directories) await mkdir(join(root, directory), { recursive: true });
  const workflowVersion = input.workflowVersion ?? 2;
  const ingressPolicyVersion = input.ingressPolicyVersion
    ?? (input.routeDecision ? input.routeDecision.policyVersion : input.workflowVersion === undefined ? 'ingress-route-v1' : undefined);
  const state = {
    projectId: input.projectId,
    workflowVersion,
    ...(input.realismContractsVersion ? {
      realismContractsVersion: input.realismContractsVersion,
      realismContractsWriteMode: input.realismContractsWriteMode ?? 'enabled'
    } : {}),
    ...(ingressPolicyVersion ? { ingressPolicyVersion } : {}),
    ...(input.routeDecision ? { routeDecision: structuredClone(input.routeDecision) } : {}),
    ...(input.routeDecision?.harnessRequired === true && input.routeDecision?.executionClass !== 'mechanical_asset_prompt' ? {
      videoGovernanceVersion: 2,
      directionRevision: {
        id: 'direction-revision-1', revision: 1, status: 'awaiting_answers',
        routeFingerprint: directorRouteFingerprint(input.routeDecision),
        reason: 'Initial video direction supplied during project initialization',
        invalidatedArtifactIds: [], updatedAt: new Date().toISOString()
      }
    } : {}),
    phase: 'intake',
    activeSegmentId: null,
    blockedReason: null,
    artifacts: [],
    updatedAt: new Date().toISOString()
  };
  assertProjectState(state);
  await writeJsonAtomic(statePath, state);
  return state;
}

export async function getProjectStatus(root) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  return {
    ...state,
    pendingHumanGate: state.artifacts
      .filter(({ status }) => status === 'awaiting_review')
      .map(({ id }) => id)
  };
}

/**
 * Compact status: only project-level info + artifacts relevant to the active
 * (or specified) segment. Dramatically reduces output size for large projects.
 */
export async function getCompactStatus(root, segmentId) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const target = segmentId ?? state.activeSegmentId;
  const relevant = state.artifacts.filter(a => {
    // Always include project-level artifacts (no segmentId)
    if (!a.segmentId) return true;
    // Include artifacts for the target segment
    if (target && a.segmentId === target) return true;
    return false;
  });
  return {
    projectId: state.projectId,
    phase: state.phase,
    activeSegmentId: state.activeSegmentId,
    executionMode: state.executionMode ?? null,
    blockedReason: state.blockedReason,
    updatedAt: state.updatedAt,
    totalArtifacts: state.artifacts.length,
    shownArtifacts: relevant.length,
    artifacts: relevant,
    pendingHumanGate: relevant
      .filter(({ status }) => status === 'awaiting_review')
      .map(({ id }) => id)
  };
}
