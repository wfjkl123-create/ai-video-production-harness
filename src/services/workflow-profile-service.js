import { join, resolve } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import {
  WORKFLOW_PROFILES,
  assertWorkflowProfile,
  workflowProfileOf,
  workflowProfileIdOf,
  visibleStepsForProfile,
  visibleStepsForProject,
  workflowProfileConflict,
  recommendWorkflowProfile,
  assetDefaultsForProfile,
  assertAssetSelection,
  assertRemakeControlSelection,
  estimatePaidImageTasks,
  ASSET_CATALOG,
  isMachineReviewedGate
} from '../domain/workflow-profile.js';
import { buildKocRemakeExecutionContract, buildVisualControlChoiceQuestion, resolveRemakeControlModes } from './visual-control-method-service.js';
import { isAssetAnchoredReferenceWorkflow } from '../domain/reference-workflow.js';
import { verifyArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { assertStoryPlan } from '../domain/story-plan.js';
import { compileDirectorCapabilityManifest } from '../domain/director-capability.js';
import { validateStoryPlanSegmentationCandidate, autoLockStoryPlanSegmentationCandidate } from './gate2-segmentation-lock-service.js';
import { routeLockedStoryPlan } from './director-route-service.js';
import { transitionArtifact } from '../domain/artifact.js';
import { createHash, randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';

function statePath(root) {
  return join(root, 'project-state.json');
}

function jsonSha256(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function intentFromRouteStatus(status) {
  if (status === 'authority') return 'faithful_remake';
  if (status === 'inspiration') return 'inspiration_only';
  return 'idea_only';
}

async function readIntake(root) {
  try {
    return await readJson(join(root, 'brief', 'director-intake-v1.json'));
  } catch {
    return null;
  }
}

function paidGenerationEvidence(state) {
  const hasLockedVideo = state.artifacts.some(item =>
    ['video_segment', 'final_edit'].includes(item.type) && item.status === 'locked');
  return hasLockedVideo;
}

function lockedStoryPlan(state) {
  return state.artifacts.some(item => item.type === 'story_plan' && item.status === 'locked');
}

const ASSET_DISPATCH_RULES = Object.freeze({
  product_image: Object.freeze({ pattern: /商品|产品|货品|带货|卖点|换产品|替换产品|旧换新/, reason: '需求涉及商品展示或商品替换，产品图负责结构、材质、颜色与比例。' }),
  character_reference: Object.freeze({ pattern: /换人|替换人物|替换模特|换脸|人物一致|角色一致|主角/, reason: '需求涉及人物替换或身份一致，人物参考图只负责人物身份。' }),
  character_board: Object.freeze({ pattern: /多角度人物|人物四视图|侧脸特写|背面特写|复杂人物动作/, reason: '人物出现多角度或复杂动作，四视图补足单张身份参考的盲区。' }),
  scene_image: Object.freeze({ pattern: /换景|替换场景|替换背景|场景一致|背景一致/, reason: '需求涉及场景替换或空间一致，场景图负责环境身份与空间基准。' }),
  prop_image: Object.freeze({ pattern: /替换道具|关键道具|拿起|递出|抓握|手持|操作道具/, reason: '关键道具需要被拿取或操作，道具图负责结构身份。' }),
  voice_reference: Object.freeze({ pattern: /保留.{0,6}(原声|音频|台词|口播)|台词.{0,4}不变|原声不变/, reason: '需求要求保留声音或台词，声音参考负责口播内容与节奏。' })
});

function catalogEntry(id) {
  return ASSET_CATALOG.find(item => item.id === id);
}

function legacyRemakeControlSelection(state) {
  if (state.remakeControlSelection || state.assetSelection?.profileId !== 'simple_remake') return state.remakeControlSelection ?? null;
  const selected = new Set(state.assetSelection.selected ?? []);
  const selectedModes = [];
  if (selected.has('storyboard')) selectedModes.push('storyboard_control');
  if (selected.has('depth_video')) selectedModes.push('depth_control');
  if (!selectedModes.length) return null;
  const routing = resolveRemakeControlModes(selectedModes);
  return {
    profileId: 'simple_remake',
    selectedModes: routing.selectedModes,
    requiresReversePrompt: routing.requiresReversePrompt,
    promptPolicy: routing.promptPolicy,
    updatedAt: state.assetSelection.updatedAt,
    legacyInferred: true
  };
}

export function buildRemakeAssetDispatch({ selectedModes, requestText = '', firstFramePolicy } = {}) {
  const routing = resolveRemakeControlModes(selectedModes, { firstFramePolicy });
  const rows = [];
  const add = (assetId, requirement, reason, ownerDimension, transfer, ignore) => {
    if (rows.some(row => row.assetId === assetId)) return;
    const entry = catalogEntry(assetId);
    rows.push({
      assetId,
      label: entry?.label ?? (assetId === 'reference_video' ? '原视频' : assetId),
      requirement,
      reason,
      ownerDimension,
      transfer,
      ignore,
      derived: entry?.derived ?? '使用已上传的原片',
      paidImageTasks: entry?.paidImageTasks ?? 0,
      catalogBacked: Boolean(entry)
    });
  };
  for (const control of routing.controls) {
    add(control.controlAsset, 'required', `${control.label}是本次明确选择的复刻控制输入。`, control.responsibility, control.transfer, control.ignore);
  }
  if (routing.selectedModes.includes('koc_remake')) {
    add('character_reference', 'required', 'KOC 换脸必须绑定用户确认的新人物身份图；它只负责身份，不负责原片构图、动作或场景。',
      '新人物身份、脸型、五官、年龄感、肤色、妆容与发型基准', ['人物身份'], ['原片构图', '身体动作', '服装', '产品', '场景', '镜头运动']);
    if (routing.firstFramePolicy === 'all_segments' || routing.firstFramePolicy === 'selected_segments') {
      add('first_frame', routing.firstFramePolicy === 'all_segments' ? 'required' : 'conditional',
        routing.firstFramePolicy === 'all_segments'
          ? '用户选择每段制作首帧；每个 A-roll 包都必须绑定原片构图中已替换好人物的首帧。'
          : '只对 Gate 2 被用户点选的片段制作并绑定首帧；其余片段不得为凑资产自动生成。',
        '开场构图与新人物落位', ['开场构图', '人物位置', '画面方向'], ['后续动作', '产品结构', '音频', 'B-roll']);
    }
  }
  for (const [assetId, rule] of Object.entries(ASSET_DISPATCH_RULES)) {
    if (!rule.pattern.test(requestText)) continue;
    const identityReplacement = ASSET_DISPATCH_RULES.character_reference.pattern.test(requestText);
    const needsMultiViewIdentity = identityReplacement && ASSET_DISPATCH_RULES.character_board.pattern.test(requestText);
    // Never create identity assets merely because the source has complex motion.
    // When identity replacement is explicit, the multi-view board supersedes a
    // single reference only if the same request also proves a multi-view risk.
    if (assetId === 'character_board' && !needsMultiViewIdentity) continue;
    if (assetId === 'character_reference' && needsMultiViewIdentity) continue;
    const entry = catalogEntry(assetId);
    add(assetId, /product_image|voice_reference/.test(assetId) ? 'required' : 'recommended', rule.reason,
      entry?.role ?? '单一控制责任', [entry?.role ?? '指定视觉维度'], ['镜头运动', '剪辑节奏', '其他资产负责的身份维度']);
  }
  const selectedAssetIds = rows.filter(row => row.catalogBacked).map(row => row.assetId);
  return {
    selectedModes: routing.selectedModes,
    requiresReversePrompt: routing.requiresReversePrompt,
    promptPolicy: routing.promptPolicy,
    firstFramePolicy: routing.firstFramePolicy,
    rows,
    selectedAssetIds,
    estimatedPaidImageTasks: estimatePaidImageTasks(selectedAssetIds, []),
    executionContract: routing.selectedModes.includes('koc_remake')
      ? buildKocRemakeExecutionContract(routing.firstFramePolicy)
      : null
  };
}

export async function getWorkflowProfileView(root) {
  root = resolve(root);
  const state = assertProjectState(await readJson(statePath(root)));
  const intake = await readIntake(root);
  const requestText = intake?.requestText ?? '';
  const referenceIntent = intentFromRouteStatus(state.routeDecision?.referenceRoleStatus);
  const recommendation = recommendWorkflowProfile({
    requestText,
    referenceIntent,
    sourceVideoIds: state.routeDecision?.sourceVideoIds ?? []
  });
  const profile = workflowProfileOf(state);
  const profileId = workflowProfileIdOf(state);
  const mechanical = state.routeDecision?.executionClass === 'mechanical_asset_prompt';
  const canSwitch = !mechanical && !lockedStoryPlan(state) && !paidGenerationEvidence(state);
  const remakeControlSelection = legacyRemakeControlSelection(state);
  const remakeDispatch = profileId === 'simple_remake' && remakeControlSelection
    ? buildRemakeAssetDispatch({
        selectedModes: remakeControlSelection.selectedModes,
        requestText,
        firstFramePolicy: remakeControlSelection.firstFramePolicy
      })
    : null;
  return {
    profile,
    profileId,
    recommendation,
    profiles: Object.values(WORKFLOW_PROFILES).map(item => ({
      id: item.id,
      label: item.label,
      summary: item.summary,
      estimatedEffort: item.estimatedEffort,
      humanGates: [...item.humanGates],
      visibleSteps: visibleStepsForProfile(item.id),
      available: !workflowProfileConflict(state, item.id),
      unavailableReason: workflowProfileConflict(state, item.id)
    })),
    visibleSteps: visibleStepsForProject(state),
    profileConflict: profileId ? workflowProfileConflict(state, profileId) : null,
    canSwitch,
    switchBlockReason: canSwitch
      ? null
      : mechanical ? workflowProfileConflict(state, profileId ?? 'simple_remake')
        : '项目已锁定故事计划或已进入付费生成；请通过修改需求评估影响后调整路线。',
    assetDefaults: assetDefaultsForProfile(profileId ?? recommendation.id, { requestText }),
    assetSelection: state.assetSelection ?? null,
    assetCatalog: ASSET_CATALOG.map(item => ({ ...item })),
    remakeControlOptions: buildVisualControlChoiceQuestion(),
    remakeControlSelection,
    remakeDispatch,
    remakeControlsEditable: canSwitch
  };
}

export async function setWorkflowProfile(root, input) {
  root = resolve(root);
  if (!input || typeof input !== 'object') throw new TypeError('workflow profile input must be an object');
  const record = assertWorkflowProfile({
    id: input.id,
    selectedBy: input.selectedBy ?? 'user',
    reason: input.reason ?? '用户手动选择工作流路线。',
    updatedAt: new Date().toISOString()
  });
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = statePath(root);
    const state = assertProjectState(await readJson(path));
    if (lockedStoryPlan(state) || paidGenerationEvidence(state)) {
      throw new Error('项目已锁定故事计划或已进入付费生成，不能切换工作流路线。');
    }
    const conflict = workflowProfileConflict(state, record.id);
    if (conflict) throw new Error(conflict);
    state.workflowProfile = record;
    // Reset any asset selection that no longer matches the new profile.
    if (state.assetSelection && state.assetSelection.profileId !== record.id) {
      delete state.assetSelection;
    }
    if (record.id !== 'simple_remake') delete state.remakeControlSelection;
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);
    await commitJsonTransaction(root, `workflow-profile-${randomUUID()}`, [{ path, value: state }]);
    return state.workflowProfile;
  });
}

