import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { assertStoryPlan } from '../domain/story-plan.js';
import { assertProjectState } from '../domain/project-state.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { assertCreativeBrief } from '../domain/creative-brief.js';
import { workflowProfileIdOf } from '../domain/workflow-profile.js';
import { isSourceFactMachineDelegated } from '../domain/reference-workflow.js';

export async function createStoryPlan(root, input, options = {}) {
  root = resolve(root);
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  if ((state.workflowVersion ?? 1) < 2) throw new Error('story-plan command requires workflowVersion 2');
  if (input?.schemaVersion !== 2) {
    const error = new Error('workflowVersion 2 requires a schemaVersion 2 story plan; the AI must upgrade the plan before the existing Gate 2 review');
    error.code = 'STORY_PLAN_V2_REQUIRED';
    throw error;
  }
  if (typeof input?.creativeBriefId !== 'string' || input.creativeBriefId.trim() === '') throw new TypeError('creativeBriefId must be a non-empty string');
  const lockedCreativeBriefs = state.artifacts
    .filter(item => item.type === 'creative_brief' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (lockedCreativeBriefs.length > 1 && lockedCreativeBriefs[0].revision === lockedCreativeBriefs[1].revision) throw new Error(`multiple locked creative_brief artifacts have revision ${lockedCreativeBriefs[0].revision}`);
  if (lockedCreativeBriefs[0]?.id !== input.creativeBriefId) throw new Error(`story plan must use latest locked creative_brief: ${lockedCreativeBriefs[0]?.id ?? 'none'}`);
  const creativeArtifact = state.artifacts.find(item => item.id === input.creativeBriefId && item.type === 'creative_brief');
  if (!creativeArtifact) throw new Error(`locked creative_brief is required: ${input.creativeBriefId}`);
  const creativeFile = await verifyLockedArtifact(root, creativeArtifact);
  const creativeBrief = assertCreativeBrief(await readJson(creativeFile.path));
  if (creativeBrief.projectId !== state.projectId) throw new Error('creative brief projectId does not match current project');
  if (input.targetDurationSec !== undefined && input.targetDurationSec !== creativeBrief.targetDurationSec) throw new Error('story plan targetDurationSec conflicts with locked creative brief');
  if (input.creativeDecision !== undefined && !isDeepStrictEqual(input.creativeDecision, creativeBrief.creativeDecision)) throw new Error('story plan creativeDecision conflicts with locked creative brief');
  const profileId = workflowProfileIdOf(state);
  const referenceWorkflow = creativeBrief.creativeDecision?.referenceWorkflow;
  const autoDelegation = profileId === 'simple_remake'
    && referenceWorkflow
    && input.sourceFactContract === undefined
    && isSourceFactMachineDelegated(referenceWorkflow, creativeBrief.creativeDecision, profileId)
    ? {
        workflowProfileId: profileId,
        reason: '简单复刻路线由系统自动整理原片事实，无需人工填写原片事实合同。'
      }
    : null;
  const plan = structuredClone(assertStoryPlan({
    ...input,
    ...(input.sourceFactDelegation === undefined && autoDelegation ? { sourceFactDelegation: autoDelegation } : {}),
    targetDurationSec: creativeBrief.targetDurationSec,
    creativeDecision: creativeBrief.creativeDecision
  }));
  if (state.projectId !== plan.projectId) throw new Error(`story plan projectId must match ${state.projectId}`);

  if (plan.shotPlanning.roughStoryboardPreview) {
    const previewPath = plan.shotPlanning.roughStoryboardPreview.path;
    const inspected = await inspectArtifactFile(root, previewPath);
    plan.shotPlanning.roughStoryboardPreview = { path: previewPath, sha256: inspected.sha256, purpose: 'human_readability_only' };
  }
  plan.kind = 'story_plan';
  plan.status = 'draft';
  plan.creativeBriefSha256 = creativeFile.sha256;
  const path = `planning/story-plans/${plan.id}.json`;
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'story_plan').map(item => item.revision)) + 1;
  const artifact = {
    id: plan.id, type: 'story_plan', revision, status: 'draft', path, sha256,
    ...(plan.assetScope?.excludedArtifactIds?.length ? { excludedAssetIds: [...plan.assetScope.excludedArtifactIds] } : {})
  };

  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const current = assertProjectState(await readJson(join(root, 'project-state.json')));
    if (options.expectedStateFingerprint && createHash('sha256').update(JSON.stringify(current)).digest('hex') !== options.expectedStateFingerprint) throw new Error('项目进度已变化，请重新查看修改影响后再采用。');
    if ((current.workflowVersion ?? 1) < 2) throw new Error('project workflow version changed before story plan publication');
    const currentCreative = current.artifacts.find(item => item.id === plan.creativeBriefId && item.type === 'creative_brief');
    if (!currentCreative || currentCreative.status !== 'locked' || currentCreative.sha256 !== creativeArtifact.sha256) throw new Error('creative brief changed before story plan publication');
    await verifyLockedArtifact(root, currentCreative);
    await options.validateBeforePublish?.();
    const expectedRevision = Math.max(0, ...current.artifacts.filter(item => item.type === 'story_plan').map(item => item.revision)) + 1;
    if (expectedRevision !== artifact.revision) throw new Error('story plan revision changed before publication; rebuild from current state');
    if (current.artifacts.some(item => item.id === artifact.id || item.path === artifact.path)) throw new Error(`story plan already exists: ${artifact.id}`);
    current.artifacts.push(artifact);
    current.phase = 'story_plan_review';
    current.updatedAt = new Date().toISOString();
    assertProjectState(current);
    await commitJsonTransaction(root, `story-plan-${artifact.id}`, [
      { path: join(root, path), value: plan },
      { path: join(root, 'project-state.json'), value: current },
      ...(options.publicationWrites?.(artifact) ?? [])
    ]);
    return artifact;
  });
}
