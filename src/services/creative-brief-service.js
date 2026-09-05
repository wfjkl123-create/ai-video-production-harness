import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { assertCreativeBrief } from '../domain/creative-brief.js';
import { assertReferenceWorkflow } from '../domain/reference-workflow.js';
import { assertProjectState } from '../domain/project-state.js';
import { readJson } from '../storage/json-store.js';
import { verifyArtifactFile } from './artifact-file-service.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { directorRouteFingerprint } from './director-interview-service.js';

const DOWNSTREAM_TYPES = new Set([
  'story_plan', 'capability_manifest', 'segmentation', 'segment_contract', 'spatial_control_model',
  'project_asset', 'segment_asset', 'storyboard_panel', 'asset_visual_audit', 'shot_narration',
  'seedance_prompt', 'independent_creative_audit', 'quality_rubric', 'video_segment', 'final_edit', 'handoff'
]);

function withoutRevisionImpact(decision) {
  const value = structuredClone(decision);
  delete value.revisionImpact;
  return value;
}

function topLevelDecisionDiff(previous, next) {
  const left = withoutRevisionImpact(previous);
  const right = withoutRevisionImpact(next);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return {
    changed: keys.filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])).map(key => `creativeDecision.${key}`),
    preserved: keys.filter(key => JSON.stringify(left[key]) === JSON.stringify(right[key])).map(key => `creativeDecision.${key}`)
  };
}

function artifactSetFingerprint(state) {
  return createHash('sha256').update(JSON.stringify(state.artifacts.map(artifact => ({
    id: artifact.id, type: artifact.type, revision: artifact.revision, status: artifact.status,
    sha256: artifact.sha256 ?? null, path: artifact.path
  })).sort((left, right) => left.id.localeCompare(right.id)))).digest('hex');
}

function assertIngressRouteBinding(state, workflow) {
  const route = state.routeDecision;
  if (!route) {
    if (state.ingressPolicyVersion !== undefined) {
      throw new Error('Gate 1 cannot publish before the deterministic intake routeDecision is captured');
    }
    return;
  }
  if (!route.harnessRequired) return;
  const expectedRole = route.referenceRoleStatus === 'not_applicable' ? 'none' : route.referenceRoleStatus;
  if (['awaiting_reference_role', 'awaiting_source_video'].includes(route.referenceRoleStatus)) {
    throw new Error('Gate 1 cannot publish before the intake reference role is resolved');
  }
  if (workflow.sourceRole !== expectedRole) {
    throw new Error(`creative brief reference role ${workflow.sourceRole} conflicts with intake route ${route.referenceRoleStatus}`);
  }
  const expectedIds = [...route.sourceVideoIds].sort();
  const actualIds = [...workflow.sourceVideoIds].sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error('creative brief sourceVideoIds must exactly match the intake routeDecision');
  }
}

async function requireCompleteDirectionInterview(root, state) {
  if (!state.routeDecision?.harnessRequired || state.videoGovernanceVersion !== 2) return null;
  const interview = await readJson(join(root, 'brief', 'director-interview-v1.json')).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Gate 1 requires a completed Gate 0 director interview');
    throw error;
  });
  if (interview.projectId !== state.projectId || interview.status !== 'complete') {
    throw new Error('Gate 1 requires a completed Gate 0 director interview for this project');
  }
  const routeFingerprint = directorRouteFingerprint(state.routeDecision);
  if (interview.routeFingerprint !== routeFingerprint
    || state.directionRevision?.routeFingerprint !== routeFingerprint
    || state.directionRevision?.interviewInputFingerprint !== interview.inputFingerprint
    || state.directionRevision?.status !== 'confirmed') {
    throw new Error('Gate 0 director interview is stale or not bound to the current video direction revision');
  }
  if ((interview.directorInputContract?.mustAnswerNow ?? []).length > 0) {
    throw new Error('Gate 0 still has must_answer_now questions');
  }
  return interview;
}