export async function setRemakeControlSelection(root, input) {
  root = resolve(root);
  if (!input || typeof input !== 'object') throw new TypeError('remake control input must be an object');
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = statePath(root);
    const state = assertProjectState(await readJson(path));
    if (workflowProfileIdOf(state) !== 'simple_remake') throw new Error('只有复刻视频路线可以选择复刻控制方式。');
    if (lockedStoryPlan(state) || paidGenerationEvidence(state)) {
      throw new Error('项目已锁定故事计划或已进入付费生成，不能更改复刻控制方式。');
    }
    const intake = await readIntake(root);
    const dispatch = buildRemakeAssetDispatch({
      selectedModes: input.selectedModes,
      requestText: intake?.requestText ?? '',
      firstFramePolicy: input.firstFramePolicy
    });
    const now = new Date().toISOString();
    const record = assertRemakeControlSelection({
      profileId: 'simple_remake',
      selectedModes: dispatch.selectedModes,
      requiresReversePrompt: dispatch.requiresReversePrompt,
      promptPolicy: dispatch.promptPolicy,
      ...(dispatch.firstFramePolicy ? { firstFramePolicy: dispatch.firstFramePolicy } : {}),
      updatedAt: now
    });
    const previousProvided = new Set(state.assetSelection?.userProvided ?? []);
    const userProvided = dispatch.selectedAssetIds.filter(id => previousProvided.has(id));
    state.remakeControlSelection = record;
    state.assetSelection = assertAssetSelection({
      profileId: 'simple_remake',
      selected: dispatch.selectedAssetIds,
      userProvided,
      estimatedPaidImageTasks: estimatePaidImageTasks(dispatch.selectedAssetIds, userProvided),
      updatedAt: now
    });
    state.updatedAt = now;
    assertProjectState(state);
    await commitJsonTransaction(root, `remake-controls-${randomUUID()}`, [{ path, value: state }]);
    return { remakeControlSelection: record, assetSelection: state.assetSelection, dispatch };
  });
}

