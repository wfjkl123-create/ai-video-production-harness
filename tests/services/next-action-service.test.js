import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { determineNextActions } from '../../src/services/next-action-service.js';
import { writeJsonAtomic, readJson } from '../../src/storage/json-store.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';
import { createCreativeBrief } from '../../src/services/creative-brief-service.js';
import { persistVideoIntake } from '../../src/services/video-intake-service.js';
import { answerDirectorInterview } from '../../src/services/director-interview-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { creativeBrief } from '../helpers/creative-brief-fixture.js';
import { prepareGate5ReworkWorkOrder } from '../../src/services/gate5-rework-work-order-service.js';

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'next-action-'));
  await initializeProject(root, { projectId: 'NEXT-1', workflowVersion: 1 });
  return root;
}

async function addRejectedGate5Video(root, { includeFailure = true } = {}) {
  const videoPath = join(root, 'segment-001-rejected.mp4');
  await writeFile(videoPath, 'rejected Gate 5 video');
  const sha256 = await sha256File(videoPath);
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({
    id: 'video-segment-001-v1', type: 'video_segment', segmentId: 'segment-001', revision: 1,
    status: 'rejected', path: 'segment-001-rejected.mp4', sha256, rejectedByReviewId: 'quality-review-rejected-001'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await writeJsonAtomic(join(root, 'reviews', 'quality-review-rejected-001.json'), {
    id: 'quality-review-rejected-001', kind: 'quality_review', actor: 'human',
    artifactId: 'video-segment-001-v1', artifactSha256: sha256,
    rubricId: 'rubric-v1', rubricSha256: 'b'.repeat(64), rubricVersion: 1,
    scores: {}, triggeredVetoIds: [], failures: ['veto triggered: wrong-binding'],
    overall: 0, qualifies: false, decision: 'rejected', note: '商品绑定错误',
    correction: '回到资产绑定，只重做受影响镜头。', createdAt: '2026-08-25T01:00:00.000Z',
    ...(includeFailure ? { failureObservation: {
      category: 'asset_wrong_binding', rootCauseKey: 'asset-binding-001',
      responsibilityStage: 'assets', returnStage: 'assets', retryKind: 'none'
    } } : {})
  });
  return { sha256 };
}

async function ingressProject(routeDecision) {
  const root = await mkdtemp(join(tmpdir(), 'next-action-ingress-'));
  await initializeProject(root, {
    projectId: 'NEXT-INGRESS',
    ...(routeDecision ? { routeDecision } : {})
  });
  return root;
}

async function lockSegmentation(root, segments) {
  await writeJsonAtomic(join(root, 'segments', 'segmentation.json'), { segments: segments.map(segment => ({ ...segment, status: 'awaiting_review' })) });
  await registerArtifact(root, {
    id: 'segmentation-v1', type: 'segmentation', revision: 1, status: 'draft', path: 'segments/segmentation.json'
  });
  await submitForReview(root, 'segmentation-v1');
  await approveArtifact(root, 'segmentation-v1', 'approve test segmentation');
}

async function lockV2StoryAndRoute(root) {
  const creative = await createCreativeBrief(root, creativeBrief({ projectId: 'NEXT-V2-LOCKED', id: 'creative-v1' }));
  await submitForReview(root, creative.id);
  await approveArtifact(root, creative.id, 'Gate 1 approved');
  const stateAfterCreative = await readJson(join(root, 'project-state.json'));
  const lockedCreative = stateAfterCreative.artifacts.find(artifact => artifact.id === creative.id);
  await writeJsonAtomic(join(root, 'planning', 'story-v1.json'), {
    creativeBriefId: creative.id, creativeBriefSha256: lockedCreative.sha256
  });
  const storyPath = join(root, 'planning', 'story-v1.json');
  const storySha256 = await sha256File(storyPath);
  const stateAfterStory = await readJson(join(root, 'project-state.json'));
  const lockedStory = {
    id: 'story-v1', type: 'story_plan', revision: 1, status: 'locked', path: 'planning/story-v1.json',
    sha256: storySha256, lockedByReviewId: 'review-story-v1'
  };
  stateAfterStory.artifacts.push(lockedStory);
  await writeJsonAtomic(join(root, 'reviews', 'review-story-v1.json'), {
    id: 'review-story-v1', artifactId: lockedStory.id, artifactSha256: storySha256,
    actor: 'human', decision: 'approved', createdAt: '2026-08-08T00:00:00.000Z'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), stateAfterStory);
  await writeJsonAtomic(join(root, 'planning', 'capability-v1.json'), { kind: 'capability_manifest' });
  const state = await readJson(join(root, 'project-state.json'));
  const capabilityPath = join(root, 'planning', 'capability-v1.json');
  const capabilitySha256 = await sha256File(capabilityPath);
  state.artifacts.push({
    id: 'capability-v1', type: 'capability_manifest', revision: 1, status: 'locked', path: 'planning/capability-v1.json',
    sha256: capabilitySha256, lockedByReviewId: 'review-capability-v1', storyPlanId: lockedStory.id,
    storyPlanSha256: lockedStory.sha256, routePrecision: 'explicit_v2', storyPlanSchemaVersion: 2
  });
  await writeJsonAtomic(join(root, 'reviews', 'review-capability-v1.json'), {
    id: 'review-capability-v1', artifactId: 'capability-v1', artifactSha256: capabilitySha256,
    actor: 'system', autoLocked: true, decision: 'approved', createdAt: '2026-08-08T00:00:00.000Z'
  });
  state.verifiedCapabilityManifestId = 'capability-v1';
  state.directorRoutingVersion = 1;
  await writeJsonAtomic(join(root, 'project-state.json'), state);
}

test('an empty project always has a concrete intake action', async () => {
  const root = await project();
  let result = await determineNextActions(root);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.actions.map(({ id }) => id), ['register_required_inputs']);
});

test('an archived project has no active next action', async () => {
  const root = await project();
  const state = await readJson(join(root, 'project-state.json'));
  state.phase = 'archived';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  assert.deepEqual(await determineNextActions(root), { blocked: false, actions: [] });
});

test('a classified Gate 5 rejection resumes only from its minimum responsibility stage', async () => {
  const root = await project();
  await writeJsonAtomic(join(root, 'creative-v1.json'), { direction: 'locked upstream direction' });
  await registerArtifact(root, {
    id: 'creative-v1', type: 'creative_brief', revision: 1, status: 'draft', path: 'creative-v1.json'
  });
  await submitForReview(root, 'creative-v1');
  await approveArtifact(root, 'creative-v1', 'lock upstream creative');
  await addRejectedGate5Video(root);
  const before = await readJson(join(root, 'project-state.json'));
  let result = await determineNextActions(root);
  assert.equal(result.blocked, false);
  assert.equal(result.actions[0].id, 'prepare_gate5_rework_order');
  assert.equal(result.actions[0].returnStage, 'assets');
  assert.deepEqual(result.actions[0].failureReturn.routing.preserveStages, [
    'intake', 'source_analysis', 'creative', 'story', 'segmentation', 'storyboard'
  ]);
  await assert.rejects(prepareGate5ReworkWorkOrder(root, {
    failureReturnId: result.actions[0].failureReturnId
  }), /confirmation is required/);
  const prepared = await prepareGate5ReworkWorkOrder(root, {
    failureReturnId: result.actions[0].failureReturnId, confirm: true
  }, { now: '2026-08-25T02:00:00.000Z' });
  assert.equal(prepared.reused, false);
  assert.equal(prepared.workOrder.frozenEvidence.artifacts[0].id, 'creative-v1');
  assert.equal(prepared.workOrder.paidBoundary.automaticRetryAllowed, false);
  assert.equal(prepared.workOrder.paidBoundary.existingApprovalReusable, false);
  result = await determineNextActions(root);
  assert.equal(result.actions[0].id, 'execute_gate5_failure_return');
  assert.equal(result.actions[0].reworkAction, 'revise_asset_binding');
  assert.equal(result.actions[0].workOrder.id, prepared.workOrder.id);
  assert.equal(result.actions[0].failureReturn.routing.forbidWholeChainRestart, true);
  assert.equal((await prepareGate5ReworkWorkOrder(root, {
    failureReturnId: result.actions[0].failureReturn.id, confirm: true
  })).reused, true);
  assert.deepEqual(await readJson(join(root, 'project-state.json')), before);
});

test('frozen upstream evidence drift blocks an already prepared Gate 5 rework order', async () => {
  const root = await project();
  await writeJsonAtomic(join(root, 'creative-v1.json'), { direction: 'locked creative' });
  await registerArtifact(root, { id: 'creative-v1', type: 'creative_brief', revision: 1, status: 'draft', path: 'creative-v1.json' });
  await submitForReview(root, 'creative-v1');
  await approveArtifact(root, 'creative-v1', 'lock creative');
  await addRejectedGate5Video(root);
  const action = (await determineNextActions(root)).actions[0];
  await prepareGate5ReworkWorkOrder(root, { failureReturnId: action.failureReturnId, confirm: true });
  await writeJsonAtomic(join(root, 'creative-v1.json'), { direction: 'changed after freeze' });
  let result = await determineNextActions(root);
  assert.equal(result.blocked, true);
  assert.equal(result.actions[0].id, 'repair_project_evidence');
  assert.match(result.actions[0].reason, /work order is invalid/);
});

test('interrupted Gate 5 work-order persistence recovers idempotently without a second contract', async () => {
  const root = await project();
  await addRejectedGate5Video(root);
  const action = (await determineNextActions(root)).actions[0];
  await assert.rejects(prepareGate5ReworkWorkOrder(root, {
    failureReturnId: action.failureReturnId, confirm: true
  }, {
    transactionOptions: { afterWrite: async () => { throw new Error('simulated crash after work-order write'); } }
  }), /simulated crash/);
  const recovered = await prepareGate5ReworkWorkOrder(root, {
    failureReturnId: action.failureReturnId, confirm: true
  });
  assert.equal(recovered.reused, true);
  assert.equal((await determineNextActions(root)).actions[0].id, 'execute_gate5_failure_return');
});

test('tampered rejected video evidence blocks the failure return instead of routing rework', async () => {
  const root = await project();
  await addRejectedGate5Video(root);
  await writeFile(join(root, 'segment-001-rejected.mp4'), 'tampered after Gate 5');
  const result = await determineNextActions(root);
  assert.equal(result.blocked, true);
  assert.equal(result.actions[0].id, 'repair_project_evidence');
  assert.match(result.actions[0].reason, /Gate 5 rejection evidence is invalid/);
});

test('an unclassified legacy Gate 5 rejection blocks instead of inferring a return stage', async () => {
  const root = await project();
  await addRejectedGate5Video(root, { includeFailure: false });
  const result = await determineNextActions(root);
  assert.equal(result.blocked, true);
  assert.equal(result.actions[0].id, 'classify_gate5_rejection');
  assert.equal(result.actions[0].artifactId, 'video-segment-001-v1');
  assert.match(result.actions[0].reason, /do not infer or restart/);
});

test('a direct Gate 5 rework successor returns to formal review and binds its rejected predecessor', async () => {
  const root = await project();
  await addRejectedGate5Video(root);
  const replacementPath = join(root, 'segment-001-rework.mp4');
  await writeFile(replacementPath, 'replacement Gate 5 video');
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({
    id: 'video-segment-001-v2', type: 'video_segment', segmentId: 'segment-001', revision: 2,
    status: 'rework', path: 'segment-001-rework.mp4', sha256: await sha256File(replacementPath),
    supersedesArtifactId: 'video-segment-001-v1'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.actions, [{
    id: 'submit_gate5_video_review', artifactId: 'video-segment-001-v2', segmentId: 'segment-001',
    resolvesReviewId: 'quality-review-rejected-001',
    reason: 'a direct replacement exists; submit its exact revision back to Gate 5 and bind the predecessor rejection'
  }]);
});

test('an ingress-enabled workflow v2 project captures its route before Gate 1', async () => {
  const root = await ingressProject();
  const result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{
    id: 'capture_intake_route',
    reason: 'workflow v2 ingress policy requires a deterministic route decision before Gate 1'
  }]);
});

