import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerDirectorInterview,
  directorInterviewSummary,
  getDirectorInterview,
  planDirectorQuestions,
  prepareDirectorInterview,
  synchronizeDirectorInterviewForWorkflow
} from '../../src/services/director-interview-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { initializeProject } from '../../src/services/project-service.js';
import { setRemakeControlSelection, setWorkflowProfile } from '../../src/services/workflow-profile-service.js';

function route(referenceRoleStatus = 'not_applicable') {
  return {
    policyVersion: 'ingress-route-v1',
    harnessRequired: true,
    reason: referenceRoleStatus === 'not_applicable' ? 'video_creation_intent' : 'video_input_and_creation_intent',
    referenceRoleStatus,
    inputTypes: ['video'],
    sourceVideoIds: referenceRoleStatus === 'not_applicable' ? [] : ['reference-video-001']
  };
}

const answers = Object.freeze({
  story_core: '妈妈在犹豫时收到孩子的画，第一次决定真正开始自己的项目。',
  audience_feeling: '害怕也可以往前走一步，不必等到完全准备好。',
  ending_picture: '她按下提交按钮，然后牵着孩子出门；不要突然变成成功人士。'
});

test('director question plan stays within five high-impact questions and adapts to route role', () => {
  const original = planDirectorQuestions({ requestText: '创作一条 AI 产品视频', routeDecision: route() });
  assert.equal(original.questions.length, 3);
  assert.deepEqual(original.questions.map(item => item.id), ['story_core', 'audience_feeling', 'ending_picture']);

  const inspiration = planDirectorQuestions({ requestText: '参考原片氛围创作视频', routeDecision: route('inspiration') });
  assert.equal(inspiration.questions.at(-1).id, 'inspiration_boundary');

  const authority = planDirectorQuestions({ requestText: '复刻原片并换产品', routeDecision: route('authority') });
  assert.equal(authority.questions.at(-1).id, 'source_authority_control');
  assert.match(authority.questions.at(-1).prompt, /分镜图、深度图还是建模/);

  const alreadyDetailed = planDirectorQuestions({
    requestText: '最终交付15秒9:16竖屏成片，验收标准是观众相信产品有效。受众是抖音精致妈妈，用于广告投放。痛点冲突由产品解决，禁止夸张。开头看见不适，中段完成调节，结尾自然活动。',
    routeDecision: route()
  });
  assert.deepEqual(alreadyDetailed.questions.map(item => item.id), ['direction_confirmation']);
});

test('prepared interview is recoverable and explicitly records that no model ran', async () => {
  const root = await mkdtemp(join(tmpdir(), 'director-interview-'));
  const first = await prepareDirectorInterview(root, {
    projectId: 'DIRECTOR-001',
    requestText: '创作一条 AI 产品视频',
    routeDecision: route()
  }, { now: () => '2026-08-19T01:00:00.000Z' });

  assert.equal(first.status, 'awaiting_answers');
  assert.equal(first.modelCallExecuted, false);
  assert.equal(first.questions.length, 3);
  assert.equal((await getDirectorInterview(root)).inputFingerprint, first.inputFingerprint);
  assert.equal((await readJson(join(root, 'brief', 'director-intake-v1.json'))).requestText, '创作一条 AI 产品视频');
  assert.equal((await readJson(join(root, 'brief', 'director-interview-v1.json'))).status, 'awaiting_answers');

  const repeated = await prepareDirectorInterview(root, {
    projectId: 'DIRECTOR-001', requestText: '创作一条 AI 产品视频', routeDecision: route()
  }, { now: () => '2026-08-19T02:00:00.000Z' });
  assert.equal(repeated.updatedAt, '2026-08-19T01:00:00.000Z');
});

test('simple remake completes Gate 0, rejects a silent narrative switch, and can inspect a legacy narrative state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'director-interview-simple-remake-'));
  await initializeProject(root, { projectId: 'REMAKE-001', routeDecision: route('authority') });
  await prepareDirectorInterview(root, {
    projectId: 'REMAKE-001',
    requestText: '复刻原片 0 到 190 秒，只把手上的商品替换为灰色 069 收腹裤。',
    routeDecision: route('authority')
  }, { now: () => '2026-08-27T01:00:00.000Z' });
  await setWorkflowProfile(root, { id: 'simple_remake', selectedBy: 'user' });
  await setRemakeControlSelection(root, { selectedModes: ['native_source'] });

  const completed = await synchronizeDirectorInterviewForWorkflow(root, { now: () => '2026-08-27T01:01:00.000Z' });
  assert.equal(completed.status, 'complete');
  assert.equal(completed.method, 'deterministic_simple_remake_intake');
  assert.equal(completed.questions.length, 0);
  assert.equal(completed.directorInputContract.mustAnswerNow.length, 0);
  assert.match(completed.gate1DraftTask.constraints.join('\n'), /Do not invent a new story/);

  await assert.rejects(() => setWorkflowProfile(root, { id: 'narrative', selectedBy: 'user' }), /保留原片/);
  // Historical files remain readable; this fixture deliberately represents
  // the conflicting combination that the current mutation API now rejects.
  const legacyState = await readJson(join(root, 'project-state.json'));
  legacyState.workflowProfile = { ...legacyState.workflowProfile, id: 'narrative' };
  await writeJsonAtomic(join(root, 'project-state.json'), legacyState);
  const restored = await synchronizeDirectorInterviewForWorkflow(root, { now: () => '2026-08-27T01:02:00.000Z' });
  assert.equal(restored.status, 'awaiting_answers');
  assert.equal(restored.method, 'deterministic_gap_and_route_aware_questions');
  assert.ok(restored.questions.length > 0);
});

test('all required answers produce a versioned Gate 1 draft task contract without generating the brief', async () => {
  const root = await mkdtemp(join(tmpdir(), 'director-interview-complete-'));
  await prepareDirectorInterview(root, {
    projectId: 'DIRECTOR-002', requestText: '创作一条 AI 产品视频', routeDecision: route()
  }, { now: () => '2026-08-19T01:00:00.000Z' });

  await assert.rejects(
    answerDirectorInterview(root, { answers: { ...answers, ending_picture: '' }, routeDecision: route() }),
    /answers\.ending_picture must be a non-empty string/
  );

  const completed = await answerDirectorInterview(root, {
    answers,
    routeDecision: route()
  }, { now: () => '2026-08-19T03:00:00.000Z' });
  assert.equal(completed.status, 'complete');
  assert.equal(completed.directorInputContract.mustAnswerNow.length, 0);
  assert.equal(completed.directorInputContract.confirmedFacts.length, 3);
  assert.equal(completed.gate1DraftTask.status, 'ready_for_director_engine');
  assert.equal(completed.gate1DraftTask.modelCallExecuted, false);
  assert.equal(completed.gate1DraftTask.outputContract.artifactType, 'creative_brief');
  assert.equal(completed.gate1DraftTask.outputContract.requiresHumanGate, true);
  assert.equal(directorInterviewSummary(completed).answeredCount, 3);

  const repeated = await answerDirectorInterview(root, {
    answers,
    routeDecision: route()
  }, { now: () => '2026-08-19T04:00:00.000Z' });
  assert.equal(repeated.updatedAt, '2026-08-19T03:00:00.000Z');
});

test('answering a stale interview after the Gate 0 route changes is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'director-interview-stale-'));
  await prepareDirectorInterview(root, {
    projectId: 'DIRECTOR-003', requestText: '创作一条 AI 产品视频', routeDecision: route()
  });

  await assert.rejects(
    answerDirectorInterview(root, { answers, routeDecision: route('inspiration') }),
    /interview is stale/
  );
});
