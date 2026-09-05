import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { intakeVideoRequest, persistVideoIntake } from '../../src/services/video-intake-service.js';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { resolveCurrentArtifacts } from '../../src/domain/current-artifact.js';
import { answerDirectorInterview } from '../../src/services/director-interview-service.js';
import { readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';
import { readExecutionTrace } from '../../src/services/execution-trace-service.js';

const video = (id = 'video-001') => ({ id, mimeType: 'video/mp4', path: `inputs/${id}.mp4` });

test('uploaded video plus AI video request enters Harness and preserves unresolved role', () => {
  const result = intakeVideoRequest({
    requestText: '用上传的视频做一条 AI 视频广告',
    inputs: [video()]
  });

  assert.equal(result.routeDecision.harnessRequired, true);
  assert.equal(result.routeDecision.reason, 'video_input_and_creation_intent');
  assert.equal(result.routeDecision.referenceRoleStatus, 'awaiting_reference_role');
  assert.equal(result.referenceWorkflow.status, 'awaiting_reference_role');
});

test('uploaded video plus explanation request bypasses Harness', () => {
  const result = intakeVideoRequest({
    requestText: '只解释这个视频的内容，不要生成视频',
    inputs: [video()]
  });

  assert.equal(result.routeDecision.harnessRequired, false);
  assert.equal(result.routeDecision.reason, 'informational_intent');
  assert.equal(result.referenceWorkflow, null);
});

test('source authority and inspiration stay distinct from Harness entry', () => {
  const authority = intakeVideoRequest({
    requestText: '照着原视频一比一复刻剧情',
    inputs: [video()]
  });
  assert.equal(authority.routeDecision.referenceRoleStatus, 'authority');
  assert.equal(authority.referenceWorkflow.sourceRole, 'authority');

  const inspiration = intakeVideoRequest({
    requestText: '这个视频只参考风格，不需要复刻',
    inputs: [video()]
  });
  assert.equal(inspiration.routeDecision.referenceRoleStatus, 'inspiration');
  assert.equal(inspiration.referenceWorkflow.sourceRole, 'inspiration');
});

test('non-video research and ordinary questions bypass', () => {
  for (const input of [
    { requestText: '研究一下 AI 视频行业现状', requestKind: 'research' },
    { requestText: '什么是景别？', requestKind: 'question_answering' }
  ]) {
    const result = intakeVideoRequest(input);
    assert.equal(result.routeDecision.harnessRequired, false);
    assert.equal(result.routeDecision.reason, 'informational_intent');
  }
});

test('an explicit reference intent must agree with available video inputs', () => {
  assert.throws(
    () => intakeVideoRequest({ requestText: '一比一复刻', explicitReferenceIntent: 'faithful_remake' }),
    /requires at least one sourceVideoId/
  );
});

test('persistent intake stores the route and auto-locks an immutable reference copy', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'video-intake-persist-'));
  const root = join(parent, 'project');
  const source = join(parent, 'uploaded.mp4');
  await writeFile(source, 'reference-video-bytes');
  await initializeProject(root, { projectId: 'INTAKE-001', workflowVersion: 2 });

  const input = {
    requestText: '用上传的视频做一条 AI 视频广告',
    inputs: [{ id: 'video-001', mimeType: 'video/mp4', path: source }]
  };
  const first = await persistVideoIntake(root, input);
  assert.equal(first.persisted, true);
  assert.equal(first.importedReferenceVideos.length, 1);
  assert.equal(first.importedReferenceVideos[0].status, 'locked');
  assert.match(first.importedReferenceVideos[0].path, /^brief\/reference\/video-001-/);
  assert.equal(await readFile(join(root, first.importedReferenceVideos[0].path), 'utf8'), 'reference-video-bytes');

  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.ingressPolicyVersion, 'ingress-route-v1');
  assert.equal(state.routeDecision.harnessRequired, true);
  assert.equal(state.routeDecision.referenceRoleStatus, 'awaiting_reference_role');
  assert.equal(state.artifacts.filter(item => item.type === 'reference_video').length, 1);
  const traceNames = (await readdir(join(root, 'traces'))).filter(name => name.endsWith('.json'));
  assert.equal(traceNames.length, 1);
  const trace = await readExecutionTrace(root, traceNames[0].replace(/\.json$/, ''));
  assert.equal(trace.metadata.authoritativeObservation.basis, 'declared_spans');
  assert.equal(trace.metadata.authoritativeObservation.stage, 'intake');
  const ledger = await readExecutionLedgerStatus(root);
  assert.equal(ledger.observations.derivation.automaticEventCount, 1);
  assert.equal(ledger.observations.timing.machineExecutionMs.sampleCount, 1);

  const second = await persistVideoIntake(root, input);
  assert.equal(second.importedReferenceVideos.length, 1);
  const repeated = await readJson(join(root, 'project-state.json'));
  assert.equal(repeated.artifacts.filter(item => item.type === 'reference_video').length, 1);
});