test('an unresolved attached-video role is resolved before registration or Gate 1', async () => {
  const root = await ingressProject({
    policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input',
    inputTypes: ['video'], sourceVideoIds: ['source-video-001'],
    referenceRoleStatus: 'awaiting_reference_role'
  });
  const result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{
    id: 'resolve_reference_role',
    sourceVideoIds: ['source-video-001'],
    reason: 'attached video purpose must be resolved as source authority or inspiration before Gate 1'
  }]);
});

test('resolved source videos are registered before the mandatory director interview and Gate 1', async () => {
  const routeDecision = {
    policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input',
    inputTypes: ['video'], sourceVideoIds: ['source-video-001', 'source-video-002'],
    referenceRoleStatus: 'inspiration'
  };
  const root = await ingressProject(routeDecision);
  let result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{
    id: 'register_reference_videos',
    sourceVideoIds: ['source-video-001', 'source-video-002'],
    reason: 'all routed source video descriptors must be registered as project reference inputs before Gate 1'
  }]);

  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({
    id: 'source-video-001', type: 'reference_video', revision: 1, status: 'draft', path: 'brief/source-001.mp4'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  result = await determineNextActions(root);
  assert.deepEqual(result.actions[0].sourceVideoIds, ['source-video-002']);

  state.artifacts.push({
    id: 'source-video-002', type: 'reference_video', revision: 1, status: 'draft', path: 'brief/source-002.mp4'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  result = await determineNextActions(root);
  assert.deepEqual(result.actions.map(({ id }) => id), ['prepare_director_interview']);
});

test('mechanical asset-and-prompt work bypasses the director, story, and review chain', async () => {
  const root = await ingressProject({
    policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input_and_creation_intent',
    inputTypes: ['video', 'image'], sourceVideoIds: ['source-video-001'], assetInputIds: ['product-001'],
    referenceRoleStatus: 'authority', executionClass: 'mechanical_asset_prompt'
  });
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push(
    { id: 'source-video-001', type: 'reference_video', revision: 1, status: 'locked', path: 'brief/source.mp4', sha256: 'b'.repeat(64), lockedByReviewId: 'system-source-lock' },
    { id: 'product-001', type: 'project_asset', assetType: 'product_reference', revision: 1, status: 'locked', path: 'assets/project/product.png', sha256: 'a'.repeat(64), lockedByReviewId: 'system-product-lock' }
  );
  await writeJsonAtomic(join(root, 'project-state.json'), state);

  let result = await determineNextActions(root);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.actions.map(({ id }) => id), ['prepare_mechanical_asset_prompt_package']);
  assert.equal(result.actions[0].assistantMaySubmitPaidGeneration, false);
  assert.deepEqual(result.actions[0].skippedStages, [
    'director_interview', 'creative_brief', 'story_plan', 'shotlist', 'semantic_review'
  ]);

  state.artifacts.push({
    id: 'mechanical-package-001', type: 'execution_package', executionClass: 'mechanical_asset_prompt',
    revision: 1, status: 'locked', path: 'mechanical/package.json', sha256: 'c'.repeat(64),
    lockedByReviewId: 'system-package-lock', sourceVideoId: 'source-video-001', sourceVideoSha256: 'b'.repeat(64),
    productAssetId: 'product-001', productAssetSha256: 'a'.repeat(64), segmentCount: 13
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  result = await determineNextActions(root);
  assert.deepEqual(result.actions.map(({ id }) => id), ['prepare_mechanical_libtv_canvas']);
  assert.equal(result.actions[0].assistantMaySubmitPaidGeneration, false);

  state.mechanicalCanvas = {
    status: 'READY_FOR_USER_CANVAS_GENERATION', executionClass: 'mechanical_asset_prompt',
    packageArtifactId: 'mechanical-package-001', packageSha256: 'c'.repeat(64),
    projectUuid: 'd'.repeat(32), nodes: Array.from({ length: 13 }, (_, index) => ({ segmentId: `segment-${index + 1}` })),
    requiresUserCanvasGeneration: true, paidGenerationTriggered: false,
    assistantMaySubmitPaidGeneration: false, preparedAt: new Date().toISOString()
  };
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  result = await determineNextActions(root);
  assert.deepEqual(result.actions.map(({ id }) => id), ['mechanical_canvas_ready']);
  assert.equal(result.actions[0].requiresUserCanvasGeneration, true);
});

test('a bypass route does not force reference registration even when it records video inputs', async () => {
  const root = await ingressProject({
    policyVersion: 'ingress-route-v1', harnessRequired: false, reason: 'informational_intent',
    inputTypes: ['video'], sourceVideoIds: ['source-video-001'], referenceRoleStatus: 'not_applicable'
  });
  const result = await determineNextActions(root);
  assert.deepEqual(result.actions.map(({ id }) => id), ['prepare_creative_brief']);
});

test('workflow v2 routes Gate 1 before Gate 2 and never asks for legacy script inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-action-v2-'));
  await initializeProject(root, { projectId: 'NEXT-V2', workflowVersion: 2 });
  assert.deepEqual((await determineNextActions(root)).actions.map(({ id }) => id), ['prepare_creative_brief']);
  const creative = await createCreativeBrief(root, creativeBrief({ projectId: 'NEXT-V2', id: 'creative-v1' }));
  await submitForReview(root, creative.id);
  await approveArtifact(root, creative.id, 'Gate 1 approved');
  const next = await determineNextActions(root);
  assert.deepEqual(next.actions.map(({ id }) => id), ['prepare_story_plan']);
  assert.equal(next.actions[0].creativeBriefId, creative.id);
});

