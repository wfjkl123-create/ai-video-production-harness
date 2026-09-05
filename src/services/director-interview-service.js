import { join } from 'node:path';
import { sha256Text } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { assertProjectState } from '../domain/project-state.js';

const SCHEMA_VERSION = 1;
const INTAKE_PATH = join('brief', 'director-intake-v1.json');
const INTERVIEW_PATH = join('brief', 'director-interview-v1.json');

function text(value, field, maxLength = 12000) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${field} must not exceed ${maxLength} characters`);
  return normalized;
}

function routeSnapshot(routeDecision) {
  if (!routeDecision || routeDecision.harnessRequired !== true) {
    throw new TypeError('a persisted Harness intake route is required before the director interview');
  }
  return {
    policyVersion: text(routeDecision.policyVersion, 'routeDecision.policyVersion', 128),
    reason: text(routeDecision.reason, 'routeDecision.reason', 128),
    referenceRoleStatus: text(routeDecision.referenceRoleStatus, 'routeDecision.referenceRoleStatus', 128),
    inputTypes: Array.isArray(routeDecision.inputTypes) ? routeDecision.inputTypes.map((type, index) => text(type, `routeDecision.inputTypes[${index}]`, 64)) : [],
    sourceVideoIds: Array.isArray(routeDecision.sourceVideoIds) ? routeDecision.sourceVideoIds.map((id, index) => text(id, `routeDecision.sourceVideoIds[${index}]`, 192)) : []
  };
}

export function directorRouteFingerprint(routeDecision) {
  return fingerprint(routeSnapshot(routeDecision));
}

export function directorInputFingerprint(projectId, requestText, routeDecision) {
  return fingerprint({
    projectId: text(projectId, 'projectId', 192),
    requestText: text(requestText, 'requestText'),
    route: routeSnapshot(routeDecision)
  });
}

function fingerprint(value) {
  return sha256Text(`${JSON.stringify(value)}\n`);
}

function question(id, prompt, whyItMatters, placeholder) {
  return { id, prompt, whyItMatters, placeholder, required: true, answer: null };
}

export function planDirectorQuestions({ requestText, routeDecision }) {
  const request = text(requestText, 'requestText');
  const route = routeSnapshot(routeDecision);
  const questions = [];
  if (route.referenceRoleStatus === 'not_applicable') {
    const coreKnown = /(?:主角|人物|妈妈|女孩|男孩|男人|女人|孩子|谁).{0,40}(?:想要|害怕|不能|不敢|冲突|困难|阻碍|转折)/i.test(request)
      || /(?:冲突|困难|阻碍|不敢|害怕).{0,50}(?:改变|决定|开始|转折|重新|解决)/i.test(request)
      || /(?:开头|第一秒).{0,60}(?:中段|转折)/i.test(request);
    const meaningKnown = /(?:希望|想让).{0,12}(?:观众|大家|人).{0,12}(?:感受|相信|明白|意识|行动)/i.test(request)
      || /(?:观众|验收标准).{0,24}(?:感受|相信|明白|意识|行动)/i.test(request);
    const endingKnown = /(?:结尾|最后|最终).{0,40}(?:画面|动作|活动|决定|完成|证明|离开|开始)/i.test(request);
    if (!coreKnown) questions.push(question(
      'story_core',
      '如果这条片只能保留一个关键瞬间，你最想让我们看见什么？主角为什么会在这一刻发生变化？',
      '先找到故事真正的心脏，后面的场景和镜头才不会越写越散。',
      '例如：孩子递来一张画，妈妈第一次说出“我想试试”，并真正按下提交按钮。'
    ));
    if (!meaningKnown) questions.push(question(
      'audience_feeling',
      '观众看完以后，你最希望他们心里留下哪一种感受或一句话？',
      '这会决定故事应该克制、温暖、紧张还是有力量。',
      '例如：开始不需要等到完全准备好；害怕也可以往前走一步。'
    ));
    if (!endingKnown) questions.push(question(
      'ending_picture',
      '最后一个画面你希望看到什么？有没有必须保留、绝对不能出现的东西？',
      '用一个具体结尾锁住故事的兑现，同时提前避开你不接受的方向。',
      '例如：她合上电脑，牵着孩子出门；不要喊口号，也不要突然变成成功人士。'
    ));
    if (questions.length === 0) questions.push(question(
      'direction_confirmation',
      '这个故事已经很完整了。请只确认一件事：后续无论怎么改，最不能牺牲的是什么？',
      '给后续取舍留下一条最高优先级。',
      '例如：必须保留妈妈是因为孩子的无意鼓励才迈出第一步。'
    ));
    return Object.freeze({ request, route, questions: questions.slice(0, 3) });
  }
  const outcomeKnown = /(?:交付|最终产物|成片|输出)/i.test(request) && /(?:验收|合格|标准|观众.{0,12}(?:变化|相信|行动))/i.test(request);
  const audienceKnown = /(?:受众|观众|人群|妈妈|女性|男性|用户)/i.test(request) && /(?:抖音|千川|小红书|视频号|广告|投放|商品页|电商)/i.test(request);
  const storyKnown = /(?:冲突|痛点|问题)/i.test(request) && /产品/i.test(request) && /(?:避免|禁止|不能|必须保留)/i.test(request);
  const constraintsKnown = /(?:\d+\s*(?:秒|分钟)|时长)/i.test(request) && /(?:9\s*:\s*16|16\s*:\s*9|竖屏|横屏|预算|截止|素材)/i.test(request);

  if (!outcomeKnown) questions.push(question(
      'outcome_and_acceptance',
      '最终要交付什么？观众看完应发生什么变化？你会用哪三条可见标准判断成片合格？',
      '锁定最终产物、观众结果和验收口径，避免把“做了一条视频”误当成完成。',
      '例如：15 秒竖屏产品短片；观众从怀疑变为相信；前三秒看懂痛点、产品作用可见、结尾有明确新状态。'
    ));
  if (!audienceKnown) questions.push(question(
      'audience_and_use',
      '谁会看、在哪里看、看完用于什么业务动作？',
      '受众、平台与用途会直接改变信息密度、表演尺度、画幅和节奏。',
      '例如：抖音信息流中的精致妈妈；用于新品冷启动；希望进入商品页或继续了解。'
    ));
  if (!storyKnown) questions.push(question(
      'story_and_product',
      '这条片最核心的冲突是什么？产品必须如何真正改变局面？哪些内容必须保留或绝不能出现？',
      '把产品放进故事因果，而不是最后贴片；同时锁定不可牺牲与禁止项。',
      '写清冲突、产品的可见作用、必须保留的关系/事实，以及会破坏可信度的做法。'
    ));
  if (!constraintsKnown) questions.push(question(
      'production_constraints',
      '有哪些会改变方案的制作约束？',
      '时长、画幅、语言、真人/产品素材、预算上限和截止时间会改变镜头与资产范围。',
      '例如：15 秒、9:16、中文旁白、必须使用现有产品图、暂不付费生成、周五前完成审核包。'
    ));

  if (route.referenceRoleStatus === 'authority') {
    if (!(/(?:分镜图|深度图|建模|blender)/i.test(request) && /(?:保留|替换)/i.test(request))) questions.push(question(
      'source_authority_control',
      '原片哪些事实必须逐项保留，哪些内容允许替换？强控制优先用分镜图、深度图还是建模？',
      '事实权威路线必须先锁定保留/替换边界和控制方式，否则后续无法可靠对照。',
      '例如：保留镜头节奏、动作与构图；只换产品；用深度图控制空间，不沿用原片人物身份。'
    ));
  } else if (route.referenceRoleStatus === 'inspiration') {
    if (!(/(?:借鉴|参考)/i.test(request) && /(?:不继承|不得|禁止|不能)/i.test(request))) questions.push(question(
      'inspiration_boundary',
      '原片只允许借鉴哪些风格维度？哪些剧情、人物、动作或构图不得被当成事实继承？',
      '把灵感和事实分开，防止参考素材污染原创方向。',
      '例如：只借鉴冷暖对比和克制镜头；不继承台词、人物关系、动作顺序与具体构图。'
    ));
  }

  if (questions.length === 0) questions.push(question(
    'direction_confirmation',
    '请用一句话确认：这次最重要的观众结果是什么，哪一项不能被后续制作牺牲？',
    '即使任务描述已经完整，仍需要一个最终优先级来处理后续取舍。',
    '例如：最重要的是让观众相信产品确实改善坐姿不适；不能用夸张变形换取视觉刺激。'
  ));

  return Object.freeze({ request, route, questions: questions.slice(0, 5) });
}

function createInterview(projectId, requestText, routeDecision, now) {
  const planned = planDirectorQuestions({ requestText, routeDecision });
  const routeFingerprint = fingerprint(planned.route);
  const inputFingerprint = directorInputFingerprint(projectId, planned.request, routeDecision);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'director-interview-v1',
    projectId,
    status: 'awaiting_answers',
    method: 'deterministic_gap_and_route_aware_questions',
    modelCallExecuted: false,
    requestText: planned.request,
    route: planned.route,
    routeFingerprint,
    inputFingerprint,
    questions: planned.questions,
    directorInputContract: null,
    gate1DraftTask: null,
    createdAt: now,
    updatedAt: now
  };
}

async function readOptional(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameInterviewInput(interview, projectId, requestText, routeDecision) {
  return interview?.projectId === projectId
    && interview.inputFingerprint === directorInputFingerprint(projectId, requestText, routeDecision);
}

export async function prepareDirectorInterview(root, input, options = {}) {
  const projectId = text(input.projectId, 'projectId', 192);
  const requestText = text(input.requestText, 'requestText');
  const route = routeSnapshot(input.routeDecision);
  const now = (options.now ?? (() => new Date().toISOString()))();
  return withProjectLock(root, async () => {
    const intakePath = join(root, INTAKE_PATH);
    const interviewPath = join(root, INTERVIEW_PATH);
    const existing = await readOptional(interviewPath);
    if (sameInterviewInput(existing, projectId, requestText, input.routeDecision)) return existing;

    const intake = {
      schemaVersion: SCHEMA_VERSION,
      projectId,
      requestText,
      route,
      routeFingerprint: fingerprint(route),
      recordedAt: now
    };
    const interview = createInterview(projectId, requestText, input.routeDecision, now);
    await writeJsonAtomic(intakePath, intake);
    await writeJsonAtomic(interviewPath, interview);
    const statePath = join(root, 'project-state.json');
    const state = await readOptional(statePath);
    if (state?.directionRevision) {
      const current = assertProjectState(state);
      current.directionRevision = {
        ...current.directionRevision,
        status: 'awaiting_answers',
        routeFingerprint: interview.routeFingerprint,
        interviewInputFingerprint: interview.inputFingerprint,
        updatedAt: now
      };
      current.updatedAt = now;
      assertProjectState(current);
      await writeJsonAtomic(statePath, current);
    }
    return interview;
  });
}

export async function getDirectorInterview(root) {
  return readOptional(join(root, INTERVIEW_PATH));
}

function simpleRemakeCompletedInterview(interview, controlSelection, now) {
  const selectedModes = [...controlSelection.selectedModes];
  const directorInputContract = {
    schemaVersion: 1,
    requestText: interview.requestText,
    route: interview.route,
    confirmedFacts: [
      { id: 'user_request', statement: interview.requestText, source: 'user_intake_request' },
      { id: 'workflow_profile', statement: 'Use the simple remake workflow; do not invent a new story or redirect the creative premise.', source: 'user_workflow_selection' },
      { id: 'remake_control', statement: `Use only the selected remake control modes: ${selectedModes.join(', ')}. Prompt policy: ${controlSelection.promptPolicy}.`, source: 'user_control_selection' }
    ],
    unknowns: [{
      id: 'execution_detail_lock',
      status: 'deferred_to_gate2',
      statement: 'Exact source-aligned segmentation and the minimum asset scope remain provisional until source facts and the Shotlist are locked.'
    }],
    professionalRecommendations: [{
      id: 'simple_remake_scope',
      statement: 'Gate 1 must lock only the requested replacement boundary, preserved source facts, product identity, and prohibitions; it must not introduce a new narrative interview or new story premise.'
    }],
    mustAnswerNow: []
  };
  const taskInput = { projectId: interview.projectId, directorInputContract };
  const gate1DraftTask = {
    schemaVersion: 1,
    id: `gate1-draft-task-${interview.projectId}`,
    kind: 'director_engine_task',
    status: 'ready_for_director_engine',
    inputSha256: fingerprint(taskInput),
    modelCallRequired: true,
    modelCallExecuted: false,
    outputContract: {
      artifactType: 'creative_brief',
      schemaVersion: 3,
      initialStatus: 'draft',
      requiresHumanGate: true
    },
    constraints: [
      'Use only the persisted request, route, workflow selection, and remake control selection as user facts.',
      'Do not invent a new story, audience promise, conflict, character motivation, or product claim.',
      'Preserve source-authority facts except for replacements explicitly requested by the user.',
      'Do not create media, submit paid generation, or approve Gate 1.'
    ],
    createdAt: now
  };
  return {
    ...interview,
    status: 'complete',
    method: 'deterministic_simple_remake_intake',
    questions: [],
    directorInputContract,
    gate1DraftTask,
    completedAt: now,
    updatedAt: now
  };
}

export async function synchronizeDirectorInterviewForWorkflow(root, options = {}) {
  const now = (options.now ?? (() => new Date().toISOString()))();
  return withProjectLock(root, async () => {
    const path = join(root, INTERVIEW_PATH);
    const statePath = join(root, 'project-state.json');
    const current = assertProjectState(await readJson(statePath));
    let interview = await readOptional(path);
    if (!interview) {
      const intake = await readOptional(join(root, INTAKE_PATH));
      if (!intake?.requestText || !current.routeDecision) return null;
      interview = createInterview(current.projectId, intake.requestText, current.routeDecision, now);
    }
    const profileId = current.workflowProfile?.id ?? null;
    const isSimpleRemakeReady = profileId === 'simple_remake' && current.remakeControlSelection;

    let synchronized = interview;
    if (isSimpleRemakeReady) {
      if (interview.method === 'deterministic_simple_remake_intake'
        && interview.status === 'complete'
        && JSON.stringify(interview.directorInputContract?.confirmedFacts?.find(item => item.id === 'remake_control')?.statement ?? '').includes(current.remakeControlSelection.selectedModes.join(', '))) {
        return interview;
      }
      synchronized = simpleRemakeCompletedInterview(interview, current.remakeControlSelection, now);
    } else if (profileId && profileId !== 'simple_remake' && interview.method === 'deterministic_simple_remake_intake') {
      synchronized = createInterview(interview.projectId, interview.requestText, current.routeDecision, now);
    } else {
      return interview;
    }

    await writeJsonAtomic(path, synchronized);
    if (current.directionRevision) {
      current.directionRevision = {
        ...current.directionRevision,
        status: synchronized.status === 'complete' ? 'confirmed' : 'awaiting_answers',
        routeFingerprint: synchronized.routeFingerprint,
        interviewInputFingerprint: synchronized.inputFingerprint,
        updatedAt: now
      };
      current.updatedAt = now;
      assertProjectState(current);
      await writeJsonAtomic(statePath, current);
    }
    return synchronized;
  });
}

function normalizedAnswers(interview, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('answers must be an object keyed by question ID');
  const expected = new Set(interview.questions.map(item => item.id));
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new TypeError(`answers contains unknown question ID: ${key}`);
  return Object.fromEntries(interview.questions.map(item => [item.id, text(value[item.id], `answers.${item.id}`, 6000)]));
}

function completedInterview(interview, answers, now) {
  const answeredQuestions = interview.questions.map(item => ({ ...item, answer: answers[item.id] }));
  const confirmedFacts = answeredQuestions.map(item => ({ id: item.id, statement: item.answer, source: 'user_gate0_answer' }));
  const directorInputContract = {
    schemaVersion: 1,
    requestText: interview.requestText,
    route: interview.route,
    confirmedFacts,
    unknowns: [{
      id: 'execution_detail_lock',
      status: 'deferred_to_gate2',
      statement: 'Exact segmentation, parallel execution mode, and minimum asset scope remain provisional until the complete script and Shotlist exist.'
    }],
    professionalRecommendations: [{
      id: 'gate1_scope',
      statement: 'Gate 1 should lock audience promise, causal story direction, product dramatic function, and creative prohibitions; execution detail remains provisional until Gate 2.'
    }],
    mustAnswerNow: []
  };
  const taskInput = { projectId: interview.projectId, directorInputContract };
  const gate1DraftTask = {
    schemaVersion: 1,
    id: `gate1-draft-task-${interview.projectId}`,
    kind: 'director_engine_task',
    status: 'ready_for_director_engine',
    inputSha256: fingerprint(taskInput),
    modelCallRequired: true,
    modelCallExecuted: false,
    outputContract: {
      artifactType: 'creative_brief',
      schemaVersion: 3,
      initialStatus: 'draft',
      requiresHumanGate: true
    },
    constraints: [
      'Use only the persisted Gate 0 request, route, and confirmed answers as user facts.',
      'Mark unresolved execution details as provisional until Gate 2.',
      'Do not create media, submit paid generation, or approve Gate 1.'
    ],
    createdAt: now
  };
  return {
    ...interview,
    status: 'complete',
    questions: answeredQuestions,
    directorInputContract,
    gate1DraftTask,
    completedAt: now,
    updatedAt: now
  };
}

export async function answerDirectorInterview(root, input, options = {}) {
  const now = (options.now ?? (() => new Date().toISOString()))();
  return withProjectLock(root, async () => {
    const path = join(root, INTERVIEW_PATH);
    const interview = await readOptional(path);
    if (!interview) throw new Error('director interview has not been prepared');
    const currentRouteFingerprint = fingerprint(routeSnapshot(input.routeDecision));
    if (currentRouteFingerprint !== interview.routeFingerprint) {
      throw new Error('director interview is stale because the persisted Gate 0 route changed; prepare a new interview');
    }
    const answers = normalizedAnswers(interview, input.answers);
    if (interview.status === 'complete' && interview.questions.every(item => item.answer === answers[item.id])) return interview;
    const completed = completedInterview(interview, answers, now);
    await writeJsonAtomic(path, completed);
    const statePath = join(root, 'project-state.json');
    const state = await readOptional(statePath);
    if (state?.directionRevision) {
      const current = assertProjectState(state);
      if (current.directionRevision.routeFingerprint !== completed.routeFingerprint) {
        throw new Error('project direction revision changed while recording Gate 0 answers');
      }
      current.directionRevision = {
        ...current.directionRevision,
        status: 'confirmed',
        interviewInputFingerprint: completed.inputFingerprint,
        updatedAt: now
      };
      current.updatedAt = now;
      assertProjectState(current);
      await writeJsonAtomic(statePath, current);
    }
    return completed;
  });
}

export function directorInterviewSummary(interview) {
  if (!interview) return null;
  return {
    id: interview.id,
    schemaVersion: interview.schemaVersion,
    status: interview.status,
    method: interview.method,
    modelCallExecuted: interview.modelCallExecuted,
    answeredCount: interview.questions.filter(item => typeof item.answer === 'string' && item.answer.trim() !== '').length,
    questionCount: interview.questions.length,
    inputFingerprint: interview.inputFingerprint,
    gate1DraftTask: interview.gate1DraftTask ? {
      id: interview.gate1DraftTask.id,
      status: interview.gate1DraftTask.status,
      inputSha256: interview.gate1DraftTask.inputSha256,
      modelCallExecuted: interview.gate1DraftTask.modelCallExecuted
    } : null,
    updatedAt: interview.updatedAt
  };
}