test('persistent intake imports an explicit source-modification reference', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'video-intake-no-hardlink-'));
  const root = join(parent, 'project');
  const source = join(parent, 'uploaded.mp4');
  await writeFile(source, 'reference-video-bytes');
  await initializeProject(root, { projectId: 'INTAKE-NO-LINK', workflowVersion: 2 });

  const result = await persistVideoIntake(root, {
    requestText: '按原视频复刻并替换产品',
    explicitReferenceIntent: 'source_modification',
    inputs: [{ id: 'video-001', mimeType: 'video/mp4', path: source }]
  });

  assert.equal(result.importedReferenceVideos.length, 1);
  assert.equal(result.importedReferenceVideos[0].status, 'locked');
  assert.equal(await readFile(join(root, result.importedReferenceVideos[0].path), 'utf8'), 'reference-video-bytes');
});

test('mechanical intake locks existing assets and does not create a director interview', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'video-intake-mechanical-'));
  const root = join(parent, 'project');
  const source = join(parent, 'uploaded.mp4');
  const product = join(parent, 'product.png');
  await writeFile(source, 'reference-video-bytes');
  await writeFile(product, 'product-image-bytes');
  await initializeProject(root, { projectId: 'INTAKE-MECHANICAL', workflowVersion: 2 });

  const result = await persistVideoIntake(root, {
    requestText: '这是简单任务，只需要切分原视频、上传并配上产品图片、撰写提示词，把原产品替换掉',
    explicitReferenceIntent: 'source_modification',
    explicitExecutionClass: 'mechanical_asset_prompt',
    inputs: [
      { id: 'video-001', mimeType: 'video/mp4', path: source },
      { id: 'product-001', mimeType: 'image/png', path: product }
    ]
  });

  assert.equal(result.directorInterview, null);
  assert.equal(result.importedMechanicalAssets.length, 1);
  assert.equal(result.importedMechanicalAssets[0].status, 'locked');
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.routeDecision.executionClass, 'mechanical_asset_prompt');
  assert.equal(state.directionRevision, undefined);
  assert.equal(state.artifacts.some(item => item.type === 'creative_brief' || item.type === 'story_plan'), false);
});

test('a bypass decision remains read-only even when a project root is supplied', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'video-intake-bypass-'));
  const root = join(parent, 'project');
  const source = join(parent, 'uploaded.mp4');
  await writeFile(source, 'reference-video-bytes');
  await initializeProject(root, { projectId: 'INTAKE-002', workflowVersion: 2 });

  const result = await persistVideoIntake(root, {
    requestText: '只解释这个视频的构图，不要生成视频',
    requestKind: 'explanation',
    inputs: [{ id: 'video-001', mimeType: 'video/mp4', path: source }]
  });
  assert.equal(result.persisted, false);
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.routeDecision, undefined);
  assert.deepEqual(state.artifacts, []);
});

test('trace failures never change a successful persistent intake', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'video-intake-trace-fail-'));
  const root = join(parent, 'project');
  await initializeProject(root, { projectId: 'INTAKE-003', workflowVersion: 2 });

  const result = await persistVideoIntake(root, {
    requestText: '生成一条 AI 视频',
    inputs: []
  }, {
    recordExecutionTrace: async () => { throw new Error('telemetry unavailable'); }
  });
  assert.equal(result.persisted, true);
});