test('workflow v2 uses its locked story plan and verified route instead of asking for legacy script and shotlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-action-v2-story-'));
  await initializeProject(root, { projectId: 'NEXT-V2-LOCKED', workflowVersion: 2 });
  await lockV2StoryAndRoute(root);
  const result = await determineNextActions(root);
  assert.deepEqual(result, {
    blocked: false,
    actions: [{ id: 'propose_segmentation', reason: 'locked story plan and verified director capability manifest are ready' }]
  });
});

test('a newer locked creative brief routes normal downstream rework instead of evidence repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-action-v2-creative-revision-'));
  await initializeProject(root, { projectId: 'NEXT-V2-LOCKED', workflowVersion: 2 });
  await lockV2StoryAndRoute(root);
  const revised = await createCreativeBrief(root, creativeBrief({ projectId: 'NEXT-V2-LOCKED', id: 'creative-v2' }));
  await submitForReview(root, revised.id);
  await approveArtifact(root, revised.id, 'Gate 1 revised direction approved');
  const result = await determineNextActions(root);
  assert.equal(result.blocked, false);
  assert.equal(result.actions[0].id, 'prepare_story_plan');
  assert.equal(result.actions[0].creativeBriefId, revised.id);
  assert.equal(result.actions[0].staleStoryPlanId, 'story-v1');
  assert.ok(result.actions[0].affectedArtifactIds.includes('story-v1'));
  assert.ok(result.actions[0].affectedArtifactIds.includes('capability-v1'));
});

