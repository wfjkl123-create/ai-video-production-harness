import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject } from '../../src/services/project-service.js';
import { createCreativeBrief } from '../../src/services/creative-brief-service.js';
import { readJson } from '../../src/storage/json-store.js';
import { creativeBrief } from '../helpers/creative-brief-fixture.js';
import { persistVideoIntake } from '../../src/services/video-intake-service.js';
import { answerDirectorInterview, prepareDirectorInterview } from '../../src/services/director-interview-service.js';

function brief(referenceWorkflow) {
  const value = creativeBrief({ projectId: 'REFERENCE-ROUTE-1' });
  value.creativeDecision = {
    ...value.creativeDecision,
    executionMode: 'sequential', assetExecutionMode: 'sequential', videoExecutionMode: 'sequential',
    parallelPlan: ['当前单段任务不并行'], estimatedAssetCombination: ['source_video'], referenceWorkflow
  };
  value.lockedConstraints = ['原视频事实必须先锁定再进入故事与镜头阶段'];
  return value;
}

test('Gate 1 persists the normalized conditional reference route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-reference-route-'));
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2 });
  const artifact = await createCreativeBrief(root, brief({
    referenceIntent: 'source_modification', sourceVideoIds: ['source-video-001']
  }));
  const stored = await readJson(join(root, artifact.path));
  assert.equal(stored.creativeDecision.referenceWorkflow.workflowRoute, 'source_fact');
  assert.equal(stored.creativeDecision.referenceWorkflow.sourceRole, 'authority');
  assert.equal(stored.creativeDecision.referenceWorkflow.requiresSourceFactWorkflow, true);
});

test('Gate 1 rejects a contradictory route instead of trusting authored derived fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-reference-conflict-'));
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2 });
  await assert.rejects(
    createCreativeBrief(root, brief({
      referenceIntent: 'source_modification',
      sourceVideoIds: ['source-video-001'],
      workflowRoute: 'standard_creation'
    })),
    /conflicts/
  );
});

test('Gate 1 reference authority must match the deterministic intake route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-ingress-route-conflict-'));
  await initializeProject(root, {
    projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2,
    routeDecision: {
      policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input',
      inputTypes: ['video'], sourceVideoIds: ['source-video-001'], referenceRoleStatus: 'inspiration'
    }
  });
  const routeDecision = (await readJson(join(root, 'project-state.json'))).routeDecision;
  const interview = await prepareDirectorInterview(root, {
    projectId: 'REFERENCE-ROUTE-1', requestText: '参考原片氛围做新视频', routeDecision
  });
  await answerDirectorInterview(root, {
    routeDecision,
    answers: Object.fromEntries(interview.questions.map(item => [item.id, `${item.id}: 确认只做灵感参考并保留可观察验收约束`]))
  });
  await assert.rejects(
    createCreativeBrief(root, brief({ referenceIntent: 'faithful_remake', sourceVideoIds: ['source-video-001'] })),
    /conflicts with intake route/
  );
});

test('a directly injected Harness route still cannot bypass the Gate 0 interview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-injected-route-gate0-'));
  await initializeProject(root, {
    projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2,
    routeDecision: {
      policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input',
      inputTypes: ['video'], sourceVideoIds: ['source-video-001'], referenceRoleStatus: 'inspiration'
    }
  });
  await assert.rejects(
    createCreativeBrief(root, brief({ referenceIntent: 'inspiration_only', sourceVideoIds: ['source-video-001'] })),
    /completed Gate 0 director interview/
  );
});

test('default ingress projects cannot bypass route capture by calling Gate 1 directly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-missing-ingress-route-'));
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1' });
  await assert.rejects(
    createCreativeBrief(root, brief({ referenceIntent: 'idea_only', sourceVideoIds: [] })),
    /routeDecision is captured/
  );
});

test('new schemaVersion 3 briefs cannot omit the reference routing decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-reference-required-'));
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2 });
  const input = brief({ referenceIntent: 'idea_only', sourceVideoIds: [] });
  delete input.creativeDecision.referenceWorkflow;
  await assert.rejects(createCreativeBrief(root, input), /requires creativeDecision.referenceWorkflow/);
});

test('new publication rejects legacy v1/v2 without rewriting historical evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-reference-legacy-write-'));
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2 });
  const input = brief({ referenceIntent: 'idea_only', sourceVideoIds: [] });
  input.schemaVersion = 2;
  delete input.creativeDecision.directorCreativeContract;
  await assert.rejects(createCreativeBrief(root, input), error => error.code === 'CREATIVE_BRIEF_V3_REQUIRED');
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.some(item => item.type === 'creative_brief'), false);
});