export async function createCreativeBrief(root, input, options = {}) {
  root = resolve(root);
  if (input?.schemaVersion !== 3) {
    const error = new Error('new Gate 1 creative briefs require schemaVersion 3; legacy v1/v2 briefs remain readable but cannot be newly published');
    error.code = 'CREATIVE_BRIEF_V3_REQUIRED';
    throw error;
  }
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  await requireCompleteDirectionInterview(root, state);
  const initialArtifactFingerprint = artifactSetFingerprint(state);
  if ((state.workflowVersion ?? 1) < 2) throw new Error('creative-brief command requires workflowVersion 2');
  const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'creative_brief').map(item => item.revision)) + 1;
  const previous = state.artifacts
    .filter(item => item.type === 'creative_brief')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  const briefInput = structuredClone(input);
  if (briefInput.creativeDecision.referenceWorkflow !== undefined) {
    briefInput.creativeDecision.referenceWorkflow = assertReferenceWorkflow(briefInput.creativeDecision.referenceWorkflow);
    assertIngressRouteBinding(state, briefInput.creativeDecision.referenceWorkflow);
  }
  let previousBrief = null;
  if (previous) {
    const inspected = await verifyArtifactFile(root, previous);
    previousBrief = assertCreativeBrief(await readJson(inspected.path));
  }
  const diff = previousBrief
    ? topLevelDecisionDiff(previousBrief.creativeDecision, briefInput.creativeDecision)
    : { changed: [], preserved: [] };
  const scopeRevisionInvalidatedIds = state.directionRevision?.invalidatedArtifactIds ?? [];
  const downstreamArtifactIds = previous
    ? state.artifacts.filter(item => DOWNSTREAM_TYPES.has(item.type)).map(item => item.id)
    : [];
  const affectedArtifactIds = [...new Set([...scopeRevisionInvalidatedIds, ...downstreamArtifactIds])].sort();
  const hasPriorImpact = Boolean(previous) || affectedArtifactIds.length > 0;
  briefInput.directionRevisionBinding = state.directionRevision ? {
    id: state.directionRevision.id,
    revision: state.directionRevision.revision,
    routeFingerprint: state.directionRevision.routeFingerprint,
    interviewInputFingerprint: state.directionRevision.interviewInputFingerprint
  } : null;
  briefInput.creativeDecision.revisionImpact = {
    previousCreativeBriefId: previous?.id ?? null,
    changeSummary: previous
      ? `Gate 1 revision ${revision} supersedes ${previous.id}; changed decision groups: ${diff.changed.join(', ') || 'none'}`
      : hasPriorImpact
        ? `First Gate 1 brief for the current direction; scope revision invalidated prior artifacts: ${affectedArtifactIds.join(', ')}`
        : 'Initial Gate 1 director creative master; no prior downstream work is invalidated',
    changedDecisionPaths: diff.changed,
    affectedStages: hasPriorImpact ? ['gate2_story_and_shot', 'gate3_assets', 'gate4_prompt_and_generation', 'gate5_video_review'] : [],
    affectedArtifactIds,
    requiredRework: hasPriorImpact ? ['Rebuild Gate 2 from the new creative brief before reusing downstream artifacts'] : [],
    preservedDecisions: diff.preserved,
    impactPolicy: 'conservative_v1'
  };
  const brief = structuredClone(assertCreativeBrief(briefInput));
  if (state.projectId !== brief.projectId) throw new Error(`creative brief projectId must match ${state.projectId}`);

  brief.kind = 'creative_brief';
  brief.status = 'draft';
  const path = `planning/creative-briefs/${brief.id}.json`;
  const serialized = `${JSON.stringify(brief, null, 2)}\n`;
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const artifact = {
    id: brief.id, type: 'creative_brief', revision, status: 'draft', path, sha256,
    ...(previous ? { supersedesArtifactId: previous.id } : {})
  };

  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const current = assertProjectState(await readJson(join(root, 'project-state.json')));
    if (options.expectedStateFingerprint && createHash('sha256').update(JSON.stringify(current)).digest('hex') !== options.expectedStateFingerprint) throw new Error('项目进度已变化，请重新查看修改影响后再采用。');
    await requireCompleteDirectionInterview(root, current);
    if ((current.workflowVersion ?? 1) < 2) throw new Error('project workflow version changed before creative brief publication');
    assertIngressRouteBinding(current, brief.creativeDecision.referenceWorkflow);
    await options.validateBeforePublish?.();
    const expectedRevision = Math.max(0, ...current.artifacts.filter(item => item.type === 'creative_brief').map(item => item.revision)) + 1;
    if (expectedRevision !== artifact.revision) throw new Error('creative brief revision changed before publication; rebuild from current state');
    if (artifactSetFingerprint(current) !== initialArtifactFingerprint) {
      throw new Error('project artifacts changed before creative brief publication; rebuild revision impact from current state');
    }
    if (current.artifacts.some(item => item.id === artifact.id || item.path === artifact.path)) throw new Error(`creative brief already exists: ${artifact.id}`);
    current.artifacts.push(artifact);
    current.phase = 'creative_review';
    current.updatedAt = new Date().toISOString();
    assertProjectState(current);
    await commitJsonTransaction(root, `creative-brief-${artifact.id}`, [
      { path: join(root, path), value: brief },
      { path: join(root, 'project-state.json'), value: current },
      ...(options.publicationWrites?.(artifact) ?? [])
    ]);
    return artifact;
  });
}