test('a Gate 2 draft bound to an older Gate 1 cannot enter human review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-action-v2-stale-draft-'));
  await initializeProject(root, { projectId: 'NEXT-DRAFT', workflowVersion: 2 });
  const first = await createCreativeBrief(root, creativeBrief({ projectId: 'NEXT-DRAFT', id: 'creative-v1' }));
  await submitForReview(root, first.id);
  await approveArtifact(root, first.id, 'first direction approved');
  let state = await readJson(join(root, 'project-state.json'));
  const lockedFirst = state.artifacts.find(item => item.id === first.id);
  await writeJsonAtomic(join(root, 'planning', 'story-draft.json'), {
    creativeBriefId: first.id, creativeBriefSha256: lockedFirst.sha256
  });
  state.artifacts.push({
    id: 'story-draft-v1', type: 'story_plan', revision: 1, status: 'draft', path: 'planning/story-draft.json',
    sha256: await sha256File(join(root, 'planning', 'story-draft.json'))
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const second = await createCreativeBrief(root, creativeBrief({ projectId: 'NEXT-DRAFT', id: 'creative-v2' }));
  await submitForReview(root, second.id);
  await approveArtifact(root, second.id, 'revised direction approved');
  const result = await determineNextActions(root);
  assert.equal(result.blocked, false);
  assert.equal(result.actions[0].id, 'prepare_story_plan');
  assert.equal(result.actions[0].creativeBriefId, second.id);
  assert.equal(result.actions[0].staleStoryPlanId, 'story-draft-v1');
  assert.deepEqual(result.actions[0].affectedArtifactIds, ['story-draft-v1']);
});