export async function setAssetSelection(root, input) {
  root = resolve(root);
  if (!input || typeof input !== 'object') throw new TypeError('asset selection input must be an object');
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = statePath(root);
    const state = assertProjectState(await readJson(path));
    const profileId = workflowProfileIdOf(state);
    if (!profileId) throw new Error('请先确认工作流路线，再选择资产。');
    if (profileId === 'simple_remake' && state.remakeControlSelection) {
      throw new Error('复刻资产由已选控制方式和镜头风险自动调度；请更新分镜图、深度视频或原视频的选择。');
    }
    const intake = await readIntake(root);
    const defaults = assetDefaultsForProfile(profileId, { requestText: intake?.requestText ?? '' });
    const selected = Array.isArray(input.selected) ? [...new Set(input.selected)] : [];
    const userProvided = Array.isArray(input.userProvided) ? [...new Set(input.userProvided)] : [];
    for (const required of defaults.required) {
      if (!selected.includes(required)) {
        const label = ASSET_CATALOG.find(item => item.id === required)?.label ?? required;
        throw new Error(`「${label}」是此路线的必需资产，不能移除。`);
      }
    }
    const record = assertAssetSelection({
      profileId,
      selected,
      userProvided,
      estimatedPaidImageTasks: estimatePaidImageTasks(selected, userProvided),
      updatedAt: new Date().toISOString()
    });
    state.assetSelection = record;
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);
    await commitJsonTransaction(root, `asset-selection-${randomUUID()}`, [{ path, value: state }]);
    return state.assetSelection;
  });
}