test('a creative revision records supersession and SHA-bound downstream impact before Gate 1 review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-revision-impact-'));
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2 });
  const first = await createCreativeBrief(root, brief({ referenceIntent: 'idea_only', sourceVideoIds: [] }));
  const secondInput = brief({ referenceIntent: 'idea_only', sourceVideoIds: [] });
  secondInput.id = 'creative-brief-v2';
  secondInput.creativeDecision.directorCreativeContract.recommendedDirection.openingDesign.firstFrame = '对方直接把产品推到镜头前';
  const second = await createCreativeBrief(root, secondInput);
  assert.equal(second.supersedesArtifactId, first.id);
  const stored = await readJson(join(root, second.path));
  assert.equal(stored.creativeDecision.revisionImpact.previousCreativeBriefId, first.id);
  assert.ok(stored.creativeDecision.revisionImpact.changedDecisionPaths.includes('creativeDecision.directorCreativeContract'));
  assert.equal(stored.creativeDecision.revisionImpact.impactPolicy, 'conservative_v1');
});

test('the first Gate 1 brief after a scope revision records invalidated work and binds the current direction', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'creative-scope-revision-binding-'));
  const root = join(parent, 'project');
  const sourcePath = join(parent, 'source-video-001.mp4');
  await writeFile(sourcePath, 'source-video');
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2 });
  const initial = await persistVideoIntake(root, {
    requestText: '只参考原片氛围', requestKind: 'video_creation', explicitReferenceIntent: 'inspiration_only',
    inputs: [{ id: 'source-video-001', mimeType: 'video/mp4', path: sourcePath }]
  });
  await answerDirectorInterview(root, {
    routeDecision: initial.routeDecision,
    answers: Object.fromEntries(initial.directorInterview.questions.map(item => [item.id, `${item.id}: 已确认。`]))
  });
  let state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({ id: 'old-mechanical-package', type: 'seedance_prompt', revision: 1, status: 'draft', path: 'old.json', sha256: 'a'.repeat(64) });
  const { writeJsonAtomic } = await import('../../src/storage/json-store.js');
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const revised = await persistVideoIntake(root, {
    requestText: '保留原片动作构图，只替换人物控制方式和产品', requestKind: 'video_creation',
    explicitReferenceIntent: 'source_modification', confirmScopeRevision: true,
    scopeRevisionReason: '控制方式变更',
    inputs: [{ id: 'source-video-001', mimeType: 'video/mp4', path: sourcePath }]
  });
  await answerDirectorInterview(root, {
    routeDecision: revised.routeDecision,
    answers: Object.fromEntries(revised.directorInterview.questions.map(item => [item.id, `${item.id}: 已确认。`]))
  });
  const artifact = await createCreativeBrief(root, brief({ referenceIntent: 'source_modification', sourceVideoIds: ['source-video-001'] }));
  const stored = await readJson(join(root, artifact.path));
  assert.ok(stored.creativeDecision.revisionImpact.affectedArtifactIds.includes('old-mechanical-package'));
  assert.equal(stored.directionRevisionBinding.id, 'direction-revision-2');
  assert.equal(stored.directionRevisionBinding.revision, 2);
});

test('a strict video project cannot publish Gate 1 until its route-bound Socratic interview is complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-requires-gate0-interview-'));
  await initializeProject(root, { projectId: 'REFERENCE-ROUTE-1', workflowVersion: 2 });
  const intake = await persistVideoIntake(root, {
    requestText: '创作一条 AI 产品视频', requestKind: 'video_creation', explicitReferenceIntent: 'idea_only', inputs: []
  });
  await assert.rejects(
    createCreativeBrief(root, brief({ referenceIntent: 'idea_only', sourceVideoIds: [] })),
    /completed Gate 0 director interview/
  );
  const answers = Object.fromEntries(intake.directorInterview.questions.map(item => [item.id, `${item.id} 的用户确认答案，含明确方向、优先级和可观察验收标准。`]));
  await answerDirectorInterview(root, { answers, routeDecision: intake.routeDecision });
  const artifact = await createCreativeBrief(root, brief({ referenceIntent: 'idea_only', sourceVideoIds: [] }));
  assert.equal(artifact.type, 'creative_brief');
});