test('workflow v2 with a locked story plan but a missing verified route stops for evidence repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-action-v2-route-drift-'));
  await initializeProject(root, { projectId: 'NEXT-V2-LOCKED', workflowVersion: 2 });
  await lockV2StoryAndRoute(root);
  const state = await readJson(join(root, 'project-state.json'));
  state.verifiedCapabilityManifestId = 'missing-capability';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.actions.map(action => action.id), ['repair_project_evidence']);
  assert.equal(result.actions.some(action => action.id === 'register_required_inputs'), false);
});

test('a source-authority route requires adaptive source facts after Gate 1 and before Gate 2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-action-source-facts-'));
  await initializeProject(root, { projectId: 'NEXT-SOURCE' });
  const sourcePath = join(root, 'uploaded.mp4');
  await writeFile(sourcePath, 'source authority video');
  const intake = await persistVideoIntake(root, {
    requestText: '照着原视频一比一复刻剧情',
    explicitReferenceIntent: 'faithful_remake',
    inputs: [{ id: 'source-001', mimeType: 'video/mp4', path: sourcePath }]
  });
  await answerDirectorInterview(root, {
    routeDecision: intake.routeDecision,
    answers: Object.fromEntries(intake.directorInterview.questions.map(question => [
      question.id,
      `${question.id} 的用户确认：原片是事实权威，保留镜头、动作和构图，验收以可观察画面证据为准。`
    ]))
  });
  const sourceBrief = creativeBrief({ projectId: 'NEXT-SOURCE', id: 'creative-source-v1' });
  sourceBrief.creativeDecision = {
    ...sourceBrief.creativeDecision,
    referenceWorkflow: intake.referenceWorkflow
  };
  const creative = await createCreativeBrief(root, sourceBrief);
  await submitForReview(root, creative.id);
  await approveArtifact(root, creative.id, 'Gate 1 source route approved');

  const next = await determineNextActions(root);
  assert.deepEqual(next.actions.map(action => action.id), ['prepare_source_fact_analysis']);
  assert.deepEqual(next.actions[0].sourceVideoIds, ['source-001']);

  await writeFile(join(root, 'planning', 'source-facts.json'), '{}\n');
  const state = await readJson(join(root, 'project-state.json'));
  const lockedCreative = state.artifacts.find(item => item.id === creative.id);
  await writeFile(join(root, 'planning', 'story-draft.json'), `${JSON.stringify({
    creativeBriefId: creative.id, creativeBriefSha256: lockedCreative.sha256
  })}\n`);
  state.artifacts.push(
    {
      id: 'source-facts-v1', type: 'source_fact_analysis', revision: 1, status: 'locked',
      path: 'planning/source-facts.json', sha256: await sha256File(join(root, 'planning', 'source-facts.json')),
      lockedByReviewId: 'review-source-facts', sourceVideoId: 'source-001'
    },
    {
      id: 'story-source-draft', type: 'story_plan', revision: 1, status: 'draft',
      path: 'planning/story-draft.json', sha256: await sha256File(join(root, 'planning', 'story-draft.json'))
    }
  );
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const comparatorNext = await determineNextActions(root);
  assert.deepEqual(comparatorNext.actions.map(action => action.id), ['run_source_comparator_audit']);
  assert.equal(comparatorNext.actions[0].storyPlanId, 'story-source-draft');
});