export async function machineApproveDelegatedStoryPlan(root, note = '简单复刻路线：故事与镜头由系统机审并自动锁定。') {
  root = resolve(root);
  const locked = await withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = statePath(root);
    const state = assertProjectState(await readJson(path));
    const profileId = workflowProfileIdOf(state);
    if (!isMachineReviewedGate(profileId, 2)) {
      throw new Error('当前路线未把故事与镜头委托给系统机审。');
    }
    const artifact = state.artifacts
      .filter(item => item.type === 'story_plan' && ['draft', 'rework', 'awaiting_review'].includes(item.status))
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!artifact) throw new Error('没有可机审的故事与镜头草稿。');
    const inspected = await verifyArtifactFile(root, artifact);
    const plan = assertStoryPlan(await readJson(inspected.path));
    const currentCreative = state.artifacts
      .filter(item => item.type === 'creative_brief' && item.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!currentCreative || plan.creativeBriefId !== currentCreative.id
      || plan.creativeBriefSha256 !== currentCreative.sha256) {
      throw new Error('当前导演创意已更新，不能自动锁定旧的故事与镜头草稿。');
    }
    await verifyLockedArtifact(root, currentCreative);
    // Machine prechecks identical to the human Gate 2 preflight.
    if (plan.schemaVersion !== 2) throw new Error('机审要求 schemaVersion 2 的故事计划。');
    compileDirectorCapabilityManifest(plan, { storyPlanId: artifact.id, storyPlanSha256: inspected.sha256 });
    await validateStoryPlanSegmentationCandidate(root, {
      storyArtifact: artifact,
      plan,
      storyPlanSha256: inspected.sha256
    });
    const index = state.artifacts.findIndex(item => item.id === artifact.id);
    const id = `review-${randomUUID()}`;
    const review = {
      id,
      artifactId: artifact.id,
      decision: 'approved',
      note,
      correction: null,
      createdAt: new Date().toISOString(),
      actor: 'system',
      autoLocked: true,
      machineReviewed: true,
      delegatedByProfile: profileId,
      submittedArtifactSha256: inspected.sha256,
      artifactSha256: inspected.sha256
    };
    let transitioned = { ...state.artifacts[index], sha256: inspected.sha256 };
    if (transitioned.status !== 'awaiting_review') transitioned = transitionArtifact(transitioned, 'awaiting_review');
    transitioned = transitionArtifact(transitioned, 'locked', id);
    state.artifacts[index] = transitioned;
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);
    await commitJsonTransaction(root, `story-machine-lock-${id}`, [
      { path: join(root, 'reviews', `${id}.json`), value: review },
      { path, value: state }
    ]);
    return { review, storyArtifactId: artifact.id };
  });
  // These helpers acquire the same project lock themselves.  Run them after
  // the review transaction releases its lock; otherwise a simple-remake
  // auto-approval deadlocks against its own mutation lock.
  const segmentationRoute = await autoLockStoryPlanSegmentationCandidate(root, locked.storyArtifactId);
  const directorRoute = await routeLockedStoryPlan(root, locked.storyArtifactId);
  return { review: locked.review, segmentationRoute, directorRoute };
}