test('a user-confirmed direction revision invalidates route-dependent work and rebuilds Gate 0', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'video-intake-scope-revision-'));
  const root = join(parent, 'project');
  const source = join(parent, 'source.mp4');
  await writeFile(source, 'reference-video');
  await initializeProject(root, { projectId: 'INTAKE-REVISION', workflowVersion: 2 });
  const base = {
    inputs: [{ id: 'video-001', mimeType: 'video/mp4', path: source }]
  };
  const initial = await persistVideoIntake(root, {
    ...base, requestText: '只参考这条片的氛围，不复刻动作', explicitReferenceIntent: 'inspiration_only'
  });
  await writeFile(join(root, 'brief', 'old-brief.json'), '{"historical":true}\n');
  await registerArtifact(root, { id: 'old-creative', type: 'creative_brief', revision: 1, status: 'draft', path: 'brief/old-brief.json' });
  let state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({
    id: 'old-capability', type: 'capability_manifest', revision: 1, status: 'locked', path: 'brief/old-capability.json',
    sha256: 'a'.repeat(64), lockedByReviewId: 'review-old-capability',
    routePrecision: 'explicit_v2', storyPlanSchemaVersion: 2
  });
  state.verifiedCapabilityManifestId = 'old-capability';
  state.directorRoutingVersion = 1;
  state.mechanicalCanvas = {
    status: 'READY_FOR_USER_CANVAS_GENERATION',
    canvasUuid: 'stale-mechanical-canvas',
    packageId: 'old-mechanical-package'
  };
  await writeJsonAtomic(join(root, 'project-state.json'), state);

  const changed = {
    ...base, requestText: '照着原片的动作、构图和节奏做，只替换产品', explicitReferenceIntent: 'source_modification'
  };
  await assert.rejects(persistVideoIntake(root, changed), /explicit user confirmation/);
  const revised = await persistVideoIntake(root, {
    ...changed, confirmScopeRevision: true, scopeRevisionReason: '原片改为事实权威，只换产品'
  });
  state = await readJson(join(root, 'project-state.json'));
  assert.equal(initial.routeDecision.referenceRoleStatus, 'inspiration');
  assert.equal(revised.routeDecision.referenceRoleStatus, 'authority');
  assert.equal(state.directionRevision.revision, 2);
  assert.equal(state.directionRevision.status, 'awaiting_answers');
  assert.deepEqual(state.directionRevision.invalidatedArtifactIds, ['old-capability', 'old-creative']);
  assert.equal(state.artifacts.find(item => item.id === 'old-creative').invalidatedByScopeRevisionId, state.directionRevision.id);
  assert.equal(state.artifacts.find(item => item.id === 'old-capability').invalidatedByScopeRevisionId, state.directionRevision.id);
  assert.equal(state.verifiedCapabilityManifestId, undefined);
  assert.equal(state.directorRoutingVersion, undefined);
  assert.equal(state.mechanicalCanvas, undefined);
  assert.equal(resolveCurrentArtifacts(state.artifacts).current.some(item => item.id === 'old-creative'), false);
  assert.equal(revised.directorInterview.status, 'awaiting_answers');
  assert.equal(revised.directorInterview.route.referenceRoleStatus, 'authority');
});

test('identical intake preserves a confirmed direction but changed priorities require a scope revision', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'video-intake-direction-idempotency-'));
  const root = join(parent, 'project');
  await initializeProject(root, { projectId: 'INTAKE-IDEMPOTENT', workflowVersion: 2 });
  const input = {
    requestText: '做一条 15 秒 9:16 产品广告，验收以编织进行时、收腹和透气证据为准，禁止真人',
    requestKind: 'video_creation', explicitReferenceIntent: 'idea_only', inputs: []
  };
  const first = await persistVideoIntake(root, input);
  const answers = Object.fromEntries(first.directorInterview.questions.map(item => [item.id, `${item.id}: 确认当前方向与可观察验收顺序`]))
  await answerDirectorInterview(root, { answers, routeDecision: first.routeDecision });
  const repeated = await persistVideoIntake(root, input);
  let state = await readJson(join(root, 'project-state.json'));
  assert.equal(repeated.directorInterview.status, 'complete');
  assert.equal(state.directionRevision.revision, 1);
  assert.equal(state.directionRevision.status, 'confirmed');

  await writeFile(join(root, 'brief', 'old-direction.json'), '{"locked":true}\n');
  await registerArtifact(root, { id: 'old-direction-work', type: 'creative_brief', revision: 1, status: 'draft', path: 'brief/old-direction.json' });
  const changed = { ...input, requestText: `${input.requestText}；新的第一优先级是空间立体曲线和大小景别冲击` };
  await assert.rejects(persistVideoIntake(root, changed), /scope revision requires explicit user confirmation/);
  await persistVideoIntake(root, { ...changed, confirmScopeRevision: true, scopeRevisionReason: '核心视觉优先级变更' });
  state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.directionRevision.revision, 2);
  assert.equal(state.directionRevision.status, 'awaiting_answers');
  assert.equal(state.artifacts.find(item => item.id === 'old-direction-work').invalidatedByScopeRevisionId, 'direction-revision-2');
});