test('pending human gates take precedence over downstream generation', async () => {
  const root = await project();
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({ id: 'script-v1', type: 'script', revision: 1, status: 'awaiting_review', path: 'brief/script.md', sha256: 'a'.repeat(64) });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{ id: 'human_review', artifactIds: ['script-v1'], reason: 'artifacts are awaiting human review' }]);
});

test('a stale pending singleton no longer blocks when a newer locked revision is current', async () => {
  const root = await project();
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push(
    { id: 'story-v1', type: 'story_plan', revision: 1, status: 'awaiting_review', path: 'planning/story-v1.json' },
    { id: 'story-v2', type: 'story_plan', revision: 2, status: 'locked', lockedByReviewId: 'review-v2', path: 'planning/story-v2.json' }
  );
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.equal(result.actions.some(action => action.id === 'human_review'), false);
});

test('ambiguous current singleton revisions block with an evidence repair action', async () => {
  const root = await project();
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push(
    { id: 'story-v1-a', type: 'story_plan', revision: 1, status: 'awaiting_review', path: 'planning/story-v1-a.json' },
    { id: 'story-v1-b', type: 'story_plan', revision: 1, status: 'awaiting_review', path: 'planning/story-v1-b.json' }
  );
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.actions.map(action => action.id), ['repair_project_evidence']);
});

test('an unresolved submission blocks every action except reconciliation', async () => {
  const root = await project();
  await writeJsonAtomic(join(root, 'runs', 'uncertain.json'), {
    id: 'run-uncertain', kind: 'runninghub_video', segmentId: 'segment-001',
    status: 'SUBMITTING', taskId: null, submissionUncertain: true
  });
  const result = await determineNextActions(root);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.actions, [{ id: 'reconcile_video_submit', runIds: ['run-uncertain'], reason: 'submission outcome is unknown' }]);
});

test('a later segment without observed handoff cannot suggest asset or video generation', async () => {
  const root = await project();
  const segments = [
    { id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg', previousSegmentId: null, nextSegmentId: 'segment-002' },
    { id: 'segment-002', status: 'locked', lockedByReviewId: 'review-seg', previousSegmentId: 'segment-001', nextSegmentId: null }
  ];
  await lockSegmentation(root, segments);
  const state = await readJson(join(root, 'project-state.json'));
  state.activeSegmentId = 'segment-002';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.deepEqual(result.actions.map(({ id }) => id), ['complete_observed_handoff']);
  assert.equal(result.actions.some(({ id }) => /generate/.test(id)), false);
});

test('an editorial-cut segment proceeds without fabricating an observed handoff', async () => {
  const root = await project();
  const segments = [
    { id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg', previousSegmentId: null, nextSegmentId: 'segment-002', continuityStrategy: 'canonical_open' },
    { id: 'segment-002', status: 'locked', lockedByReviewId: 'review-seg', previousSegmentId: 'segment-001', nextSegmentId: null, continuityStrategy: 'editorial_cut' }
  ];
  await lockSegmentation(root, segments);
  const state = await readJson(join(root, 'project-state.json'));
  state.activeSegmentId = 'segment-002';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.equal(result.actions.some(({ id }) => id === 'complete_observed_handoff'), false);
  assert.ok(result.actions.some(({ id }) => id === 'create_quality_rubric'));
});

test('tampered locked segmentation returns an evidence repair action instead of trusting it', async () => {
  const root = await project();
  await lockSegmentation(root, [{
    id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg', previousSegmentId: null, nextSegmentId: null
  }]);
  const state = await readJson(join(root, 'project-state.json'));
  const artifact = state.artifacts.find(({ id }) => id === 'segmentation-v1');
  await writeFile(join(root, artifact.path), '{"segments":[]}\n');
  const result = await determineNextActions(root);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.actions.map(({ id }) => id), ['repair_project_evidence']);
});

test('does not suggest a segment contract until the rubric and project assets are locked', async () => {
  const root = await project();
  await lockSegmentation(root, [{
    id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg',
    projectAssetIds: ['character-1', 'product-1'], previousSegmentId: null, nextSegmentId: null
  }]);
  const result = await determineNextActions(root);
  assert.deepEqual(result.actions.map(({ id }) => id), ['create_quality_rubric', 'prepare_project_assets']);
  assert.equal(result.actions.some(({ id }) => id === 'create_segment_contract'), false);
});

test('a locked video older than the latest locked contract is stale and the segment returns to asset preparation', async () => {
  const root = await project();
  await lockSegmentation(root, [{
    id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg',
    projectAssetIds: [], previousSegmentId: null, nextSegmentId: null
  }]);
  await writeFile(join(root, 'rubric.md'), 'rubric');
  await registerArtifact(root, { id: 'rubric-v1', type: 'quality_rubric', revision: 1, status: 'draft', path: 'rubric.md' });
  await submitForReview(root, 'rubric-v1');
  await approveArtifact(root, 'rubric-v1', 'approve rubric');
  await writeFile(join(root, 'old-video.mp4'), 'old video');
  await registerArtifact(root, {
    id: 'video-v1', type: 'video_segment', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'old-video.mp4'
  });
  await submitForReview(root, 'video-v1');
  await approveArtifact(root, 'video-v1', 'approve old video');
  await new Promise(resolve => setTimeout(resolve, 2));
  const stateWithSegmentation = await readJson(join(root, 'project-state.json'));
  const currentSegmentation = stateWithSegmentation.artifacts.find(({ id }) => id === 'segmentation-v1');
  await writeFile(join(root, 'contract-v2.json'), `${JSON.stringify({
    segmentation: {
      id: currentSegmentation.id,
      revision: currentSegmentation.revision,
      sha256: currentSegmentation.sha256
    }
  })}\n`);
  await registerArtifact(root, {
    id: 'contract-v2', type: 'segment_contract', segmentId: 'segment-001', revision: 2,
    status: 'draft', path: 'contract-v2.json'
  });
  await submitForReview(root, 'contract-v2');
  await approveArtifact(root, 'contract-v2', 'approve revised contract');

  const result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{
    id: 'prepare_segment_assets', segmentId: 'segment-001', reason: 'segment contract and continuity gates are ready'
  }]);
});

test('a locked asset manifest advances directly to generation preparation', async () => {
  const root = await project();
  await lockSegmentation(root, [{
    id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg',
    projectAssetIds: [], previousSegmentId: null, nextSegmentId: null
  }]);
  await writeFile(join(root, 'rubric.md'), 'rubric');
  await registerArtifact(root, { id: 'rubric-v1', type: 'quality_rubric', revision: 1, status: 'draft', path: 'rubric.md' });
  await submitForReview(root, 'rubric-v1');
  await approveArtifact(root, 'rubric-v1', 'approve rubric');
  const state = await readJson(join(root, 'project-state.json'));
  const segmentation = state.artifacts.find(({ id }) => id === 'segmentation-v1');
  await writeJsonAtomic(join(root, 'contract-v1.json'), {
    segmentation: { id: segmentation.id, revision: segmentation.revision, sha256: segmentation.sha256 }
  });
  await registerArtifact(root, {
    id: 'contract-v1', type: 'segment_contract', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'contract-v1.json'
  });
  await submitForReview(root, 'contract-v1');
  await approveArtifact(root, 'contract-v1', 'approve contract');
  await writeJsonAtomic(join(root, 'assets', 'segment-001-asset-manifest.json'), {
    id: 'segment-001-asset-manifest', segmentId: 'segment-001', status: 'locked',
    lockedByReviewId: 'review-assets',
    sourceArtifactIds: { segmentation: segmentation.id },
    items: []
  });

  const result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{
    id: 'prepare_generation_package', segmentId: 'segment-001',
    reason: 'the required assets are locked and the generation package can now be prepared'
  }]);
});

test('a locked asset manifest from an older segmentation cannot skip current asset preparation', async () => {
  const root = await project();
  await lockSegmentation(root, [{
    id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg',
    projectAssetIds: [], previousSegmentId: null, nextSegmentId: null
  }]);
  await writeFile(join(root, 'rubric.md'), 'rubric');
  await registerArtifact(root, { id: 'rubric-v1', type: 'quality_rubric', revision: 1, status: 'draft', path: 'rubric.md' });
  await submitForReview(root, 'rubric-v1');
  await approveArtifact(root, 'rubric-v1', 'approve rubric');
  const state = await readJson(join(root, 'project-state.json'));
  const segmentation = state.artifacts.find(({ id }) => id === 'segmentation-v1');
  await writeJsonAtomic(join(root, 'contract-v1.json'), {
    segmentation: { id: segmentation.id, revision: segmentation.revision, sha256: segmentation.sha256 }
  });
  await registerArtifact(root, {
    id: 'contract-v1', type: 'segment_contract', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'contract-v1.json'
  });
  await submitForReview(root, 'contract-v1');
  await approveArtifact(root, 'contract-v1', 'approve contract');
  await writeJsonAtomic(join(root, 'assets', 'segment-001-asset-manifest.json'), {
    id: 'segment-001-asset-manifest', segmentId: 'segment-001', status: 'locked',
    lockedByReviewId: 'review-old-assets', sourceArtifactIds: { segmentation: 'segmentation-r0' },
    items: [{ id: 'old-depth', scope: 'segment', segmentationId: 'segmentation-r0', segmentationSha256: 'stale' }]
  });

  const result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{
    id: 'prepare_segment_assets', segmentId: 'segment-001', reason: 'segment contract and continuity gates are ready'
  }]);
});

test('a locked contract from an older segmentation cannot authorize the reused segment id', async () => {
  const root = await project();
  const segment = {
    id: 'segment-001', status: 'locked', lockedByReviewId: 'review-seg',
    projectAssetIds: [], previousSegmentId: null, nextSegmentId: null
  };
  await lockSegmentation(root, [segment]);
  await writeFile(join(root, 'rubric.md'), 'rubric');
  await registerArtifact(root, { id: 'rubric-v1', type: 'quality_rubric', revision: 1, status: 'draft', path: 'rubric.md' });
  await submitForReview(root, 'rubric-v1');
  await approveArtifact(root, 'rubric-v1', 'approve rubric');

  const firstState = await readJson(join(root, 'project-state.json'));
  const firstSegmentation = firstState.artifacts.find(({ id }) => id === 'segmentation-v1');
  await writeFile(join(root, 'contract-v1.json'), `${JSON.stringify({
    segmentation: { id: firstSegmentation.id, revision: firstSegmentation.revision, sha256: firstSegmentation.sha256 }
  })}\n`);
  await registerArtifact(root, {
    id: 'contract-v1', type: 'segment_contract', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'contract-v1.json'
  });
  await submitForReview(root, 'contract-v1');
  await approveArtifact(root, 'contract-v1', 'approve first contract');

  await writeJsonAtomic(join(root, 'segments', 'segmentation-v2.json'), {
    segments: [{ ...segment, status: 'awaiting_review', narrativeTask: 'new route' }]
  });
  await registerArtifact(root, {
    id: 'segmentation-v2', type: 'segmentation', revision: 2, status: 'draft', path: 'segments/segmentation-v2.json',
    supersedesArtifactId: 'segmentation-v1'
  });
  await submitForReview(root, 'segmentation-v2');
  await approveArtifact(root, 'segmentation-v2', 'approve revised segmentation');

  const result = await determineNextActions(root);
  assert.deepEqual(result.actions, [{
    id: 'create_segment_contract', segmentId: 'segment-001',
    reason: 'the segment needs a production contract bound to the current locked segmentation'
  }]);
});

test('fallback state still returns an inspectable next action', async () => {
  const root = await project();
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push(
    { id: 'script-v1', type: 'script', revision: 1, status: 'locked', lockedByReviewId: 'r1', path: 'brief/script.md', sha256: 'a'.repeat(64) },
    { id: 'shot-v1', type: 'shotlist', revision: 1, status: 'locked', lockedByReviewId: 'r2', path: 'brief/shot.md', sha256: 'b'.repeat(64) }
  );
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const result = await determineNextActions(root);
  assert.deepEqual(result.actions.map(({ id }) => id), ['propose_segmentation']);
});
