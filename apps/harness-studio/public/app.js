import { STAGE_NAMES, stageResults, directionEditableArtifact } from './stage-workspace.js';
import { chineseInterfaceText, chineseProjectName, chineseSegmentName, chineseMediaName } from './chinese-copy.js';
import { creationJournal, readCreationJournal } from './creation-journal.js';
import { workspaceProgress, mediaKindOf, groupProjectMedia, reviewAudience } from './workspace-model.js';
const GATES = [
  ['Gate 0', '需求路由'], ['Gate 1', '导演创意'], ['Gate 2', '故事与镜头'], ['Gate 3', '资产审核'], ['Gate 4', '生成准备'], ['Gate 5', '成片审核']
];
const HUMAN_DECISIONS = [
  { id: 'creative', label: '创意方向确认', gate: 1, description: '锁定观众承诺、故事因果、人物与产品的戏剧功能。' },
  { id: 'paid_package', label: '付费生成包确认', gate: 4, description: '核对生成单元、提示词、资产绑定、模型能力、次数与实际费用。' },
  { id: 'final_acceptance', label: '最终成片接受', gate: 5, description: '只对完整剪辑、技术验收与创意结果作最终判断。' }
];
const BLOCKED_GENERATION_JOB_STATUSES = new Set(['QUEUED', 'RUNNING', 'PAUSED_REQUIRES_CONFIRMATION', 'NEEDS_RECONCILIATION']);
const WORKFLOW_CONTRACTS = [
  { id: 'narrative_block', label: '剧情段', description: '按完整场景与剧情结构划分，不把十五秒当机械切点。' },
  { id: 'generation_unit', label: '生成单元', description: '一次模型调用的实际镜头范围；未经验证不合并多镜。' },
  { id: 'asset_ledger', label: '资产账本', description: '每项资产只登记一个职责、来源、绑定与去重状态。' },
  { id: 'prompt_package', label: '提示词包', description: '提示词、资产引用、镜头、时长与模型参数绑定同一指纹。' },
  { id: 'review_decision', label: '决策记录', description: '三类关键人工决策与异常付费裁决分别留痕。' },
  { id: 'failure_return', label: '最小回流', description: '失败只回到根因阶段，冻结更早的已通过证据。' },
  { id: 'final_edit_manifest', label: '最终剪辑清单', description: '生成单元、顺序、裁切、音频、字幕与成片溯源。' }
];
const REVIEWABLE_TYPES = ['creative_brief', 'story_plan', 'spatial_control_model', 'project_asset', 'segment_asset', 'human_visual_exception', 'video_segment', 'final_edit'];
const PROJECT_TABS = [
  ['overview', '制作进度'], ['director', '导演说明'], ['workflow', '系统检查'], ['assets', '素材与成片'], ['production', '各段进度'], ['runs', '生成记录'], ['ledger', '运行诊断'], ['reviews', '我的确认'], ['evidence', '历史资料']
];
const PHASE_GATES = {
  intake: 0, creative_review: 1, story_plan_review: 2, asset_production: 3,
  generation_preflight: 4, generation_rework: 4, video_review: 5, delivery_preparation: 5, archived: 5
};
const ACTION_GATES = {
  capture_intake_route: 0, resolve_reference_role: 0, register_reference_videos: 0, register_mechanical_assets: 0, complete_director_interview: 0,
  prepare_creative_brief: 1, prepare_source_fact_analysis: 1,
  prepare_story_plan: 2, machine_review_story_plan: 2, run_source_comparator_audit: 2, propose_segmentation: 2,
  create_quality_rubric: 2, create_segment_contract: 2,
  prepare_project_assets: 3, prepare_segment_assets: 3, complete_observed_handoff: 3,
  prepare_generation_package: 4,
  prepare_mechanical_asset_prompt_package: 4, prepare_mechanical_libtv_canvas: 4, mechanical_canvas_ready: 4,
  reconcile_video_submit: 4, resolve_director_run: 1, verify_delivery: 5,
  classify_gate5_rejection: 5, submit_gate5_video_review: 5
};
const RETURN_STAGE_GATES = {
  intake: 0, source_analysis: 0, creative: 1, story: 2, segmentation: 2, storyboard: 2,
  assets: 3, prompt: 4, paid_approval: 4, generation: 4, editing: 5, technical_review: 5, gate5: 5
};
const RETURN_STAGE_LABELS = {
  intake: '需求输入', source_analysis: '原片事实分析', creative: '创意方向', story: '故事脚本',
  segmentation: '剧情分段', storyboard: '分镜控制', assets: '资产绑定', prompt: '提示词包',
  paid_approval: '付费审批包', generation: '生成单元', editing: '最终剪辑',
  technical_review: '技术验收', gate5: '最终创意验收'
};
const FAILURE_CATEGORY_LABELS = {
  prompt_fact_error: '提示词事实错误', prompt_asset_reference_error: '提示词资产引用错误',
  asset_missing: '资产缺失', asset_wrong_binding: '资产错绑', asset_extra: '多余资产',
  asset_generation_error: '资产生成错误', unsupported_parameter: '不支持的生成参数',
  missing_shot: '漏镜', wrong_shot_order: '镜头错序', identity_drift: '人物漂移',
  product_drift: '产品漂移', scene_drift: '场景漂移', continuity_break: '连续性中断',
  technical_output_failure: '技术输出失败', external_submission_unknown: '外部提交状态未知',
  user_creative_rejection: '创意未被接受', other: '其他明确问题'
};
const app = document.querySelector('#app');
const dialog = document.querySelector('#artifact-dialog');
const announcer = document.querySelector('#announcer');
let data = null;
let activeSlug = null;
let activeProjectTab = 'overview';
let selectedWorkspaceStage = null;
let projectDetailsOpen = false;
let projectQuery = '';
let csrfToken = '';
let sessionInfo = null;

// 用户界面只呈现中文和可读的审核结论。内部字段、模型标识、JSON、代码和
// 指纹仍由后台保存与校验，但不直接暴露给审核者。
const TECHNICAL_COPY = new Map([
  ['Harness', '导演工作台'], ['Studio', '工作台'], ['Gate', '阶段'], ['PRODUCTION', '制作'], ['FLOW', '流程'],
  ['LIVE', '运行中'], ['CURRENT', '当前'], ['STAGE', '阶段'], ['WEB', '网页'], ['AI', '智能'], ['TV', '画布'],
  ['Director', '导演'], ['Engine', '引擎'], ['JSON', '结构化资料'], ['ID', '编号'], ['SHA', '校验指纹'],
  ['PASS', '通过'], ['FAIL', '未通过'], ['READY', '已就绪'], ['COMPLETE', '已完成'], ['SUCCESS', '成功'],
  ['FAILED', '失败'], ['RUNNING', '执行中'], ['QUEUED', '排队中'], ['CANCELED', '已取消'], ['CANCELLED', '已取消'],
  ['UNCERTAIN', '待核对'], ['NEEDS_RECONCILIATION', '待核对'], ['MODEL_SUCCEEDED_UNCOMMITTED', '已生成待保存'],
  ['LibTV', '视频画布'], ['Seedance', '视频模型'], ['Kling', '视频模型'], ['Credits', '额度'],
  ['Prompt', '提示词'], ['Package', '生成包'], ['EXACT', '精确'], ['ORIGINAL', '原始'], ['FINGERPRINT', '任务指纹'],
  ['AVAILABLE', '可用'], ['REQUIRED', '必需'], ['OPTIONAL', '可选'], ['Passwordless', '免注册'], ['Shotlist', '镜头清单'],
  ['HTTP', '网络协议'], ['LAN', '局域网'], ['UUID', '项目编号'], ['API', '接口'], ['Skill', '能力模块'], ['Source', '来源'],
  ['One', '一个'], ['verified', '已验证'], ['next', '下一步'], ['step', '步骤'], ['unknown', '未知'], ['recorded', '已记录'],
  ['canonical', '正式'], ['creative', '创意'], ['story', '故事'], ['asset', '资产'], ['video', '视频'], ['image', '图片'],
  ['audio', '音频'], ['run', '运行'], ['model', '模型'], ['input', '输入'], ['output', '输出'], ['status', '状态'],
  ['project', '项目'], ['segment', '段落'], ['artifact', '产物'], ['current', '当前'], ['legacy', '历史兼容'],
  ['record', '记录'], ['unknowns', '未知项'], ['A', '第一项'], ['B', '第二项'], ['s', '秒'],
  ['Codex', '工作台'], ['CLI', '操作工具'], ['v1', '旧版'], ['v2', '第二版'], ['v3', '第三版'],
  ['VIP', '高级模型'], ['O3', '视频模型'], ['fps', '帧每秒'], ['taskId', '任务编号']
]);

function localizeTechnicalText(value) { return chineseInterfaceText(value); }

function localizeVisibleCopy() {
  for (const root of [app, dialog]) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while(walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest('script,style,textarea,input,pre,code,[data-original-text]')) continue;
      const translated = chineseInterfaceText(node.nodeValue);
      if (translated !== node.nodeValue) node.nodeValue = translated;
    }
    for (const element of root.querySelectorAll('[placeholder],[aria-label]')) {
      for (const key of ['placeholder','aria-label']) if (element.hasAttribute(key)) {
        const value = element.getAttribute(key); const translated = chineseInterfaceText(value);
        if (value !== translated) element.setAttribute(key, translated);
      }
    }
  }
}

const ARTIFACT_TYPE_COPY = new Map([
  ['creative_brief', '导演创意母版'], ['story_plan', '故事与镜头计划'], ['project_asset', '项目资产'],
  ['segment_asset', '段落资产'], ['spatial_control_model', '空间控制模型'], ['human_visual_exception', '人工视觉例外'],
  ['video_segment', '视频分段'], ['final_edit', '最终成片'], ['shot_narration', '逐镜讲戏本'],
  ['seedance_prompt', '视频生成提示词'], ['independent_creative_audit', '独立创意复核'], ['source_fact_analysis', '原片事实分析'],
  ['capability_manifest', '导演能力清单'], ['segmentation', '生成分段'], ['quality_rubric', '审片标准'],
  ['segment_contract', '段落执行合同'], ['handoff', '段间衔接记录'], ['rule', '经验规则'],
  ['narrative_block', '剧情段合同'], ['generation_unit', '生成单元合同'], ['asset_ledger', '资产账本'],
  ['prompt_package', '提示词包'], ['review_decision', '决策记录'], ['failure_return', '最小回流记录'],
  ['final_edit_manifest', '最终剪辑清单']
]);
const ASSET_TYPE_COPY = new Map([
  ['character_board', '人物基准图'], ['character_identity_single_view', '人物身份图'], ['scene_multiview', '场景多视图'],
  ['scene_overhead', '场景俯视图'], ['product_reference', '产品参考图'], ['story_prop', '故事道具图'],
  ['wardrobe_board', '服装基准图'], ['color_board', '色彩基准图'], ['initial_blocking', '初始调度图'],
  ['handoff_blocking', '衔接调度图'], ['camera_blocking', '机位调度图'], ['director_view_proxy', '导演视角预览'],
  ['dialogue_axis_board', '对话轴线图'], ['storyboard', '分镜图'], ['mannequin_grid', '动作结构图'],
  ['character_product_state', '人物与产品状态图'], ['depth_video_reference', '深度参考视频']
]);

const FIELD_LABELS = new Map([
  ['purpose', '项目目的'], ['audience', '核心观众'], ['desiredAudienceEffect', '观众变化'],
  ['logline', '主方向'], ['coreMeaning', '核心意义'], ['trigger', '触发事件'],
  ['storyOutline', '故事骨架'], ['scenePriorities', '关键画面证据'], ['emotionCurve', '情绪曲线'],
  ['cameraInstruction', '镜头说明'], ['cameraEvidence', '镜头证据'],
  ['performanceInstruction', '动作说明'], ['performanceEvidence', '动作证据'],
  ['responsibility', '资产职责'], ['mustNotControl', '禁止控制范围'], ['decision', '审核结论'],
  ['note', '审核备注'], ['correction', '返工要求'], ['routeDecision', '需求路由'],
  ['referenceRoleStatus', '参考素材角色'], ['shots', '镜头列表'], ['videoSegments', '视频分段'],
  ['characters', '人物关系'], ['assetPlan', '资产计划'], ['story', '故事结构'],
  ['creativeDecision', '导演决策'], ['continuityStrategy', '连续性策略'], ['duration', '时长'],
  ['model', '使用模型'], ['inputCount', '输入数量'], ['outputCount', '输出数量'],
  ['reason', '判断依据'], ['risk', '风险说明'], ['scope', '适用范围'], ['type', '资料类型'],
  ['schemaVersion', '资料版本'], ['targetDurationSec', '目标时长'], ['lockedConstraints', '已锁定约束'],
  ['directorEngineEvidence', '导演引擎依据'], ['kind', '资料用途'], ['sourceFacts', '原片事实'],
  ['route', '执行路线'], ['productDramaticFunction', '产品剧情功能'], ['mustKeep', '必须保留'],
  ['mustAvoid', '必须避免'], ['openingRationale', '开头理由'], ['endingPayoff', '结尾兑现'],
  ['centralConflict', '核心冲突'], ['coreTurn', '核心转折'], ['audienceQuestion', '观众问题']
]);
const PHASE_COPY = new Map([
  ['intake', '需求路由'], ['creative_review', '导演创意审核'], ['story_plan_review', '故事与镜头审核'],
  ['asset_production', '资产制作'], ['generation_preflight', '生成前检查'],
  ['generation_rework', '生成返工'], ['video_review', '成片审核'], ['delivery_preparation', '交付准备'],
  ['archived', '已归档']
]);
const GATE5_FAILURE_CATEGORY_OPTIONS = [
  ['prompt_fact_error', '提示词事实错误'], ['prompt_asset_reference_error', '提示词资产引用错误'],
  ['asset_missing', '资产缺失'], ['asset_wrong_binding', '资产错绑'], ['asset_extra', '多余资产'],
  ['asset_generation_error', '资产生成错误'], ['unsupported_parameter', '不支持的参数'],
  ['missing_shot', '漏镜'], ['wrong_shot_order', '镜头错序'], ['identity_drift', '人物漂移'],
  ['product_drift', '产品漂移'], ['scene_drift', '场景漂移'], ['continuity_break', '连续性断裂'],
  ['technical_output_failure', '技术输出故障'], ['user_creative_rejection', '创意方向不接受'],
  ['other', '其他（证据不足以细分）']
];
const GATE5_STAGE_OPTIONS = [
  ['source_analysis', '源视频分析'], ['creative', '创意方向'], ['story', '故事/脚本'],
  ['segmentation', '剧情分段'], ['storyboard', '分镜'], ['assets', '资产'], ['prompt', '提示词'],
  ['paid_approval', '付费包审批'], ['generation', '生成'], ['editing', '剪辑'],
  ['technical_review', '技术验收'], ['gate5', 'Gate 5 创意验收']
];
const RUN_STATUS_COPY = new Map([
  ['SUCCESS', '已完成'], ['FAILED', '失败'], ['FAILED_PRE_SUBMIT', '提交前失败'],
  ['UNCERTAIN', '待核对'], ['MODEL_SUCCEEDED_UNCOMMITTED', '已生成待保存'],
  ['READY_FOR_USER_CANVAS_GENERATION', '等待画布生成'], ['QUEUED', '排队中'],
  ['RUNNING', '执行中'], ['CANCELED', '已取消'], ['CANCELLED', '已取消'],
  ['PAUSED_REQUIRES_CONFIRMATION', '重启后待确认'], ['NEEDS_RECONCILIATION', '需要核对']
]);
const RUN_KIND_COPY = new Map([
  ['director_gate1', '导演创意草稿'], ['libtv_canvas_preparation', '视频画布准备'],
  ['libtv_video', '视频生成'], ['image_generation', '图片生成'], ['image', '图片生成'], ['video', '视频生成']
]);

function artifactTypeLabel(type) { return ARTIFACT_TYPE_COPY.get(type) ?? '审核资料'; }
function assetTypeLabel(type) { return ASSET_TYPE_COPY.get(type) ?? '视觉资产'; }
function statusLabel(status) {
  return { locked: '已锁定', awaiting_review: '待人工审核', rejected: '已退回', rework: '待返工', draft: '草稿',
    passed: '已通过', blocked: '已阻塞', pending: '待处理', invited: '待启用', active: '已启用', revoked: '已撤销' }[status] ?? '内部状态';
}
function phaseLabel(phase) { return PHASE_COPY.get(phase) ?? '当前阶段'; }
function runStatusLabel(status) { return RUN_STATUS_COPY.get(status) ?? '后台运行'; }
function runKindLabel(kind) { return RUN_KIND_COPY.get(kind) ?? '后台任务'; }
function projectDisplayName(project) { return chineseProjectName(project); }
function segmentDisplayName(segment) { return chineseSegmentName(segment); }

const LEDGER_EVENT_COPY = new Map([
  ['ledger.bootstrap', '账本开始观察'], ['preflight.ready', '生成前检查完成'],
  ['paid_approval.granted', '付费授权已记录'], ['generation.claimed', '生成任务已占用授权'],
  ['generation.submitted', '生成任务已提交'], ['generation.submission_uncertain', '提交状态待核对'],
  ['generation.reconciled', '提交状态已核对'], ['generation.succeeded', '生成成功'],
  ['generation.failed', '生成失败'], ['generation.interrupted', '生成中断'],
  ['generation.confirmed_not_submitted', '确认未提交'], ['quality_review.accepted', '成片审核接受'],
  ['quality_review.rejected', '成片审核退回'], ['generation_output_failure.recorded', '成片失败已归因'],
  ['generation_remediation.approved', '修复路线已批准'], ['execution_observation.recorded', '执行指标已取证'],
  ['delivery.finalized', '最终交付已封存']
]);

function ledgerEventLabel(type) { return LEDGER_EVENT_COPY.get(type) ?? '执行事件'; }

function ledgerStatusLabel(status) {
  return {
    not_observed: '未观察到', in_progress: '进行中', observed: '已记录', blocked: '需处理', finalized: '已完成'
  }[status] ?? '未知';
}

function ledgerStatusClass(status) {
  if (['observed', 'finalized'].includes(status)) return 'locked';
  if (status === 'blocked') return 'rejected';
  if (status === 'in_progress') return 'awaiting_review';
  return 'draft';
}

function compactObservedTime(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 60_000) return `${Math.round(value / 100) / 10} 秒`;
  if (value < 3_600_000) return `${Math.round(value / 6_000) / 10} 分钟`;
  return `${Math.round(value / 360_000) / 10} 小时`;
}

const COST_UNIT_COPY = new Map([['CNY', '人民币'], ['USD', '美元'], ['credits', '额度'], ['tasks', '任务']]);
const FAILURE_CATEGORY_COPY = new Map([
  ['prompt_fact_error', '提示词事实错误'], ['prompt_asset_reference_error', '提示词资产引用错误'],
  ['asset_missing', '资产缺失'], ['asset_wrong_binding', '资产错绑'], ['asset_extra', '资产多做'],
  ['asset_generation_error', '资产生成错误'], ['unsupported_parameter', '参数不受支持'],
  ['missing_shot', '漏镜'], ['wrong_shot_order', '镜头错序'], ['identity_drift', '人物漂移'],
  ['product_drift', '产品漂移'], ['scene_drift', '场景漂移'], ['continuity_break', '连续性中断'],
  ['technical_output_failure', '技术输出失败'], ['external_submission_unknown', '外部提交状态未知'],
  ['user_creative_rejection', '创意未获接受'], ['other', '其他已取证原因']
]);

function actualCostCopy(byUnit, perMinute = false) {
  const entries = Object.entries(byUnit ?? {}).filter(([, value]) => perMinute
    ? Number.isFinite(value.actualCostPerFinalMinute)
    : value.actual?.eventCount > 0);
  if (entries.length === 0) return '—';
  return entries.map(([unit, value]) => `${escapeHtml(COST_UNIT_COPY.get(unit) ?? '其他单位')} ${Number(perMinute ? value.actualCostPerFinalMinute : value.actual.amount).toLocaleString('zh-CN', { maximumFractionDigits: 3 })}${perMinute ? ' / 分钟' : ''}`).join(' · ');
}

function executionLedgerView(project) {
  const ledger = project.executionLedger;
  if (!ledger) return '<section><article class="panel empty">执行账本状态暂不可用。</article></section>';
  const consistency = {
    consistent: ['账本一致', 'locked'], not_initialized: ['尚未开始记录', 'draft'],
    pending_recovery: ['有本地事务待恢复', 'awaiting_review'], inconsistent: ['账本需要核对', 'rejected']
  }[ledger.consistency] ?? ['状态未知', 'draft'];
  const caveat = ledger.historyCoverage === 'since_observation_bootstrap'
    ? '该账本从首次接入后的观察点开始记录；更早阶段没有事件，不等于失败或未执行。'
    : ledger.historyCoverage === 'not_recorded'
      ? '这个项目还没有执行账本事件。后续发生受支持的执行动作时会开始记录。'
      : '这里展示账本实际观察到的事件；没有事件的环节不会被推断为已完成。';
  const consistencyNotice = ledger.consistency === 'pending_recovery'
    ? '<p class="notice warning-note">检测到未完成的本地事务。本页只读，不会自动重放；请从“下一步”按明确恢复操作处理。</p>'
    : ledger.consistency === 'inconsistent'
      ? '<p class="notice danger-note">事件、账本头或投影之间不一致。本页不会自行修复，也不会把当前显示当作完整交付证明。</p>' : '';
  const funnel = ledger.funnel.map((stage, index) => `<article class="ledger-stage ledger-${escapeHtml(stage.status)}"><div class="ledger-stage-index">${index + 1}</div><div><small>${escapeHtml(stage.label)}</small><strong>${escapeHtml(ledgerStatusLabel(stage.status))}</strong><span>${stage.observedEventCount} 条事件${stage.segmentIds.length ? ` · ${stage.segmentIds.length} 个分段` : ''}</span></div><i class="status ${ledgerStatusClass(stage.status)}">${escapeHtml(ledgerStatusLabel(stage.status))}</i></article>`).join('');
  const segments = ledger.segments.length
    ? ledger.segments.map(segment => `<article class="ledger-segment"><div><strong>${escapeHtml(segmentDisplayName({ id: segment.segmentId }))}</strong><span>${segment.eventCount} 条事件 · 最近：${escapeHtml(ledgerEventLabel(segment.stage))}</span></div><i class="status ${ledgerStatusClass(segment.status)}">${escapeHtml(ledgerStatusLabel(segment.status))}</i></article>`).join('')
    : '<p class="empty compact">尚未观察到分段执行事件。</p>';
  const events = ledger.latestEvents.length
    ? ledger.latestEvents.map(event => `<li><span><b>${escapeHtml(ledgerEventLabel(event.type))}</b><small>${event.segmentId ? escapeHtml(segmentDisplayName({ id: event.segmentId })) : '项目级'} · ${escapeHtml(new Date(event.occurredAt).toLocaleString('zh-CN', { hour12: false }))}</small></span><em>第 ${event.sequence} 条</em></li>`).join('')
    : '<li class="empty compact">暂无事件。</li>';
  const gate5 = ledger.gate5?.status === 'delivery_finalized' ? '已完成交付'
    : ledger.gate5?.status === 'partially_accepted' ? '已有接受记录，尚未最终交付'
      : ledger.gate5?.status === 'rejected' ? '有成片被退回' : '尚未观察到成片接受';
  const observed = ledger.observations;
  const observationMetrics = observed ? `<article class="panel ledger-observation-panel"><div class="focus-title"><div><div class="eyebrow">第二版取证指标</div><h2>只计算明确测量值</h2></div><span class="status ${observed.eventCount ? 'locked' : 'draft'}">${observed.eventCount ? `${observed.eventCount} 条` : '暂无'}</span></div><div class="ledger-metrics"><article><small>自动 / 人工取证</small><strong>${observed.derivation.automaticEventCount} / ${observed.derivation.manualEventCount}</strong><span>自动来源必须有 SHA 证据绑定</span></article><article><small>机器执行中位数</small><strong>${compactObservedTime(observed.timing.machineExecutionMs.medianMs)}</strong><span>${observed.timing.machineExecutionMs.sampleCount} 个样本</span></article><article><small>平台排队 / 人工等待</small><strong>${compactObservedTime(observed.timing.externalQueueMs.medianMs)} / ${compactObservedTime(observed.timing.humanWaitMs.medianMs)}</strong><span>分别统计，不从总时长倒推</span></article><article><small>已观察实际费用</small><strong class="ledger-gate5-copy">${actualCostCopy(observed.cost.byUnit)}</strong><span>不代表未接入费用或完整项目总成本</span></article></div><p class="notice">旧版事件或缺少证据的字段继续显示未知；系统不会根据事件时间差反推排队、人工等待或费用。</p></article>` : '';
  return `<section class="ledger-view"><div class="section-head"><div><div class="eyebrow">只读执行事实</div><h2>从生成前检查到最终交付</h2></div><span class="status ${consistency[1]}">${escapeHtml(consistency[0])}</span></div><p class="notice">${escapeHtml(caveat)}</p>${consistencyNotice}<div class="ledger-metrics"><article><small>账本事件</small><strong>${ledger.counts.events}</strong><span>最近序号 ${ledger.head.lastSequence || '—'}</span></article><article><small>付费任务占用</small><strong>${ledger.counts.paidClaims}</strong><span>不等同于成功输出</span></article><article><small>生成成功 / 失败</small><strong>${ledger.counts.successes} / ${ledger.counts.failures}</strong><span>不确定提交 ${ledger.counts.uncertainSubmissions}</span></article><article><small>最终接受状态</small><strong class="ledger-gate5-copy">${escapeHtml(gate5)}</strong><span>接受 ${ledger.counts.qualityAccepted} · 退回 ${ledger.counts.qualityRejected}</span></article></div>${observationMetrics}<div class="ledger-layout"><article class="panel"><div class="eyebrow">主流程漏斗</div><div class="ledger-funnel">${funnel}</div></article><aside class="side-stack"><article class="panel"><div class="eyebrow">逐段状态</div><div class="ledger-segments">${segments}</div></article><article class="panel"><div class="eyebrow">最近事件</div><ul class="ledger-events">${events}</ul></article></aside></div></section>`;
}

function activeProductionStatus(project) {
  const production = project.production ?? [];
  const currentSegmentId = project.status?.activeSegmentId ?? project.next?.segmentId ?? null;
  return production.find(item => item.segmentId === currentSegmentId)?.executionStatus
    ?? production[0]?.executionStatus
    ?? { tone: 'waiting', label: '等待处理', title: '等待确定下一步', detail: '项目还没有进入逐段制作，系统会先完成当前阶段需要的准备。', actionHint: '请查看当前唯一操作', updatedAt: null };
}

function runtimeStatusCard(status, compact = false) {
  const tone = ['running', 'blocked', 'ready', 'waiting'].includes(status?.tone) ? status.tone : 'waiting';
  const updated = status?.updatedAt ? `<span class="runtime-status-time">状态更新于 ${escapeHtml(new Date(status.updatedAt).toLocaleString('zh-CN', { hour12: false }))}</span>` : '';
  return `<article class="runtime-status runtime-${tone}${compact ? ' compact' : ''}" ${tone === 'running' ? 'aria-live="polite"' : ''}><div class="runtime-status-mark"><span></span></div><div class="runtime-status-copy"><div class="eyebrow">当前执行状态</div><h2>${escapeHtml(status?.title ?? '等待处理')}</h2><p>${escapeHtml(status?.detail ?? '系统正在确认下一步。')}</p><footer><b>${escapeHtml(status?.actionHint ?? '请查看当前操作')}</b>${updated}</footer></div><span class="status ${tone === 'blocked' ? 'rejected' : tone === 'ready' ? 'locked' : tone === 'running' ? 'awaiting_review' : 'draft'}">${escapeHtml(status?.label ?? '等待处理')}</span></article>`;
}

function readableArtifactContent(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return `<article class="readable-document">${escapeHtml(content)}</article>`; }
  const hiddenKeys = new Set(['id', 'projectId', 'segmentId', 'sourceSegmentId', 'sha256', 'tokenSha256', 'path', 'createdAt', 'updatedAt', 'revision', 'status']);
  const rows = Object.entries(parsed).filter(([key, value]) => !hiddenKeys.has(key) && value !== null && value !== '' && value !== undefined).slice(0, 18).map(([key, value]) => {
    const label = FIELD_LABELS.get(key) ?? '审核字段';
    const display = Array.isArray(value) ? value.slice(0, 6).map(item => typeof item === 'object' ? '已整理的结构化内容' : localizeTechnicalText(item)).join('、') : typeof value === 'object' ? '已整理的结构化内容' : localizeTechnicalText(value);
    return `<li><b>${escapeHtml(label)}</b><span>${escapeHtml(display)}</span></li>`;
  }).join('');
  return `<article class="visual-review-summary"><div class="eyebrow">可视化审核摘要</div><h3>系统已将后台资料整理为可读要点</h3><ul>${rows || '<li><span>该资料没有需要人工阅读的文字字段。</span></li>'}</ul></article>`;
}

function assetManifestVisual(manifest) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return `<section class="visual-review-summary"><div class="eyebrow">资产审核清单</div><h3>本段只使用以下已锁定资产</h3><div class="visual-review-grid">${items.map(item => `<article class="visual-review-card"><span class="status locked">已锁定</span><h4>${escapeHtml(assetTypeLabel(item.type))}</h4><p>${escapeHtml(item.responsibility ?? '用于当前镜头的指定视觉职责。')}</p><small>${item.scope === 'segment' ? '本段专用' : '项目共用'} · 未授权职责不会自动扩展</small></article>`).join('') || '<p class="empty">当前没有可审核资产。</p>'}</div></section>`;
}

const visibleCopyObserver = new MutationObserver(() => localizeVisibleCopy());
visibleCopyObserver.observe(app, { childList: true, subtree: true });
visibleCopyObserver.observe(dialog, { childList: true, subtree: true });

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function libTvCanvasUrl(projectUuid) {
  return `https://www.liblib.tv/canvas?projectId=${encodeURIComponent(projectUuid)}`;
}

function canvasLink(projectUuid, label, className = 'button primary') {
  return `<a class="${className}" href="${escapeHtml(libTvCanvasUrl(projectUuid))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function announce(message) {
  announcer.textContent = '';
  requestAnimationFrame(() => { announcer.textContent = message; });
}

function focusAfterRender(selector, message, center = false) {
  requestAnimationFrame(() => {
    if (center) centerHorizontalItem(selector);
    const element = document.querySelector(selector);
    element?.focus({ preventScroll: true });
    if (message) announce(message);
  });
}

function centerHorizontalItem(selector) {
  const element = document.querySelector(selector);
  const container = element?.parentElement;
  if (!element || !container) return;
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const elementCenter = container.scrollLeft + (elementRect.left - containerRect.left) + (elementRect.width / 2);
  container.scrollLeft = Math.max(0, elementCenter - (container.clientWidth / 2));
}

async function request(path, options) {
  const init = { ...(options ?? {}) };
  const method = String(init.method ?? 'GET').toUpperCase();
  // 网页内所有对象提交都由这一层统一标记为结构化请求。此前资产选择
  // 漏掉了这一项，服务端会在真正写入前拒绝请求，用户只能看到一个没有反馈的按钮。
  if (typeof init.body === 'string') {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    init.headers = headers;
  }
  if (!['GET', 'HEAD'].includes(method)) {
    const headers = new Headers(init.headers ?? {});
    headers.set('x-harness-csrf', csrfToken);
    init.headers = headers;
  }
  const response = await fetch(path, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? '请求失败');
  return payload;
}

function actionLabel(action) {
  const labels = {
    capture_intake_route: '开始 Gate 0 需求路由', resolve_reference_role: '确认参考素材角色', register_reference_videos: '登记原片输入', register_mechanical_assets: '登记替换素材',
    complete_director_interview: '完成 Gate 0 导演访谈',
    human_review: '完成当前人工审核', prepare_creative_brief: '准备 Gate 1 导演创意单', submit_creative_brief_review: '提交 Gate 1 审核候选', prepare_story_plan: '准备故事与镜头计划', machine_review_story_plan: '完成故事与镜头机审', submit_story_plan_review: '提交 Gate 2 审核候选',
    prepare_source_fact_analysis: '整理原片事实', prepare_project_assets: '准备项目资产', prepare_segment_assets: '准备段落资产', prepare_generation_package: '进入生成前准备', prepare_mechanical_asset_prompt_package: '处理资产与提示词', prepare_mechanical_libtv_canvas: '准备 LibTV 画布', mechanical_canvas_ready: '在 LibTV 画布内检查并生成',
    resolve_project_blocker: '处理项目阻塞', reconcile_video_submit: '核对生成提交', inspect_project_lock: '检查项目写锁',
    resolve_director_run: '恢复 Director Engine 运行',
    repair_project_evidence: '修复证据链', verify_delivery: '核验成片交付', create_segment_contract: '建立段落执行合同',
    create_quality_rubric: '建立审片标准', complete_observed_handoff: '记录段间衔接', propose_segmentation: '锁定生成分段',
    run_source_comparator_audit: '运行原片事实对照', register_required_inputs: '登记必需输入',
    classify_gate5_rejection: '补齐 Gate 5 退回根因', execute_gate5_failure_return: '执行 Gate 5 最小返工',
    prepare_gate5_rework_order: '冻结证据并建立返工作业',
    submit_gate5_video_review: '重新提交 Gate 5 成片审核'
  };
  return labels[action.id] ?? action.id;
}

function currentTaskCopy(action) {
  const copies = {
    resolve_director_run: ['上次文字准备未完成', '已有内容保留。可以先直接整理文字，再继续确认方向。'],
    capture_intake_route: ['先说清楚这次要做什么', '告诉系统这是复刻还是原创，以及最基本的目标。'],
    complete_director_interview: ['把故事重点聊清楚', '一次只回答一个会真正改变剧情的问题。'],
    prepare_creative_brief: ['生成第一版剧情方案', '系统会根据刚才的对话整理故事方向；生成后仍然由你确认。'],
    submit_creative_brief_review: ['确认剧情方向', '检查人物、冲突、转折和结尾是否符合刚才说好的重点。'],
    prepare_source_fact_analysis: ['先把原视频看清楚', '记录原片真正出现的动作、镜头和商品位置，避免后面凭感觉复刻。'],
    prepare_story_plan: ['把故事拆成可拍镜头', '系统会根据已经确认的剧情安排场景、动作和镜头顺序。'],
    machine_review_story_plan: ['完成故事与镜头机审', '这是简单复刻路线的机器检查；通过后系统会自动锁定，不增加人工审核。'],
    submit_story_plan_review: ['确认故事与镜头', '只确认镜头是否完整表达剧情，不需要处理生成参数。'],
    run_source_comparator_audit: ['检查是否忠于原片', '系统会逐项核对动作、顺序和商品位置，发现差异只退回对应镜头。'],
    propose_segmentation: ['确定视频怎样分段制作', '系统按剧情自然边界拆分，不会机械地每十五秒切一刀。'],
    create_quality_rubric: ['确定最终审片标准', '先说清楚什么算成功，后面每段视频都按同一套标准检查。'],
    create_segment_contract: ['锁定当前段的制作范围', '把这一段需要的镜头、资产和验收条件固定下来，避免后面越做越多。'],
    prepare_project_assets: ['补齐这一阶段真正需要的素材', '只导入当前镜头会用到的素材，不提前堆积无关资产。'],
    prepare_segment_assets: ['补齐当前段需要的素材', '只处理当前段缺少的内容，已经确认的素材继续复用。'],
    prepare_generation_package: ['检查生成前的全部内容', '系统会核对提示词、素材绑定、镜头时长和模型能力；通过后才显示付费确认。'],
    prepare_mechanical_asset_prompt_package: ['直接处理资产和提示词', '跳过创意、故事与分镜流程；准备好后停在 LibTV 画布，由你最终检查并点击生成。'],
    prepare_mechanical_libtv_canvas: ['把已处理素材放到 LibTV 画布', '片段、产品图和提示词已经就绪；这里只上传并连线，不会点击生成。'],
    mechanical_canvas_ready: ['在 LibTV 画布内最终检查', '全部素材和提示词已写后读回；请由你在画布内亲自点击生成。'],
    human_review: ['确认当前内容', '请只判断眼前这份内容是否符合要求；确认后系统会进入下一阶段。'],
    verify_delivery: ['确认最终成片可以交付', '核对完整视频、声音、字幕和技术检查，不把分段结果当成最终成片。']
  };
  return copies[action?.id] ?? [action ? actionLabel(action) : '当前没有待办事项', '系统会在出现下一项工作时明确提醒你。'];
}

function effectiveNextAction(project) {
  const nextAction = project.studioFlow?.nextAction ?? project.next?.actions?.[0];
  const artifacts = project.artifacts ?? project.status?.artifacts ?? [];
  const creativeDraft = artifacts.filter(item => item.type === 'creative_brief' && !item.invalidatedByScopeRevisionId && ['draft', 'rework'].includes(item.status))
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id))[0];
  if (nextAction?.id === 'answer_director_interview') {
    return {
      id: 'complete_director_interview',
      questionIds: nextAction.questionIds ?? [],
      reason: `还需要回答 ${project.directorInterview?.questionCount - project.directorInterview?.answeredCount || nextAction.questionIds?.length || 1} 个会改变创意方向的问题；完成后才准备 Gate 1 草稿任务合同。`
    };
  }
  if (nextAction?.id === 'prepare_creative_brief' && creativeDraft) {
    return { id: 'submit_creative_brief_review', artifactId: creativeDraft.id, reason: 'Gate 1 director draft is ready for machine checks and human review submission' };
  }
  if (nextAction?.id === 'prepare_creative_brief' && project.directorInterview?.status === 'awaiting_answers') {
    return {
      id: 'complete_director_interview',
      reason: `还需要回答 ${project.directorInterview.questionCount - project.directorInterview.answeredCount} 个会改变创意方向的问题；完成后才准备 Gate 1 草稿任务合同。`
    };
  }
  return nextAction;
}

function pendingCreativeRevision(project) {
  const artifacts = project.artifacts ?? project.status?.artifacts ?? [];
  const artifact = artifacts.filter(item => item.type === 'creative_brief' && !item.invalidatedByScopeRevisionId && ['draft', 'rework', 'awaiting_review'].includes(item.status))
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id))[0];
  if (!artifact) return null;
  const summary = project.creativeRevision?.id === artifact.id ? project.creativeRevision : null;
  return { artifact, summary };
}

function reasonLabel(reason) {
  const value = String(reason ?? '');
  const translations = [
    ['Gate 2 script, character bible, and shot plan must be reviewed before assets', 'Gate 2 的完整剧本、人物圣经和镜头计划必须先通过审核，才能开始资产制作。'],
    ['三项核心资产路线由系统自动整理依据，先生成一份轻量 Gate 2 故事与镜头草稿', '深度视频、首帧和产品图由系统自动编排，先生成一份轻量的阶段 2 故事与镜头草稿。'],
    ['all Gate 2 machine prechecks passed', 'Gate 2 的全部机器预检已经通过，可以提交当前故事与镜头候选。'],
    ['locked story plan and verified director capability manifest are ready', '故事计划与导演能力清单已经锁定，可以继续生成正式分段。'],
    ['all segment-referenced project assets must be human-locked', '所有被分段引用的项目资产都需要完成人工审核并锁定。'],
    ['segment contract and continuity gates are ready', '段落合同与连续性检查已经就绪。'],
    ['the required assets are locked and the generation package can now be prepared', '深度视频、首帧和产品图已经由系统校验并锁定，现在进入生成前准备。'],
    ['a machine-validated locked quality rubric is required before the segment contract', '建立段落执行合同前，需要先锁定通过机审的统一审片标准。'],
    ['the segment needs a production contract bound to the current locked segmentation', '当前段落需要绑定到最新锁定分段的生产合同。'],
    ['artifacts are awaiting human review', '有产物正在等待你完成人工审核。'],
    ['locked script and shotlist are required', '需要先锁定剧本与镜头清单。'],
    ['source-authority projects require adaptive observed-fact evidence before the Gate 2 story plan', '这是原片权威项目，阶段 2 故事与镜头规划前，必须先登记原视频中实际看见和听见的事实。'],
    ['register_required_inputs', '需要先登记当前任务所需的输入素材。'],
    ['video_input_and_creation_intent', '检测到视频输入和视频创作意图，已进入 Harness 制作流程。']
  ];
  return translations.find(([source]) => value === source)?.[1] ?? value;
}

function statusClass(status) { return ['locked', 'awaiting_review', 'rejected', 'rework', 'draft'].includes(status) ? status : 'draft'; }

function projectLegacy(project) {
  return Number(project.workflowVersion ?? 1) < 2 || !project.ingressPolicyVersion;
}

function projectRouteGap(project) {
  return !projectLegacy(project)
    && !project.routeDecision
    && project.status?.phase !== 'intake'
    && (project.status?.totalArtifacts > 0 || project.status?.artifacts?.length > 0);
}

function actionSurface(project, nextAction = project.next?.actions?.[0]) {
  if (projectRouteGap(project)) return {
    kind: 'repair', label: '需要先修复', title: '补齐 Gate 0 需求路由',
    description: '这个旧项目已经有后续产物，但没有可验证的 Gate 0 路由。先补齐任务目的和参考素材角色，再继续导演创作。'
  };
  if (nextAction?.id === 'resolve_director_run') return {
    kind: 'repair', label: '需要先恢复', title: actionLabel(nextAction),
    description: nextAction.runs?.every(run => run.status === 'MODEL_SUCCEEDED_UNCOMMITTED' && run.paidModelCallCompleted === true)
      ? '模型结果已有本地指纹和费用证据；网页只重做本地校验与草稿写入，不会再调用模型。'
      : '调用结果不确定，为避免重复计费，网页禁止自动重试。'
  };
  if (nextAction?.id === 'classify_gate5_rejection') return {
    kind: 'repair', label: '需要先补证', title: actionLabel(nextAction),
    description: '系统不会替你猜测退回原因。只有明确根因、责任阶段和最小回流阶段后，才会开放返工。'
  };
  if (nextAction?.id === 'prepare_gate5_rework_order') return {
    kind: 'repair', label: '建立返工作业', title: actionLabel(nextAction),
    description: '先把当前上游锁定证据和退回版本写入可恢复工作单；这一步只写本地合同，不调用模型、画布或付费生成。'
  };
  if (nextAction?.id === 'execute_gate5_failure_return') return {
    kind: 'repair', label: '最小返工', title: actionLabel(nextAction),
    description: `只从${RETURN_STAGE_LABELS[nextAction.returnStage] ?? '已确认责任阶段'}恢复；更早的锁定证据继续冻结，系统不会自动付费重试。`
  };
  const directorActions = new Set(['prepare_creative_brief', 'prepare_story_plan', 'prepare_source_fact_analysis', 'prepare_project_assets', 'prepare_segment_assets', 'complete_observed_handoff']);
  const externalActions = new Set(['reconcile_video_submit']);
  if (nextAction?.id === 'prepare_creative_brief' && project.directorInterview?.gate1DraftTask?.status === 'ready_for_director_engine') return {
    kind: 'director', label: '导演引擎', title: actionLabel(nextAction),
    description: 'Gate 0 输入已经绑定；网页可在明确授权后运行一次受预算限制的 Gate 1 导演草稿，并保留模型、费用、SHA 与失败证据。'
  };
  if (directorActions.has(nextAction?.id)) return {
    kind: 'director', label: '导演引擎', title: actionLabel(nextAction),
    description: '这一阶段需要理解素材、作出导演判断或生成专业内容。当前网页负责承接、校验和锁定；统一 Director Engine 尚未在网页内接通。'
  };
  if (externalActions.has(nextAction?.id)) return {
    kind: 'external', label: '外部画布', title: actionLabel(nextAction),
    description: '生成动作由主机上的 LibTV 执行；网页在每一次付费提交前展示精确指纹并要求当前操作者确认。'
  };
  return {
    kind: 'native', label: '网页内完成', title: nextAction ? actionLabel(nextAction) : '当前没有待执行动作',
    description: '这一步由 Harness Studio 调用既有服务完成，并保留版本、SHA、审核与状态转换证据。'
  };
}

function gateExplanation(project, index, name) {
  if (index === 0 && project.directorInterview?.status === 'awaiting_answers') {
    return `Gate 0 路由已记录，导演访谈尚未完成（${project.directorInterview.answeredCount}/${project.directorInterview.questionCount}）`;
  }
  if (index === 0 && projectLegacy(project) && !project.routeDecision) {
    return 'Legacy v1 项目创建时未要求 Gate 0 路由；这里只标记历史兼容，不把它伪装成已验证通过';
  }
  const verified = project.gateStates?.find(item => item.gate === index);
  if (verified?.status === 'passed') return `${name}已通过完整验证`;
  if (verified?.blockedReasons?.length) return verified.blockedReasons.join('；');
  if (verified?.status === 'blocked') return `${name}尚未通过，但底层状态没有给出具体阻塞原因`;
  return `${name}尚未完成`;
}

function projectGate(project) {
  if (projectRouteGap(project)) return 0;
  if (project.directorInterview?.status === 'awaiting_answers') return 0;
  if (pendingCreativeRevision(project)) return 1;
  const nextAction = effectiveNextAction(project);
  const mechanicalActionGate = ACTION_GATES[nextAction?.id];
  if (project.routeDecision?.executionClass === 'mechanical_asset_prompt' && Number.isInteger(mechanicalActionGate)) return mechanicalActionGate;
  const failureReturnGate = RETURN_STAGE_GATES[nextAction?.returnStage];
  if (Number.isInteger(failureReturnGate)) return failureReturnGate;
  const verifiedGate = project.gateStates?.find(item => item.status !== 'passed' && !(projectLegacy(project) && item.gate === 0));
  if (verifiedGate) return verifiedGate.gate;
  const artifacts = project.status?.artifacts ?? [];
  if (artifacts.some(item => ['video_segment', 'final_edit'].includes(item.type) && item.status === 'awaiting_review')) return 5;
  if (artifacts.some(item => ['project_asset', 'segment_asset', 'spatial_control_model'].includes(item.type) && item.status === 'awaiting_review')) return 3;
  if (artifacts.some(item => item.type === 'story_plan' && item.status === 'awaiting_review')) return 2;
  if (artifacts.some(item => item.type === 'creative_brief' && item.status === 'awaiting_review')) return 1;
  if (!project.routeDecision && !project.status?.routeDecision && project.next?.actions?.[0]?.id === 'capture_intake_route') return 0;
  const actionGate = ACTION_GATES[effectiveNextAction(project)?.id];
  if (Number.isInteger(actionGate)) return actionGate;
  return PHASE_GATES[project.status?.phase] ?? (project.status?.artifacts?.length ? 2 : 0);
}

function gatePassed(project, gate) {
  if (gate === 0 && project.directorInterview) return project.directorInterview.status === 'complete';
  const verified = project.gateStates?.find(item => item.gate === gate);
  if (verified) return verified.status === 'passed';
  const artifacts = project.artifacts ?? project.status?.artifacts ?? [];
  if (gate === 0) return project.routeDecision?.harnessRequired === true || project.status?.routeDecision?.harnessRequired === true;
  if (gate === 1) return artifacts.some(item => item.type === 'creative_brief' && item.status === 'locked');
  if (gate === 2) return artifacts.some(item => item.type === 'story_plan' && item.status === 'locked')
    && artifacts.some(item => item.type === 'segmentation' && item.status === 'locked')
    && Boolean(project.verifiedCapabilityManifestId ?? project.status?.verifiedCapabilityManifestId);
  if (gate === 3) return Array.isArray(project.production) && project.production.length > 0
    && project.production.every(item => item.assetManifestStatus === 'locked');
  if (gate === 4) return Array.isArray(project.segments) && project.segments.length > 0
    && project.segments.every(segment => project.runs?.some(run => run.kind === 'libtv_video' && run.status === 'SUCCESS' && run.segmentId === segment.id));
  if (gate === 5) return project.status?.phase === 'archived';
  return false;
}

function groupArtifacts(artifacts) {
  return artifacts.reduce((groups, artifact) => {
    const gate = artifact.type === 'creative_brief' ? 1 : artifact.type === 'story_plan' ? 2
      : ['project_asset', 'segment_asset', 'spatial_control_model', 'human_visual_exception'].includes(artifact.type) ? 3
        : ['video_segment', 'final_edit', 'handoff'].includes(artifact.type) ? 5
          : ['shot_narration', 'seedance_prompt', 'independent_creative_audit', 'rule'].includes(artifact.type) ? 4
            : ['source_fact_analysis', 'capability_manifest', 'segmentation', 'quality_rubric', 'segment_contract'].includes(artifact.type) ? 2 : 0;
    (groups[gate] ??= []).push(artifact); return groups;
  }, {});
}

function projectSidebar() {
  const projects = (data.projects ?? []).filter(project => !projectQuery || project.slug.toLowerCase().includes(projectQuery.toLowerCase()));
  const unreadable = projects.filter(project => project.error).length;
  const readable = projects.length - unreadable;
  const isOwner = sessionInfo?.principal?.role === 'owner';
  const accessLabel = isOwner ? '所有者 · 可查看全部项目' : `${sessionInfo?.principal?.label ?? '团队成员'} · 仅查看自己的项目`;
  return `<aside class="sidebar"><button class="brand" id="home"><span class="mark">▲</span><span>导演工作台</span></button>
    <button class="button primary create-project" id="new-project">＋ 新建视频项目</button>
    ${isOwner ? '<button class="button quiet team-button" id="open-team">管理团队专属链接</button>' : ''}
    <details class="sidebar-projects"><summary><span>全部项目</span><small>${readable} 个${unreadable ? ` · ${unreadable} 需修复` : ''}</small></summary><label class="project-search"><span class="sr-only">搜索项目</span><input id="project-search" type="search" placeholder="输入项目名称后按回车" value="${escapeHtml(projectQuery)}" /></label>
    <div class="nav-section"><div class="project-list">${projects.map(project => {
      if (project.error) return `<div class="project-item project-item-error" title="${escapeHtml(project.error)}"><strong>${escapeHtml(project.slug)}</strong><small class="error">状态不可读 · 不计入工作区</small></div>`;
      const selected = project.slug === activeSlug ? ' selected' : '';
      const action = effectiveNextAction(project);
      return `<button class="project-item${selected}" data-project="${escapeHtml(project.slug)}" aria-label="打开项目：${escapeHtml(projectDisplayName(project))}"><strong>${escapeHtml(projectDisplayName(project))}</strong><small>阶段 ${projectGate(project)} · ${escapeHtml(action ? actionLabel(action) : phaseLabel(project.status.phase))}</small></button>`;
    }).join('') || '<p class="empty">从第一个项目开始。</p>'}</div></div></details>
    <div class="sidebar-foot"><span class="meta">${escapeHtml(accessLabel)}</span><span>后台运行在所有者主机；本账号没有项目数量配额。</span></div></aside>`;
}

function executionPortfolioCard(portfolio) {
  if (!portfolio) return '';
  const initialized = portfolio.scope.initializedProjects;
  const aggregateEligible = portfolio.scope.aggregateEligibleProjects;
  const observation = {
    unavailable: ['暂无可计算基线', 'draft'], partial: ['部分项目已覆盖', 'awaiting_review'],
    attention_required: ['存在账本需处理', 'rejected'], observed: ['观察基线已覆盖', 'locked']
  }[portfolio.observation] ?? ['观察状态未知', 'draft'];
  const attention = portfolio.consistency.pendingRecovery + portfolio.consistency.inconsistent + portfolio.consistency.unreadable;
  const funnel = portfolio.funnel.map(stage => {
    const observed = stage.observedProjects + stage.inProgressProjects;
    const total = Math.max(1, aggregateEligible);
    const observedWidth = Math.round((observed / total) * 100);
    const blockedWidth = Math.round((stage.blockedProjects / total) * 100);
    return `<article class="portfolio-stage"><div><strong>${escapeHtml(stage.label)}</strong><span>${observed} 项目有记录 · ${stage.blockedProjects} 项目需处理</span></div><div class="portfolio-bar" aria-label="${escapeHtml(stage.label)}：${observed} 个项目有记录，${stage.blockedProjects} 个项目需处理"><i style="width:${observedWidth}%"></i><b style="width:${blockedWidth}%"></b></div><small>${stage.observedEventCount} 条事件</small></article>`;
  }).join('');
  const coverageNote = portfolio.scope.uncoveredProjects > 0
    ? `${portfolio.scope.uncoveredProjects} 个旧项目尚无账本，只计入覆盖缺口，不按失败处理。`
    : initialized > 0 ? '全部可读项目都有账本观察记录。' : '后续项目发生受支持的执行动作后，这里才会形成真实基线。';
  const attentionNote = attention > 0
    ? `<p class="notice danger-note">${attention} 个项目存在待恢复事务、账本不一致或项目状态不可读，已从事件总数和漏斗中排除；需要逐项处理后才能进入稳定基线。</p>` : '';
  const observed = portfolio.observations;
  const emptyTimingMetric = { sampleCount: 0, totalMs: 0, medianMs: null, samplesMs: [] };
  const generationTiming = observed.timingByStage.generation ?? {
    machineExecutionMs: emptyTimingMetric,
    externalQueueMs: emptyTimingMetric,
    humanWaitMs: emptyTimingMetric
  };
  const actualCostPerMinute = actualCostCopy(portfolio.efficiency.actualCostPerFinalMinuteByUnit, true);
  const failureTop = Object.entries(observed.failures.byCategory).sort((left, right) => right[1] - left[1]).slice(0, 5);
  const failureCopy = failureTop.length ? failureTop.map(([category, count]) => `${escapeHtml(FAILURE_CATEGORY_COPY.get(category) ?? '其他已取证原因')} ${count}`).join(' · ') : '尚无已取证失败根因';
  return `<section class="portfolio-baseline" aria-label="跨项目执行观察基线"><div class="section-head"><div><div class="eyebrow">全部可访问项目 · 只读聚合</div><h2>执行观察基线</h2></div><span class="status ${observation[1]}">${escapeHtml(observation[0])}</span></div><div class="portfolio-summary"><article><small>账本覆盖</small><strong>${portfolio.scope.ledgerCoveragePercent}%</strong><span>${initialized} / ${portfolio.scope.readableProjects} 个可读项目</span></article><article><small>生成成功 / 失败事件</small><strong>${portfolio.counts.successes} / ${portfolio.counts.failures}</strong><span>不确定提交 ${portfolio.counts.uncertainSubmissions}</span></article><article><small>成片接受 / 退回事件</small><strong>${portfolio.counts.qualityAccepted} / ${portfolio.counts.qualityRejected}</strong><span>最终交付 ${portfolio.counts.deliveries}</span></article><article><small>付费任务占用</small><strong>${portfolio.counts.paidClaims}</strong><span>事件数量不等于成功率</span></article></div><div class="portfolio-summary portfolio-observation-summary"><article><small>第二版 / 自动取证项目</small><strong>${portfolio.scope.projectsWithV2Observations} / ${portfolio.scope.projectsWithAutomaticObservations}</strong><span>共 ${aggregateEligible} 个可聚合项目</span></article><article><small>生成准备机器时间</small><strong>${compactObservedTime(generationTiming.machineExecutionMs.medianMs)}</strong><span>${generationTiming.machineExecutionMs.sampleCount} 个生成阶段样本</span></article><article><small>生成阶段排队 / 人工等待</small><strong>${compactObservedTime(generationTiming.externalQueueMs.medianMs)} / ${compactObservedTime(generationTiming.humanWaitMs.medianMs)}</strong><span>入场等其他阶段不会混入</span></article><article><small>已观察成本 / 成片分钟</small><strong class="ledger-gate5-copy">${actualCostPerMinute}</strong><span>未接入费用仍未知；付费返工 ${portfolio.efficiency.observedPaidRetry.perFinalMinute ?? '—'} 次 / 分钟</span></article></div><p class="notice">${escapeHtml(coverageNote)} 只有绑定证据的第二版观察才进入时间、费用和根因统计；已观察费用不代表完整项目总成本，实际、推导、估算费用及不同单位始终分开。</p>${attentionNote}<details class="portfolio-details"><summary>展开六段执行漏斗和失败根因</summary><div class="portfolio-funnel">${funnel}</div><p class="notice portfolio-failure-copy">${failureCopy}</p></details></section>`;
}

function overviewView() {
  const matching = (data.projects ?? []).filter(project => !projectQuery || project.slug.toLowerCase().includes(projectQuery.toLowerCase()));
  const projects = matching.filter(project => !project.error);
  const unreadable = matching.filter(project => project.error).length;
  const queue = projects.filter(project => effectiveNextAction(project)).slice(0, 6);
  const pending = projects.reduce((total, project) => total + project.status.pendingHumanGate.length, 0);
  const blocked = projects.filter(project => project.next?.blocked || projectRouteGap(project)).length;
  const teamCaption = sessionInfo?.principal?.role === 'owner' ? '局域网团队模式 · 你可查看全部项目' : `专属工作区 · ${sessionInfo?.principal?.label ?? '团队成员'}仅查看自己的项目`;
  const nextProject = queue[0] ?? projects[0] ?? null;
  const continueCard = nextProject ? `<button class="overview-choice-card continue" data-project="${escapeHtml(nextProject.slug)}"><span class="overview-choice-icon">→</span><small>继续上次工作</small><strong>${escapeHtml(projectDisplayName(nextProject))}</strong><p>${escapeHtml(effectiveNextAction(nextProject) ? actionLabel(effectiveNextAction(nextProject)) : '查看当前项目状态')}</p></button>` : '';
  return `<main class="main control-room simplified-overview"><header class="overview-decision"><div class="eyebrow">导演工作台</div><h1 tabindex="-1">今天想做什么？</h1><p>新建一个视频，或者继续上次没有完成的工作。其他资料默认收起。</p><div class="overview-choice-grid"><button class="overview-choice-card new" id="new-project-header"><span class="overview-choice-icon">＋</span><small>开始新项目</small><strong>新建一个视频</strong><p>选择复刻视频或原创视频</p></button>${continueCard}</div><span class="hero-caption"><i></i> ${escapeHtml(teamCaption)}</span></header>
    <details class="overview-disclosure"><summary><span><strong>查看全部项目</strong><small>${projects.length} 个可用${pending ? ` · ${pending} 项等待判断` : ''}</small></span><i>⌄</i></summary><div class="overview-disclosure-body"><section class="project-grid">${projects.map(projectCard).join('') || '<article class="panel empty">还没有项目。</article>'}</section></div></details>
    <details class="overview-disclosure"><summary><span><strong>查看运营数据与系统状态</strong><small>${blocked + unreadable ? `${blocked + unreadable} 项需要处理` : '当前没有硬阻塞'}</small></span><i>⌄</i></summary><div class="overview-disclosure-body"><div class="overview-metrics compact"><article><div><b>${projects.length}</b><span>可操作项目</span></div></article><article><div><b>${pending}</b><span>等待人工判断</span></div></article><article><div><b>${blocked + unreadable}</b><span>需要排除阻塞</span></div></article></div>${executionPortfolioCard(data.executionPortfolio)}<button class="button quiet" id="show-foundation">了解工作流原则</button></div></details></main>`;
}

function projectCard(project) {
  const action = effectiveNextAction(project);
  const pending = project.status.pendingHumanGate.length;
  const gate = projectGate(project);
  const progress = Math.round(((gate + 1) / GATES.length) * 100);
  const completed = project.status.phase === 'archived';
  const routeGap = projectRouteGap(project);
  return `<button class="project-card gate-tone-${gate}" style="--project-progress:${progress}%" data-project="${escapeHtml(project.slug)}" aria-label="打开项目：${escapeHtml(projectDisplayName(project))}"><span class="project-visual" aria-hidden="true"><span class="project-orb"><i>阶段${gate}</i></span><span class="project-visual-label">${escapeHtml(GATES[gate]?.[1] ?? '项目')}</span></span><span class="meta">阶段 ${gate} · ${escapeHtml(phaseLabel(project.status.phase))}</span><strong>${escapeHtml(projectDisplayName(project))}</strong><p>${escapeHtml(routeGap ? '旧项目缺少阶段 0 路由，需要先修复' : action ? actionLabel(action) : '当前流程已完成')}</p><div class="project-progress" aria-hidden="true"><i></i></div><footer><span class="status ${routeGap || project.next?.blocked ? 'rejected' : pending ? 'awaiting_review' : 'locked'}">${routeGap ? '需修复' : project.next?.blocked ? '阻塞' : pending ? `${pending} 待审` : completed ? '已完成' : '已就绪'}</span><span>打开项目 <b>↗</b></span></footer></button>`;
}

function workspaceTrialKey(project) { return `harness-workspace-trial:${sessionInfo?.principal?.id ?? 'local'}:${project.slug ?? project.status.projectId}`; }
function projectView(project) {
  const trial = localStorage.getItem(workspaceTrialKey(project)) !== 'disabled';
  const html = trial ? projectViewInner(project) : legacyProjectViewInner(project);
  return html.replace('</header>', `</header><div class="workspace-trial"><button class="button quiet" id="toggle-workspace-trial">${trial ? '切回原版布局' : '试用简洁工作台'}</button><small>仅切换这个项目的显示，不改变制作状态。</small></div>`);
}

function renderGateRail(project, gate) {
  const progress = workspaceProgress(project, gate);
  return progress.steps.map(step => `<button class="user-step ${step.active ? 'active' : ''}" data-workspace-stage="${step.index}" ${step.active ? 'aria-current="step"' : ''}><b>${step.index + 1}</b><span>${step.label}</span><small>${step.notApplicable ? '本路线无需处理' : step.active ? progress.complete ? '已交付' : '当前步骤' : step.verified ? '已核验' : '查看进度'}</small></button>`).join('');
}
function projectVisibleStepProgress(project, gate) { return workspaceProgress(project, gate); }

function stableWorkflowRoute(project) {
  if (project.studioFlow?.routeKind === 'remake') return {
    id: 'remake', label: '复刻路线',
    description: '原片是事实权威；逐镜拆解动作、构图、台词、身份与产品绑定，并持续做源对照。'
  };
  if (project.studioFlow?.routeKind === 'unresolved') return {
    id: 'unresolved', label: '路线待确认',
    description: '参考素材角色尚未锁定；在确认它是事实权威还是只提供灵感前，不进入原创或复刻承诺。'
  };
  const referenceRole = project.routeDecision?.referenceRoleStatus ?? project.status?.routeDecision?.referenceRoleStatus;
  if (referenceRole === 'authority') return {
    id: 'remake', label: '复刻路线',
    description: '原片是事实权威；逐镜拆解动作、构图、台词、身份与产品绑定，并持续做源对照。'
  };
  if (!project.routeDecision || ['unresolved', undefined].includes(referenceRole)) return { id: 'unresolved', label: '立项待完成', description: '继续保存的需求；系统不会默认改为原创。' };
  return {
    id: 'original', label: '原创路线',
    description: referenceRole === 'inspiration'
      ? '参考素材只提供灵感；系统强化概念提案、故事结构与创意探索，不迁移原片事实。'
      : '从业务想法出发；系统强化需求引导、概念提案、故事结构与创意探索。'
  };
}

function decisionState(project, decision) {
  const projected = project.studioFlow?.humanDecisions?.find(item => item.id === decision.id);
  if (projected) {
    return {
      accepted: { label: '已确认', tone: 'locked' },
      accepted_and_archived: { label: '已接受并封存', tone: 'locked' },
      awaiting_user: { label: decision.id === 'final_acceptance' ? '整片待接受' : '当前决策', tone: 'awaiting_review' },
      package_ready_not_authorized: { label: '包已就绪，未授权', tone: 'awaiting_review' },
      not_ready: { label: '尚未到达', tone: 'draft' }
    }[projected.status] ?? { label: '状态未知', tone: 'draft' };
  }
  return { label: '等待服务投影', tone: 'draft' };
}

function workflowContractState(project, contractId) {
  const projected = project.studioFlow?.contracts?.[contractId];
  if (projected) {
    if (projected.evidenceMode === 'exact_contract') return projected.status === 'locked'
      ? { label: '已登记并锁定', tone: 'locked', exact: true }
      : { label: statusLabel(projected.status), tone: statusClass(projected.status), exact: true };
    if (projected.evidenceMode === 'legacy_mapping') return { label: '仅有旧合同映射', tone: 'draft', exact: false };
    return { label: '尚未登记', tone: 'draft', exact: false };
  }
  return { label: '无法验证新合同', tone: 'draft', exact: false };
}

function stableWorkflowPanel(project) {
  const route = stableWorkflowRoute(project);
  const decisions = HUMAN_DECISIONS.map((decision, index) => {
    const state = decisionState(project, decision);
    return `<article class="decision-card"><span class="decision-index">${index + 1}</span><div><small>关键人工决策类型</small><strong>${escapeHtml(decision.label)}</strong><p>${escapeHtml(decision.description)}</p></div><i class="status ${state.tone}">${escapeHtml(state.label)}</i></article>`;
  }).join('');
  const contracts = WORKFLOW_CONTRACTS.map(contract => {
    const state = workflowContractState(project, contract.id);
    return `<article class="contract-card"><div><small>${state.exact ? '新版正式合同' : '兼容状态'}</small><strong>${escapeHtml(contract.label)}</strong></div><span class="status ${state.tone}">${escapeHtml(state.label)}</span><p>${escapeHtml(contract.description)}</p></article>`;
  }).join('');
  return `<section class="panel stable-workflow-panel" aria-label="新版 Harness 稳定工作流"><div class="focus-title"><div><div class="eyebrow">新版 Harness / 共用主干</div><h2>六个机器检查点，三类关键人工决策</h2></div><span class="route-badge route-${route.id}">${escapeHtml(route.label)}</span></div><p class="stable-route-copy">${escapeHtml(route.description)} 原创与复刻路线共用状态机、资产账本、提示词编译、审计、付费边界、最终剪辑和成片验收。剧情段决定叙事，生成单元决定调用，两者不得混为同一个机械切分。</p><div class="decision-flow">${decisions}</div><p class="notice compact">当前仍处于只读兼容投影：旧项目可能继续出现故事、资产或分段审片操作；每个付费生成包也必须逐次确认。“三类”不是承诺整个旧项目只点击三次。</p><details class="contract-disclosure"><summary>查看七项流程合同与迁移状态</summary><div class="contract-grid">${contracts}</div><p class="notice compact">“旧合同映射”只表示现有证据可以定位到相近阶段，不代表新版合同已经落盘。工作台不会把文件存在、机器通过、分段生成和最终成片接受混为一谈。</p></details></section>`;
}

function workflowRoutePanel(project) {
  const view = project.workflowProfileView;
  if (!view) return '';
  const current = view.profile;
  const rec = view.recommendation;
  if (!current) {
    const eligible = view.profiles.filter(item => item.available !== false);
    if (!eligible.length) return '<p class="notice">请先补全项目需求，再选择制作路线。</p>';
    const recommended = eligible.find(item => item.id === rec?.id) ?? eligible[0];
    const alternatives = view.profiles.filter(item => item.id !== recommended.id && item.available !== false).map(item => `<button class="route-alternative" data-set-profile="${item.id}"><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.summary)}</small></span><b>选择</b></button>`).join('');
    return `<article class="single-task-card route-decision-card"><div class="single-task-kicker"><span>现在只做这一件事</span><i>系统已完成判断</i></div><h2>建议使用“${escapeHtml(recommended.label)}”</h2><p class="single-task-reason">${escapeHtml(rec.reason)}</p><div class="single-task-action"><button class="button primary" data-set-profile="${recommended.id}" data-selected-by="system_recommendation">使用这个方案，继续下一步</button><small>确认后才会进入制作；这里不会生成媒体或产生费用。</small></div>${alternatives ? `<details class="alternative-routes"><summary>这个建议不合适？查看其他方案</summary><div>${alternatives}</div></details>` : ''}</article>`;
  }
  const hasLockedCreativeDirection = (project.artifacts ?? []).some(item => item.type === 'creative_brief' && item.status === 'locked');
  const assetPanel = current
    ? (current.id === 'simple_remake'
        ? remakeControlPanel(project, view)
        : current.id === 'original' && !hasLockedCreativeDirection
          ? originalConversationPanel()
          : assetSelectorPanel(project, view))
    : '';
  const switchNotice = current && !view.canSwitch ? `<p class="notice compact">${escapeHtml(view.switchBlockReason)}</p>` : '';
  return `<article class="panel workflow-route"><div class="focus-title"><div><div class="eyebrow">当前方案</div><h2>${escapeHtml(current.label)}</h2></div><span class="status locked">使用中</span></div>${switchNotice}${assetPanel}</article>`;
}

function originalConversationPanel() {
  return `<section class="original-conversation-next"><div><div class="eyebrow">原创剧情立项</div><h3>先把故事聊清楚，暂时不选资产。</h3><p>人物图、场景图和分镜数量要等剧情方向确认后再由系统建议。现在提前选择，只会增加无效问题和多余成本。</p></div><button class="button primary" id="continue-original-chat">继续聊故事</button></section>`;
}

const ASSET_VISUAL = {
  depth_video: { glyph: '深', tone: 1 },
  first_frame: { glyph: '首', tone: 2 },
  product_image: { glyph: '品', tone: 3 },
  character_reference: { glyph: '人', tone: 4 },
  character_board: { glyph: '视', tone: 4 },
  scene_image: { glyph: '景', tone: 5 },
  prop_image: { glyph: '具', tone: 3 },
  storyboard: { glyph: '镜', tone: 2 },
  voice_reference: { glyph: '声', tone: 1 }
};

function remakeControlPanel(project, view) {
  const selection = view.remakeControlSelection;
  const editable = view.remakeControlsEditable !== false;
  const selected = new Set(selection?.selectedModes ?? []);
  const options = view.remakeControlOptions?.options ?? [];
  const firstFrameOptions = view.remakeControlOptions?.firstFrameChoice?.options ?? [];
  const cards = options.map((item, index) => {
    const checked = selected.has(item.id);
    const glyph = ['镜', '深', '原', 'K'][index] ?? '控';
    return `<label class="asset-option remake-mode-option${checked ? ' selected' : ''}">`
      + `<input type="checkbox" data-remake-mode="${escapeHtml(item.id)}" ${checked ? 'checked' : ''} ${editable ? '' : 'disabled'}>`
      + `<span class="asset-thumb tone-${index + 1}" aria-hidden="true">${glyph}</span>`
      + `<span class="asset-option-body"><span class="asset-option-title">${escapeHtml(item.label)}</span>`
      + `<small class="asset-summary">${escapeHtml(item.description)}</small></span>`
      + '<span class="asset-check" aria-hidden="true">✓</span></label>';
  }).join('');
  const dispatch = view.remakeDispatch;
  const rows = (dispatch?.rows ?? []).map(item => `<article class="remake-dispatch-row"><div><strong>${escapeHtml(item.label)}</strong><span class="chip">${item.requirement === 'required' ? '必须' : '建议'}</span></div><p>${escapeHtml(item.reason)}</p><small><b>它负责：</b>${escapeHtml(item.ownerDimension)}　<b>不负责：</b>${escapeHtml((item.ignore ?? []).join('、'))}</small></article>`).join('');
  const firstFramePolicy = selection?.firstFramePolicy ?? 'none';
  const firstFrameChooser = firstFrameOptions.length
    ? `<fieldset class="koc-first-frame-choice"><legend>仅 口播人物复刻：首帧图策略</legend><div class="choice-grid">${firstFrameOptions.map(item => `<label class="choice-card"><input type="radio" name="kocFirstFramePolicy" value="${escapeHtml(item.id)}" ${firstFramePolicy === item.id ? 'checked' : ''} ${editable ? '' : 'disabled'}><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></label>`).join('')}</div></fieldset>`
    : '';
  const reverseCopy = selection
    ? (selection.promptPolicy === 'koc_source_bound_identity_replacement'
        ? '已安排 口播人物复刻：全量抽取 A-roll、精确整头匿名、按首帧选择准备身份资产，并在准备屏障通过后并行制作各片段。'
        : selection.requiresReversePrompt
          ? '已安排逆向拆解：分镜图或深度视频需要先还原原片镜头语言，再编译正式生成提示词。'
          : '只使用官方原视频替换：不反推原片提示词，只生成替换指令与资产绑定。')
    : '分镜图、深度视频和原视频可组合；口播人物复刻为独立流程。系统会根据选择自动安排资产、提示词、并行任务和审查。';
  const result = selection
    ? `<section class="remake-dispatch"><div class="asset-selection-result success"><strong>${selection.legacyInferred ? '已从旧项目资产记录还原控制方式' : '复刻控制方式已保存'}</strong><span>${escapeHtml(reverseCopy)}</span></div><div class="eyebrow">系统自动生成的资产任务单</div>${rows || '<p class="notice compact">本次只需要原视频，不额外制造图片资产。</p>'}<p class="notice compact">这只是制作计划，不会生成图片或视频，也不会产生费用。资产编号和 @图/@视频绑定由系统在编译阶段完成。</p></section>`
    : `<p class="asset-selection-help">${escapeHtml(reverseCopy)} 保存这一步不会生成媒体或产生费用。</p>`;
  const action = editable
    ? `<button class="button ${selection ? '' : 'primary'}" id="save-remake-controls">${selection ? '更新控制方式' : '保存并生成资产任务单'}</button>`
    : '<span class="status locked">项目已进入后续制作，按原记录只读显示</span>';
  return `<div class="asset-selector remake-control-selector"><div class="focus-title"><div><div class="eyebrow">复刻视频控制方式</div><h3>只选你要用的方式，可自由组合；KOC 为独立流程</h3></div><span class="status ${selection ? 'locked' : 'awaiting_review'}">${selection ? '已记录' : '待选择'}</span></div><div class="asset-option-grid">${cards}</div>${firstFrameChooser}${result}<div class="focus-action asset-selection-action"><div><strong>${selection ? '后台已按选择安排资产' : '选择至少一种控制方式'}</strong><span>分镜图省成本；深度视频稳动作；原视频走原生替换；KOC 只处理 A-roll 并回插原片。</span></div>${action}</div></div>`;
}

function verifiedPreparedCanvasNodes(project) {
  return (project.production ?? []).filter(item => item.canvasPreparation?.status === 'READY_FOR_USER_CANVAS_GENERATION'
    && item.canvasPreparation?.prepVerification === 'PASS'
    && !(item.canvasPreparation?.verificationDiffs?.length)
    && item.canvasPreparation?.projectUuid
    && item.canvasPreparation?.nodeName);
}

function canvasPreparationIsStale(project) {
  // 已通过写后读回的画布节点始终优先显示。项目后续段落仍在准备，
  // 不应把当前可执行段误判为“旧画布”。
  if (verifiedPreparedCanvasNodes(project).length) return false;
  const action = effectiveNextAction(project)?.id;
  return new Set([
    'prepare_story_plan', 'submit_story_plan_review', 'propose_segmentation',
    'create_quality_rubric', 'create_segment_contract', 'prepare_project_assets',
    'prepare_segment_assets', 'prepare_generation_package', 'repair_project_evidence',
    'prepare_gate5_rework_order', 'execute_gate5_failure_return', 'classify_gate5_rejection', 'submit_gate5_video_review'
  ]).has(action);
}

function preparedCanvasNodes(project) {
  return verifiedPreparedCanvasNodes(project);
}

function canvasNodeGuide(project, compact = false) {
  if (pendingCreativeRevision(project)) return '';
  if (canvasPreparationIsStale(project)) {
    return `<section class="canvas-node-guide${compact ? ' compact' : ''}" aria-label="视频画布准备状态"><div class="canvas-node-guide-heading"><div><div class="eyebrow">画布准备状态</div><strong>正在按当前生成单元合同重建画布</strong></div><span class="status awaiting_review">暂不可打开</span></div><p>旧画布节点只保留为历史记录，不能继续生成。当前生成单元完成提示词包、资产绑定和控制能力检查后，这里才会显示新的节点名称。</p></section>`;
  }
  const nodes = preparedCanvasNodes(project);
  if (!nodes.length) return '';
  const rows = nodes.map((item, index) => `<div class="canvas-node-row"><span>第 ${index + 1} 段画布节点名称</span><code class="canvas-node-name">${escapeHtml(item.canvasPreparation.nodeName)}</code><button class="button small" type="button" data-copy-canvas-node="${escapeHtml(item.canvasPreparation.nodeName)}">复制名称</button></div>`).join('');
  return `<section class="canvas-node-guide${compact ? ' compact' : ''}" aria-label="视频画布节点位置"><div class="canvas-node-guide-heading"><div><div class="eyebrow">画布内定位</div><strong>打开画布后，按以下名称确认当前节点</strong></div><span class="status locked">已准备</span></div><p>这是已准备好的当前段视频节点；该名称用于在节点较多时准确辨认本段，不需要逐个查看其它节点。</p><div class="canvas-node-list">${rows}</div></section>`;
}

function sourceStoryboardCard(project) {
  const storyboard = project.sourceStoryboard;
  if (!storyboard?.panels?.length) return '';
  const templateCount = storyboard.templateBoards?.length ?? 0;
  const detail = templateCount
    ? `已完成 ${templateCount} 张逐格转换的黑白线稿故事板，分别覆盖两段测试。`
    : '当前只展示原片真实截帧；尚未逐格转换为黑白线稿。';
  const templateStatus = storyboard.templateReviewStatus ?? (templateCount ? '整板已生成' : '尚未转换');
  return `<section class="source-storyboard-card" aria-label="原片动作分镜"><div><div class="eyebrow">原片动作控制</div><strong>原片分镜与线稿故事板</strong><p>前 ${escapeHtml(String(storyboard.lockedDurationSeconds ?? 31))} 秒已按 ${storyboard.panels.length} 格拆解：每格都写明真实时段、动作终点与切镜逻辑。${detail} 线稿由原片对应截帧逐格转换，不会凭文字重新编画面。</p></div><div class="source-storyboard-actions"><span class="status locked">${escapeHtml(templateStatus)}</span><button class="button" id="open-source-storyboard">查看原片与线稿</button></div></section>`;
}

function assetSelectorPanel(project, view) {
  const defaults = view.assetDefaults ?? { required: [], recommended: [], optional: [] };
  const selected = new Set(project.assetSelection?.selected ?? [...defaults.required, ...defaults.recommended]);
  const userProvided = new Set(project.assetSelection?.userProvided ?? []);
  const selectionSaved = project.assetSelection?.profileId === view.profile?.id;
  const cards = (view.assetCatalog ?? []).map(item => {
    const required = defaults.required.includes(item.id);
    const checked = selected.has(item.id);
    const visual = ASSET_VISUAL[item.id] ?? { glyph: '资', tone: 1 };
    return `<label class="asset-option${checked ? ' selected' : ''}${required ? ' required' : ''}">`
      + `<input type="checkbox" data-asset-id="${item.id}" ${checked ? 'checked' : ''} ${required ? 'disabled' : ''}>`
      + `<span class="asset-thumb tone-${visual.tone}" aria-hidden="true">${visual.glyph}</span>`
      + '<span class="asset-option-body">'
      + `<span class="asset-option-title">${escapeHtml(item.label)}${required ? '<i class="req">必需</i>' : ''}</span>`
      + `<small class="asset-summary">${escapeHtml(item.summary)}</small>`
      + '<span class="asset-chips">'
      + `<span class="chip">${escapeHtml(item.role)}</span>`
      + `<span class="chip">${escapeHtml(item.derived)}</span>`
      + (userProvided.has(item.id) ? '<span class="chip">已导入</span>' : item.paidImageTasks ? `<span class="chip paid">付费 ${item.paidImageTasks} 次</span>` : '')
      + '</span></span>'
      + '<span class="asset-check" aria-hidden="true">✓</span>'
      + '</label>';
  }).join('');
  const estimate = project.assetSelection?.estimatedPaidImageTasks ?? (view.assetCatalog ?? []).filter(item => selected.has(item.id) && !userProvided.has(item.id)).reduce((sum, item) => sum + (item.paidImageTasks ?? 0), 0);
  const labels = (view.assetCatalog ?? []).filter(item => selected.has(item.id)).map(item => item.label).join('、');
  const prepared = pendingCreativeRevision(project) ? null : preparedCanvasNodes(project)[0];
  const nextStep = prepared?.canvasPreparation?.projectUuid
    ? canvasLink(prepared.canvasPreparation.projectUuid, '下一步：打开视频画布')
    : '<button class="button" id="show-current-task">返回当前任务</button>';
  const savedNotice = selectionSaved
    ? `<div class="asset-selection-result success" role="status"><strong>资产选择已保存</strong><span>将按「${escapeHtml(labels)}」控制后续尚未锁定的制作内容；预计付费图片 ${estimate} 次。</span>${prepared ? '<small>当前项目的视频画布已经准备完成，保存不会重复上传、不会重新准备画布，也不会产生费用。</small>' : ''}</div>`
    : '<p class="asset-selection-help">保存后，系统会把这份选择写入项目；不会立即生成图片或视频，也不会产生费用。</p>';
  return `<div class="asset-selector"><div class="focus-title"><div><div class="eyebrow">本项目需要哪些资产</div><h3>点选即可，不必填写编号</h3></div><span class="asset-estimate" id="asset-estimate">预计付费图片 ${estimate} 次</span></div><div class="asset-option-grid">${cards}</div>${savedNotice}${canvasNodeGuide(project, true)}<div class="focus-action asset-selection-action"><div><strong>${selectionSaved ? '已记录本项目的资产范围' : '先保存资产范围，再由系统按此范围继续'}</strong><span>${selectionSaved ? '如需调整，改选后再次保存即可。' : '系统不会把这一步当作付费生成，也不会静默扩大资产范围。'}</span></div><div class="asset-selection-buttons"><button class="button ${selectionSaved ? '' : 'primary'}" id="save-asset-selection">${selectionSaved ? '更新资产选择' : '保存资产选择并显示下一步'}</button>${selectionSaved ? nextStep : ''}</div></div></div>`;
}

function creativeRevisionCard(revision) {
  const summary = revision?.summary;
  const highlights = summary?.reviewHighlights?.length ? summary.reviewHighlights : [
    '每一项测试都先交代可复检参照，再完成对应压力动作，最后硬切回同一位置复检。'
  ];
  const cards = highlights.map((item, index) => `<article class="visual-review-card"><span class="status awaiting_review">验证 ${index + 1}</span><p>${escapeHtml(item)}</p></article>`).join('');
  return `<article class="panel visual-review-summary creative-revision-card"><div class="focus-title"><div><h3>这次调整的内容</h3></div><span class="status awaiting_review">待确认</span></div><p>${escapeHtml(summary?.storyDirection ?? '旧画布已经停止作为当前方案使用；本轮从新的导演创意开始。')}</p><div class="visual-review-grid">${cards}</div><p class="notice compact">确认后，系统会把剧情结构与实际生成单元分别登记；旧画布不会被重新打开或提交生成。</p></article>`;
}

function segmentAssetPreparationCard(project, nextAction) {
  if (nextAction?.id !== 'prepare_segment_assets' || !nextAction.segmentId) return '';
  const segmentId = nextAction.segmentId;
  const currentSegmentation = (project.artifacts ?? [])
    .filter(item => item.type === 'segmentation' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  const currentAssets = (project.artifacts ?? []).filter(item => item.type === 'segment_asset'
    && item.segmentId === segmentId && item.status === 'locked'
    && (!currentSegmentation || (item.segmentationId === currentSegmentation.id && item.segmentationSha256 === currentSegmentation.sha256)));
  const projectAssets = (project.artifacts ?? []).filter(item => item.type === 'project_asset' && item.status === 'locked');
  const catalog = project.workflowProfileView?.assetCatalog ?? [];
  const defaults = project.workflowProfileView?.assetDefaults ?? { required: [], recommended: [] };
  const selectedIds = project.assetSelection?.selected ?? [...defaults.required, ...defaults.recommended];
  const selectedAssets = catalog.filter(item => selectedIds.includes(item.id));
  const checklist = selectedAssets.length ? selectedAssets.map(item => [
    item.label,
    [...currentAssets, ...projectAssets].some(asset => asset.assetType === item.assetType),
    item.summary
  ]) : [[
    '当前生成单元资产切片',
    false,
    '先由故事、镜头和路线反推最小资产；原创项目不会被强制要求原片深度或原片音频。'
  ]];
  const done = checklist.filter(([, ready]) => ready).length;
  const rows = checklist.map(([label, ready, note]) => `<li class="${ready ? 'done' : 'waiting'}"><b>${ready ? '已完成' : '待处理'}</b><span>${escapeHtml(label)}</span><small>${escapeHtml(note)}</small></li>`).join('');
  const allReady = checklist.length > 0 && done === checklist.length;
  const nextLine = allReady
    ? '当前资产账本切片已齐全，系统将继续核对提示词包与模型能力。'
    : '仍有资产职责未绑定；在最小资产切片完整前，视频生成按钮不会开放。';
  return `<section class="panel asset-preparation-progress" aria-live="polite"><div class="focus-title"><div><div class="eyebrow">当前生成单元</div><h2>${escapeHtml(segmentDisplayName({ id: segmentId }))}：资产账本 ${done} / ${checklist.length}</h2></div><span class="status ${allReady ? 'locked' : 'awaiting_review'}">${allReady ? '资产齐全' : '处理中'}</span></div><p>${escapeHtml(nextLine)}</p><ul>${rows}</ul><p class="notice compact">这里只显示当前生成单元实际选用的资产职责；未选择的资产不会被补做，目前也没有提交图片或视频生成。</p></section>`;
}

function gate5FailureReturnCard(nextAction) {
  if (!['prepare_gate5_rework_order', 'execute_gate5_failure_return'].includes(nextAction?.id) || !nextAction.failureReturn) return '';
  const value = nextAction.failureReturn;
  const routing = value.routing;
  const preserved = routing.preserveStages.map(stage => RETURN_STAGE_LABELS[stage] ?? stage).join('、') || '无';
  const rework = routing.reworkStages.map(stage => RETURN_STAGE_LABELS[stage] ?? stage).join(' → ');
  const paidWarning = routing.newPaidAuthorizationRequired
    ? '若返工需要再次调用付费生成，必须重新展示精确生成包并逐次确认。'
    : '当前最小返工位于生成之后，不应新增付费生成；若范围变化，仍需重新授权。';
  const prepared = nextAction.id === 'execute_gate5_failure_return' && nextAction.workOrder;
  const progress = prepared ? nextAction.workOrderProgress : null;
  const progressRows = prepared ? nextAction.workOrder.steps.map(step => {
    const status = step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '进行中' : '待处理';
    return `<li class="${step.status === 'completed' ? 'done' : 'waiting'}"><b>${escapeHtml(status)}</b><span>${escapeHtml(RETURN_STAGE_LABELS[step.stage] ?? step.stage)}</span><small>${step.checkpoint ? escapeHtml(step.checkpoint.note) : '完成时必须绑定证据 ID 与 SHA'}</small></li>`;
  }).join('') : '';
  const progressControls = !prepared ? ''
    : progress.status === 'PAUSED'
      ? `<button class="button primary" data-gate5-rework-action="resume" data-work-order="${escapeHtml(prepared.id)}">恢复返工</button>`
      : progress.status === 'READY'
        ? `<button class="button primary" data-gate5-rework-action="start" data-work-order="${escapeHtml(prepared.id)}" data-stage="${escapeHtml(progress.currentStage)}">开始当前阶段</button>`
        : progress.status === 'IN_PROGRESS'
          ? `<button class="button" data-gate5-rework-action="pause" data-work-order="${escapeHtml(prepared.id)}">暂停并保留进度</button>`
          : '';
  const action = prepared
    ? `<button class="button primary" data-open-gate5-failure-return>进入最小返工</button>${progressControls}`
    : `<button class="button primary" data-prepare-gate5-rework="${escapeHtml(nextAction.failureReturnId)}">冻结证据并建立返工作业</button>`;
  const progressBlock = prepared
    ? `<div class="eyebrow">返工检查点 ${progress.completedStages} / ${progress.totalStages} · ${escapeHtml(progress.status)}</div><ul>${progressRows}</ul>`
    : `<ul><li class="done"><b>继续冻结</b><span>${escapeHtml(preserved)}</span><small>保留已锁定证据，不从头重跑</small></li><li class="waiting"><b>允许重做</b><span>${escapeHtml(rework)}</span><small>替代稿必须明确继承被退回版本，并提高版本号</small></li></ul>`;
  return `<section class="panel asset-preparation-progress" aria-live="polite"><div class="focus-title"><div><div class="eyebrow">Gate 5 退回路由</div><h2>只回到${escapeHtml(RETURN_STAGE_LABELS[routing.returnStage] ?? routing.returnStage)}</h2></div><span class="status ${prepared ? 'locked' : 'rejected'}">${prepared ? '工作单已锁定' : '待建工作单'}</span></div><p><strong>${escapeHtml(FAILURE_CATEGORY_LABELS[value.failure.category] ?? value.failure.category)}</strong>：${escapeHtml(value.correction)}</p>${progressBlock}<p class="notice compact">${escapeHtml(paidWarning)}系统不会自动重试、复用旧批准，也不会把“新文件存在”当作 Gate 5 已接受。阶段完成必须绑定当前证据，页面按钮本身不会调用外部服务。</p>${action}</section>`;
}

function projectViewInner(project) {
  const { status, next, artifacts, routeDecision } = project;
  const grouped = groupArtifacts(artifacts);
  const nextAction = effectiveNextAction(project);
  const awaiting = artifacts.filter(item => item.status === 'awaiting_review');
  const locked = artifacts.filter(item => item.status === 'locked');
  const gate = projectGate(project);
  const routeGap = projectRouteGap(project);
  const canIntake = routeGap || nextAction?.id === 'capture_intake_route';
  const surface = actionSurface(project, nextAction);
  const wholeFilmComplete = project.studioFlow?.completion?.wholeFilmComplete === true;
  const latestCreative = artifacts.filter(item => item.type === 'creative_brief').sort((a, b) => b.revision - a.revision || b.id.localeCompare(a.id))[0];
  const latestStory = artifacts.filter(item => item.type === 'story_plan').sort((a, b) => b.revision - a.revision || b.id.localeCompare(a.id))[0];
  const creativeRevision = pendingCreativeRevision(project);
  const creativeDraft = creativeRevision?.artifact ?? (['draft', 'rework'].includes(latestCreative?.status) ? latestCreative : null);
  const storyDraft = ['draft', 'rework'].includes(latestStory?.status) ? latestStory : null;
  const preparedCanvasSegment = creativeRevision ? null : preparedCanvasNodes(project)[0] ?? null;
  const simpleRemakeReadySegment = !creativeRevision && project.workflowProfileId === 'simple_remake'
    ? (project.production ?? []).find(item => item.readyForCanvas)
    : null;
  const mechanicalCanvasReady = project.routeDecision?.executionClass === 'mechanical_asset_prompt'
    && project.mechanicalCanvas?.status === 'READY_FOR_USER_CANVAS_GENERATION'
    && typeof project.mechanicalCanvas?.projectUuid === 'string'
    ? project.mechanicalCanvas
    : null;
  const stepProgress = projectVisibleStepProgress(project, gate);
  const terminalProject = wholeFilmComplete || project.status?.phase === 'archived';
  let focusButton = creativeRevision && creativeDraft
    ? creativeDraft.status === 'awaiting_review'
      ? `<button class="button primary focus-button" data-artifact="${escapeHtml(creativeDraft.id)}" data-artifact-project="${escapeHtml(activeSlug ?? '')}">审阅并确认剧情段方案</button>`
      : `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(creativeDraft.id)}">查看并提交导演确认</button>`
    : mechanicalCanvasReady
    ? `${canvasLink(mechanicalCanvasReady.projectUuid, `打开 LibTV 画布（${mechanicalCanvasReady.nodes?.length ?? 0} 段待你点击生成）`, 'button primary focus-button')}<button class="button" id="prepare-mechanical-package">重新切分或调整范围</button>`
    : preparedCanvasSegment?.canvasPreparation?.projectUuid
    ? canvasLink(preparedCanvasSegment.canvasPreparation.projectUuid, '打开视频画布', 'button primary focus-button')
    : simpleRemakeReadySegment
    ? `<button class="button primary focus-button" data-prepare-canvas="${escapeHtml(simpleRemakeReadySegment.segmentId)}">下一步：准备视频画布</button>`
    : nextAction?.id === 'prepare_mechanical_asset_prompt_package'
    ? '<button class="button primary focus-button" id="prepare-mechanical-package">切分视频并编译提示词</button>'
    : nextAction?.id === 'prepare_mechanical_libtv_canvas'
    ? '<button class="button primary focus-button" id="prepare-mechanical-canvas">上传并绑定到 LibTV 画布</button>'
    : nextAction?.id === 'human_review' && (nextAction.artifactIds?.[0] ?? awaiting[0]?.id)
    ? `<button class="button primary focus-button" data-artifact="${escapeHtml(nextAction.artifactIds?.[0] ?? awaiting[0].id)}" data-artifact-project="${escapeHtml(activeSlug ?? '')}">打开第一个待审产物</button>`
    : nextAction?.id === 'machine_review_story_plan'
    ? '<button class="button primary focus-button" id="machine-review-story-plan">完成故事与镜头机审</button>'
    : terminalProject
    ? '<button class="button primary focus-button" id="return-project-list">返回项目列表</button>'
    : canIntake ? `<button class="button primary focus-button" id="open-intake">${routeGap ? '补齐 Gate 0 路由' : '开始 Gate 0'}</button>`
    : nextAction?.id === 'complete_director_interview' ? '<button class="button primary focus-button" id="open-director-interview">继续导演访谈</button>'
      : nextAction?.id === 'submit_creative_brief_review' && creativeDraft ? `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(creativeDraft.id)}">提交 Gate 1 审核候选</button>`
      : nextAction?.id === 'prepare_creative_brief' ? (project.directorInterview?.gate1DraftTask?.status === 'ready_for_director_engine'
        ? `<button class="button primary focus-button" id="open-director-engine">${project.workflowProfileId === 'simple_remake' ? '生成第一版复刻方案' : '生成第一版剧情方案'}</button>`
        : project.routeDecision?.referenceRoleStatus === 'not_applicable'
          ? '<button class="button primary focus-button" id="open-creative-brief">编辑 Gate 1 创意单</button>'
          : '<button class="button primary focus-button" id="open-full-creative-brief">打开完整 Gate 1 规划器</button>')
        : nextAction?.id === 'prepare_story_plan' ? (project.compactGate2?.supported && ['asset_anchored', 'simple_remake'].includes(project.compactGate2?.mode)
          ? '<button class="button primary focus-button" id="auto-lightweight-story-plan">系统整理已选素材并生成故事与镜头草稿</button>'
          : project.compactGate2?.supported
            ? '<button class="button primary focus-button" id="open-story-plan">编辑 Gate 2 故事与镜头</button>'
          : `<button class="button focus-button" id="open-full-story-plan">打开完整 Gate 2 规划器</button><div class="notice compact-note">${escapeHtml(project.compactGate2?.reason ?? '这个项目需要完整 Gate 2 规划器。')}</div>`)
          : nextAction?.id === 'submit_story_plan_review' && (storyDraft || nextAction.storyPlanId) ? `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(storyDraft?.id ?? nextAction.storyPlanId)}">提交 Gate 2 审核候选</button>`
              : nextAction?.id === 'prepare_source_fact_analysis' ? '<button class="button primary focus-button" id="open-source-facts">开始整理原片事实</button>'
              : nextAction?.id === 'run_source_comparator_audit' ? '<button class="button primary focus-button" id="run-source-comparator">运行确定性原片对照</button>'
                : nextAction?.id === 'complete_observed_handoff' ? '<button class="button primary focus-button" id="prepare-observed-handoff">检查上一段结尾状态</button>'
                : nextAction?.id === 'propose_segmentation' ? '<button class="button primary focus-button" id="create-segmentation">从 Gate 2 锁定生成分段</button>'
              : nextAction?.id === 'create_quality_rubric' ? '<button class="button primary focus-button" id="create-quality-rubric">建立统一审片标准</button>'
                : nextAction?.id === 'create_segment_contract' ? '<button class="button primary focus-button" id="create-segment-contract">建立当前段执行合同</button>'
                  : ['prepare_project_assets', 'prepare_segment_assets'].includes(nextAction?.id) ? '<button class="button primary focus-button" id="open-upload">导入所需资产</button>'
                    : nextAction?.id === 'prepare_generation_package' ? '<button class="button primary focus-button" id="open-production">进入生成前准备</button>'
                    : nextAction?.id === 'resolve_director_run'
                      ? `<div class="focus-button-row">${nextAction.runs?.every(run => run.status === 'MODEL_SUCCEEDED_UNCOMMITTED' && run.paidModelCallCompleted === true) ? `<button class="button primary focus-button" data-recover-director-run="${escapeHtml(nextAction.runs[0].id)}">只恢复已保存的导演草稿</button>` : ''}<button class="button quiet" data-resolve-director-run="${escapeHtml(nextAction.runs?.[0]?.id ?? '')}">停止模型重试，转手工编辑</button></div>`
                    : nextAction?.id === 'recover_transactions' ? '<button class="button primary focus-button" id="recover-transactions">恢复未完成的本地事务</button>'
                    : nextAction?.id === 'prepare_gate5_rework_order' ? `<button class="button primary focus-button" data-prepare-gate5-rework="${escapeHtml(nextAction.failureReturnId)}">冻结证据并建立返工作业</button>`
                    : nextAction?.id === 'execute_gate5_failure_return' ? '<button class="button primary focus-button" data-open-gate5-failure-return>进入最小返工</button>'
                    : nextAction?.id === 'submit_gate5_video_review' ? `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(nextAction.artifactId)}">重新提交 Gate 5 审核</button>`
                    : nextAction?.id === 'verify_delivery' ? '<button class="button primary focus-button" id="verify-delivery">核验最终交付</button>' : '';
  if (!focusButton && nextAction) focusButton = '<button class="button focus-button" data-open-operational-readiness>查看阻塞与恢复路径</button>';
  const context = { grouped, nextAction, awaiting, locked, gate, focusButton };
  const tabBody = activeProjectTab === 'overview' ? simpleStageView(project, context) : projectTabView(project, context);
  const projectTitle = escapeHtml(projectDisplayName(project));
  const primaryTabs = ['overview', 'assets', 'reviews'];
  const navigation = `<nav class="workspace-primary" aria-label="项目导航">${primaryTabs.map(id => `<button class="button ${activeProjectTab === id ? 'primary' : 'quiet'}" data-project-tab="${id}" ${activeProjectTab === id ? 'aria-current="page"' : ''}>${escapeHtml(PROJECT_TABS.find(t => t[0] === id)[1])}</button>`).join('')}<button class="button quiet" id="open-change-request">我想调整</button></nav>`;
  const extras = PROJECT_TABS.filter(([id]) => !primaryTabs.includes(id)).map(([id, label]) => `<button class="button quiet" data-project-tab="${id}">${escapeHtml(label)}</button>`).join('');
  return `<main class="main project-workspace workspace-v2"><header class="project-task-header"><button class="back-link" id="home">← 全部项目</button><div><small>${escapeHtml(stableWorkflowRoute(project).label)}</small><h1 tabindex="-1">${projectTitle}</h1></div><span class="step-pill">第 ${stepProgress.currentStep} / 7 步</span></header><nav class="user-step-rail" aria-label="七步制作进度">${renderGateRail(project, gate)}</nav>${navigation}<section class="project-tab-body">${tabBody}</section><footer class="workspace-primary"><button class="button quiet" data-project-tab="evidence">历史成果</button><button class="button quiet" id="refresh">刷新进度</button></footer></main>`;

}


function simpleStageView(project, context) {
  const current = workspaceProgress(project, context.gate).currentStep - 1;
  const stage = selectedWorkspaceStage ?? current;
  const results = stageResults(project, stage);
  const editable = directionEditableArtifact(project, stage);
  const [nextTitle, nextReason] = currentTaskCopy(context.nextAction);
  const summary = stage === 1 ? project.creativeRevision?.storyDirection : null;
  const completed = results.filter(a=>a.status==='locked').length;
  const nextCopy = stage === current ? nextTitle : stage < current ? '可以查看这个阶段的结果，或从这里调整接下来的方向。' : '还可以提前补充这个阶段的要求，已有成果会保留。';
  return `<section class="stage-workspace"><h2>${STAGE_NAMES[stage]}</h2><article class="panel"><h3>已完成什么</h3><p>${stage===0 ? project.routeDecision ? '已记录视频的用途与制作路线。' : '还没有完整的需求说明。' : completed ? `已有${completed}项确认过的结果。` : '这个阶段尚无确认完成的结果。'}</p>${summary ? `<p>${escapeHtml(summary)}</p>` : ''}<div>${results.slice(0,6).map(artifactRow).join('') || (stage ? '<p>暂时还没有产出。</p>' : '')}</div>${results.length>6?'<button class="button quiet" data-project-tab="assets">查看全部结果</button>':''}</article><article class="panel"><h3>接下来做什么</h3><p>${escapeHtml(nextCopy)}</p>${stage===current ? `<p>${escapeHtml(nextReason)}</p>`:''}<div class="workspace-primary">${editable?`<button class="button primary" data-edit-stage="${stage}">告诉人工智能怎么改</button><button class="button quiet" data-edit-stage="${stage}" value="direct">${stage===1 || (stage===2&&editable.type==='story_plan')?'直接修改文字':'直接调整后续方向'}</button>`:'<button class="button primary" id="open-director-interview">补充需求</button>'}${stage===current ? context.focusButton : ''}</div><p class="meta">修改先形成新版供你比较；采用前会说明后续哪些内容需要重新核对。</p></article></section>`;
}

function mediaLibraryView(project) {
  const groups = groupProjectMedia(project);
  return `<section><div class="section-head"><h2>素材与成片</h2><button class="button" id="open-upload">导入文件</button></div><nav class="workspace-primary" aria-label="素材类型">${[['all','全部'],['video','视频'],['image','图片'],['audio','音频']].map(([id,label])=>`<button class="button quiet" data-media-filter="${id}">${label}</button>`).join('')}</nav>${groups.map(group => `<section class="media-group"><h3>${escapeHtml(group.kind !== 'run' ? '历史素材 · 尚未关联生成记录' : group.kind === 'run' ? `${segmentDisplayName({id:group.segmentId})} · ${group.run?.createdAt ? new Date(group.run.createdAt).toLocaleString('zh-CN') : '生成记录'}` : `${segmentDisplayName({id:group.segmentId})} · 尚未关联生成记录`)}</h3><div class="media-library-grid">${group.artifacts.map((artifact, index) => {
    const kind = mediaKindOf(artifact);
    const url = `/api/projects/${encodeURIComponent(activeSlug)}/media/${encodeURIComponent(artifact.id)}`;
    const name = chineseMediaName(artifact, index);
    const preview = kind === 'image' ? `<img src="${url}" alt="${escapeHtml(name)}" loading="lazy">` : kind === 'video' ? `<video src="${url}#t=0.1" controls preload="metadata" aria-label="${escapeHtml(name)}"></video>` : `<audio src="${url}" controls preload="none" aria-label="${escapeHtml(name)}"></audio>`;
    return `<article class="media-library-card" data-media-kind="${kind}">${preview}<strong>${escapeHtml(name)}</strong><small>${escapeHtml(artifact.segmentId ? segmentDisplayName({id:artifact.segmentId}) : '未标注片段')} · 第${artifact.revision ?? 1}版 · ${escapeHtml(statusLabel(artifact.status))}</small><button class="button quiet" data-artifact="${escapeHtml(artifact.id)}" data-artifact-project="${escapeHtml(activeSlug)}">查看详情与使用记录</button></article>`;
  }).join('')}</div></section>`).join('') || '<p>还没有可预览的素材。原文件与历史资料不会被删除。</p>'}</section>`;
}

async function openStageEditor(stage, direct = false) {
  const project = data.current;
  const projectSlug = activeSlug;
  const artifact = directionEditableArtifact(project,stage);
  if (!artifact) { openDirectorInterview(); return; }
  const base = `/api/projects/${encodeURIComponent(projectSlug)}/artifact-edits/${encodeURIComponent(artifact.id)}`;
  const post = (action,body) => request(`${base}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  dialog.innerHTML = '<div class="dialog-inner"><h2>正在读取当前内容…</h2></div>'; dialog.showModal();
  try {
    let editor = await request(base);
    let before = editor.sourceFields ?? editor.fields;
    dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><h2>调整${STAGE_NAMES[stage]}</h2><button class="close" aria-label="关闭">×</button></div><p>${artifact.type==='story_plan'?'正在修改镜头方案。':'正在修改后续制作共同遵循的方向。'}旧版结果会保留。</p><form id="rewrite-stage" class="operation-form"><label>哪里不对？希望怎么改？<textarea name="instruction" required rows="3" placeholder="例如：开头不要警告语气，改成温和地解释问题；其他内容保留。"></textarea></label><button class="button primary">让人工智能准备修改</button></form><details id="direct-stage-edit" ${direct?'open':''}><summary>直接修改文字</summary><form id="stage-fields" class="operation-form"></form></details><div id="stage-edit-result" aria-live="polite"></div></div>`;
    let editingBusy=false;
    dialog.querySelector('.close').onclick=()=>{if(!editingBusy)dialog.close();};
    dialog.addEventListener('cancel',event=>{if(editingBusy)event.preventDefault();});
    const output=dialog.querySelector('#stage-edit-result');
    const setBusy = busy => {editingBusy=busy;dialog.querySelectorAll('#rewrite-stage textarea,#rewrite-stage button,#stage-fields textarea,#stage-fields button').forEach(e=>e.disabled=busy);};
    const drawFields=()=>{dialog.querySelector('#stage-fields').innerHTML=editor.fields.map((f,i)=>`<label>${escapeHtml(f.label)}<textarea data-field-index="${i}" rows="3">${escapeHtml(f.value)}</textarea></label>`).join('')+'<button class="button">保存修改预览</button>';};
    const showCandidate=async result=>{
      editor=result; before=editor.sourceFields??before; drawFields();
      const changed=editor.fields.filter(f=>before.find(x=>x.key===f.key)?.value!==f.value);
      output.innerHTML=`<h3>修改预览</h3>${changed.map(f=>`<article class="panel"><h4>${escapeHtml(f.label)}</h4><small>修改前</small><p>${escapeHtml(before.find(x=>x.key===f.key)?.value??'')}</p><small>修改后</small><p>${escapeHtml(f.value)}</p></article>`).join('') || '<p>已保存的修改稿。</p>'}<p>还没有替换当前执行内容。</p><button class="button primary" id="preview-adoption">查看采用后的影响</button>`;
      output.querySelector('#preview-adoption').onclick=async event=>{
        event.currentTarget.disabled=true;setBusy(true);
        try {
          const preview=await post('preview',{draftId:editor.draftId,expectedDraftRevision:editor.draftRevision});
          output.innerHTML+=`<p class="notice">${escapeHtml(preview.notice)}</p><button class="button primary" id="adopt-stage-edit">采用这版，进入确认</button>`;
          output.querySelector('#adopt-stage-edit').onclick=async event=>{
            event.currentTarget.disabled=true;setBusy(true);
            try {await post('apply',{...preview,confirmImpact:true});dialog.close();await refreshAll();await loadProject(projectSlug);}
            catch(error){output.textContent=`尚未采用：${error.message}`;}finally{setBusy(false);}
          };
        } catch(error){output.textContent=error.message;}finally{setBusy(false);}
      };
    };
    drawFields();
    dialog.querySelector('#stage-fields').oninput=()=>{output.textContent='文字已修改，请先保存新的预览。';};
    dialog.querySelector('#stage-fields').onsubmit=async event=>{
      event.preventDefault();const button=event.currentTarget.querySelector('button');setBusy(true);
      const values=Object.fromEntries([...event.currentTarget.querySelectorAll('[data-field-index]')].map(t=>[editor.fields[Number(t.dataset.fieldIndex)].key,t.value]));
      before=editor.fields;
      try{await showCandidate(await post('save',{sourceSha256:editor.sourceSha256,expectedDraftRevision:editor.draftRevision,values}));}catch(error){output.textContent=error.message;}finally{setBusy(false);}
    };
    dialog.querySelector('#rewrite-stage').oninput=()=>{output.textContent='修改要求已变化，请重新准备。';};
    dialog.querySelector('#rewrite-stage').onsubmit=async event=>{
      event.preventDefault();const button=event.currentTarget.querySelector('button');setBusy(true);
      const instruction=event.currentTarget.querySelector('[name=instruction]').value;
      try{
        const prepared=await post('prepare-rewrite',{instruction:`当前正在查看“${STAGE_NAMES[stage]}”。${instruction}`});
        if(!prepared.available){output.textContent=prepared.reason;return;}
        output.innerHTML=`<h3>确认本次文字修改</h3><p>${escapeHtml(prepared.instruction)}</p><p>语言模型：<span data-original-text>${escapeHtml(prepared.model)}</span></p><p>本次费用上限：${prepared.maxBudgetUsd}美元。只调用一次，不会自动重试。</p><button class="button primary" id="authorize-rewrite">确认费用上限，生成修改预览</button>`;
        output.querySelector('#authorize-rewrite').onclick=async event=>{
          event.currentTarget.disabled=true;setBusy(true);before=editor.sourceFields??editor.fields;
          output.innerHTML='<p>正在修改文字，当前执行版本保持不变…</p>';
          try{await showCandidate(await post('rewrite',{authorizationId:prepared.authorizationId,confirm:true}));}catch(error){output.textContent=`未完成改稿：${error.message}。不会自动重试。`;}finally{setBusy(false);}
        };
      }catch(error){output.textContent=error.message;}finally{setBusy(false);}
    };
    if(editor.draftId&&editor.status!=='published_for_review') await showCandidate(editor);
  } catch(error) {dialog.innerHTML=`<div class="dialog-inner"><button class="close" aria-label="关闭">×</button><h2>暂时不能修改这份内容</h2><p>${escapeHtml(error.message)}</p></div>`;dialog.querySelector('.close').onclick=()=>dialog.close();}
}

function openChangeRequest() {
  const project = data.current;
  const projectSlug = activeSlug;
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><h2>你想调整哪里？</h2><button class="close" aria-label="关闭">×</button></div><p>先核对影响范围，未受影响的工作不必停下。这一步不会提交生成或作废旧结果。</p><form id="change-request-form" class="operation-form"><label>修改内容<textarea name="description" required placeholder="例如：第2段的字幕换一句，其他画面继续保留。"></textarea></label><label>范围<select name="scope"><option value="unknown">还不确定，先记录说明</option><option value="segments">指定片段</option><option value="assets">指定素材</option><option value="project">整片方向</option><option value="presentation">仅界面名称或说明</option></select></label><label>选择片段<select name="segmentId"><option value="">请选择</option>${(project.segments ?? []).map(x=>`<option value="${escapeHtml(x.id)}">${escapeHtml(segmentDisplayName(x))}</option>`).join('')}</select></label><label>选择素材<select name="artifactId"><option value="">请选择</option>${(project.artifacts ?? []).filter(mediaKindOf).map(x=>`<option value="${escapeHtml(x.id)}">${escapeHtml(chineseMediaName(x, (project.artifacts ?? []).indexOf(x)))}</option>`).join('')}</select></label><button class="button primary">查看已知影响</button></form><div id="change-preview" aria-live="polite"></div><details><summary>已保存的修改要求</summary><div id="change-history">正在读取…</div></details></div>`;
  dialog.querySelector('.close').onclick = () => dialog.close();
  async function refreshChangeHistory() {
    const target = dialog.querySelector('#change-history');
    try {
      const result = await request(`/api/projects/${encodeURIComponent(projectSlug)}/change-requests`);
      target.innerHTML = result.requests.map(r=>`<p><strong>等待分析</strong> · ${escapeHtml(r.request.description)}</p>`).join('') || '还没有保存的修改要求。';
    } catch(error) { target.textContent = `暂时无法读取：${error.message}`; }
  }
  void refreshChangeHistory();
  dialog.querySelector('#change-request-form').addEventListener('input', () => { dialog.querySelector('#change-preview').textContent = '内容已变化，请重新查看影响。'; });
  dialog.querySelector('#change-request-form').onsubmit = async event => {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    const scope = fields.get('scope');
    const input = { scope, description: fields.get('description'), segmentIds: scope === 'segments' && fields.get('segmentId') ? [fields.get('segmentId')] : [], artifactIds: scope === 'assets' && fields.get('artifactId') ? [fields.get('artifactId')] : [] };
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      const result = await request(`/api/projects/${encodeURIComponent(projectSlug)}/change-impact-preview`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input) });
      dialog.querySelector('#change-preview').innerHTML = `<h3>已知关联：${result.affectedSegmentIds.length} 段</h3><p>${escapeHtml(result.affectedSegmentIds.map(id=>segmentDisplayName({id})).join('、') || '目前没有确定的关联片段')}</p><p>${escapeHtml(result.guidance)}</p>${result.unknowns.map(x=>`<p>${escapeHtml(x)}</p>`).join('')}<p><strong>这只是依赖预览，尚未执行修改。</strong>自然语言仍需AI核对后决定具体调整，不能把未查到依赖当作没有影响。</p><button class="button primary" id="save-change">保存修改要求</button>`;
      dialog.querySelector('#save-change').onclick = async event => {
        event.currentTarget.disabled = true;
        try {
          await request(`/api/projects/${encodeURIComponent(projectSlug)}/change-requests`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,snapshotSha256:result.snapshotSha256,confirm:true})});
          dialog.querySelector('#change-preview').textContent = '修改要求已保存，等待分析。当前任务未自动停止，也未提交新的生成。';
          await refreshChangeHistory();
        } catch(error) { dialog.querySelector('#change-preview').textContent = `未保存：${error.message}。请重新查看影响。`; }
      };
    } catch(error) { dialog.querySelector('#change-preview').textContent = error.message; }
    finally { button.disabled = false; }
  };
  dialog.showModal();
}

function statePlanesView(project) {
  const planes = project.studioFlow?.statePlanes;
  if (!planes) return '<div class="notice boundary-card">合同、执行和最终接受尚未形成可验证投影；工作台不会把其中任何一层推断为完成。</div>';
  const labels = {
    verified: '精确合同已验证', legacy_evidence_only: '仅有兼容证据', not_ready: '尚未就绪',
    packages_ready: '生成包已就绪', outputs_observed: '已观察到分段结果', queued: '任务已排队', running: '正在执行',
    paused_requires_reconfirmation: '重启后等待重新确认', submission_uncertain: '提交结果不确定',
    whole_film_waiting_acceptance: '整片等待接受', unit_outputs_unaccepted: '只有分段结果', accepted: '最终成片已接受', planning: '仍在准备'
  };
  const card = (name, plane, detail) => `<article><small>${name}</small><strong>${escapeHtml(labels[plane.status] ?? plane.status)}</strong><span class="status ${plane.status === 'accepted' || plane.status === 'verified' ? 'locked' : plane.status === 'submission_uncertain' ? 'rejected' : 'awaiting_review'}">${detail}</span></article>`;
  return `<div class="state-plane-grid">${card('合同状态', planes.contract, `${planes.contract.exactCount}/${planes.contract.totalCount} 个精确合同`)}${card('执行状态', planes.execution, planes.execution.retryBlocked ? '同段新付费任务已锁定' : '没有未决付费任务')}${card('接受状态', planes.acceptance, planes.acceptance.accepted ? 'Gate 5 已绑定' : '不能计为最终成功')}</div>`;
}

function segmentGenerationBlocked(project, segmentId, kind) {
  const safety = project.studioFlow?.generationSafety?.find(item => item.segmentId === segmentId);
  return safety?.blockedKinds?.includes(kind) === true;
}

function safeGenerationSegments(project, kind, { readyOnly = false } = {}) {
  const ready = new Set((project.production ?? []).filter(item => item.readyForCanvas === true).map(item => item.segmentId));
  return (project.segments ?? []).filter(segment => (!readyOnly || ready.has(segment.id))
    && !segmentGenerationBlocked(project, segment.id, kind));
}

function directorDeskView(project, surface, focusButton) {
  const interview = project.directorInterview;
  const interviewState = !interview ? '<span class="status draft">历史项目未启用</span>'
    : interview.status === 'complete' ? '<span class="status locked">访谈已完成</span>'
      : `<span class="status awaiting_review">${interview.answeredCount}/${interview.questionCount} 待回答</span>`;
  const taskStateCore = interview?.gate1DraftTask?.status === 'ready_for_director_engine'
    ? `<article class="panel director-contract ready"><div><div class="eyebrow">阶段 1 草稿任务合同</div><h3>输入已经封装，等待导演引擎执行</h3><p>合同已绑定本次访谈指纹；不会自动生成媒体，也不会跳过阶段 1 人工审核。</p></div><div class="director-contract-action"><span class="status locked">已就绪</span>${focusButton}</div></article>`
    : interview ? `<article class="panel director-contract"><div><div class="eyebrow">Gate 0 / 渐进披露</div><h3>先回答真正会改变方向的问题</h3><p>完成后才会形成 Gate 1 草稿任务合同；当前没有调用任何模型。</p></div>${focusButton}</article>` : '';
  const taskState = `${statePlanesView(project)}${taskStateCore}`;
  return `<section class="director-desk"><article class="director-hero surface-${surface.kind}"><div><div class="eyebrow">当前执行面 / ${escapeHtml(surface.label)}</div><h2>${escapeHtml(surface.title)}</h2><p>${escapeHtml(surface.description)}</p></div><span class="surface-seal">${surface.kind === 'native' ? '网页' : surface.kind === 'director' ? '智能' : surface.kind === 'external' ? '画布' : '!'}</span></article>${taskState}<div class="director-grid"><article class="panel"><div class="eyebrow">网页已经负责</div><h3>路线、状态与证据</h3><div class="director-inline-status">${interviewState}</div><ul class="clean-list"><li>先判断原创、灵感或原片权威路线</li><li>答案、路由和输入指纹可恢复</li><li>六个机器检查点持续保存版本、校验与退回证据</li></ul></article><article class="panel"><div class="eyebrow">导演引擎</div><h3>剧情段与生成单元分别规划</h3><ul class="clean-list"><li>原创强化概念、故事与创意探索；复刻强化逐镜源对照</li><li>十五秒只是单次生成上限，不是剧情的机械切点</li><li>资产、提示词、模型能力与最终剪辑使用同一溯源链</li></ul></article><article class="panel"><div class="eyebrow">目标主干保留给当前操作者</div><h3>不可自动越过的三类决定</h3><ul class="clean-list"><li>创意方向确认</li><li>每一个精确付费生成包逐次确认</li><li>完整成片是否接受与交付</li><li>旧项目的额外兼容审核在核心合同迁移前仍会保留</li></ul></article></div><article class="panel parity-note"><div><div class="eyebrow">一致性标准</div><h3>同一项目、同一输入、同一服务合同</h3></div><p>工作台只把已读回的服务状态显示为通过；旧合同映射会明确标注为兼容证据。媒体模型本身仍不能承诺逐像素一致，多镜能力也必须按当前控制面重新验证。</p></article></section>`;
}

function projectTabView(project, context) {
  const { status, next, artifacts, segments = [], runs = [], reviews = [] } = project;
  const { grouped, nextAction, awaiting, locked, gate, focusButton } = context;
  const surface = actionSurface(project, nextAction);
  const wholeFilmComplete = project.studioFlow?.completion?.wholeFilmComplete === true;
  // 该值同时驱动当前焦点的文案与按钮；项目页的每个标签视图都是独立渲染函数，不能依赖外层局部变量。
  const creativeRevision = pendingCreativeRevision(project);
  const simpleRemakeReadySegment = !creativeRevision && project.workflowProfileId === 'simple_remake'
    ? (project.production ?? []).find(item => item.readyForCanvas)
    : null;
  if (activeProjectTab === 'director') return directorDeskView(project, surface, focusButton);
  if (activeProjectTab === 'workflow') return `<section><div class="section-head"><div><div class="eyebrow">内部状态机</div><h2>机器检查点与最小回流证据</h2></div><span class="meta">目标主干归并为三类关键决策</span></div><p class="notice boundary-card">以下六列是内部检查点，不是六次人工审批。出现失败时只回到提示词、资产、生成、剪辑等最小责任阶段；更早已锁定的证据保持冻结。</p><div class="workflow-board">${GATES.map(([id, name], index) => { const verified = project.gateStates?.find(item => item.gate === index); const blocked = verified?.status === 'blocked' ? `<p class="notice compact danger-note">${escapeHtml(gateExplanation(project, index, name))}</p>` : ''; return `<article class="gate-column ${index === gate ? 'current' : ''}"><header><span>检查点 ${index}</span><strong>${name}</strong><small>${verified?.status === 'passed' ? '完整验证通过' : `${(grouped[index] ?? []).length} 项证据`}</small></header>${blocked}<div>${(grouped[index] ?? []).map(artifactRow).join('') || '<p class="empty compact">暂无证据</p>'}</div></article>`; }).join('')}</div></section>`;
  if (activeProjectTab === 'assets') return mediaLibraryView(project);
  if (activeProjectTab === 'production') {
    const safeImageSegmentIds = new Set(safeGenerationSegments(project, 'image').map(segment => segment.id));
    const pendingImageAssets = (project.production ?? [])
      .filter(item => safeImageSegmentIds.has(item.segmentId))
      .reduce((sum, item) => sum + (item.pendingImageAssetCount ?? 0), 0);
    return `<section><div class="section-head"><h2>各段进度</h2>${pendingImageAssets ? '<button class="button primary" id="open-paid-image">查看图片生成与费用</button>' : ''}<span>${project.production?.length ?? 0} 段</span></div>${(project.production ?? []).map(item => `<details class="segment-progress"><summary><strong>${escapeHtml(segmentDisplayName({id:item.segmentId}))}</strong><span>${item.readyForCanvas ? '准备完成，等待生成确认' : item.packageReady ? '等待检查' : '尚未准备完成'}</span></summary>${productionCard(item, project.workflowProfileId)}</details>`).join('') || '<p>还没有分段。完成方向确认后，系统会整理镜头。</p>'}</section>`;
  }
  if (activeProjectTab === 'runs') {
    const readySegmentIds = new Set(safeGenerationSegments(project, 'video', { readyOnly: true }).map(item => item.id));
    const readySegments = (project.production ?? []).filter(item => item.readyForCanvas === true && readySegmentIds.has(item.segmentId));
    const jobs = project.generationJobs ?? [];
    const hasStudioFlow = Boolean(project.studioFlow);
    const lockedOutputs = hasStudioFlow ? project.studioFlow.completion?.unitOutputCount ?? 0 : 0;
    const projectedFinalEditId = project.studioFlow?.completion?.finalEditArtifactId ?? null;
    const finalEdit = hasStudioFlow
      ? artifacts.find(item => item.id === projectedFinalEditId && item.type === 'final_edit' && item.status === 'locked')
      : null;
    const completionLevel = project.studioFlow?.completion?.level;
    const deliveryState = !hasStudioFlow ? ['等待服务投影，无法验证交付状态', 'draft']
      : wholeFilmComplete ? ['已完成完整交付', 'locked']
      : completionLevel === 'final_edit_ready' || finalEdit ? ['整片已锁定，等待最终接受', 'awaiting_review']
        : lockedOutputs ? [`已有 ${lockedOutputs} 个生成单元结果，尚无完整成片`, 'awaiting_review']
          : ['尚未生成可验收视频', 'draft'];
    return `<section><div class="section-head"><div><div class="eyebrow">生成、剪辑与交付</div><h2>分段结果不等于最终成片</h2></div><div class="section-actions">${readySegments.length ? '<button class="button primary" id="open-paid-video">付费生成视频</button><button class="button" id="prepare-libtv">只准备画布</button>' : ''}${segments.length > 1 ? '<button class="button" id="open-upload">导入最终剪辑</button>' : ''}</div></div><article class="panel final-delivery-state"><div><small>最终交付状态</small><strong>${escapeHtml(deliveryState[0])}</strong><p>只有最终剪辑清单、全部生成单元溯源、技术验收和 Gate 5 创意接受同时成立，项目才能记为完成。</p></div><span class="status ${deliveryState[1]}">${!hasStudioFlow ? '无法验证' : wholeFilmComplete ? '已封存' : finalEdit ? '待接受' : '未完成'}</span></article><div class="notice boundary-card">每次付费调用都必须先显示模型、绑定资产、生成次数、精确指纹与实际费用，并取得本次单次授权；禁止自动付费重试。</div>${jobs.length ? `<div class="run-grid">${jobs.map(generationJobCard).join('')}</div>` : ''}<div class="run-grid">${runs.map(runCard).join('') || '<article class="panel empty">尚无视频生成运行记录。</article>'}</div>${segments.length ? `<article class="panel segment-strip"><div class="eyebrow">生成单元</div><div>${segments.map(segmentChip).join('')}</div></article>` : '<article class="panel empty">故事与镜头形成正式生成单元后，才会开放付费视频生成。</article>'}</section>`;
  }
  if (activeProjectTab === 'ledger') return executionLedgerView(project);
  if (activeProjectTab === 'reviews') {
    const human = reviews.filter(r => reviewAudience(r, artifacts) === 'human');
    const other = reviews.filter(r => reviewAudience(r, artifacts) !== 'human');
    return `<section><h2>我的确认</h2><p>创意方向 · 每次付费生成 · 最终成片</p>${awaiting.length ? `<h3>需要处理</h3>${awaiting.map(artifactRow).join('')}` : '<p>当前没有待确认的内容。</p>'}<h3>人工决定</h3>${human.map(reviewRow).join('') || '<p>还没有可确认来源的人工记录。</p>'}<details><summary>AI检查与历史记录（${other.length}条，来源不明的记录单独保留）</summary>${other.map(reviewRow).join('')}</details></section>`;
  }
  if (activeProjectTab === 'evidence') {
    const receipt = project.deliveryReceipt && wholeFilmComplete ? `<article class="panel completion-receipt"><div><div class="eyebrow">最终交付回执</div><h2>项目已经完成执行、审核与复盘</h2><p>交付指纹 ${escapeHtml(project.deliveryReceipt.deliveryFingerprint.slice(0, 16))}… · ${project.deliveryReceipt.deliverable.length} 个生成单元</p></div><span class="status locked">COMPLETE</span></article>`
      : project.deliveryReceipt ? '<article class="panel"><div class="eyebrow">交付回执异常</div><p class="notice danger-note">发现回执，但它没有与当前锁定最终剪辑、项目归档状态和交付指纹形成完整绑定；不会据此显示项目完成。</p></article>' : '';
    return `<section>${receipt}<div class="section-head"><div><div class="eyebrow">事实源</div><h2>全部版本化证据</h2></div><span class="meta">${artifacts.length} 项</span></div><div class="evidence-table">${artifacts.map(artifactRow).join('') || '<p class="empty">尚无项目证据。</p>'}</div></section>`;
  }
  const routeGap = projectRouteGap(project);
  const [taskTitle, taskReason] = currentTaskCopy(nextAction);
  const simpleRemakeBriefReady = project.workflowProfileId === 'simple_remake' && nextAction?.id === 'prepare_creative_brief';
  const terminalProject = wholeFilmComplete || project.status?.phase === 'archived';
  const visibleTitle = routeGap ? '补齐最开始的需求' : creativeRevision ? '确认新版剧情段方案' : terminalProject ? '项目已完成并归档' : simpleRemakeReadySegment ? '生成前准备已完成' : simpleRemakeBriefReady ? '生成第一版复刻方案' : taskTitle;
  const visibleReason = routeGap ? '这个旧项目缺少最开始的需求记录。补齐后，系统才能保证后面的剧情和素材没有走错方向。' : creativeRevision ? '新的方案只替换需要返工的剧情段，已经确认过的内容继续保留。' : terminalProject ? '完整成片、审核记录和交付结果已经绑定，可以随时回查。' : simpleRemakeReadySegment ? '系统已经完成当前段的生成前检查。下一步只准备视频画布，不会生成视频，也不会产生费用。' : simpleRemakeBriefReady ? '系统只根据原片、替换范围和已选控制方式整理复刻方案；不改写原片剧情，不新增观众承诺、人物动机或产品宣称。' : taskReason;
  const routeTask = project.routeDecision?.executionClass === 'mechanical_asset_prompt' ? '' : !project.workflowProfileId ? workflowRoutePanel(project)
    : project.workflowProfileId === 'simple_remake' && !project.workflowProfileView?.remakeControlSelection
      ? remakeControlPanel(project, project.workflowProfileView)
      : '';
  const currentEvidence = creativeRevision ? `${sourceStoryboardCard(project)}${creativeRevisionCard(creativeRevision)}` : '';
  if (routeTask) return `<section class="single-task-page">${routeTask}</section>`;
  return `<section class="single-task-page"><article class="single-task-card ${routeGap || next?.blocked ? 'is-blocked' : ''}" aria-labelledby="current-task-title"><div class="single-task-kicker"><span>现在只做这一件事</span><i>${escapeHtml(surface.label)}</i></div><h2 id="current-task-title">${escapeHtml(visibleTitle)}</h2><p class="single-task-reason">${escapeHtml(visibleReason)}</p>${project.blockedReason ? `<p class="notice danger-note">${escapeHtml(project.blockedReason)}</p>` : ''}${currentEvidence}<div class="single-task-action">${focusButton || '<span class="status locked">当前不需要操作</span>'}</div></article></section>`;
}

function generationJobCard(job) {
  const tone = job.status === 'SUCCESS' ? 'locked' : ['FAILED', 'NEEDS_RECONCILIATION', 'CANCELED'].includes(job.status) ? 'rejected' : 'awaiting_review';
  const label = runStatusLabel(job.status);
  const resume = job.status === 'PAUSED_REQUIRES_CONFIRMATION' ? `<button class="button" data-resume-job="${escapeHtml(job.id)}">重新确认并恢复队列</button><button class="button quiet" data-cancel-paused-job="${escapeHtml(job.id)}">取消原暂停任务</button>` : '';
  const refresh = BLOCKED_GENERATION_JOB_STATUSES.has(job.status) ? '<button class="button quiet" data-refresh-generation-jobs>刷新原任务状态</button>' : '';
  const uncertain = job.status === 'NEEDS_RECONCILIATION'
    ? '<div class="notice danger-note"><strong>提交结果不确定。</strong>同段新付费任务已锁定；这里只能刷新或由所有者核对供应商状态，不能重新创建。</div>' : '';
  const fingerprint = /^[a-f0-9]{64}$/.test(job.fingerprintSha256 ?? '') ? `${job.fingerprintSha256.slice(0, 12)}…` : '未读回';
  return `<article class="run-card"><div class="run-card-head"><span class="status ${tone}">${escapeHtml(label)}</span><span class="meta">付费${job.kind === 'image' ? '图片' : '视频'}队列</span></div><strong>后台任务已登记</strong><p>${escapeHtml(segmentDisplayName({ id: job.request?.segmentId }))} · 指纹 ${escapeHtml(fingerprint)}</p><footer><span>由当前工作区提交</span><span>${escapeHtml(new Date(job.createdAt).toLocaleString())}</span></footer>${uncertain}${job.errorMessage ? `<div class="notice danger-note">${escapeHtml(job.errorMessage)}</div>` : ''}<div class="section-actions">${refresh}${resume}</div></article>`;
}

function productionCard(item, workflowProfileId) {
  const simpleRemake = workflowProfileId === 'simple_remake';
  const narrationLocked = item.narration?.status === 'locked';
  const promptLocked = item.prompt?.status === 'locked';
  const auditLocked = item.independentAudit?.status === 'locked';
  const executionStatus = item.executionStatus ?? { tone: 'waiting', label: '等待处理', title: '等待确认下一步', detail: '系统正在确认当前段的准备状态。', actionHint: '请查看当前操作' };
  const step = (label, done) => `<li class="${done ? 'done' : ''}"><span>${done ? '✓' : '○'}</span>${label}</li>`;
  const canvasReady = item.canvasPreparation?.status === 'READY_FOR_USER_CANVAS_GENERATION';
  let action = canvasReady
    ? (item.canvasPreparation?.projectUuid
      ? canvasLink(item.canvasPreparation.projectUuid, '打开视频画布')
      : '<span class="status locked">视频画布已准备</span>')
    : executionStatus.tone === 'running' ? '<span class="status awaiting_review">系统正在处理</span>'
    : executionStatus.tone === 'blocked' ? '<span class="status rejected">等待系统修正</span>'
    : item.assetManifestStatus === 'missing' ? `<button class="button" data-production-action="asset-manifest" data-segment="${escapeHtml(item.segmentId)}">生成资产清单</button>`
    : item.assetManifestStatus === 'awaiting_review' ? `<button class="button primary" data-production-action="asset-manifest-approval" data-segment="${escapeHtml(item.segmentId)}">审核资产清单</button>`
      : !narrationLocked ? (workflowProfileId === 'simple_remake'
        ? `<button class="button primary" data-production-action="narration-auto" data-segment="${escapeHtml(item.segmentId)}">系统整理讲戏本</button>`
        : `<button class="button primary" data-production-action="narration" data-segment="${escapeHtml(item.segmentId)}">编辑并机审讲戏本</button>`)
        : !promptLocked ? (workflowProfileId === 'simple_remake'
          ? `<button class="button primary" data-production-action="prompt-auto" data-segment="${escapeHtml(item.segmentId)}">系统整理生成提示</button>`
          : `<button class="button primary" data-production-action="prompt" data-segment="${escapeHtml(item.segmentId)}">导入生成提示</button>`)
          : !item.packageReady ? `<button class="button primary" data-production-action="compile" data-segment="${escapeHtml(item.segmentId)}">整理生成包</button>`
            : simpleRemake && item.readyForCanvas ? `<button class="button primary" data-prepare-canvas="${escapeHtml(item.segmentId)}">下一步：准备视频画布</button>`
              : !auditLocked || !item.readyForCanvas ? `<button class="button primary" data-production-action="independent-audit" data-segment="${escapeHtml(item.segmentId)}">${auditLocked ? '恢复或验证当前包审查' : '运行一次独立审查'}</button>`
              : '<span class="status locked">可进入 LibTV 画布准备</span>';
  const blockers = item.blockedReasons?.length ? `<p class="notice danger-note">${item.blockedReasons.map(escapeHtml).join('；')}</p>` : '';
  const sceneWarnings = item.canvasPreparation?.sceneWarnings?.length
    ? `<div class="notice warning-note"><strong>场景权威提示（不阻断）：</strong>${item.canvasPreparation.sceneWarnings.map(escapeHtml).join('<br />')}</div>` : '';
  const prepVerified = item.canvasPreparation?.prepVerification === 'PASS'
    ? step('画布节点写后读回校验已通过', true) : '';
  const finalCheck = simpleRemake ? step('系统生成前检查已完成', item.readyForCanvas) : step('独立复核已完成', auditLocked && item.readyForCanvas);
  const factBinding = data.current?.studioFlow?.factInheritance?.units?.find(unit => unit.segmentId === item.segmentId);
  const factBound = ['bound_current_inputs', 'blocked_before_generation'].includes(factBinding?.status);
  return `<article class="panel production-card"><div class="focus-title"><div><div class="eyebrow">生成单元</div><h2>${escapeHtml(segmentDisplayName({id:item.segmentId}))}</h2></div>${action}</div>${runtimeStatusCard(executionStatus, true)}<ol>${step('资产清单与画面校验已完成', item.assetManifestVerified)}${step('讲戏本机审已完成', narrationLocked)}${step('生成提示与自检已完成', promptLocked)}${step('生成包已整理', item.packageReady)}${step('现有治理绑定已核对当前生成包', factBound)}${finalCheck}${prepVerified}</ol>${factBinding?.packageSha256 ? `<div class="notice compact">生成包指纹 ${escapeHtml(factBinding.packageSha256.slice(0, 12))}… · ${factBinding.mediaBindingCount ?? 0} 个媒体绑定</div>` : ''}${blockers}${sceneWarnings}</article>`;
}

function assetCard(artifact) {
  const bindings = (data.current?.studioFlow?.assetIdentities ?? []).filter(item => item.boundArtifactId === artifact.id);
  const lineage = bindings.length === 0 ? '尚未进入当前生成包' : bindings.map(binding => {
    const state = binding.current ? '当前绑定' : binding.state === 'superseded_package_binding' ? '仍绑定旧版本' : '绑定需核对';
    return `${binding.segmentId} / 包 ${binding.packageSha256.slice(0, 8)}… / ${binding.tag} · ${state} · ${binding.digestPrefix}…`;
  }).join('；');
  const staleBinding = bindings.some(binding => !binding.current);
  const tone = staleBinding ? 'rejected' : statusClass(artifact.status);
  return `<button class="asset-card" data-artifact="${escapeHtml(artifact.id)}" data-artifact-project="${escapeHtml(activeSlug ?? '')}"><span class="asset-kind">${escapeHtml(assetTypeLabel(artifact.assetType ?? artifact.type))}</span><strong>已登记资产</strong><span>${escapeHtml(artifact.segmentId ? '当前段落' : '项目共用')} · 第 ${artifact.revision} 版</span><span>${escapeHtml(lineage)}</span><i class="status ${tone}">${escapeHtml(staleBinding ? '版本绑定需核对' : statusLabel(artifact.status))}</i></button>`;
}

function runCard(run) {
  const sync = run.kind === 'libtv_canvas_preparation' && run.status === 'READY_FOR_USER_CANVAS_GENERATION'
    ? `<button class="button small" data-sync-libtv="${escapeHtml(run.id)}">我已在画布生成，读取结果</button>` : '';
  const context = run.kind === 'director_gate1' ? '阶段 1 导演草稿' : run.segmentId ? '当前段落' : '未绑定段落';
  const cost = Number.isFinite(run.costUsd) ? `已记录费用 ${run.costUsd.toFixed(3)} 美元` : run.outputCount ? `${run.outputCount} 个输出` : '无已记录费用';
  const failedStatuses = new Set(['FAILED', 'FAILED_PRE_SUBMIT', 'UNCERTAIN', 'MODEL_SUCCEEDED_UNCOMMITTED']);
  const statusTone = run.status === 'SUCCESS' ? 'locked' : failedStatuses.has(run.status) ? 'rejected' : 'draft';
  const sceneWarning = run.sceneWarnings?.length ? `<div class="notice warning-note">${run.sceneWarnings.map(escapeHtml).join('<br />')}</div>` : '';
  const verifyFail = run.prepVerification === 'FAIL' && run.verificationDiffs?.length ? `<div class="notice danger-note">写后读回校验未通过：${run.verificationDiffs.map(escapeHtml).join('；')}</div>` : '';
  return `<article class="run-card"><div class="run-card-head"><span class="status ${statusTone}">${escapeHtml(runStatusLabel(run.status))}</span><span class="meta">${escapeHtml(runKindLabel(run.kind))}</span></div><strong>后台运行已登记</strong><p>${escapeHtml(context)} · 模型与校验信息已在后台绑定</p><footer><span>${escapeHtml(cost)}</span><span>主机串行执行</span></footer>${sceneWarning}${verifyFail}${sync}</article>`;
}

function reviewRow(review) {
  const available = review.artifactAvailable !== false && Boolean(review.artifactId);
  const binding = available ? `data-artifact="${escapeHtml(review.artifactId)}" data-artifact-project="${escapeHtml(activeSlug ?? '')}"` : 'disabled aria-disabled="true"';
  const decision = ({approved:'已确认',rejected:'已退回',rework:'需要修改'})[review.decision] ?? '已记录';
  const tone = review.decision === 'approved' ? 'locked' : ['rejected','rework'].includes(review.decision) ? 'rejected' : 'draft';
  const translated = chineseInterfaceText(review.note ?? '无备注');
  const technical = /[A-Za-z]/.test(translated);
  const note = technical ? '详细原因保留在下方原始审核备注中。' : translated;
  return `<article class="review-entry"><button class="review-record${available ? '' : ' is-unavailable'}" ${binding}><span><strong>${escapeHtml(artifactTypeLabel(data.current?.artifacts?.find(a=>a.id===review.artifactId)?.type))} · ${escapeHtml(review.createdAt ? new Date(review.createdAt).toLocaleString('zh-CN') : '历史审核')}</strong><small>${escapeHtml(note)}${available ? '' : ' · 对应资料当前不可打开'}</small></span><span class="status ${tone}">${decision}</span></button>${technical ? `<details><summary>原始审核备注（含英文技术记录）</summary><p>这是当时记录的完整原因，保留原文便于核对；审核结论见上方中文状态。</p><pre data-original-text>${escapeHtml(review.note)}</pre></details>` : ''}</article>`;
}

function segmentChip(segment) {
  const seconds = Number.isFinite(segment.duration) ? segment.duration
    : Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec) ? segment.endSec - segment.startSec : null;
  const duration = Number.isFinite(seconds) ? `${seconds.toFixed(1)} 秒` : '时长待定';
  return `<span class="segment-chip"><b>${escapeHtml(segmentDisplayName(segment))}</b>${duration} · ${escapeHtml(segment.continuityStrategy ?? '未定')}</span>`;
}

function artifactRow(artifact) {
  return `<button class="artifact" data-artifact="${escapeHtml(artifact.id)}" data-artifact-project="${escapeHtml(activeSlug ?? '')}"><span class="artifact-main"><strong>${escapeHtml(artifactTypeLabel(artifact.type))}</strong><span>第 ${artifact.revision} 版 · 后台资料已整理</span></span><span class="status ${statusClass(artifact.status)}">${escapeHtml(statusLabel(artifact.status))}</span></button>`;
}

function render(project = null) {
  app.innerHTML = `<div class="app-shell">${projectSidebar()}${project ? projectView(project) : overviewView()}</div>`;
  bindEvents();
  if (!project) requestAnimationFrame(() => document.querySelectorAll('.sidebar-projects, .overview-disclosure').forEach(item => { item.open = false; }));
}

function bindEvents() {
  document.querySelectorAll('[data-project]').forEach(button => button.addEventListener('click', async () => {
    button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true'); announce('正在打开项目…');
    try { await loadProject(button.dataset.project); }
    catch (error) { button.classList.remove('is-loading'); button.removeAttribute('aria-busy'); alert(error.message); }
  }));
  document.querySelectorAll('#home').forEach(button => button.addEventListener('click', showOverview));
  document.querySelectorAll('#new-project, #new-project-header').forEach(button => button.addEventListener('click', openNewProject));
  document.querySelector('#refresh')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = '正在刷新…';
    try {
      await loadProject(activeSlug);
      const refreshed = document.querySelector('#refresh');
      if (refreshed) {
        refreshed.textContent = '已刷新';
        window.setTimeout(() => { if (refreshed.isConnected) refreshed.textContent = '刷新状态'; }, 1400);
      }
      window.setTimeout(() => announce('项目状态已刷新。'), 50);
    }
    catch (error) { button.disabled = false; button.textContent = '重新刷新'; alert(error.message); }
  });
  document.querySelectorAll('[data-open-operational-readiness]').forEach(button => button.addEventListener('click', () => openOperationalReadiness(button)));
  document.querySelector('#open-change-request')?.addEventListener('click', () => openStageEditor(selectedWorkspaceStage ?? workspaceProgress(data.current,projectGate(data.current)).currentStep-1));
  document.querySelectorAll('[data-media-filter]').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('[data-media-kind]').forEach(card => { card.hidden = button.dataset.mediaFilter !== 'all' && card.dataset.mediaKind !== button.dataset.mediaFilter; }); }));
  document.querySelector('#open-intake')?.addEventListener('click', openIntake);
  document.querySelector('#open-director-interview')?.addEventListener('click', openDirectorInterview);
  document.querySelector('#continue-original-chat')?.addEventListener('click', openDirectorInterview);
  document.querySelector('#open-director-engine')?.addEventListener('click', event => openDirectorEngine(event.currentTarget));
  document.querySelector('#open-creative-brief')?.addEventListener('click', openCreativeBrief);
  document.querySelector('#open-full-creative-brief')?.addEventListener('click', openFullCreativeBrief);
  document.querySelector('#open-story-plan')?.addEventListener('click', openStoryPlan);
  document.querySelector('#auto-lightweight-story-plan')?.addEventListener('click', autoCreateLightweightStoryPlan);
  document.querySelector('#machine-review-story-plan')?.addEventListener('click', machineReviewStoryPlan);
  document.querySelector('#prepare-mechanical-package')?.addEventListener('click', openMechanicalPackageDialog);
  document.querySelector('#prepare-mechanical-canvas')?.addEventListener('click', openMechanicalCanvasDialog);
  document.querySelector('#save-asset-selection')?.addEventListener('click', saveAssetSelectionClient);
  document.querySelector('#save-remake-controls')?.addEventListener('click', saveRemakeControlsClient);
  document.querySelectorAll('[data-workspace-stage]').forEach(button=>button.addEventListener('click',()=>{selectedWorkspaceStage=Number(button.dataset.workspaceStage);activeProjectTab='overview';render(data.current);}));
  document.querySelectorAll('[data-edit-stage]').forEach(button=>button.addEventListener('click',()=>openStageEditor(Number(button.dataset.editStage),button.value==='direct')));
  document.querySelector('#toggle-workspace-trial')?.addEventListener('click', () => {
    const key = workspaceTrialKey(data.current);
    localStorage.setItem(key, localStorage.getItem(key) !== 'disabled' ? 'disabled' : 'enabled');
    activeProjectTab = 'overview'; render(data.current);
  });
  document.querySelector('#show-current-task')?.addEventListener('click', () => {
    activeProjectTab = 'overview';
    projectDetailsOpen = false;
    render(data.current);
    focusAfterRender('#current-task-title', '已返回当前唯一任务', true);
  });
  document.querySelector('#return-project-list')?.addEventListener('click', () => showOverview());
  document.querySelector('#project-details')?.addEventListener('toggle', event => {
    projectDetailsOpen = event.currentTarget.open;
    announce(projectDetailsOpen ? '已展开项目进度与资料。' : '已收起项目进度与资料。');
  });
  document.querySelectorAll('[data-set-profile]').forEach(button => button.addEventListener('click', () => setWorkflowProfileClient(button.dataset.setProfile, button.dataset.selectedBy ?? 'user', button)));
  document.querySelectorAll('.asset-option:not(.remake-mode-option) input[type="checkbox"]').forEach(box => box.addEventListener('change', updateAssetEstimate));
  document.querySelectorAll('.remake-mode-option input[type="checkbox"]').forEach(box => box.addEventListener('change', event => event.currentTarget.closest('.remake-mode-option')?.classList.toggle('selected', event.currentTarget.checked)));
  document.querySelector('#open-full-story-plan')?.addEventListener('click', openFullStoryPlan);
  document.querySelector('#open-source-facts')?.addEventListener('click', openSourceFacts);
  document.querySelector('#run-source-comparator')?.addEventListener('click', () => runConfirmedOperation('source-comparator', '确认将当前 Gate 2 候选逐项对照锁定的原片事实？PASS 才能进入正式 Gate 2 人审。'));
  document.querySelector('#prepare-observed-handoff')?.addEventListener('click', prepareObservedHandoff);
  document.querySelector('#create-segmentation')?.addEventListener('click', createCanonicalSegmentation);
  document.querySelector('#create-quality-rubric')?.addEventListener('click', createQualityRubric);
  document.querySelector('#create-segment-contract')?.addEventListener('click', createSegmentContract);
  document.querySelector('#open-production')?.addEventListener('click', () => {
    activeProjectTab = 'production';
    render(data.current);
    focusAfterRender('.project-task-header h1', '已打开逐段制作', true);
  });
  document.querySelectorAll('[data-open-gate5-failure-return]').forEach(button => button.addEventListener('click', () => {
    const returnStage = effectiveNextAction(data.current)?.returnStage;
    activeProjectTab = ['assets'].includes(returnStage) ? 'assets'
      : ['prompt', 'paid_approval', 'generation', 'editing', 'technical_review', 'gate5'].includes(returnStage) ? 'production'
        : 'workflow';
    render(data.current);
    focusAfterRender('.project-task-header h1', '已打开最小返工责任阶段', true);
  }));
  document.querySelectorAll('[data-prepare-gate5-rework]').forEach(button => button.addEventListener('click', async () => {
    if (!window.confirm('确认只在本地冻结当前上游证据并建立可恢复返工作业？这不会生成媒体或产生费用。')) return;
    try {
      await request(`/api/projects/${encodeURIComponent(activeSlug)}/gate5-rework-orders`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ failureReturnId: button.dataset.prepareGate5Rework, confirm: true })
      });
      await refreshAll(); await loadProject(activeSlug);
    } catch (error) { alert(error.message); }
  }));
  document.querySelectorAll('[data-gate5-rework-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.gate5ReworkAction;
    const reason = action === 'pause' ? window.prompt('请记录暂停原因；现有阶段和证据不会被清空。') : null;
    if (action === 'pause' && !reason?.trim()) return;
    if (!window.confirm('确认只更新本地返工检查点？这不会提交生成、不会复用旧批准，也不会产生费用。')) return;
    try {
      await request(`/api/projects/${encodeURIComponent(activeSlug)}/gate5-rework-orders/${encodeURIComponent(button.dataset.workOrder)}/progress`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, stage: button.dataset.stage ?? null, reason, confirm: true })
      });
      await refreshAll(); await loadProject(activeSlug);
    } catch (error) { alert(error.message); }
  }));
  document.querySelector('#open-source-storyboard')?.addEventListener('click', openSourceStoryboard);
  document.querySelector('#verify-delivery')?.addEventListener('click', verifyProjectDelivery);
  document.querySelector('#recover-transactions')?.addEventListener('click', () => runConfirmedOperation('recover-transactions', '确认按已写入的事务日志重放未完成的本地 JSON 写入？这不会调用模型或外部服务。'));
  document.querySelectorAll('[data-recover-director-run]').forEach(button => button.addEventListener('click', () => recoverDirectorRun(button.dataset.recoverDirectorRun)));
  document.querySelectorAll('[data-resolve-director-run]').forEach(button => button.addEventListener('click', () => openDirectorManualFallback(button.dataset.resolveDirectorRun)));
  document.querySelector('#prepare-libtv')?.addEventListener('click', openLibTvPreparation);
  document.querySelector('#open-paid-video')?.addEventListener('click', openPaidVideoGeneration);
  document.querySelector('#open-paid-image')?.addEventListener('click', openPaidImageGeneration);
  document.querySelectorAll('#open-upload').forEach(button => button.addEventListener('click', openUpload));
  document.querySelector('#show-foundation')?.addEventListener('click', openFoundation);
  document.querySelector('#open-team')?.addEventListener('click', openTeam);
  document.querySelector('#project-search')?.addEventListener('keydown', event => { if (event.key === 'Enter') { projectQuery = event.currentTarget.value.trim(); render(activeSlug ? data.current : null); } });
  document.querySelectorAll('[data-project-tab]').forEach(button => button.addEventListener('click', () => { const tab = button.dataset.projectTab; activeProjectTab = tab; projectDetailsOpen = false; render(data.current); focusAfterRender('.project-task-header h1', `已打开${PROJECT_TABS.find(([id]) => id === tab)?.[1] ?? '项目资料'}`, true); }));
  document.querySelectorAll('[data-gate]').forEach(button => button.addEventListener('click', () => { const gate = Number(button.dataset.gate); activeProjectTab = gate === 3 ? 'assets' : gate >= 4 ? 'runs' : 'workflow'; projectDetailsOpen = false; render(data.current); focusAfterRender('.project-task-header h1', `已打开 ${GATES[gate]?.[0]} ${GATES[gate]?.[1]}`, true); }));
  document.querySelectorAll('[data-submit-candidate]').forEach(button => button.addEventListener('click', () => submitCandidate(button.dataset.submitCandidate)));
  document.querySelectorAll('[data-artifact]').forEach(button => button.addEventListener('click', () => {
    openArtifact(button.dataset.artifact, button.dataset.artifactProject ?? activeSlug).catch(error => alert(error.message));
  }));
  document.querySelectorAll('[data-sync-libtv]').forEach(button => button.addEventListener('click', () => openLibTvSync(button.dataset.syncLibtv)));
  document.querySelectorAll('[data-copy-canvas-node]').forEach(button => button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copyCanvasNode);
      button.textContent = '已复制';
      window.setTimeout(() => { button.textContent = '复制名称'; }, 1600);
    } catch {
      alert('复制失败，请直接选中节点名称复制。');
    }
  }));
  document.querySelectorAll('[data-production-action]').forEach(button => button.addEventListener('click', () => openProductionAction(button.dataset.productionAction, button.dataset.segment)));
  document.querySelectorAll('[data-prepare-canvas]').forEach(button => button.addEventListener('click', () => openLibTvPreparation(button.dataset.prepareCanvas)));
  document.querySelectorAll('[data-resume-job]').forEach(button => button.addEventListener('click', () => openResumeGenerationJob(button.dataset.resumeJob)));
  document.querySelectorAll('[data-cancel-paused-job]').forEach(button => button.addEventListener('click', () => cancelPausedGenerationJob(button.dataset.cancelPausedJob)));
  document.querySelectorAll('[data-refresh-generation-jobs]').forEach(button => button.addEventListener('click', () => loadProject(activeSlug)));
  if (!document.documentElement.dataset.interactionFeedbackBound) {
    document.documentElement.dataset.interactionFeedbackBound = 'true';
    document.addEventListener('click', event => {
      const control = event.target.closest('button, summary');
      if (!control || control.disabled) return;
      control.classList.remove('interaction-confirmed');
      requestAnimationFrame(() => control.classList.add('interaction-confirmed'));
    });
    document.addEventListener('change', event => {
      const control = event.target.closest('input[type="radio"], input[type="checkbox"], select');
      if (!control) return;
      const label = control.closest('label')?.innerText?.trim().replace(/\s+/g, ' ') || '选项';
      announce(`已更新：${label}`);
    });
  }
}

async function setWorkflowProfileClient(id, selectedBy, button = null) {
  const profile = data.current?.workflowProfileView?.profiles?.find(item => item.id === id);
  const label = profile?.label ?? id;
  if (button) { button.disabled = true; button.textContent = '正在应用方案…'; }
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/workflow-profile`, {
      method: 'POST',
      body: JSON.stringify({ id, selectedBy, confirm: true })
    });
    await loadProject(activeSlug);
    announce(`已使用${label}，现在显示下一步。`);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '重新应用方案'; }
    alert(error.message);
  }
}

function updateAssetEstimate() {
  const catalog = data.current?.workflowProfileView?.assetCatalog ?? [];
  const userProvided = new Set(data.current?.assetSelection?.userProvided ?? []);
  const boxes = [...document.querySelectorAll('.asset-option input[type="checkbox"]')];
  const selected = boxes.filter(box => box.checked || box.disabled).map(box => box.dataset.assetId);
  const estimate = catalog.filter(item => selected.includes(item.id) && !userProvided.has(item.id)).reduce((sum, item) => sum + (item.paidImageTasks ?? 0), 0);
  const label = document.querySelector('#asset-estimate');
  if (label) label.textContent = `预计付费图片 ${estimate} 次`;
  boxes.forEach(box => {
    const card = box.closest('.asset-option');
    if (card) card.classList.toggle('selected', box.checked || box.disabled);
  });
}

async function saveAssetSelectionClient() {
  const boxes = [...document.querySelectorAll('.asset-option input[type="checkbox"]')];
  const selected = boxes.filter(box => box.checked || box.disabled).map(box => box.dataset.assetId);
  const userProvided = (data.current?.assetSelection?.userProvided ?? []).filter(id => selected.includes(id));
  const button = document.querySelector('#save-asset-selection');
  if (button) { button.disabled = true; button.textContent = '正在保存资产选择…'; }
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/asset-selection`, {
      method: 'POST',
      body: JSON.stringify({ selected, userProvided, confirm: true })
    });
    await loadProject(activeSlug);
    announce('资产选择已保存；下一步已经显示在资产区域。');
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '重新保存资产选择'; }
    alert(`资产选择没有保存：${localizeTechnicalText(error.message)}`);
  }
}

async function saveRemakeControlsClient() {
  const selectedModes = [...document.querySelectorAll('[data-remake-mode]')].filter(box => box.checked).map(box => box.dataset.remakeMode);
  if (!selectedModes.length) return alert('请至少选择一种复刻控制方式。');
  if (selectedModes.includes('koc_remake') && selectedModes.length !== 1) return alert('口播人物复刻是独立流程，不能与其他控制方式同时选择。');
  const firstFramePolicy = selectedModes.includes('koc_remake')
    ? String(document.querySelector('[name="kocFirstFramePolicy"]:checked')?.value ?? '')
    : undefined;
  const button = document.querySelector('#save-remake-controls');
  if (button) { button.disabled = true; button.textContent = '正在安排资产…'; }
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/remake-controls`, {
      method: 'POST',
      body: JSON.stringify({ selectedModes, ...(firstFramePolicy ? { firstFramePolicy } : {}), confirm: true })
    });
    await loadProject(activeSlug);
    announce('复刻控制方式已保存，资产任务单已自动生成。');
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '重新保存控制方式'; }
    alert(`复刻控制方式没有保存：${localizeTechnicalText(error.message)}`);
  }
}

async function autoCreateLightweightStoryPlan() {
  const button = document.querySelector('#auto-lightweight-story-plan');
  if (button) { button.disabled = true; button.textContent = '系统正在整理已选素材…'; }
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/story-plans/auto-lightweight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '系统整理已选素材并生成故事与镜头草稿'; }
    alert(error.message);
  }
}

async function machineReviewStoryPlan() {
  const button = document.querySelector('#machine-review-story-plan');
  if (button) { button.disabled = true; button.textContent = '系统正在机审…'; }
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/story-plans/machine-review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '完成故事与镜头机审'; }
    alert(error.message);
  }
}

function openMechanicalPackageDialog() {
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">机械快路径 · 无导演流程</div><h2>切分原片并编译替换提示词</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">系统会按 15 秒确定性切分已锁定的原片，把每段与已锁定的产品图绑定，编译好替换提示词。这一步不调用任何模型、不生成视频、不产生费用。</p><form class="operation-form" id="mechanical-package-form"><label>每段时长（秒，4–15）<input name="segmentDurationSec" type="number" min="4" max="15" step="1" value="15" required /></label><label>只处理前 N 秒（可选）<input name="maxDurationSec" type="number" min="4" step="1" placeholder="留空则处理整秒范围" /></label><label>LibTV 画布项目 UUID（可选，32 位小写）<input name="projectUuid" pattern="[a-f0-9]{32}" placeholder="填写后同时把片段、产品图和提示词准备到画布" /></label><div class="notice">原片不足 1 秒的尾数不会单独生成片段。填写画布 UUID 时，系统只上传素材并写入提示词节点，仍然由你在画布内亲自点击“生成视频”。</div><button class="button primary" type="submit">开始处理</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#mechanical-package-form').addEventListener('submit', submitMechanicalPackage);
  dialog.showModal();
}

async function submitMechanicalPackage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const segmentDurationSec = Number(fields.get('segmentDurationSec'));
  const maxDurationRaw = String(fields.get('maxDurationSec') ?? '').trim();
  const projectUuid = String(fields.get('projectUuid') ?? '').trim();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在切分与编译提示词…';
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/mechanical-package`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: true,
        segmentDurationSec,
        ...(maxDurationRaw ? { maxDurationSec: Number(maxDurationRaw) } : {}),
        ...(projectUuid ? { projectUuid } : {})
      })
    });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
    announce(result.canvas
      ? `已准备 ${result.package.segmentCount} 段到 LibTV 画布；请在画布内检查并亲自点击生成。`
      : `已完成 ${result.package.segmentCount} 段切分与提示词包；提供 LibTV 画布 UUID 后可一键准备画布。`);
  } catch (error) {
    button.disabled = false; button.textContent = '开始处理';
    alert(error.message);
  }
}

function openMechanicalCanvasDialog() {
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">机械快路径 · LibTV</div><h2>把现成片段与提示词准备到画布</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">本地切分和提示词已经完成。填写要使用的 LibTV 项目 UUID，系统会上传产品图和所有片段，创建已绑定提示词的视频节点并读回核对。</p><form class="operation-form" id="mechanical-canvas-form"><label>LibTV 画布项目 UUID<input name="projectUuid" pattern="[a-f0-9]{32}" placeholder="32 位小写 UUID" required /></label><div class="notice">这一步不会运行节点，不会提交视频生成，也不会产生生成费用。</div><button class="button primary" type="submit">只准备画布</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#mechanical-canvas-form').addEventListener('submit', submitMechanicalCanvas);
  dialog.showModal();
}

async function submitMechanicalCanvas(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const projectUuid = String(new FormData(form).get('projectUuid') ?? '').trim();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在上传、连线并读回核对…';
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/mechanical-canvas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, projectUuid })
    });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
    announce(`LibTV 画布已准备 ${result.canvas.nodes?.length ?? 0} 个视频节点；请在画布内检查并亲自点击生成。`);
  } catch (error) {
    button.disabled = false; button.textContent = '只准备画布';
    alert(error.message);
  }
}

async function openResumeGenerationJob(jobId) {
  try {
    const preflight = await request(`/api/projects/${encodeURIComponent(activeSlug)}/generation-jobs/${encodeURIComponent(jobId)}/resume-preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    const kind = preflight.summary.taskCount === undefined ? 'video' : 'image';
    const detail = generationSummaryDetail(kind, preflight.summary);
    dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">重启恢复 / 新授权</div><h2>重新核对原任务的完整指纹</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">${escapeHtml(detail)}</p><div class="fingerprint-card"><small>EXACT ORIGINAL FINGERPRINT</small><code>${escapeHtml(preflight.fingerprintSha256)}</code></div><form class="operation-form" id="resume-generation-job-form"><input type="hidden" name="authorizationId" value="${escapeHtml(preflight.authorizationId)}" /><input type="hidden" name="fingerprintSha256" value="${escapeHtml(preflight.fingerprintSha256)}" /><input type="hidden" name="jobId" value="${escapeHtml(jobId)}" /><label>恢复说明<textarea name="note" minlength="4" maxlength="2000" placeholder="例如：主机重启后已重新核对同一指纹，授权恢复一次。" required></textarea></label><label class="authorization-check"><input type="checkbox" name="confirmOneAttempt" required /> 我确认由当前操作者重新授权上面这个完整指纹的一次付费执行；不自动重试。</label><div class="notice danger-note">原提交人：${escapeHtml(preflight.originalSubmitterId)}。这是一份新的恢复审批，不会复用重启前的点击。</div><button class="button primary" type="submit">重新授权并恢复队列</button></form></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#resume-generation-job-form').addEventListener('submit', submitResumeGenerationJob);
    dialog.showModal();
  } catch (error) { alert(error.message); }
}

async function cancelPausedGenerationJob(jobId) {
  if (!window.confirm('确认取消这笔重启后仍暂停、尚未提交供应商的原任务？取消后如需生成，必须重新预检并重新授权。')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/generation-jobs/${encodeURIComponent(jobId)}/cancel-paused`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    await loadProject(activeSlug);
    announce('原暂停任务已取消；同段付费入口将按当前生成包重新判断。');
  } catch (error) { alert(error.message); }
}

async function submitResumeGenerationJob(event) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  if (fields.get('confirmOneAttempt') !== 'on') return alert('请确认这一次恢复授权。');
  if (!window.confirm('最后确认：恢复后主机会执行这一笔原指纹付费任务。确认恢复？')) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在写入新的恢复授权…';
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/generation-jobs/${encodeURIComponent(fields.get('jobId'))}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        authorizationId: fields.get('authorizationId'),
        fingerprintSha256: fields.get('fingerprintSha256'),
        note: fields.get('note'),
        confirm: true,
        confirmationPhrase: '我确认提交一次付费生成'
      })
    });
    showGenerationJob(payload.job);
  } catch (error) { button.disabled = false; button.textContent = '重新授权并恢复队列'; alert(error.message); }
}

async function openTeam() {
  try {
    const team = await request('/api/team');
    const members = team.members.map(member => `<article class="team-member"><div><strong>${escapeHtml(member.label)}</strong><small>${escapeHtml(member.status === 'active' ? '已启用专属工作区' : member.status === 'invited' ? '邀请尚未使用' : '已撤销')}</small></div>${member.status !== 'revoked' ? `<button class="button quiet" data-revoke-member="${escapeHtml(member.id)}" data-member-label="${escapeHtml(member.label)}">撤销</button>` : '<span class="status rejected">已撤销</span>'}</article>`).join('');
    const transportWarning = sessionInfo?.transport === 'http' ? '<div class="notice danger-note">当前是局域网 HTTP 试运行。专属链接相当于钥匙，只在你信任的内网发送；不要转发到微信群、云盘或公网。</div>' : '';
    dialog.innerHTML = `<div class="dialog-inner team-dialog"><div class="dialog-head"><div><div class="eyebrow">团队访问 · 免注册</div><h2>一人一条专属链接</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">同事第一次打开链接后会自动建立自己的隐形身份，不需要注册或配置接口。每个人只看到自己的项目，你可以看到全部。</p>${transportWarning}<form class="operation-form" id="team-settings-form"><label>团队默认视频画布项目编号<input name="defaultLibTvProjectUuid" minlength="32" maxlength="32" pattern="[a-f0-9]{32}" value="${escapeHtml(team.settings?.defaultLibTvProjectUuid ?? '')}" placeholder="由你配置一次，同事无需填写" required /></label><label class="authorization-check"><input type="checkbox" name="paidGenerationEnabled" ${team.settings?.paidGenerationEnabled !== false ? 'checked' : ''} /> 允许团队成员提交自己项目的付费图片与视频</label><button class="button" type="submit">保存团队生成设置</button></form><form class="operation-form" id="invite-member-form"><label>同事显示名称<input name="label" maxlength="80" placeholder="例如：剪辑师小周" required /></label><button class="button primary" type="submit">生成一条一次性专属链接</button></form><section class="team-members"><div class="eyebrow">当前成员</div>${members || '<p class="empty">还没有添加同事。</p>'}</section></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#invite-member-form').addEventListener('submit', createTeamInvite);
    dialog.querySelector('#team-settings-form').addEventListener('submit', saveTeamSettings);
    dialog.querySelectorAll('[data-revoke-member]').forEach(button => button.addEventListener('click', () => revokeTeamMember(button.dataset.revokeMember, button.dataset.memberLabel)));
    dialog.showModal();
  } catch (error) { alert(error.message); }
}

async function saveTeamSettings(event) {
  event.preventDefault();
  const defaultLibTvProjectUuid = String(new FormData(event.currentTarget).get('defaultLibTvProjectUuid') ?? '').trim();
  const paidGenerationEnabled = new FormData(event.currentTarget).get('paidGenerationEnabled') === 'on';
  if (!window.confirm('确认把这个 LibTV 项目设为团队默认生成位置？同事之后无需再填写。')) return;
  try {
    await request('/api/team/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultLibTvProjectUuid, paidGenerationEnabled, confirm: true }) });
    alert('团队默认生成位置已保存。');
  } catch (error) { alert(error.message); }
}

async function createTeamInvite(event) {
  event.preventDefault();
  const label = String(new FormData(event.currentTarget).get('label') ?? '').trim();
  if (!window.confirm(`确认给“${label}”生成一条一次性专属链接？`)) return;
  try {
    const result = await request('/api/team/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, confirm: true }) });
    const bases = sessionInfo?.lanUrls?.length ? sessionInfo.lanUrls : [location.origin];
    const inviteUrls = bases.map(base => new URL(result.invitePath, base).href);
    const links = inviteUrls.map((inviteUrl, index) => `<label>局域网地址 ${index + 1}<span class="copy-field"><input class="invite-link" value="${escapeHtml(inviteUrl)}" readonly /><button class="button" type="button" data-copy-invite="${escapeHtml(inviteUrl)}">复制</button></span></label>`).join('');
    dialog.innerHTML = `<div class="dialog-inner team-dialog"><div class="dialog-head"><div><div class="eyebrow">专属链接已生成</div><h2>${escapeHtml(label)}</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">这条链接只可成功使用一次，有效期至 ${escapeHtml(new Date(result.invite.expiresAt).toLocaleString())}。对方打开后，链接中的令牌会立即从地址栏消失。若显示多个地址，复制与同事处于同一网段的那一个。</p>${links}<div class="review-row"><button class="button quiet" id="back-to-team">返回成员列表</button></div><div class="notice danger-note">不要把同一条链接发给多人。若发错人，立即返回成员列表撤销，再重新生成。</div></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelectorAll('[data-copy-invite]').forEach(button => button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copyInvite);
      button.textContent = '已复制';
    }));
    dialog.querySelector('#back-to-team').addEventListener('click', openTeam);
  } catch (error) { alert(error.message); }
}

async function revokeTeamMember(principalId, label) {
  if (!window.confirm(`确认撤销“${label}”的全部会话、未使用邀请和仍在排队的生成任务？已经开始执行的付费任务不会被粗暴中断。`)) return;
  try {
    await request(`/api/team/members/${encodeURIComponent(principalId)}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    await openTeam();
  } catch (error) { alert(error.message); }
}

async function recoverDirectorRun(runId) {
  if (!window.confirm('确认只使用已保存、已记录费用的导演结果重做本地校验与草稿写入？此操作不会再调用模型。')) return;
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-engine/recover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, runId })
    });
    await refreshAll(); await loadProject(activeSlug);
    await openArtifact(result.artifact.id);
  } catch (error) { alert(error.message); }
}

function openDirectorManualFallback(runId) {
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">导演引擎 · 失败闭环</div><h2>保留证据，转为手工编辑</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">这会保留已有运行、费用、失败和模型结果证据，并对同一阶段 0 任务禁止再次模型调用。随后改用网页手工完成阶段 1 候选。</p><form class="operation-form" id="director-manual-fallback-form"><label>决策记录<textarea name="note" minlength="4" maxlength="2000" placeholder="例如：返回内容未通过导演创意母版校验；保留费用证据，不重试模型，改为手工修订。" required></textarea></label><div class="notice danger-note">若调用结果待核对，此操作不会把它伪装成“未计费”；只是停止重试并允许手工继续。</div><button class="button primary" type="submit">确认不重试，转手工编辑</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#director-manual-fallback-form').addEventListener('submit', async event => {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get('note') ?? '').trim();
    if (!window.confirm('确认保留全部失败和费用证据，对当前任务禁止再次导演模型调用，改用手工阶段 1 编辑？')) return;
    try {
      await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-engine/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          confirm: true, decision: 'manual_fallback_without_model_retry', runId, note
        })
      });
      dialog.close(); await refreshAll(); await loadProject(activeSlug);
      if (data.current.routeDecision?.referenceRoleStatus === 'not_applicable') openCreativeBrief();
      else await openFullCreativeBrief();
    } catch (error) { alert(error.message); }
  });
  dialog.showModal();
}

async function openOperationalReadiness(trigger = null) {
  const originalText = trigger?.textContent;
  if (trigger) { trigger.disabled = true; trigger.textContent = '正在检查…'; }
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/operational-readiness`);
    const ready = result.executionReadiness === 'PASS';
    const complete = result.allWebCoverage === 'PASS';
    const blockers = result.blockers?.length
      ? `<ul class="readiness-list danger-list">${result.blockers.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="readiness-clear">当前下一步没有发现硬阻塞。</p>';
    const stages = result.stages.map(stage => `<article class="readiness-stage ${stage.executable ? 'is-executable' : 'has-gap'}"><div><span>${escapeHtml(stage.id)}</span><strong>${escapeHtml(stage.label)}</strong></div><i class="status ${stage.executable ? 'locked' : 'awaiting_review'}">${stage.executable ? '可执行' : '待接入'}</i><p>${escapeHtml(stage.coverage)}</p>${stage.gap ? `<small>${escapeHtml(stage.gap)}</small>` : ''}</article>`).join('');
    const dependencies = result.dependencies.map(item => `<li><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.evidence ?? '未返回版本证据')}</small></span><i class="status ${item.available ? 'locked' : item.required ? 'rejected' : 'draft'}">${item.available ? 'AVAILABLE' : item.required ? 'REQUIRED' : 'OPTIONAL'}</i></li>`).join('');
    const warnings = result.warnings?.length
      ? `<ul class="readiness-list">${result.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="readiness-clear">没有附加警告。</p>';
    dialog.innerHTML = `<div class="dialog-inner readiness-dialog"><div class="dialog-head"><div><div class="eyebrow">上线前可执行性检查</div><h2>${ready ? '当前下一步可以安全执行。' : '当前下一步必须先解除阻塞。'}</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">PASS 只表示“当前下一步”的项目证据、网页操作和必需依赖已就绪；不代表后续所有 Gate 都已全自动闭环。</p><div class="readiness-summary"><article class="${ready ? 'pass' : 'blocked'}"><small>CURRENT EXECUTION</small><strong>${escapeHtml(result.executionReadiness)}</strong><span>${escapeHtml(result.currentAction ?? '没有待执行动作')}</span></article><article class="${complete ? 'pass' : 'partial'}"><small>FULL WEB COVERAGE</small><strong>${escapeHtml(result.allWebCoverage)}</strong><span>${complete ? '全链路均有网页执行面' : '仍有辅助式或外部环节'}</span></article></div><section class="readiness-blockers"><div class="eyebrow">当前硬阻塞</div>${blockers}</section><details open><summary>七段执行面覆盖</summary><div class="readiness-stage-grid">${stages}</div></details><details><summary>本机执行依赖</summary><ul class="readiness-dependencies">${dependencies}</ul></details><details><summary>已知缺口与边界</summary>${warnings}</details><p class="readiness-footnote">检查时间 ${escapeHtml(result.checkedAt)} · 全程只读，未调用任何生成模型。</p></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.showModal();
    if (trigger) { trigger.disabled = false; trigger.textContent = originalText; }
  } catch (error) { if (trigger) { trigger.disabled = false; trigger.textContent = '重新检查'; } alert(error.message); }
}

function resetPageScroll() {
  const previous = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';
  window.scrollTo(0, 0);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    document.documentElement.style.scrollBehavior = previous;
  }));
}
function showOverview() { activeSlug = null; activeProjectTab = 'overview'; projectDetailsOpen = false; render(null); resetPageScroll(); focusAfterRender('.overview-hero h1', '已返回项目控制室'); }
async function loadProject(slug) { if (activeSlug !== slug) { selectedWorkspaceStage=null; activeProjectTab = 'overview'; projectDetailsOpen = false; } activeSlug = slug; const project = await request(`/api/projects/${encodeURIComponent(slug)}`); data.current = project; render(project); resetPageScroll(); focusAfterRender('.project-task-header h1', `已打开项目 ${project.status.projectId}`); }

async function createCanonicalSegmentation() {
  if (!window.confirm('确认从已锁定的 Gate 2 故事与导演能力路由生成 canonical 分段？这一步不生成任何媒体。')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/operations/canonical-segmentation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

async function runConfirmedOperation(path, prompt) {
  if (!window.confirm(prompt)) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/operations/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

function createQualityRubric() {
  return runConfirmedOperation('quality-rubric', '确认采用 Harness 的统一审片维度、权重、最低分与一票否决项？它会作为本项目全部成片的锁定标准。');
}

function createSegmentContract() {
  return runConfirmedOperation('segment-contract', '确认将当前段绑定到已锁定分段、审片标准和禁止自动付费重试的执行合同？');
}

function auditAuthorizationSummary(kind = '生成包') {
  return `<section class="audit-summary"><div><span class="eyebrow">系统自动复核</span><h3>一次复核，自动完成</h3><p>系统会用默认的独立审查模型，只读检查${kind}的故事、镜头、素材与生成说明是否一致。</p></div><ul><li>不会改写内容</li><li>不会生成图片或视频</li><li>不会自动重试</li></ul></section>`;
}

async function openProductionAction(action, segmentId) {
  const base = `/api/projects/${encodeURIComponent(activeSlug)}/segments/${encodeURIComponent(segmentId)}/production`;
  if (action === 'asset-manifest') {
    if (!window.confirm(`确认从 ${segmentId} 的锁定镜头与已审核资产生成精确资产清单候选？`)) return;
    try {
      await request(`${base}/asset-manifest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      alert('资产清单候选已生成；请继续逐项审核职责、最小范围和锁定资产。');
      await refreshAll(); await loadProject(activeSlug); activeProjectTab = 'production'; render(data.current);
    } catch (error) { alert(error.message); }
    return;
  }
  if (action === 'asset-manifest-approval') {
    try {
      const payload = await request(`${base}/asset-manifest`);
      dialog.innerHTML = `<div class="dialog-inner full-editor"><div class="dialog-head"><div><div class="eyebrow">阶段 3 / 最终输入清单</div><h2>本段资产审核</h2></div><button class="close" aria-label="关闭">×</button></div>${assetManifestVisual(payload.manifest)}<form class="operation-form" id="manifest-review-form"><textarea name="note" placeholder="写下你对资产职责、最小范围和画面用途的审核结论" required></textarea><button class="button primary" type="submit">批准并锁定资产清单</button></form></div>`;
      dialog.querySelector('.close').addEventListener('click', () => dialog.close());
      dialog.querySelector('#manifest-review-form').addEventListener('submit', event => submitProductionForm(event, `${base}/asset-manifest-approval`, fields => ({ note: fields.get('note') })));
      dialog.showModal();
    } catch (error) { alert(error.message); }
    return;
  }
  if (action === 'narration') {
    try {
      const payload = await request(`${base}/narration`);
      dialog.innerHTML = `<div class="dialog-inner full-editor"><div class="dialog-head"><div><div class="eyebrow">逐镜讲戏本 / 确定性机审</div><h2>${escapeHtml(segmentId)}</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">模板里的示例只是结构占位。必须替换成这个段落的真实 Shot、可见动作、运镜、光源、情绪动作、真人感、视线和空间合同；提交后 narration-lint 通过才会自动锁定。</p><form class="operation-form" id="narration-form"><textarea class="json-editor" name="narration" spellcheck="false" required>${escapeHtml(JSON.stringify(payload.template, null, 2))}</textarea><button class="button primary" type="submit">校验并机审锁定</button></form></div>`;
      dialog.querySelector('.close').addEventListener('click', () => dialog.close());
      dialog.querySelector('#narration-form').addEventListener('submit', event => submitProductionForm(event, `${base}/narration`, fields => ({ narration: JSON.parse(fields.get('narration')) }), '讲戏本不是有效 JSON。'));
      dialog.showModal();
    } catch (error) { alert(error.message); }
    return;
  }
  if (action === 'narration-auto') {
    try {
      await request(`${base}/narration-auto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      await refreshAll(); await loadProject(activeSlug); activeProjectTab = 'production'; render(data.current);
    } catch (error) { alert(error.message); }
    return;
  }
  if (action === 'prompt-auto') {
    try {
      await request(`${base}/prompt-auto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      await refreshAll(); await loadProject(activeSlug); activeProjectTab = 'production'; render(data.current);
    } catch (error) { alert(error.message); }
    return;
  }
  if (action === 'prompt') {
    dialog.innerHTML = `<div class="dialog-inner full-editor"><div class="dialog-head"><div><div class="eyebrow">生成提示 / 后台编译入口</div><h2>${escapeHtml(segmentId)}</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">这里仅导入已经按项目提示词规范整理的生成提示。媒体引用由系统在后台绑定，不要求你填写编号。</p><form class="operation-form" id="prompt-form"><label>完整生成提示<textarea name="promptText" spellcheck="false" required></textarea></label><fieldset><legend>导演自检</legend><label><input type="checkbox" name="selfAuditA" value="PASS" required /> 镜头编排、冲突、夸张程度与核心需求已逐项通过</label><label><input type="checkbox" name="selfAuditB" value="PASS" required /> 故事因果、情绪、动作动机与产品功能已逐项通过</label></fieldset><label>修订说明<textarea name="revisionNote" placeholder="记录自检发现的问题及最终如何重写" required></textarea></label><button class="button primary" type="submit">校验并锁定生成提示</button></form></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#prompt-form').addEventListener('submit', event => submitProductionForm(event, `${base}/prompt`, fields => Object.fromEntries(fields)));
    dialog.showModal();
    return;
  }
  if (action === 'compile') {
    dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">生成前准备</div><h2>${escapeHtml(segmentId)}</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">选择本段使用的视频模型和分辨率。简单复刻会使用本段原片窗口控制动作、运镜和原声，产品图只负责替换对象；这里只整理生成包，不提交视频生成，也不会产生费用。</p><form class="operation-form" id="compile-form"><fieldset><legend>选择视频模型</legend><div class="choice-grid"><label class="choice-card"><input type="radio" name="model" value="Seedance 2.0" checked /><strong>Seedance 2.0</strong><small>默认按 15 秒原片窗口逐段替换。</small></label><label class="choice-card"><input type="radio" name="model" value="Seedance 2.0 VIP" /><strong>即梦二点零高级版</strong><small>需要更高规格时手动选择。</small></label><label class="choice-card"><input type="radio" name="model" value="Seedance 2.5" /><strong>即梦二点五版</strong><small>适合需要更长镜头或更多变化的项目。</small></label><label class="choice-card"><input type="radio" name="model" value="Kling O3" /><strong>可灵视频模型</strong><small>作为另一种生成风格的备选。</small></label></div></fieldset><label>分辨率<select name="resolution"><option value="480p" selected>480P</option><option value="720p">720P</option></select></label><button class="button primary" type="submit">免费整理生成包</button></form></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#compile-form').addEventListener('submit', event => submitProductionForm(event, `${base}/compile`, fields => Object.fromEntries(fields)));
    dialog.showModal();
    return;
  }
  if (action === 'independent-audit') {
    try {
      const payload = await request(`${base}/independent-audit-template`);
      const mediaCount = payload.evidence.inputMedia.images.length + payload.evidence.inputMedia.videos.length + payload.evidence.inputMedia.audio.length;
      const isRetry = payload.retryRequired === true;
      dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">生成前检查</div><h2>${isRetry ? '重新进行独立复核' : '开始独立复核'}</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">${isRetry ? '上一轮未能形成完整结论。本次会保留原记录，并只重新检查同一份已锁定生成包。' : '当前生成包已准备完成，系统会独立检查故事、镜头与素材是否能按同一方案执行。'}</p><div class="notice">本次将核对 ${mediaCount} 项已绑定素材，并确认生成说明与画面控制一致。</div><form class="operation-form" id="independent-audit-form">${auditAuthorizationSummary('当前生成包')}<button class="button primary" type="submit">${isRetry ? '重新进行一次独立复核' : '开始一次独立复核'}</button></form></div>`;
      dialog.querySelector('.close').addEventListener('click', () => dialog.close());
      dialog.querySelector('#independent-audit-form').addEventListener('submit', event => submitPaidAuditForm(event, `${base}/independent-audit`, { explicitRetryUncertainAudit: isRetry }));
      dialog.showModal();
    } catch (error) { alert(error.message); }
  }
}

async function submitPaidAuditForm(event, path, extraPayload = {}) {
  event.preventDefault();
  const form = event.currentTarget;
  const isRetry = extraPayload.explicitRetryUncertainAudit === true;
  if (!window.confirm(isRetry
    ? '确认重新进行一次独立复核？上一轮记录会保留；这次只会读取当前已锁定的内容，不会改写素材、生成图片或提交视频。'
    : '确认开始一次独立复核？这次只会读取当前已锁定的内容，不会改写素材、生成图片或提交视频。')) return;
  const button = form.querySelector('button[type="submit"]');
  const idleText = button.textContent;
  button.disabled = true; button.textContent = '正在完成独立复核…'; form.setAttribute('aria-busy', 'true');
  try {
    const result = await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ useDefaultAuditPolicy: true, confirm: true, ...extraPayload }) });
    dialog.close();
    alert(`${result.reusedPaidResult ? '已恢复此前的复核结果，本次没有再次调用模型。' : `独立复核${result.decision === 'PASS' ? '通过' : '未通过'}。`}${result.decision === 'PASS' ? '复核结果已保存。' : '系统已保留问题，暂不进入下一步。'}`);
    await refreshAll(); await loadProject(activeSlug); activeProjectTab = 'production'; render(data.current);
  } catch (error) {
    form.removeAttribute('aria-busy'); button.disabled = false; button.textContent = idleText;
    const message = /OpenCodex audit|maximum number of turns|当前生成包已有.*外部审查/i.test(String(error.message))
      ? '本次独立复核未能形成完整结论，系统已保留本次记录且不会自动重试。'
      : error.message;
    alert(message);
  }
}

async function submitProductionForm(event, path, buildPayload, parseError = '表单内容无效。') {
  event.preventDefault();
  const form = event.currentTarget;
  let payload;
  try { payload = buildPayload(new FormData(form)); } catch { return alert(parseError); }
  if (!window.confirm('确认把当前内容交给 Harness 做精确校验并写入版本化证据？')) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; form.setAttribute('aria-busy', 'true');
  try {
    await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, confirm: true }) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug); activeProjectTab = 'production'; render(data.current);
  } catch (error) { form.removeAttribute('aria-busy'); button.disabled = false; alert(error.message); }
}

async function prepareObservedHandoff() {
  const action = effectiveNextAction(data.current);
  const segmentId = action?.segmentId;
  if (!segmentId) return alert('当前没有需要衔接检查的上一段视频。');
  if (!window.confirm(`确认从 ${segmentId} 的已锁定成片提取六张结尾候选帧？这是本地无费用操作。`)) return;
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/handoffs/${encodeURIComponent(segmentId)}/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    openHandoffReview(segmentId, payload);
  } catch (error) { alert(error.message); }
}

function openHandoffReview(segmentId, payload) {
  const timestamps = payload.evidenceTimestamps;
  const field = value => ({ value, basis: 'observed', timestamps });
  const observation = {
    people: field([{ personId: '', leftRight: 'unknown', depth: 'unknown', bodyDirection: '', faceDirection: '', gaze: '' }]),
    distances: field([]),
    productState: field({ description: '' }),
    props: field([]),
    camera: field({ position: '', direction: '', shotSize: '' }),
    openMotion: field([]),
    unknowns: field([])
  };
  const frames = payload.candidates.map(candidate => `<figure><img src="${escapeHtml(candidate.mediaUrl)}" alt="${escapeHtml(`${segmentId} 在 ${candidate.timestamp.toFixed(3)} 秒的衔接候选帧`)}" /><figcaption>${candidate.timestamp.toFixed(3)}s</figcaption></figure>`).join('');
  dialog.innerHTML = `<div class="dialog-inner full-editor"><div class="dialog-head"><div><div class="eyebrow">段间衔接 / 人工观察</div><h2>${escapeHtml(segmentId)} 的真实结束状态</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">只根据下面六张实际视频帧记录人物、产品、机位和未完成运动。尾帧不能成为人物身份、产品纹理或画质权威。</p><div class="handoff-contact-sheet">${frames}</div><form class="operation-form" id="handoff-review-form"><label>观察合同 JSON<textarea class="json-editor" name="observation" spellcheck="false" required>${escapeHtml(JSON.stringify(observation, null, 2))}</textarea></label><label>审核结论<textarea name="note" placeholder="说明哪些状态由哪些候选帧直接支持。" required></textarea></label><label>若退回，写明需要如何修正<textarea name="correction" placeholder="批准时可留空；退回时必填。"></textarea></label><label class="authorization-check"><input type="checkbox" name="acceptDeviation" /> 接受已明确写入 unknowns 的偏差，不把未知项伪装成观察事实。</label><div class="review-row"><button class="button primary" type="submit" name="decision" value="approved">批准并锁定观察衔接</button><button class="button danger" type="submit" name="decision" value="rejected">退回上一段</button></div></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#handoff-review-form').addEventListener('submit', event => submitHandoffReview(event, segmentId));
  dialog.showModal();
}

async function submitHandoffReview(event, segmentId) {
  event.preventDefault();
  const form = event.currentTarget; const fields = new FormData(form); const decision = event.submitter.value;
  const correction = String(fields.get('correction') ?? '').trim();
  if (decision === 'rejected' && !correction) return alert('退回上一段时必须写明具体修正要求。');
  let observation = null;
  if (decision === 'approved') {
    try { observation = JSON.parse(String(fields.get('observation') ?? '')); }
    catch { return alert('观察合同必须是合法 JSON。'); }
  }
  if (!window.confirm(decision === 'approved' ? '确认这些内容全部来自六张候选帧的实际观察？' : '确认退回上一段并进入返工？')) return;
  const button = event.submitter; button.disabled = true; form.setAttribute('aria-busy', 'true');
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/handoffs/${encodeURIComponent(segmentId)}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        confirm: true, decision, observation, correction,
        note: String(fields.get('note') ?? '').trim(), acceptDeviation: fields.get('acceptDeviation') === 'on'
      })
    });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { form.removeAttribute('aria-busy'); button.disabled = false; alert(error.message); }
}

async function verifyProjectDelivery() {
  if (!window.confirm('确认按当前锁定分段、成片 SHA 和审核记录核验交付？')) return;
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/operations/verify-delivery`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true })
    });
    if (Array.isArray(result.blocked) && result.blocked.length > 0) {
      const reasons = result.blocked.flatMap(item => item.reasons ?? ['证据不完整']).join('\n• ');
      alert(`交付未通过：\n• ${reasons}`);
    } else {
      openDeliveryRetrospective(result);
      return;
    }
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

function openDeliveryRetrospective(delivery) {
  dialog.innerHTML = `<div class="dialog-inner creative-editor"><div class="dialog-head"><div><div class="eyebrow">交付核验 PASS / 项目复盘</div><h2>把这次项目真正闭环</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">已验证 ${delivery.deliverable?.length ?? 0} 个 canonical 分段${delivery.finalEdit ? '与最终剪辑' : ''}。完成复盘后，系统会原子写入交付回执并归档项目；复盘中的规则只作为候选，不会自动升级成硬规则。</p><form class="operation-form" id="delivery-retrospective-form"><label>最终结果<textarea name="outcome" placeholder="实际交付了什么？最终是否达到最初的验收目标？" required minlength="4"></textarea></label><div class="form-grid"><label>有效做法<textarea name="whatWorked" placeholder="哪些导演决策、资产或控制方式被实际证明有效？" required minlength="4"></textarea></label><label>失败与偏差<textarea name="whatFailed" placeholder="哪里返工、失真、等待或超出预期？没有失败也要写清验证边界。" required minlength="4"></textarea></label></div><label>下个项目必须改变什么<textarea name="nextProjectChange" placeholder="只写会改变下一次执行方式的具体动作。" required minlength="4"></textarea></label><label>候选经验规则（可选，每行一条，最多 5 条）<textarea name="ruleCandidates" placeholder="例如：人物表演镜头必须保留完整的触发—反应—决定覆盖。"></textarea></label><div class="notice">这是本地项目写入：确认后会生成交付回执、保存复盘并把项目标记为已完成。不会发布、发送或触发任何生成。</div><button class="button primary" type="submit">确认交付、保存复盘并归档</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#delivery-retrospective-form').addEventListener('submit', submitDeliveryRetrospective);
  dialog.showModal();
}

async function submitDeliveryRetrospective(event) {
  event.preventDefault();
  const form = event.currentTarget; const fields = new FormData(form);
  if (!window.confirm('确认当前成片已经验收，并以这份复盘完成项目归档？')) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; form.setAttribute('aria-busy', 'true');
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/operations/finalize-delivery`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        confirm: true,
        outcome: String(fields.get('outcome') ?? '').trim(),
        whatWorked: String(fields.get('whatWorked') ?? '').trim(),
        whatFailed: String(fields.get('whatFailed') ?? '').trim(),
        nextProjectChange: String(fields.get('nextProjectChange') ?? '').trim(),
        ruleCandidates: String(fields.get('ruleCandidates') ?? '').split('\n').map(value => value.trim()).filter(Boolean).slice(0, 5)
      })
    });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
    announce('项目已完成交付、复盘并归档。');
  } catch (error) { form.removeAttribute('aria-busy'); button.disabled = false; alert(error.message); }
}

function openLibTvPreparation(preferredSegmentId = null) {
  const readyIds = new Set((data.current?.production ?? []).filter(item => item.readyForCanvas).map(item => item.segmentId));
  const segments = (data.current?.segments ?? []).filter(segment => readyIds.has(segment.id));
  const selected = segments.find(segment => segment.id === preferredSegmentId) ?? segments[0];
  if (!selected) return alert('当前没有已经完成生成前准备的段落。');
  const segmentField = segments.length === 1
    ? `<input type="hidden" name="segmentId" value="${escapeHtml(selected.id)}" /><div class="notice">当前段落：${escapeHtml(selected.id)}</div>`
    : `<label>段落<select name="segmentId" required>${segments.map(segment => `<option value="${escapeHtml(segment.id)}" ${segment.id === selected.id ? 'selected' : ''}>${escapeHtml(segment.id)}</option>`).join('')}</select></label>`;
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">生成前确认</div><h2>准备视频画布</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">系统会把已锁定的素材和生成说明放入默认视频画布。不会生成视频，也不会产生费用。</p><form class="operation-form" id="libtv-form">${segmentField}<input type="hidden" name="model" value="Seedance 2.0 VIP" /><div class="notice">系统会自动命名节点并使用立布当前可创建的 Seedance 2.0 通道。画布准备完成后，你只需在画布里查看并决定是否生成。</div><button class="button primary" type="submit">准备视频画布</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#libtv-form').addEventListener('submit', submitLibTvPreparation);
  dialog.showModal();
}

function openPaidVideoGeneration() {
  const segments = safeGenerationSegments(data.current ?? {}, 'video', { readyOnly: true });
  if (!segments.length) return alert('当前没有可新建的视频任务：未完成生成前准备，或同段已有排队、运行、暂停或待核对任务。请先刷新原任务状态。');
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">付费视频 / 第一步</div><h2>先生成精确预检</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">这里只读取已经锁定的提示词、资产和独立审查，计算本次指纹；不会提交付费任务。</p><form class="operation-form" id="paid-video-preflight-form"><label>段落<select name="segmentId" required>${segments.map(segment => `<option value="${escapeHtml(segment.id)}">${escapeHtml(segment.id)}</option>`).join('')}</select></label><label>节点名称<input name="nodeName" pattern="[A-Za-z0-9._-]+" placeholder="留空则使用段落默认名称" /></label><label>模型<select name="model"><option>Seedance 2.0 VIP</option><option>Seedance 2.5</option><option>Kling O3</option></select></label><div class="notice">LibTV 项目位置由所有者统一配置；同事不需要 API、密钥或项目 UUID。</div><button class="button primary" type="submit">免费检查本次视频任务</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#paid-video-preflight-form').addEventListener('submit', event => submitGenerationPreflight(event, 'video'));
  dialog.showModal();
}

function openPaidImageGeneration() {
  const segments = safeGenerationSegments(data.current ?? {}, 'image');
  if (!segments.length) return alert('当前没有可新建的图片任务：同段已有排队、运行、暂停或待核对任务。请先刷新原任务状态。');
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">付费图片 / 第一步</div><h2>检查待生成资产</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">Harness 会从已锁定的资产清单与提示词生成精确计划；缺少模板、Skill 追溯、审核或待生成目标时会直接拒绝。</p><form class="operation-form" id="paid-image-preflight-form"><label>段落<select name="segmentId" required>${segments.map(segment => `<option value="${escapeHtml(segment.id)}">${escapeHtml(segment.id)}</option>`).join('')}</select></label><label>模型<input name="model" value="Seedream 4.5" required /></label><div class="notice">当前不设置成员次数配额；每一个批次仍按实际图片任务计费，并且失败后不会自动付费重试。</div><button class="button primary" type="submit">免费检查本次图片批次</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#paid-image-preflight-form').addEventListener('submit', event => submitGenerationPreflight(event, 'image'));
  dialog.showModal();
}

async function submitGenerationPreflight(event, kind) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在校验指纹…';
  try {
    const preflight = await request(`/api/projects/${encodeURIComponent(activeSlug)}/paid-${kind}/preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, confirm: true })
    });
    renderGenerationConfirmation(kind, preflight);
  } catch (error) { button.disabled = false; button.textContent = kind === 'video' ? '免费检查本次视频任务' : '免费检查本次图片批次'; alert(error.message); }
}

function generationSummaryDetail(kind, summary) {
  return kind === 'video'
    ? `${summary.model} · ${summary.duration}s · ${summary.ratio} · ${summary.resolution} · 图片 ${summary.inputCounts.images} / 视频 ${summary.inputCounts.videos} / 音频 ${summary.inputCounts.audio}`
    : `${summary.model} · ${summary.taskCount} 个图片任务 · ${summary.assetIds.join('、')}`;
}

function renderGenerationConfirmation(kind, preflight) {
  const summary = preflight.summary;
  const detail = generationSummaryDetail(kind, summary);
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">付费${kind === 'video' ? '视频' : '图片'} / 最终确认</div><h2>只授权这个精确指纹</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">${escapeHtml(detail)}</p><div class="fingerprint-card"><small>REQUEST FINGERPRINT</small><code>${escapeHtml(preflight.fingerprintSha256)}</code></div><form class="operation-form" id="paid-generation-submit-form"><input type="hidden" name="authorizationId" value="${escapeHtml(preflight.authorizationId)}" /><input type="hidden" name="fingerprintSha256" value="${escapeHtml(preflight.fingerprintSha256)}" /><label>本次提交说明<textarea name="note" minlength="4" maxlength="2000" placeholder="例如：已核对当前段模型、输入与成片规格，提交一次。" required></textarea></label><label class="authorization-check"><input type="checkbox" name="confirmOneAttempt" required /> 我确认只提交上面这个指纹的一次付费${kind === 'video' ? '视频' : '图片'}生成；不自动重试。</label><div class="notice danger-note">成员没有累计次数上限，但每次都必须重新走这一步。关闭页面不会取消已经提交到主机队列的任务。</div><button class="button primary" type="submit">确认并加入主机生成队列</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#paid-generation-submit-form').addEventListener('submit', event => submitPaidGeneration(event, kind));
}

async function submitPaidGeneration(event, kind) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  if (fields.get('confirmOneAttempt') !== 'on') return alert('请确认这一次付费提交。');
  if (!window.confirm('最后确认：现在会把这一次付费生成加入主机队列。确认提交？')) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在建立一次性授权…';
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/paid-${kind}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        authorizationId: fields.get('authorizationId'),
        fingerprintSha256: fields.get('fingerprintSha256'),
        note: fields.get('note'),
        confirm: true,
        confirmationPhrase: '我确认提交一次付费生成'
      })
    });
    showGenerationJob(payload.job);
  } catch (error) { button.disabled = false; button.textContent = '确认并加入主机生成队列'; alert(error.message); }
}

function showGenerationJob(job) {
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">主机生成队列</div><h2>${job.kind === 'video' ? '视频' : '图片'}任务已登记</h2></div><button class="close" aria-label="关闭">×</button></div><div id="generation-job-live">${generationJobCard(job)}</div><p class="notice">状态为 NEEDS_RECONCILIATION 时不要重新点击；先由所有者核对供应商任务，避免重复扣费。</p><button class="button" id="close-generation-job">稍后在“生成运行”查看</button></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#close-generation-job').addEventListener('click', () => dialog.close());
  const poll = async () => {
    if (!dialog.open || !dialog.querySelector('#generation-job-live')) return;
    try {
      const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/generation-jobs/${encodeURIComponent(job.id)}`);
      dialog.querySelector('#generation-job-live').innerHTML = generationJobCard(payload.job);
      if (['QUEUED', 'RUNNING'].includes(payload.job.status)) setTimeout(poll, 2000);
      else { await loadProject(activeSlug); }
    } catch { setTimeout(poll, 4000); }
  };
  setTimeout(poll, 1500);
}

async function submitLibTvPreparation(event) {
  event.preventDefault(); const form = event.currentTarget; const input = Object.fromEntries(new FormData(form));
  // 留空时由服务根据当前执行包生成唯一且可复用的画布节点名，避免同一段改版后发生名称冲突。
  if (!input.nodeName) delete input.nodeName;
  if (!window.confirm('确认只准备 LibTV 画布节点？这会写入 LibTV 项目，但不会启动付费生成。')) return;
  const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = '正在准备画布…';
  form.setAttribute('aria-busy', 'true');
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/operations/prepare-libtv-canvas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, confirm: true }) });
    dialog.close(); alert(result.paidGenerationTriggered ? '异常：返回记录显示触发了生成，请立即核对。' : 'LibTV 节点已准备完成；请在画布内审核并由你点击生成。');
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) { form.removeAttribute('aria-busy'); button.disabled = false; button.textContent = '只准备画布，不生成'; alert(error.message); }
}

function openLibTvSync(preparationRunId) {
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">Gate 4 → Gate 5</div><h2>读取用户在 LibTV 生成的结果</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">网页会通过官方 LibTV CLI 读取这个精确节点，验证 taskId、成功终态、节点设置与准备指纹，再下载视频并登记生成谱系。它不会再次运行节点。</p><form class="operation-form" id="libtv-sync-form"><input type="hidden" name="preparationRunId" value="${escapeHtml(preparationRunId)}" /><label>视频产物 ID<input name="artifactId" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" placeholder="例如 segment-001-video-v1" required /></label><div class="notice">若节点尚未成功、画布设置被改动或本地提示词/资产发生漂移，读取会被拒绝；不会用手工上传冒充成功运行。</div><button class="button primary" type="submit">只读取、校验并下载</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#libtv-sync-form').addEventListener('submit', submitLibTvSync);
  dialog.showModal();
}

async function submitLibTvSync(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = Object.fromEntries(new FormData(form));
  if (!window.confirm('确认你已经在这个精确 LibTV 节点内自行点击生成，现在只读取终态与下载结果？')) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在核对节点并下载…';
  form.setAttribute('aria-busy', 'true');
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/operations/sync-libtv-canvas-result`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, confirm: true })
    });
    dialog.close();
    alert(result.reused ? '该 taskId 已登记，未重复下载或创建产物。' : '已验证 LibTV 成功终态、下载视频并绑定运行指纹；现在可进入 Gate 5 审片。');
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) { form.removeAttribute('aria-busy'); button.disabled = false; button.textContent = '只读取、校验并下载'; alert(error.message); }
}

function openNewProject() {
  dialog.innerHTML = `<div class="dialog-inner new-project-route"><div class="dialog-head"><div><div class="eyebrow">开始一个新视频</div><h2>这次想做哪一种？</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">先选方向就够了。项目编号、技术路线和内部资产编号都由系统处理。</p><div class="new-route-grid"><button class="new-route-card" type="button" data-new-project-route="remake"><span class="new-route-icon">复</span><strong>复刻一条视频</strong><p>上传原视频，告诉我需要替换什么，再从四种控制方式里选择；前三种可组合，KOC 为独立流程。</p><span>开始复刻 →</span></button><button class="new-route-card" type="button" data-new-project-route="original"><span class="new-route-icon original">创</span><strong>原创一个小剧情</strong><p>先把故事想法告诉导演，再通过对话一起找准剧情重点和核心。</p><span>开始聊故事 →</span></button></div><p class="notice compact">此处不会调用模型、生成媒体或产生费用。</p></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-new-project-route="remake"]').addEventListener('click', openNewRemakeProject);
  dialog.querySelector('[data-new-project-route="original"]').addEventListener('click', openNewOriginalProject);
  dialog.showModal();
}

function automaticProjectId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

async function createLocalProject(prefix, projectId = automaticProjectId(prefix)) {
  return request('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, confirm: true })
  });
}

function openNewRemakeProject() {
  dialog.innerHTML = `<div class="dialog-inner new-project-simple"><div class="dialog-head"><div><div class="eyebrow">复刻视频</div><h2>上传原片，告诉我换什么。</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">立项只需要下面三步。人物、产品、场景和提示词的详细资产由后台继续拆解。</p><form class="operation-form" id="new-remake-form"><label class="friendly-upload"><strong>1. 原视频</strong><span>上传你要复刻的完整视频</span><input name="referenceFile" type="file" accept="video/mp4,video/quicktime,video/webm" required /></label><label><strong>2. 需要替换什么？</strong><textarea name="replacementText" rows="3" placeholder="例如：保留原片动作、镜头和台词，只把说话主角替换成我的新人物。" required></textarea></label><fieldset><legend>3. 选择一种复刻方式</legend><div class="choice-grid remake-choice-grid"><label class="choice-card"><input type="checkbox" name="remakeMode" value="storyboard_control" /><strong>分镜图</strong><small>用关键画面控制构图、动作与切镜。</small></label><label class="choice-card"><input type="checkbox" name="remakeMode" value="depth_control" /><strong>深度视频</strong><small>用深度信息控制动作、空间与运镜。</small></label><label class="choice-card"><input type="checkbox" name="remakeMode" value="native_source" /><strong>原视频</strong><small>官方原生替换，直接使用原片，不反推原片提示词。</small></label><label class="choice-card"><input type="checkbox" name="remakeMode" value="koc_remake" /><strong>口播人物复刻</strong><small>只替换说话主角，其他插入画面和原声保留。</small></label></div></fieldset><fieldset id="koc-first-frame-options" hidden><legend>口播人物复刻的首帧图</legend><div class="choice-grid"><label class="choice-card"><input type="radio" name="kocFirstFramePolicy" value="none" /><strong>不需要</strong><small>使用处理过的原片和新人物照片。</small></label><label class="choice-card"><input type="radio" name="kocFirstFramePolicy" value="all_segments" /><strong>每段都需要</strong><small>每段制作一张换好人物的开场图。</small></label><label class="choice-card"><input type="radio" name="kocFirstFramePolicy" value="selected_segments" /><strong>指定片段</strong><small>Gate 2 分段后再点选需要首帧的片段。</small></label></div></fieldset><p class="notice compact">口播人物复刻选择首帧策略后，系统会在 A-roll 清单、匿名控制和身份资产通过检查后并行准备全部独立片段。</p><button class="button primary" type="submit">创建复刻项目</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#new-remake-form').addEventListener('submit', submitNewRemakeProject);
  const pending=pendingCreation('remake');
  if(pending) {
    dialog.querySelector('[name=replacementText]').value=pending.input.replacementText;
    dialog.querySelectorAll('[name=remakeMode]').forEach(x=>{x.checked=pending.input.selectedModes.includes(x.value);});
    dialog.querySelectorAll('[name=kocFirstFramePolicy]').forEach(x=>{x.checked=pending.input.kocFirstFramePolicy===x.value;});
    dialog.querySelector('[name=referenceFile]').required=!pending.completed.staged;
    if(pending.completed.staged) {
      dialog.querySelector('[name=referenceFile]').disabled=true;
      dialog.querySelector('.friendly-upload span').textContent=`已保存：${pending.input.sourceFile?.name ?? pending.completed.staged.filename ?? '原视频'}，继续使用此文件`;
    }
    dialog.querySelector('#koc-first-frame-options').hidden=!pending.input.selectedModes.includes('koc_remake');
  }
  dialog.querySelectorAll('[name="remakeMode"]').forEach(radio => radio.addEventListener('change', () => {
    const selected = dialog.querySelector('[name="remakeMode"][value="koc_remake"]')?.checked === true;
    dialog.querySelector('#koc-first-frame-options').hidden = !selected;
    dialog.querySelectorAll('[name="kocFirstFramePolicy"]').forEach(input => { input.required = selected; });
  }));
}

function creationKey(route) { return `harness-creation-v1:${sessionInfo?.principal?.id ?? 'local'}:${route}`; }
function pendingCreation(route) {
  try { return readCreationJournal(localStorage, creationKey(route)); } catch(error) { alert(error.message); return null; }
}
let creationInProgress = false;
function creationFileIdentity(file) { return { name:file.name, size:file.size, lastModified:file.lastModified, type:file.type }; }
async function submitNewRemakeProject(event) {
  event.preventDefault(); if (creationInProgress) return; const form = event.currentTarget; const fields = new FormData(form);
  const old = pendingCreation('remake');
  const file = fields.get('referenceFile');
  const replacementText = String(fields.get('replacementText') ?? '').trim();
  const selectedModes = fields.getAll('remakeMode').map(String);
  if (!selectedModes.length) return alert('请选择复刻方式。');
  if (selectedModes.includes('koc_remake') && selectedModes.length > 1) return alert('口播人物复刻需要单独选择。');
  const kocFirstFramePolicy = selectedModes.includes('koc_remake') ? fields.get('kocFirstFramePolicy') : null;
  if (selectedModes.includes('koc_remake') && !kocFirstFramePolicy) return alert('请选择首帧图的处理方式。');
  if (!old?.completed?.staged && (!(file instanceof File) || !file.size)) return alert('请选择原视频，继续保存到同一项目。');
  const button = form.querySelector('button[type="submit"]'); button.disabled = true; form.setAttribute('aria-busy','true');
  creationInProgress = true;
  try {
    const sourceFile = old?.completed?.staged ? old.input.sourceFile : creationFileIdentity(file);
    const input = { replacementText, selectedModes, kocFirstFramePolicy, ...(sourceFile ? {sourceFile} : {}) };
    const journal = creationJournal(localStorage, creationKey('remake'), input, ()=>automaticProjectId('remake'));
    button.textContent = '正在恢复或建立项目…';
    const created = await journal.step('created', record=>createLocalProject('remake', record.projectId));
    const projectSlug = created.slug; activeSlug = projectSlug;
    button.textContent = '正在保存原视频…';
    form.querySelector('[name=referenceFile]').disabled = true;
    const staged = await journal.step('staged', ()=>request(`/api/projects/${encodeURIComponent(projectSlug)}/reference-staging?${new URLSearchParams({confirm:'true',filename:file.name})}`, {method:'POST',headers:{'content-type':file.type || 'application/octet-stream'},body:file}));
    form.querySelector('[name=referenceFile]').disabled = true;
    form.querySelector('.friendly-upload span').textContent=`已保存：${staged.filename ?? sourceFile?.name ?? '原视频'}，继续使用此文件`;
    await journal.step('intake', ()=>request(`/api/projects/${encodeURIComponent(projectSlug)}/intake`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestText:`复刻原视频。需要替换：${replacementText}`,referenceIntent:'source_modification',stagedReference:{token:staged.token,id:'reference-video-001'},confirm:true})}));
    await journal.step('profile', ()=>request(`/api/projects/${encodeURIComponent(projectSlug)}/workflow-profile`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'simple_remake',selectedBy:'user',reason:'用户选择复刻视频。',confirm:true})}));
    await journal.step('controls', ()=>request(`/api/projects/${encodeURIComponent(projectSlug)}/remake-controls`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({selectedModes,...(kocFirstFramePolicy?{firstFramePolicy:kocFirstFramePolicy}:{}),confirm:true})}));
    await refreshAll(); await loadProject(projectSlug); journal.finish(); dialog.close();
  } catch(error) { alert(`立项暂未完成，已保存的步骤会继续保留。${error.message}`); }
  finally { if (!pendingCreation('remake')?.completed?.staged) form.querySelector('[name=referenceFile]').disabled=false; creationInProgress=false; button.disabled=false; button.textContent='继续完成立项'; form.removeAttribute('aria-busy'); }
}

function openNewOriginalProject() {
  dialog.innerHTML = `<div class="dialog-inner original-chat-start"><div class="dialog-head"><div><div class="eyebrow">原创视频</div><h2>先聊故事，不填表格。</h2></div><button class="close" aria-label="关闭">×</button></div><div class="director-chat"><article class="chat-bubble director"><small>导演</small><p>先用你自己的话告诉我：这个故事讲什么？最想让观众感受到什么？不完整也没关系。</p></article></div><form class="operation-form chat-compose" id="new-original-form"><label><span class="sr-only">故事想法</span><textarea name="storyIdea" rows="5" placeholder="例如：一个长期忽视自己的妈妈，在出门前终于为自己做了一次选择……" required></textarea></label><button class="button primary" type="submit">把想法告诉导演</button><p class="notice compact">下一步仍然是对话，一次只问一个真正会改变故事的问题。</p></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#new-original-form').addEventListener('submit', submitNewOriginalProject);
  const pending=pendingCreation('original'); if(pending) dialog.querySelector('[name=storyIdea]').value=pending.input.storyIdea;
}

async function submitNewOriginalProject(event) {
  event.preventDefault(); if (creationInProgress) return; const form = event.currentTarget;
  const storyIdea=String(new FormData(form).get('storyIdea')??'').trim();
  const button=form.querySelector('button[type="submit"]'); button.disabled=true;
  creationInProgress=true;
  try {
    const journal=creationJournal(localStorage,creationKey('original'),{storyIdea},()=>automaticProjectId('original'));
    const created=await journal.step('created',record=>createLocalProject('original',record.projectId)); const projectSlug=created.slug; activeSlug=projectSlug;
    await journal.step('intake',()=>request(`/api/projects/${encodeURIComponent(projectSlug)}/intake`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestText:`原创视频：${storyIdea}`,referenceIntent:'idea_only',stagedReference:null,confirm:true})}));
    await journal.step('profile',()=>request(`/api/projects/${encodeURIComponent(projectSlug)}/workflow-profile`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'original',selectedBy:'user',reason:'用户选择原创视频。',confirm:true})}));
    await refreshAll(); await loadProject(projectSlug); await openDirectorInterview(); journal.finish();
  } catch(error) { alert(`已完成的步骤会继续保留。${error.message}`); }
  finally { creationInProgress=false; button.disabled=false; button.textContent='继续整理想法'; }
}

function openIntake() {
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">任务分级 / 需求路由</div><h2>这条视频要完成什么？</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">先判断这是机械执行还是创意生产。机械任务只处理现有素材与提示词，随后停在 LibTV 画布。</p><form class="operation-form" id="intake-form"><label>视频任务描述<textarea name="requestText" placeholder="例如：把原视频按 15 秒切分，绑定现有产品图，并为每段写产品替换提示词。" required></textarea></label><fieldset><legend>任务级别</legend><label><input type="checkbox" name="mechanicalTask" /> 这是步骤已经明确的机械任务，只处理现有资产和提示词</label><small>仅适用于无需新剧情、角色、镜头设计、生成图片、建模或深度控制的任务。</small></fieldset><fieldset><legend>原视频在本项目中的角色</legend><label><input type="radio" name="referenceIntent" value="idea_only" checked /> 纯原创，不绑定原片</label><label><input type="radio" name="referenceIntent" value="inspiration_only" /> 只参考风格或氛围</label><label><input type="radio" name="referenceIntent" value="faithful_remake" /> 原片是事实权威，忠实复刻</label><label><input type="radio" name="referenceIntent" value="source_modification" /> 保留原片事实，只替换指定内容</label></fieldset><label>原视频（选择后三种路线时必填）<input name="referenceFile" type="file" accept="video/mp4,video/quicktime,video/webm" /></label><label>原视频 ID <input name="referenceId" value="reference-video-001" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" /></label><p class="notice">机械任务还必须已经导入产品图。此步骤不会调用模型、生成媒体或付费。</p><button class="button primary" type="submit">记录任务分级</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#intake-form').addEventListener('submit', submitIntake);
  dialog.showModal();
}

async function submitIntake(event) {
  event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); const requestText = String(fields.get('requestText') ?? '').trim(); const referenceIntent = String(fields.get('referenceIntent') ?? 'idea_only'); const mechanicalTask = fields.get('mechanicalTask') === 'on'; const file = fields.get('referenceFile');
  if (mechanicalTask && referenceIntent !== 'source_modification') return alert('机械产品替换任务必须选择“保留原片事实，只替换指定内容”。');
  if (referenceIntent !== 'idea_only' && (!(file instanceof File) || file.size === 0)) return alert('参考/复刻路线必须选择一条原视频。');
  if (referenceIntent === 'idea_only' && file instanceof File && file.size > 0) return alert('纯原创路线不能绑定原视频；请选择“只参考”或“事实权威”路线。');
  if (!window.confirm('确认记录这次 Gate 0 路由？它会写入项目状态，但不会启动任何生成。')) return;
  const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = '正在登记路由…';
  try {
    let stagedReference = null;
    if (file instanceof File && file.size > 0) {
      button.textContent = '正在复制原视频…';
      const query = new URLSearchParams({ confirm: 'true', filename: file.name });
      const staged = await request(`/api/projects/${encodeURIComponent(activeSlug)}/reference-staging?${query}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      stagedReference = { token: staged.token, id: String(fields.get('referenceId') ?? 'reference-video-001').trim() };
    }
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestText, referenceIntent, taskClass: mechanicalTask ? 'mechanical_asset_prompt' : 'creative_production', stagedReference, confirm: true }) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
    if (!mechanicalTask) await openDirectorInterview();
  } catch (error) { button.disabled = false; button.textContent = '记录路由，进入导演访谈'; alert(error.message); }
}

async function openDirectorInterview() {
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-interview`);
    renderDirectorInterviewChat(payload.interview, Object.fromEntries(payload.interview.questions.filter(item => item.answer).map(item => [item.id, item.answer])));
  } catch (error) { alert(error.message); }
}

function renderDirectorInterviewChat(interview, draftAnswers = {}) {
  const answered = interview.questions.filter(item => draftAnswers[item.id]);
  const nextQuestion = interview.questions.find(item => !draftAnswers[item.id]);
  const completed = interview.status === 'complete' || !nextQuestion;
  const history = answered.map(item => `<article class="chat-bubble director"><small>导演</small><p>${escapeHtml(item.prompt)}</p></article><article class="chat-bubble user"><small>你</small><p>${escapeHtml(draftAnswers[item.id])}</p></article>`).join('');
  const current = nextQuestion ? `<article class="chat-bubble director current"><small>导演 · ${answered.length + 1}/${interview.questions.length}</small><p>${escapeHtml(nextQuestion.prompt)}</p><span>${escapeHtml(nextQuestion.whyItMatters)}</span></article>` : '';
  const composer = completed
    ? `<div class="chat-complete"><span class="status locked">故事重点已聊清楚</span><p>这些回答将成为后续导演创意的事实底稿。现在只准备文字草稿，不会生成图片或视频。</p><button class="button primary" id="finish-director-chat">进入导演台</button></div>`
    : `<form class="operation-form chat-compose" id="director-chat-form"><label><span class="sr-only">回答导演</span><textarea name="answer" rows="4" placeholder="${escapeHtml(nextQuestion.placeholder)}" required></textarea></label><button class="button primary" type="submit">${answered.length + 1 === interview.questions.length ? '说完了，进入导演台' : '继续聊下一点'}</button><small>一次只回答这一件事；不用写专业术语。</small></form>`;
  dialog.innerHTML = `<div class="dialog-inner director-chat-dialog"><div class="dialog-head"><div><div class="eyebrow">原创剧情对话</div><h2>${completed ? '故事重点已经清楚。' : '我们一件一件聊。'}</h2></div><button class="close" aria-label="关闭">×</button></div><div class="director-chat">${history}${current}</div>${composer}<p class="notice compact">对话只记录本地文字事实，不调用模型、不生成媒体、不产生费用。</p></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#finish-director-chat')?.addEventListener('click', () => { activeProjectTab = 'overview'; projectDetailsOpen = false; dialog.close(); render(data.current); focusAfterRender('#current-task-title', '已进入下一阶段', true); });
  dialog.querySelector('#director-chat-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const answer = String(new FormData(event.currentTarget).get('answer') ?? '').trim();
    const updated = { ...draftAnswers, [nextQuestion.id]: answer };
    if (Object.keys(updated).length < interview.questions.length) return renderDirectorInterviewChat(interview, updated);
    await submitDirectorInterviewAnswers(interview, updated, event.currentTarget);
  });
  if (!dialog.open) dialog.showModal();
}

async function submitDirectorInterviewAnswers(interview, answers, form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在整理对话…';
  try {
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-interview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers, confirm: true })
    });
    await refreshAll(); await loadProject(activeSlug);
    renderDirectorInterviewChat(result.interview, answers);
    announce('故事重点已经聊清楚，导演台已准备下一步。');
  } catch (error) { button.disabled = false; button.textContent = '重新整理对话'; alert(error.message); }
}

async function submitDirectorInterview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const answers = {};
  for (const [name, value] of fields.entries()) if (name.startsWith('answer:')) answers[name.slice(7)] = String(value).trim();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = '正在保存访谈合同…';
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-interview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers, confirm: true })
    });
    activeProjectTab = 'director';
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
    announce('Gate 0 导演访谈已完成，Gate 1 草稿任务合同已经准备。');
  } catch (error) { button.disabled = false; button.textContent = '完成访谈，准备 Gate 1 任务'; alert(error.message); }
}

async function openDirectorEngine(trigger = null) {
  const originalText = trigger?.textContent;
  if (trigger) { trigger.disabled = true; trigger.textContent = '正在准备剧情方案…'; }
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-engine`);
    const config = payload.configuration;
    const task = payload.task;
    const authorizationChallenge = payload.authorizationChallenge;
    const unavailable = !config.available;
    const directorModelOptions = (config.availableModels ?? [config.model]).filter(Boolean).map(model => `<option data-original-text value="${escapeHtml(model)}" ${model === config.model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('');
    dialog.innerHTML = `<div class="dialog-inner director-engine-dialog"><div class="dialog-head"><div><div class="eyebrow">Director Engine / Gate 1</div><h2>生成一份可审核的导演创意草稿</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">这次只进行一次文字模型调用。输出必须通过 Creative Brief v3 本地校验，随后只登记为 draft，仍需你在 Gate 1 明确审核。</p><div class="engine-contract-grid"><article><small>绑定任务</small><strong>${escapeHtml(task.id)}</strong><span>SHA ${escapeHtml(task.inputSha256.slice(0, 12))}…</span></article><article><small>默认执行模型</small><strong data-original-text>${escapeHtml(config.model ?? '未配置')}</strong><span>可在本次授权中选择</span></article><article><small>最高预算</small><strong>${config.maxBudgetUsd ? `$${Number(config.maxBudgetUsd).toFixed(2)}` : '—'}</strong><span>仅本次文字草稿</span></article></div>${unavailable ? `<p class="notice danger-note">${escapeHtml(config.reason ?? 'Director Engine 当前不可用')}</p>` : `<form class="operation-form" id="director-engine-form"><label>本次使用的语言模型<select name="model">${directorModelOptions}</select></label><label class="authorization-check"><input type="checkbox" name="authorize" required /> 我明确授权一次 Gate 1 文字草稿模型调用，最高不超过 $${Number(config.maxBudgetUsd).toFixed(2)}；此授权不包含图片、视频或发布。</label><div class="notice">生成失败不会创建 Creative Brief；运行证据会保留为 FAILED。系统不会自动重试，也不会自动提交 Gate 1 审核。</div><button class="button primary" type="submit">授权并生成一次导演草稿</button></form>`}</div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#director-engine-form')?.addEventListener('submit', event => submitDirectorEngine(event, config, authorizationChallenge));
    dialog.showModal();
    if (trigger) { trigger.disabled = false; trigger.textContent = originalText; }
  } catch (error) { if (trigger) { trigger.disabled = false; trigger.textContent = '重新准备剧情方案'; } alert(error.message); }
}

async function submitDirectorEngine(event, config, authorizationChallenge) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.elements.authorize.checked) return form.elements.authorize.reportValidity();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Director Engine 正在生成草稿…';
  form.setAttribute('aria-busy', 'true');
  try {
    const selectedModel = String(form.elements.model.value || config.model);
    let effectiveConfig = config;
    let effectiveChallenge = authorizationChallenge;
    if (selectedModel !== config.model) {
      const refreshed = await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-engine?model=${encodeURIComponent(selectedModel)}`);
      effectiveConfig = refreshed.configuration;
      effectiveChallenge = refreshed.authorizationChallenge;
      if (!effectiveConfig?.available || !effectiveChallenge) throw new Error(effectiveConfig?.reason ?? '所选语言模型当前不可用');
    }
    const result = await request(`/api/projects/${encodeURIComponent(activeSlug)}/director-engine/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: true,
        authorization: 'AUTHORIZE_ONE_GATE1_TEXT_DRAFT',
        authorizationId: effectiveChallenge.id,
        taskSha256: effectiveChallenge.taskSha256,
        promptSha256: effectiveChallenge.promptSha256,
        model: effectiveConfig.model,
        maxBudgetUsd: effectiveConfig.maxBudgetUsd
      })
    });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
    await openArtifact(result.artifact.id);
  } catch (error) {
    form.removeAttribute('aria-busy'); button.disabled = false; button.textContent = '授权并生成一次导演草稿'; alert(error.message);
  }
}

function formField(name, label, placeholder, rows = 2) {
  return `<label>${label}<textarea name="${name}" rows="${rows}" placeholder="${placeholder}" required></textarea></label>`;
}

function openCreativeBrief() {
  dialog.innerHTML = `<div class="dialog-inner creative-editor"><div class="dialog-head"><div><div class="eyebrow">Gate 1 / 导演创意母版</div><h2>先锁定故事方向，再进入镜头。</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">只填写会改变创意方向、观众承诺和制作风险的变量。分段、资产数量与技术执行将在 Gate 2 锁定。</p><form class="operation-form" id="creative-brief-form"><details open><summary>01 · 目的与观众</summary><div class="form-grid">${formField('purpose', '项目目的', '希望这条视频为业务或观众完成什么？')}${formField('audience', '核心观众', '谁会看？他们目前的犹豫或需要是什么？')}${formField('desiredAudienceEffect', '看完后的变化', '观众应该从什么判断，转向什么判断或行动？')}${formField('productDramaticFunction', '产品的剧情功能', '产品如何实际改变冲突，而不是作为贴片出现？')}</div></details><details><summary>02 · 开头、冲突与兑现</summary><div class="form-grid">${formField('logline', '一句话主方向', '谁在什么压力下，用什么行动完成什么变化？')}${formField('coreMeaning', '核心意义', '这条片真正要让观众相信什么？')}${formField('extensionOfUserIdea', '从原始想法推导的完整因果', '你如何把想法延展成可执行的因果链？')}${formField('firstFrame', '第一帧', '第一秒看见什么具体画面？')}${formField('trigger', '触发事件', '什么动作或事件立刻启动故事？')}${formField('audienceQuestion', '观众问题', '开头让观众想知道什么？')}${formField('storyBridge', '开头到行动的桥', '为什么角色接下来会做出这个关键行动？')}${formField('openingRationale', '开头理由', '为什么这一帧比解释更有效？')}${formField('centralConflict', '核心冲突', '角色无法靠什么解决，必须承担什么风险？')}${formField('coreTurn', '核心转折', '哪一个可见结果改变了局面？')}${formField('endingPayoff', '结尾兑现', '如何用行为回答开头的问题？')}${formField('progressionLogic', '因果闭环', '用一句话串起触发、行动、结果和新状态。')}</div></details><details><summary>03 · 节奏、镜头与边界</summary><div class="form-grid">${formField('storyOutline', '三行故事骨架', '开头：…\n转折：…\n兑现：…', 4)}${formField('scenePriorities', '最重要的可见证据', '第一项…\n第二项…\n第三项…', 4)}${formField('emotionCurve', '情绪曲线', '从什么情绪，经何种变化，到什么新状态？')}${formField('rhythmStrategy', '节奏策略', '哪里快、哪里需要留出反应时间？')}${formField('pointOfView', '视角策略', '观众主要跟随谁或看见什么？')}${formField('cameraMotive', '镜头动机', '镜头何时、为什么靠近或保持距离？')}${formField('editingStrategy', '剪辑策略', '每个节拍如何完整成立？')}${formField('soundStrategy', '声音策略', '哪些真实声音或留白承载变化？')}${formField('mustKeep', '必须保留', '一项不可牺牲的结果或关系\n另一项…', 3)}${formField('mustAvoid', '必须避免', '一个会破坏可信度或故事因果的做法\n另一项…', 3)}</div></details><details><summary>04 · 决策记录</summary><div class="form-grid">${formField('confirmedFacts', '已经确认的事实', '项目是…\n时长是…', 3)}${formField('professionalRecommendation', '导演推荐与理由', '推荐此方向，因为它如何服务观众、因果和制作风险？')}${formField('lockedVariables', '本 Gate 锁定什么', '观众承诺\n核心冲突\n产品剧情功能', 3)}${formField('audienceRationale', '观众效果依据', '为什么观众会经历这个判断变化？')}${formField('causalityRationale', '因果依据', '为什么每个动作由前一动作触发？')}${formField('productRationale', '产品功能依据', '产品如何成为解决冲突的证据？')}${formField('executionRisk', '制作风险判断', '用什么限制来保证后续可执行？')}</div></details><label>目标时长（秒）<input name="targetDurationSec" type="number" min="1" max="120" value="15" required /></label><div class="notice">提交只会创建 Gate 1 创意单候选，随后仍需在审核界面明确批准；不会生成任何媒体或付费任务。</div><button class="button primary" type="submit">创建 Gate 1 审核候选</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#creative-brief-form').addEventListener('submit', submitCreativeBrief);
  dialog.showModal();
}

async function submitCreativeBrief(event) {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  if (!window.confirm('确认创建 Gate 1 创意单候选？它会写入项目，但仍需人工审核才能锁定。')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/creative-briefs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, confirm: true }) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

async function openFullCreativeBrief() {
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/creative-brief-template`);
    dialog.innerHTML = `<div class="dialog-inner full-editor"><div class="dialog-head"><div><div class="eyebrow">阶段 1 · 完整导演创意母版</div><h2>人物、复杂叙事与原片路线</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">模板已绑定阶段 0 的参考角色和原视频编号。系统会在后台编译结构化资料并校验人物功能、因果闭环、边界和路线一致性。</p><div class="notice editor-context"><strong>当前路由：${escapeHtml(payload.routeDecision.referenceRoleStatus)}</strong><span>${escapeHtml((payload.routeDecision.sourceVideoIds ?? []).join('、') || '无原片')}</span></div><form class="operation-form" id="full-creative-form"><label>完整导演创意母版（后台结构化内容）<textarea class="json-editor" name="brief" spellcheck="false" required>${escapeHtml(JSON.stringify(payload.template, null, 2))}</textarea></label><div class="notice">原始结构化内容不会在页面展示；这里只创建阶段 1 审核候选，源事实分析仍在阶段 1 锁定后按路线执行。</div><button class="button primary" type="submit">校验并创建阶段 1 候选</button></form></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#full-creative-form').addEventListener('submit', submitFullCreativeBrief);
    dialog.showModal();
  } catch (error) { alert(error.message); }
}

async function submitFullCreativeBrief(event) {
  event.preventDefault();
  let brief;
  try { brief = JSON.parse(new FormData(event.currentTarget).get('brief')); }
  catch { return alert('导演创意母版内容无法读取，请返回可视化编辑器重新填写。'); }
  if (!window.confirm('确认用这份完整导演母版创建阶段 1 审核候选？')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/creative-briefs/full`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief, confirm: true }) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

function storyField(name, label, placeholder, rows = 2) {
  return formField(name, label, placeholder, rows);
}

function openStoryPlan() {
  const creative = data.current?.creativeBrief;
  const eligibility = data.current?.compactGate2;
  if (!creative) return alert('未找到已锁定的 Gate 1 创意母版。');
  if (!eligibility?.supported) return alert(eligibility?.reason ?? '当前项目需要完整 Gate 2 规划器。');
  const creativeContext = `<article class="notice editor-context"><strong>继承的 Gate 1 母版 · r${escapeHtml(creative.revision)}</strong><span>${escapeHtml(creative.logline ?? '未提供一句话方向')}</span><span>${escapeHtml(creative.targetDurationSec)} 秒 · ${escapeHtml(creative.purpose ?? '项目目的未提供')}</span><span>观众：${escapeHtml(creative.audience ?? '未提供')} · 产品作用：${escapeHtml(creative.productDramaticFunction ?? '未提供')}</span></article>`;
  dialog.innerHTML = `<div class="dialog-inner creative-editor"><div class="dialog-head"><div><div class="eyebrow">Gate 2 / 故事与镜头</div><h2>把已锁创意收束为一个可执行镜头。</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">本编辑器只开放与 Gate 1 不冲突的执行变量：单段、单镜、产品证据。保存后仍先形成候选，再由你进入正式 Gate 2 审核。</p>${creativeContext}<form class="operation-form" id="story-plan-form"><details class="gate2-step" open><summary>01 · 导演执行基调</summary><div class="form-grid">${storyField('directorialVoice', '导演声音', '例如：克制、写实，以产品的可见反应而非夸张表情建立可信度。')}${storyField('audienceFeltIntent', '观众最终感受', '观众在镜头结束时应该具体相信或感到什么？')}${storyField('visualStrategy', '视觉策略', '画面先让观众看哪里，随后发现什么？')}${storyField('rhythmStrategy', '节奏策略', '哪些动作完整发生，哪里留出停顿或反应？')}${storyField('realismStrategy', '真实感策略', '材质、重量、光线或动作如何避免机械感？')}</div></details><details class="gate2-step"><summary>02 · 一个完整的产品故事</summary><div class="form-grid">${storyField('storyPromise', '故事承诺', '观众看完会得到的核心体验或答案。')}${storyField('initialCondition', '开始条件', '镜头一开始尚未解决的具体状态。')}${storyField('objective', '本镜目标', '产品或使用动作在本镜中要达成的可观察目标。')}${storyField('centralConflict', '阻碍', '什么让结果无法直接出现，必须完成这次动作？')}${storyField('turn', '转折', '哪一个可见变化让局面发生方向改变？')}${storyField('climax', '证据顶点', '冲突最高点中，哪一个动作/结果必须被看清？')}${storyField('progression', '可观察的推进', '从问题/不确定，到产品被验证，再到新状态。')}${storyField('finalOutcome', '最终可见结果', '最后一帧已经发生了什么，能如何验证？')}${storyField('tone', '表演与审美基调', '例如：生活化、克制、有呼吸感。')}${storyField('location', '场景地点', '产品在哪个具体空间里被使用或展示？')}${storyField('timeOfDay', '时间与光线', '例如：清晨窗边的自然侧光。')}${storyField('sceneFunction', '本场唯一工作', '建立痛点、给出产品证据，或兑现变化。')}${storyField('pov', '观众视角', '观众跟随产品、使用者的手部，还是生活动作？')}${storyField('scenePowerShift', '本场主导权变化', '例如：从问题占据注意力到产品结果占据注意力。')}${storyField('sceneSubtext', '本场未说出口的意义', '动作和停顿真正让观众理解什么？')}${storyField('beats', '节拍（逐行）', '先看到什么问题\n产品如何进入动作\n最后如何证明结果', 4)}${storyField('segmentStoryBeat', '这一段的终点', '这一段完成哪一个唯一叙事工作？')}${storyField('splitReason', '为什么在此结束', '这是单段片，为什么在这个明确结果上收束？')}</div></details><details class="gate2-step"><summary>03 · 镜头合同</summary><div class="form-grid">${storyField('shotPurpose', '本镜目的', '把产品如何改变原始问题变成可见证据。')}${storyField('subjectAction', '主体动作与终点', '产品或手部执行什么动作，并准确到达什么结果？')}${storyField('shotContract', '景别、机位与运动', '必须写具体：例如 50mm 中近景、固定机位，最后缓慢推近至产品结构。')}${storyField('blocking', '空间、路径与遮挡', '产品、手部、前后景分别在哪里，如何移动或停留？')}${storyField('startState', '开始状态', '镜头开始时产品/环境处于什么确定状态？')}${storyField('endState', '结束状态', '镜头结束时可被下一步继承或审核的确定状态。')}${storyField('continuityAnchors', '连续性锚点（逐行）', '产品结构\n材质与颜色\n光线方向\n画面屏幕方向', 4)}${storyField('audio', '声音', '同步动作声、环境声、旁白，或明确静音。')}${storyField('risks', '风险点（逐行）', '产品结构\n手部接触\n反光材质', 3)}${storyField('mustSee', '必须看见的证据（逐行）', '第一眼能识别的产品结构\n动作完成后的具体结果', 3)}</div></details><details class="gate2-step"><summary>04 · 讲戏与可验收意图</summary><div class="form-grid">${storyField('narrativeFunction', '镜头叙事工作', '例如：通过一次完整操作，把“担心无效”转向“结果可验证”。')}${storyField('valueTurn', '可见价值变化', '必须明确从…到…：例如 从犹豫观察到确认产品已起效。')}${storyField('povCharacter', '视角主体', '例如：产品使用动作的近距离观察者。')}${storyField('powerShift', '前后主导权变化', '例如：从问题占主导到使用者通过产品重新掌握主动。')}${storyField('subtext', '未说出口的意义', '动作与停顿真正要表达什么？')}${storyField('feltIntent', '镜头结束时的感受', '观众应具体感到安心、笃定、松一口气，或其他结果。')}${storyField('whyThisShot', '为什么必须这样拍', '必须点明具体景别/机位/构图/运动与其作用。')}${storyField('audienceAttention', '注意力顺序', '观众先看哪里，随后发现哪个关键细节？')}${storyField('expressiveDetail', '表达性细节', '哪一个材质、声音、停顿或动作终点承载意义？')}${storyField('cameraInstruction', '镜头载体', '具体景别、机位、运动速度与停止位置。')}${storyField('cameraEvidence', '镜头可见证据', '画面如何证明镜头准确落在结果上？')}${storyField('performanceInstruction', '动作/物理载体', '动作如何由触发驱动，并抵达有重量感的终点？')}${storyField('performanceEvidence', '动作可见证据', '起始与结束行为/物理状态如何明确不同？')}</div></details><details class="gate2-step"><summary>05 · 最小资产范围</summary><div class="form-grid">${storyField('productReferenceReason', '为什么需要产品参考图', '写清需要锁定的结构、材质、颜色、比例或特写细节。')}</div><p class="notice">此单镜路线只要求产品参考资产；人物、场景九宫格与分镜不会被模板化扩张。</p></details><div class="notice">提交只创建一个绑定当前 Gate 1 SHA 的 Gate 2 草稿。它不生成资产、不创建付费任务，也不改变已锁定的创意方向。</div><button class="button primary" type="submit">创建 Gate 2 审核候选</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  setupGate2Steps(dialog);
  dialog.querySelector('#story-plan-form').addEventListener('submit', submitStoryPlan);
  dialog.showModal();
}

function setupGate2Steps(container) {
  const steps = [...container.querySelectorAll('.gate2-step')];
  steps.forEach((step, index) => {
    step.dataset.step = String(index + 1);
    if (index > 0) {
      step.classList.add('is-locked');
      step.querySelectorAll('textarea, input, select').forEach(control => { control.disabled = true; });
    }
    if (index < steps.length - 1) {
      const next = document.createElement('button');
      next.className = 'button step-next'; next.type = 'button'; next.textContent = `继续填写 ${String(index + 2).padStart(2, '0')} →`;
      next.addEventListener('click', () => {
        const controls = [...step.querySelectorAll('textarea, input, select')];
        const invalid = controls.find(control => !control.checkValidity());
        if (invalid) { invalid.reportValidity(); invalid.focus(); return; }
        step.classList.add('is-complete');
        const following = steps[index + 1];
        following.classList.remove('is-locked'); following.open = true;
        following.querySelectorAll('textarea, input, select').forEach(control => { control.disabled = false; });
        following.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      step.append(next);
    }
  });
}

async function submitStoryPlan(event) {
  event.preventDefault();
  if (event.currentTarget.querySelector('.gate2-step.is-locked')) return alert('请按顺序完成每个 Gate 2 区块，再创建审核候选。');
  const input = Object.fromEntries(new FormData(event.currentTarget));
  if (!window.confirm('确认创建绑定当前 Gate 1 创意母版的 Gate 2 故事与镜头候选？它仍需进入正式审核。')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/story-plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, confirm: true }) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

async function submitCandidate(artifactId) {
  if (!artifactId) return;
  if (!window.confirm('确认把这份候选提交到正式人工审核？提交后仍可在审核界面批准或退回。')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/reviews/${encodeURIComponent(artifactId)}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    if (dialog.open) dialog.close();
    await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

async function openFullStoryPlan() {
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/story-plan-template`);
    dialog.innerHTML = `<div class="dialog-inner full-editor"><div class="dialog-head"><div><div class="eyebrow">阶段 2 · 完整规划器</div><h2>多段、人物与原片路线</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">模板已经绑定最新阶段 1。系统会在后台编译结构化资料并校验人物、场景、分段、镜头清单、连续性和最小资产范围。</p><div class="notice editor-context"><strong>${escapeHtml(payload.creativeBrief?.logline ?? '已锁定阶段 1')}</strong><span>${escapeHtml(payload.creativeBrief?.targetDurationSec ?? '—')} 秒 · ${escapeHtml(payload.creativeBrief?.purpose ?? '')}</span></div><form class="operation-form" id="full-story-form"><label>完整故事与镜头计划（后台结构化内容）<textarea class="json-editor" name="plan" spellcheck="false" required>${escapeHtml(JSON.stringify(payload.template, null, 2))}</textarea></label><div class="notice">原始结构化内容不会在页面展示；此操作只创建阶段 2 审核候选，不会生成资产、视频或付费任务。</div><button class="button primary" type="submit">校验并创建阶段 2 候选</button></form></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#full-story-form').addEventListener('submit', submitFullStoryPlan);
    dialog.showModal();
  } catch (error) { alert(error.message); }
}

async function submitFullStoryPlan(event) {
  event.preventDefault();
  let plan;
  try { plan = JSON.parse(new FormData(event.currentTarget).get('plan')); }
  catch { return alert('故事与镜头计划内容无法读取，请返回可视化编辑器重新填写。'); }
  if (!window.confirm('确认用这份完整规划创建 Gate 2 审核候选？')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/story-plans/full`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan, confirm: true }) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

async function openSourceFacts() {
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/source-fact-template`);
    const referenceVideoId = payload.template.referenceVideo.artifactId;
    dialog.innerHTML = `<div class="dialog-inner source-fact-dialog"><div class="dialog-head"><div><div class="eyebrow">原片事实 · 阶段前置</div><h2>先把原视频看清楚，再继续规划</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">这一步不是生成视频，也不是写剧本。它只登记原视频里实际看见、听见和仍然不确定的内容，作为后续故事与镜头规划的事实底稿。</p><div class="source-fact-layout"><div><video id="source-fact-preview" class="media-preview" controls preload="metadata" src="/api/projects/${encodeURIComponent(activeSlug)}/media/${encodeURIComponent(referenceVideoId)}"></video><p class="notice">播放或拖动视频，记录关键变化发生的时间点。普通区间按每秒观察，动作密集处再提高观察密度。</p></div><form class="operation-form" id="source-fact-form"><section class="visual-form-section"><h3>一、原片范围</h3><label>原片时长（秒）<input name="durationSec" type="number" min="0.1" step="0.001" placeholder="正在读取视频时长…" required /></label><label>普通观察说明<textarea name="normalReason" rows="2" placeholder="例如：人物和场景变化较少，按每秒观察。" required></textarea></label></section><section class="visual-form-section"><h3>二、实际看到或听到的事实</h3><p class="field-help">每行写一条，格式为“时间｜事实”。时间必须是视频中实际发生的秒数。</p><label>画面事实<textarea name="visualFacts" rows="5" placeholder="例如：\n0｜人物站在画面中央，身体朝向镜头\n4｜人物抬起右手接触产品\n8｜产品结构被完整看见"></textarea></label><label>声音事实<textarea name="audioFacts" rows="3" placeholder="例如：\n2｜听见人物说出第一句台词\n7｜听见产品扣合的声音"></textarea></label><label>关键证据时间点（秒，每行一个）<textarea name="evidenceTimesSec" rows="2" placeholder="例如：0\n4\n8" required></textarea></label></section><section class="visual-form-section"><h3>三、解释与不确定项</h3><label>解释（不能当作事实）<textarea name="interpretation" rows="3" placeholder="例如：人物可能在犹豫，但画面只能确认她停顿了一下。"></textarea></label><label>仍不确定的内容<textarea name="uncertainties" rows="3" placeholder="例如：手部被身体遮挡，无法确认是否完成了第二次调整。"></textarea></label></section><div class="notice">系统会在后台自动生成观察时间线、采样点和校验资料；页面不会展示原始结构化内容。没有实际证据的猜测不能提交。</div><button class="button primary" type="submit">校验并锁定原片事实</button></form></div></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    const durationInput = dialog.querySelector('[name="durationSec"]');
    const preview = dialog.querySelector('#source-fact-preview');
    preview.addEventListener('loadedmetadata', () => { if (Number.isFinite(preview.duration) && preview.duration > 0) durationInput.value = preview.duration.toFixed(3); });
    preview.load();
    dialog.querySelector('#source-fact-form').addEventListener('submit', submitSourceFacts);
    dialog.showModal();
  } catch (error) { alert(error.message); }
}

function sourceFactLines(value) {
  return String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function parseTimedFacts(value, modality, fallbackTime) {
  return sourceFactLines(value).map((line, index) => {
    const match = line.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s*[|｜:：]\s*(.+)$/);
    const evidenceTime = match ? Number(match[1]) : fallbackTime;
    const statement = match ? match[2].trim() : line;
    if (!statement || !Number.isFinite(evidenceTime)) throw new Error(`第 ${index + 1} 条${modality === 'visual' ? '画面' : '声音'}事实缺少有效时间或内容。`);
    return { statement, modality, evidenceTimesSec: [evidenceTime] };
  });
}

async function submitSourceFacts(event) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  const durationSec = Number(fields.get('durationSec'));
  const evidenceTimesSec = sourceFactLines(fields.get('evidenceTimesSec')).map(Number);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return alert('请先确认原片时长。');
  if (!evidenceTimesSec.length || evidenceTimesSec.some(time => !Number.isFinite(time) || time < 0 || time >= durationSec)) return alert('请填写位于原片范围内的证据时间点。');
  const sampleTimesSec = Array.from({ length: Math.max(1, Math.ceil(durationSec)) }, (_, index) => index).filter(time => time < durationSec);
  const fallbackTime = evidenceTimesSec[0] ?? sampleTimesSec[0];
  let observedFacts;
  try {
    observedFacts = [
      ...parseTimedFacts(fields.get('visualFacts'), 'visual', fallbackTime),
      ...parseTimedFacts(fields.get('audioFacts'), 'audible', fallbackTime)
    ];
  } catch (error) { return alert(error.message); }
  if (!observedFacts.length && !sourceFactLines(fields.get('uncertainties')).length) return alert('至少填写一条画面事实、声音事实，或明确写出仍不确定的内容。');
  const invalidFact = observedFacts.find(fact => fact.evidenceTimesSec.some(time => !sampleTimesSec.some(sample => Math.abs(sample - time) < 0.001)));
  if (invalidFact) return alert('事实时间点需要落在每秒观察点上，请使用整数秒，或调整到相邻的整秒。');
  const analysis = {
    ...data.current?.sourceFactTemplate,
    projectId: data.current?.status?.projectId,
    referenceVideo: { ...data.current?.sourceFactTemplate?.referenceVideo },
    durationSec,
    samplingStrategy: {
      version: 'adaptive-source-sampling-v1',
      normal: { mode: 'uniform_low_frequency', targetFps: 1 },
      strongAction: { mode: 'dense_action_sampling', targetFps: 6 }
    },
    timeline: [{
      rowId: 'full-observation-range', startSec: 0, endSec: durationSec, samplingClass: 'normal',
      samplingReason: String(fields.get('normalReason') ?? '').trim(), targetFps: 1,
      sampleTimesSec, observedFacts,
      interpretation: sourceFactLines(fields.get('interpretation')),
      uncertainties: sourceFactLines(fields.get('uncertainties'))
    }]
  };
  const template = await request(`/api/projects/${encodeURIComponent(activeSlug)}/source-fact-template`);
  analysis.referenceVideo = template.template.referenceVideo;
  analysis.projectId = template.template.projectId;
  if (!window.confirm('确认这份内容来自对当前原视频的实际观察，并提交确定性校验？')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/source-facts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysis, confirm: true }) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

function uploadDefaults() {
  const project = data.current;
  const next = project?.next?.actions?.[0];
  const segmentId = next?.segmentId ?? project?.status?.activeSegmentId ?? project?.segments?.[0]?.id ?? '';
  const artifactType = activeProjectTab === 'runs' ? 'final_edit' : next?.id === 'prepare_project_assets' ? 'project_asset' : 'segment_asset';
  return { artifactType, segmentId };
}

function openUpload() {
  const defaults = uploadDefaults();
  const lockedVideos = (data.current?.artifacts ?? []).filter(item => item.type === 'video_segment' && item.status === 'locked').map(item => item.id).join(',');
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">导入项目文件</div><h2>登记为 Harness 产物</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">资产会复制到当前项目并登记为 draft；段落视频不能手工上传，必须从已准备的 LibTV 节点读取成功 task 与指纹。</p><form class="operation-form" id="upload-form"><div class="form-grid"><label>产物类型<select name="artifactType"><option value="project_asset" ${defaults.artifactType === 'project_asset' ? 'selected' : ''}>项目资产</option><option value="segment_asset" ${defaults.artifactType === 'segment_asset' ? 'selected' : ''}>段落资产</option><option value="final_edit" ${defaults.artifactType === 'final_edit' ? 'selected' : ''}>多段最终成片</option></select></label><label>产物 ID<input name="artifactId" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" placeholder="例如 product-reference-v1" required /></label><label>资产类别<input name="assetType" placeholder="例如 product_reference" /></label><label>段落 ID<input name="segmentId" value="${escapeHtml(defaults.segmentId)}" placeholder="例如 segment-001" /></label><label>人物 ID（可选）<input name="characterId" placeholder="例如 character-a" /></label><label>替代旧产物 ID（可选）<input name="supersedesArtifactId" placeholder="需要返工替换时填写" /></label></div><fieldset id="final-edit-fields" hidden><legend>最终成片合同</legend><label>源段落视频 ID（英文逗号分隔）<input name="sourceVideoArtifactIds" value="${escapeHtml(lockedVideos)}" /></label><label><input type="checkbox" name="pictureLock" value="true" /> 画面剪辑已锁定</label><label><input type="checkbox" name="soundMix" value="true" /> 声音混音已完成</label><label><input type="checkbox" name="colorContinuity" value="true" /> 色彩连续性已核对</label><label><input type="checkbox" name="continuityReview" value="true" /> 全片连续性已审看</label></fieldset><label>选择文件<input name="file" type="file" accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.mp3,.wav" required /></label><div class="notice">上传前会实际解码媒体；资产仍需 Gate 3 审核，最终成片仍需人工审核。此操作不会触发任何生成。</div><button class="button primary" type="submit">上传并登记草稿</button></form></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  const form = dialog.querySelector('#upload-form');
  const type = form.elements.artifactType;
  const syncFields = () => { form.querySelector('#final-edit-fields').hidden = type.value !== 'final_edit'; };
  type.addEventListener('change', syncFields); syncFields();
  form.addEventListener('submit', submitUpload);
  dialog.showModal();
}

async function submitUpload(event) {
  event.preventDefault();
  const form = event.currentTarget; const fields = new FormData(form); const file = fields.get('file');
  if (!(file instanceof File) || file.size === 0) return alert('请选择要导入的文件。');
  if (fields.get('artifactType') === 'final_edit' && !['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type)) return alert('最终成片必须选择 MP4、MOV 或 WebM 视频。');
  if (!window.confirm(`确认把“${file.name}”复制到当前项目并登记为草稿？`)) return;
  const query = new URLSearchParams({ confirm: 'true', filename: file.name });
  for (const name of ['artifactType', 'artifactId', 'assetType', 'segmentId', 'characterId', 'supersedesArtifactId', 'sourceVideoArtifactIds', 'pictureLock', 'soundMix', 'colorContinuity', 'continuityReview']) {
    const value = String(fields.get(name) ?? '').trim(); if (value) query.set(name, value);
  }
  const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = '正在复制并登记…';
  form.setAttribute('aria-busy', 'true');
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/uploads?${query}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    activeProjectTab = ['video_segment', 'final_edit'].includes(query.get('artifactType')) ? 'runs' : 'assets';
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { form.removeAttribute('aria-busy'); button.disabled = false; button.textContent = '上传并登记草稿'; alert(error.message); }
}

function openFoundation() {
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">导演工作台 / 操作模型</div><h2>网页负责操作，Harness 负责证明。</h2></div><button class="close" aria-label="关闭">×</button></div><div class="foundation-list"><p><b>1. 原创与复刻分路线。</b>原创强化概念与故事探索；复刻保留原片事实、逐镜拆解和差异检查。参考片角色未决时不提前选路线。</p><p><b>2. 双层分段。</b>剧情段服务完整叙事，生成单元服务实际模型调用；二者不能混成一个“十五秒分段”。</p><p><b>3. 三类关键人工决策。</b>目标主干聚焦创意方向、逐次付费生成包和最终成片；旧项目在合同迁移前仍可能保留额外兼容审核。</p><p><b>4. 七项流程合同。</b>剧情段、生成单元、资产账本、提示词包、决策记录、最小回流和最终剪辑清单分别留痕。</p><p><b>5. 付费与完成边界。</b>每次付费调用独立确认且禁止自动重试；分段可播放不等于完成，只有匹配的整片剪辑、技术验收、最终接受与交付回执同时成立才算完成。</p></div></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close()); dialog.showModal();
}

// D 项：分层验收卡。任务状态 SUCCESS 只代表平台任务完成，不等于验收通过；
// 规格层与绑定层是机器读回的事实，内容层只提供抽帧供人眼判断。
function videoAcceptanceCard(acceptance) {
  const spec = acceptance.spec;
  const specBody = spec?.error
    ? `<p class="notice danger-note">规格探测失败：${escapeHtml(spec.error)}</p>`
    : spec
      ? `<dl class="acceptance-facts">
          <div><dt>分辨率</dt><dd>${spec.width ?? '?'}×${spec.height ?? '?'}</dd></div>
          <div><dt>时长</dt><dd>${spec.durationSec ?? '?'} 秒</dd></div>
          <div><dt>帧率</dt><dd>${spec.frameRate ?? '?'} fps</dd></div>
          <div><dt>音轨</dt><dd>${spec.hasAudio ? escapeHtml(spec.audioCodec ?? '有') : '无音轨'}</dd></div>
        </dl>`
      : '<p class="empty">无规格数据。</p>';
  const binding = acceptance.binding;
  const bindingBody = binding
    ? `<dl class="acceptance-facts">
        <div><dt>模型</dt><dd data-original-text>${escapeHtml(binding.model ?? '未知')}</dd></div>
        <div><dt>设置</dt><dd>${escapeHtml([binding.settings?.ratio, binding.settings?.resolution, binding.settings?.duration != null ? binding.settings.duration + 's' : null, binding.settings?.enableSound === 'on' ? '有声' : '无声'].filter(Boolean).join(' · '))}</dd></div>
        <div><dt>媒体绑定</dt><dd>${binding.mixedList?.length ? binding.mixedList.map(item => escapeHtml(`${item.label ?? '?'}（${item.mediaType ?? '?'}`)).join('、') : '无'}</dd></div>
      </dl>`
    : '<p class="empty">无画布读回快照（该视频可能不是经画布同步登记的）。</p>';
  const contentBody = acceptance.contentFrameStrip
    ? `<img class="acceptance-frames" src="${acceptance.contentFrameStrip}" alt="成片抽帧总览" /><small>抽帧仅供观察；内容是否通过以 Gate 5 人审为准。</small>`
    : '<p class="empty">未能生成抽帧总览。</p>';
  return `<article class="panel acceptance-card"><div class="eyebrow">分层验收证据 · 任务状态 SUCCESS ≠ 验收通过</div><div class="acceptance-grid"><section><h3>规格层 · ffprobe 实测</h3>${specBody}</section><section><h3>绑定层 · 画布读回快照</h3>${bindingBody}</section><section><h3>内容层 · 抽帧（人工判断）</h3>${contentBody}</section></div></article>`;
}

function openSourceStoryboard() {
  const storyboard = data.current?.sourceStoryboard;
  if (!storyboard?.panels?.length || !activeSlug) return;
  const base = `/api/projects/${encodeURIComponent(activeSlug)}/source-storyboard`;
  const panels = storyboard.panels.map(panel => `<article class="storyboard-panel"><div class="storyboard-panel-head"><b>${escapeHtml(panel.id)} · ${escapeHtml(panel.shot)}</b><span>${escapeHtml(panel.range)}</span></div><div class="storyboard-image-wrap"><img src="${base}/source/${encodeURIComponent(panel.sourceFile)}" alt="${escapeHtml(panel.title)}原片分镜" /></div><div class="storyboard-panel-copy"><strong>${escapeHtml(panel.title)}</strong><p>${escapeHtml(panel.action)}</p><small>动作终点：${escapeHtml(panel.endpoint)}</small></div></article>`).join('');
  const templateBoards = (storyboard.templateBoards ?? []).map(board => `<article class="template-storyboard-board"><div><b>${escapeHtml(board.title)}</b><span>${escapeHtml(board.range)} · ${escapeHtml(String(board.panelCount))} 格</span></div><img src="${base}/template/${encodeURIComponent(board.filename)}" alt="${escapeHtml(board.title)}完整线稿故事板" /></article>`).join('');
  const templateSection = templateBoards ? `<section class="template-storyboard-section"><div class="template-storyboard-heading"><div><div class="eyebrow">逐格线稿故事板</div><h3>按测试轮次查看动作、节拍与硬切</h3></div><span class="status locked">${escapeHtml(storyboard.templateReviewStatus ?? '已生成')}</span></div><p>这些整板由原片对应截帧逐格转换，用于后续视频生成的动作控制。线稿只改变为黑白表现，保留人物调度、服装层级、标线位置、球拍、座椅、背景层级与切镜关系。</p><div class="template-storyboard-grid">${templateBoards}</div></section>` : '';
  const storyboardNote = templateBoards
    ? '完整线稿故事板已由对应原片截帧逐格转换而来；每一格只允许保留原片的机位、姿态、动作、标线和节拍。'
    : '当前只展示原片真实截帧。线稿尚未转换，避免把文字设想误当成原片动作。';
  dialog.innerHTML = `<div class="dialog-inner storyboard-dialog"><div class="dialog-head"><div><div class="eyebrow">原片动作控制</div><h2>原片分镜与线稿故事板</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">共 ${storyboard.panels.length} 格，覆盖前 ${escapeHtml(String(storyboard.lockedDurationSeconds ?? 31))} 秒。每格对应原片真实时间段：先建立画笔基准线，再完成受力动作，最后硬切回同一交界线回查。</p><p class="storyboard-note">${storyboardNote}</p>${templateSection}<section class="template-storyboard-section"><div class="template-storyboard-heading"><div><div class="eyebrow">原片动作证据</div><h3>逐格核对原片真实时段</h3></div></div><section class="storyboard-grid">${panels}</section></section></div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.showModal();
}

async function openArtifact(id, projectSlug = activeSlug) {
  const detail = await request(`/api/projects/${encodeURIComponent(projectSlug)}/artifacts/${encodeURIComponent(id)}`);
  const canReview = detail.artifact.status === 'awaiting_review' && REVIEWABLE_TYPES.includes(detail.artifact.type);
  const canSubmit = ['draft', 'rework'].includes(detail.artifact.status) && REVIEWABLE_TYPES.includes(detail.artifact.type);
  const needsAudit = ['project_asset', 'segment_asset'].includes(detail.artifact.type) && detail.artifact.mediaKind === 'image';
  const media = detail.mediaUrl ? (detail.mediaType?.startsWith('video/')
    ? `<video class="media-preview" controls src="${escapeHtml(detail.mediaUrl)}"></video>`
    : detail.mediaType?.startsWith('audio/') ? `<audio class="media-preview" controls src="${escapeHtml(detail.mediaUrl)}"></audio>`
      : `<img class="media-preview image-preview" src="${escapeHtml(detail.mediaUrl)}" alt="${escapeHtml(detail.artifact.id)}" />`) : '';
  const body = detail.content !== null ? readableArtifactContent(detail.content) : media || '<p class="empty">该产物没有可在浏览器中预览的文字或媒体内容。</p>';
  let qualityReview = '';
  if (canReview && ['video_segment', 'final_edit'].includes(detail.artifact.type)) {
    const payload = await request(`/api/projects/${encodeURIComponent(projectSlug)}/videos/${encodeURIComponent(id)}/review-template`);
    const resolution = payload.requiredResolution
      ? `<div class="notice">这是被退回版本的直接修订。通过时会绑定并关闭审核 ${escapeHtml(payload.requiredResolution.reviewId)}；系统不会仅凭“新版本存在”推断问题已解决。</div><input type="hidden" name="resolvesReviewId" value="${escapeHtml(payload.requiredResolution.reviewId)}" />`
      : '';
    const dimensionControls = payload.rubric.dimensions.map(dimension => {
      const evidence = payload.rubric.version >= 2
        ? `<textarea name="evidence:${escapeHtml(dimension.id)}" placeholder="写出实际观察到的画面证据（必填）" required></textarea><input name="regions:${escapeHtml(dimension.id)}" placeholder="时码或区域，多个用逗号或换行分隔" required /><input type="hidden" name="anchors:${escapeHtml(dimension.id)}" value="${escapeHtml(JSON.stringify(dimension.canonicalAnchorIds))}" /><input type="hidden" name="anchor-shas:${escapeHtml(dimension.id)}" value="${escapeHtml(JSON.stringify(dimension.canonicalAnchorSha256ById))}" />`
        : '';
      return `<label>${escapeHtml(dimension.label)}<small>权重 ${dimension.weight}% · 最低 ${dimension.minimum}${dimension.critical ? ' · 关键' : ''}</small><input type="number" name="score:${escapeHtml(dimension.id)}" min="0" max="100" required /></label>${evidence}`;
    }).join('');
    const categoryOptions = GATE5_FAILURE_CATEGORY_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    const stageOptions = GATE5_STAGE_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    const failureFields = `<fieldset><legend>退回归因（仅退回时必填）</legend><label>失败类别<select name="failureCategory"><option value="">请选择可由画面证据支持的类别</option>${categoryOptions}</select></label><label>稳定根因键<input name="rootCauseKey" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" placeholder="例如 gate5.identity.character-binding" /></label><label>责任阶段<select name="responsibilityStage"><option value="">请选择根因所在阶段</option>${stageOptions}</select></label><label>最小回流阶段<select name="returnStage"><option value="">请选择只需回到的最小阶段</option>${stageOptions}</select></label><small>不确定类别时选“其他”，但责任阶段和回流阶段仍须由人明确；本次退回不证明已发生免费或付费重试。</small></fieldset>`;
    qualityReview = `<form class="review-actions quality-form" id="quality-review-form" data-rubric-id="${escapeHtml(payload.rubric.id)}" data-rubric-version="${payload.rubric.version}"><div class="notice">Gate 5 必须逐项按锁定审片标准评分；系统不会从分数或备注自动猜测根因。</div>${resolution}<div class="score-grid">${dimensionControls}</div><fieldset><legend>一票否决（实际出现时勾选）</legend>${payload.rubric.vetoes.map(veto => `<label><input type="checkbox" name="veto" value="${escapeHtml(veto.id)}" /> ${escapeHtml(veto.label)}</label>`).join('')}</fieldset><textarea name="note" placeholder="审片结论与具体画面证据（必填）" required></textarea><textarea name="correction" placeholder="退回时的具体修改要求"></textarea>${failureFields}<textarea name="overrideReason" placeholder="评分与决策不一致时必须说明覆盖理由"></textarea><div class="review-row"><button class="button primary" value="approved" type="submit">通过 Gate 5</button><button class="button danger" value="rejected" type="submit">退回重做</button></div></form>`;
  }
  const preparation = canSubmit ? `<div class="review-actions"><div class="notice">草稿必须先完成所需机审，再提交到 Gate 人工审核。</div><div class="review-row">${needsAudit ? `<button class="button" id="open-asset-audit" data-asset-id="${escapeHtml(detail.artifact.id)}">运行独立像素审查</button>` : ''}<button class="button primary" data-submit-candidate="${escapeHtml(detail.artifact.id)}">提交人工审核</button></div></div>` : '';
  const standardReview = canReview && !['video_segment', 'final_edit'].includes(detail.artifact.type) ? `<form class="review-actions" id="review-form" data-artifact-id="${escapeHtml(detail.artifact.id)}"><div class="notice">此操作会写入当前项目的正式审核记录。请在完整查看本产物后决定。</div><textarea name="note" placeholder="审核结论（必填）"></textarea><textarea name="correction" placeholder="退回时的具体修改要求"></textarea><div class="review-row"><button class="button primary" value="approve" type="submit">批准并锁定</button><button class="button danger" value="reject" type="submit">退回修改</button></div></form>` : '';
  const acceptance = detail.videoAcceptance ? videoAcceptanceCard(detail.videoAcceptance) : '';
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">${escapeHtml(artifactTypeLabel(detail.artifact.type))} · 第 ${detail.artifact.revision} 版</div><h2>${escapeHtml(artifactTypeLabel(detail.artifact.type))}</h2></div><button class="close" aria-label="关闭">×</button></div><details><summary>原始文件与系统编号（技术核对用）</summary><p>原始文件名：<code>${escapeHtml(detail.artifact.path ?? '未记录')}</code></p><p>系统编号：<code>${escapeHtml(detail.artifact.id)}</code></p><p>这些原文用于定位文件，保留字母以免影响素材绑定。</p></details>${body}${detail.content !== null ? media : ''}${acceptance}${preparation}${qualityReview}${standardReview}</div>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#review-form')?.addEventListener('submit', submitReview);
  dialog.querySelector('#quality-review-form')?.addEventListener('submit', event => submitQualityReview(event, detail.artifact.id));
  dialog.querySelector('[data-submit-candidate]')?.addEventListener('click', () => submitCandidate(detail.artifact.id));
  dialog.querySelector('#open-asset-audit')?.addEventListener('click', () => openAssetAudit(detail.artifact.id));
  dialog.showModal();
}

async function submitQualityReview(event, artifactId) {
  event.preventDefault();
  const form = event.currentTarget; const fields = new FormData(form); const decision = event.submitter.value;
  const note = String(fields.get('note') ?? '').trim(); const correction = String(fields.get('correction') ?? '').trim();
  if (!note || (decision === 'rejected' && !correction)) return alert(decision === 'rejected' ? '退回时必须写明具体修改要求。' : '请填写基于画面的审片结论。');
  const scores = {};
  for (const [name, value] of fields.entries()) if (name.startsWith('score:')) scores[name.slice(6)] = Number(value);
  const triggeredVetoIds = fields.getAll('veto').map(String);
  const evidenceByDimension = {};
  if (Number(form.dataset.rubricVersion) >= 2) {
    for (const dimensionId of Object.keys(scores)) {
      const observation = String(fields.get(`evidence:${dimensionId}`) ?? '').trim();
      const timestampsOrRegions = String(fields.get(`regions:${dimensionId}`) ?? '').split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
      if (!observation || timestampsOrRegions.length === 0) return alert('每个审片维度都必须填写实际画面证据和时码或区域。');
      evidenceByDimension[dimensionId] = {
        observation, timestampsOrRegions,
        anchorIds: JSON.parse(String(fields.get(`anchors:${dimensionId}`))),
        anchorSha256ById: JSON.parse(String(fields.get(`anchor-shas:${dimensionId}`)))
      };
    }
  }
  let failureObservation;
  if (decision === 'rejected') {
    const category = String(fields.get('failureCategory') ?? '').trim();
    const rootCauseKey = String(fields.get('rootCauseKey') ?? '').trim();
    const responsibilityStage = String(fields.get('responsibilityStage') ?? '').trim();
    const returnStage = String(fields.get('returnStage') ?? '').trim();
    if (!category || !rootCauseKey || !responsibilityStage || !returnStage) return alert('退回时必须明确失败类别、稳定根因键、责任阶段和最小回流阶段。');
    failureObservation = { category, rootCauseKey, responsibilityStage, returnStage, retryKind: 'none' };
  }
  const input = {
    confirm: true, rubricId: form.dataset.rubricId, decision, note, correction: correction || null,
    scores, triggeredVetoIds, overrideReason: String(fields.get('overrideReason') ?? '').trim() || null,
    ...(Object.keys(evidenceByDimension).length > 0 ? { evidenceByDimension } : {}),
    ...(failureObservation ? { failureObservation } : {}),
    ...(fields.get('resolvesReviewId') ? { resolvesReviewId: String(fields.get('resolvesReviewId')) } : {})
  };
  if (!window.confirm(decision === 'approved' ? '确认这些评分和证据足以通过 Gate 5？' : '确认按当前评分退回该视频？')) return;
  try {
    await request(`/api/projects/${encodeURIComponent(activeSlug)}/videos/${encodeURIComponent(artifactId)}/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    dialog.close(); await refreshAll(); await loadProject(activeSlug);
  } catch (error) { alert(error.message); }
}

async function openAssetAudit(assetId) {
  try {
    const payload = await request(`/api/projects/${encodeURIComponent(activeSlug)}/assets/${encodeURIComponent(assetId)}/audit-template`);
    dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-head"><div><div class="eyebrow">资产检查</div><h2>开始画面复核</h2></div><button class="close" aria-label="关闭">×</button></div><p class="lede">系统会直接检查这张画面的关键条件，避免只根据文件名或描述做判断。</p><div class="notice">本次将核对 ${payload.requiredChecks.length} 项画面条件。</div><form class="operation-form" id="asset-audit-form">${auditAuthorizationSummary('当前画面')}<button class="button primary" type="submit">开始一次画面复核</button></form></div>`;
    dialog.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#asset-audit-form').addEventListener('submit', event => submitPaidAuditForm(event, `/api/projects/${encodeURIComponent(activeSlug)}/assets/${encodeURIComponent(assetId)}/audits`));
    dialog.showModal();
  } catch (error) { return alert(error.message); }
}

async function submitReview(event) {
  event.preventDefault(); const decision = event.submitter.value; const fields = new FormData(event.currentTarget); const note = String(fields.get('note') ?? '').trim(); const correction = String(fields.get('correction') ?? '').trim();
  if (!note || (decision === 'reject' && !correction)) return alert(decision === 'reject' ? '请填写退回原因与修改要求。' : '请填写审核结论。');
  const artifactId = event.currentTarget.dataset.artifactId;
  if (!artifactId) return alert('审核产物编号缺失，请刷新后重新打开审核页面。');
  if (!window.confirm(decision === 'approve' ? '确认批准并锁定该产物？此操作会创建正式审核记录。' : '确认退回该产物？此操作会创建正式审核记录。')) return;
  try { await request(`/api/projects/${encodeURIComponent(activeSlug)}/reviews/${encodeURIComponent(artifactId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note, correction, confirm: true }) }); dialog.close(); await refreshAll(); await loadProject(activeSlug); } catch (error) { alert(error.message); }
}

async function refreshAll() {
  data = await request('/api/projects');
  if (activeSlug && !data.projects.some(project => project.slug === activeSlug && !project.error)) activeSlug = null;
  render(activeSlug ? data.current : null);
}

async function boot() {
  const session = await request('/api/session');
  sessionInfo = session;
  csrfToken = session.csrfToken;
  await refreshAll();
}

boot().catch(error => { app.innerHTML = `<main class="main"><p class="error">无法载入 Harness Studio：${escapeHtml(error.message)}</p></main>`; });

// Temporary per-project rollout fallback, kept until user usability acceptance.
function legacyProjectViewInner(project) {
  const { status, next, artifacts, routeDecision } = project;
  const grouped = groupArtifacts(artifacts);
  const nextAction = effectiveNextAction(project);
  const awaiting = artifacts.filter(item => item.status === 'awaiting_review');
  const locked = artifacts.filter(item => item.status === 'locked');
  const gate = projectGate(project);
  const routeGap = projectRouteGap(project);
  const canIntake = routeGap || nextAction?.id === 'capture_intake_route';
  const surface = actionSurface(project, nextAction);
  const wholeFilmComplete = project.studioFlow?.completion?.wholeFilmComplete === true;
  const latestCreative = artifacts.filter(item => item.type === 'creative_brief').sort((a, b) => b.revision - a.revision || b.id.localeCompare(a.id))[0];
  const latestStory = artifacts.filter(item => item.type === 'story_plan').sort((a, b) => b.revision - a.revision || b.id.localeCompare(a.id))[0];
  const creativeRevision = pendingCreativeRevision(project);
  const creativeDraft = creativeRevision?.artifact ?? (['draft', 'rework'].includes(latestCreative?.status) ? latestCreative : null);
  const storyDraft = ['draft', 'rework'].includes(latestStory?.status) ? latestStory : null;
  const preparedCanvasSegment = creativeRevision ? null : preparedCanvasNodes(project)[0] ?? null;
  const simpleRemakeReadySegment = !creativeRevision && project.workflowProfileId === 'simple_remake'
    ? (project.production ?? []).find(item => item.readyForCanvas)
    : null;
  const mechanicalCanvasReady = project.routeDecision?.executionClass === 'mechanical_asset_prompt'
    && project.mechanicalCanvas?.status === 'READY_FOR_USER_CANVAS_GENERATION'
    && typeof project.mechanicalCanvas?.projectUuid === 'string'
    ? project.mechanicalCanvas
    : null;
  const stepProgress = projectVisibleStepProgress(project, gate);
  const terminalProject = wholeFilmComplete || project.status?.phase === 'archived';
  let focusButton = creativeRevision && creativeDraft
    ? creativeDraft.status === 'awaiting_review'
      ? `<button class="button primary focus-button" data-artifact="${escapeHtml(creativeDraft.id)}" data-artifact-project="${escapeHtml(activeSlug ?? '')}">审阅并确认剧情段方案</button>`
      : `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(creativeDraft.id)}">查看并提交导演确认</button>`
    : mechanicalCanvasReady
    ? `${canvasLink(mechanicalCanvasReady.projectUuid, `打开 LibTV 画布（${mechanicalCanvasReady.nodes?.length ?? 0} 段待你点击生成）`, 'button primary focus-button')}<button class="button" id="prepare-mechanical-package">重新切分或调整范围</button>`
    : preparedCanvasSegment?.canvasPreparation?.projectUuid
    ? canvasLink(preparedCanvasSegment.canvasPreparation.projectUuid, '打开视频画布', 'button primary focus-button')
    : simpleRemakeReadySegment
    ? `<button class="button primary focus-button" data-prepare-canvas="${escapeHtml(simpleRemakeReadySegment.segmentId)}">下一步：准备视频画布</button>`
    : nextAction?.id === 'prepare_mechanical_asset_prompt_package'
    ? '<button class="button primary focus-button" id="prepare-mechanical-package">切分视频并编译提示词</button>'
    : nextAction?.id === 'prepare_mechanical_libtv_canvas'
    ? '<button class="button primary focus-button" id="prepare-mechanical-canvas">上传并绑定到 LibTV 画布</button>'
    : nextAction?.id === 'human_review' && (nextAction.artifactIds?.[0] ?? awaiting[0]?.id)
    ? `<button class="button primary focus-button" data-artifact="${escapeHtml(nextAction.artifactIds?.[0] ?? awaiting[0].id)}" data-artifact-project="${escapeHtml(activeSlug ?? '')}">打开第一个待审产物</button>`
    : nextAction?.id === 'machine_review_story_plan'
    ? '<button class="button primary focus-button" id="machine-review-story-plan">完成故事与镜头机审</button>'
    : terminalProject
    ? '<button class="button primary focus-button" id="return-project-list">返回项目列表</button>'
    : canIntake ? `<button class="button primary focus-button" id="open-intake">${routeGap ? '补齐 Gate 0 路由' : '开始 Gate 0'}</button>`
    : nextAction?.id === 'complete_director_interview' ? '<button class="button primary focus-button" id="open-director-interview">继续导演访谈</button>'
      : nextAction?.id === 'submit_creative_brief_review' && creativeDraft ? `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(creativeDraft.id)}">提交 Gate 1 审核候选</button>`
      : nextAction?.id === 'prepare_creative_brief' ? (project.directorInterview?.gate1DraftTask?.status === 'ready_for_director_engine'
        ? `<button class="button primary focus-button" id="open-director-engine">${project.workflowProfileId === 'simple_remake' ? '生成第一版复刻方案' : '生成第一版剧情方案'}</button>`
        : project.routeDecision?.referenceRoleStatus === 'not_applicable'
          ? '<button class="button primary focus-button" id="open-creative-brief">编辑 Gate 1 创意单</button>'
          : '<button class="button primary focus-button" id="open-full-creative-brief">打开完整 Gate 1 规划器</button>')
        : nextAction?.id === 'prepare_story_plan' ? (project.compactGate2?.supported && ['asset_anchored', 'simple_remake'].includes(project.compactGate2?.mode)
          ? '<button class="button primary focus-button" id="auto-lightweight-story-plan">系统整理已选素材并生成故事与镜头草稿</button>'
          : project.compactGate2?.supported
            ? '<button class="button primary focus-button" id="open-story-plan">编辑 Gate 2 故事与镜头</button>'
          : `<button class="button focus-button" id="open-full-story-plan">打开完整 Gate 2 规划器</button><div class="notice compact-note">${escapeHtml(project.compactGate2?.reason ?? '这个项目需要完整 Gate 2 规划器。')}</div>`)
          : nextAction?.id === 'submit_story_plan_review' && (storyDraft || nextAction.storyPlanId) ? `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(storyDraft?.id ?? nextAction.storyPlanId)}">提交 Gate 2 审核候选</button>`
              : nextAction?.id === 'prepare_source_fact_analysis' ? '<button class="button primary focus-button" id="open-source-facts">开始整理原片事实</button>'
              : nextAction?.id === 'run_source_comparator_audit' ? '<button class="button primary focus-button" id="run-source-comparator">运行确定性原片对照</button>'
                : nextAction?.id === 'complete_observed_handoff' ? '<button class="button primary focus-button" id="prepare-observed-handoff">检查上一段结尾状态</button>'
                : nextAction?.id === 'propose_segmentation' ? '<button class="button primary focus-button" id="create-segmentation">从 Gate 2 锁定生成分段</button>'
              : nextAction?.id === 'create_quality_rubric' ? '<button class="button primary focus-button" id="create-quality-rubric">建立统一审片标准</button>'
                : nextAction?.id === 'create_segment_contract' ? '<button class="button primary focus-button" id="create-segment-contract">建立当前段执行合同</button>'
                  : ['prepare_project_assets', 'prepare_segment_assets'].includes(nextAction?.id) ? '<button class="button primary focus-button" id="open-upload">导入所需资产</button>'
                    : nextAction?.id === 'prepare_generation_package' ? '<button class="button primary focus-button" id="open-production">进入生成前准备</button>'
                    : nextAction?.id === 'resolve_director_run'
                      ? `<div class="focus-button-row">${nextAction.runs?.every(run => run.status === 'MODEL_SUCCEEDED_UNCOMMITTED' && run.paidModelCallCompleted === true) ? `<button class="button primary focus-button" data-recover-director-run="${escapeHtml(nextAction.runs[0].id)}">只恢复已保存的导演草稿</button>` : ''}<button class="button quiet" data-resolve-director-run="${escapeHtml(nextAction.runs?.[0]?.id ?? '')}">停止模型重试，转手工编辑</button></div>`
                    : nextAction?.id === 'recover_transactions' ? '<button class="button primary focus-button" id="recover-transactions">恢复未完成的本地事务</button>'
                    : nextAction?.id === 'prepare_gate5_rework_order' ? `<button class="button primary focus-button" data-prepare-gate5-rework="${escapeHtml(nextAction.failureReturnId)}">冻结证据并建立返工作业</button>`
                    : nextAction?.id === 'execute_gate5_failure_return' ? '<button class="button primary focus-button" data-open-gate5-failure-return>进入最小返工</button>'
                    : nextAction?.id === 'submit_gate5_video_review' ? `<button class="button primary focus-button" data-submit-candidate="${escapeHtml(nextAction.artifactId)}">重新提交 Gate 5 审核</button>`
                    : nextAction?.id === 'verify_delivery' ? '<button class="button primary focus-button" id="verify-delivery">核验最终交付</button>' : '';
  if (!focusButton && nextAction) focusButton = '<button class="button focus-button" data-open-operational-readiness>查看阻塞与恢复路径</button>';
  const tabBody = legacyProjectTabView(project, { grouped, nextAction, awaiting, locked, gate, focusButton });
  const projectTitle = escapeHtml(projectDisplayName(project));
  const projectStage = escapeHtml(GATES[gate]?.[1] ?? phaseLabel(status.phase));
  if (activeProjectTab !== 'overview') {
    return `<main class="main project-workspace focused-reference-page"><header class="project-task-header"><button class="back-link" id="home">← 全部项目</button><div><div class="eyebrow">${projectTitle}</div><h1 tabindex="-1">${escapeHtml(PROJECT_TABS.find(([id]) => id === activeProjectTab)?.[1] ?? '项目资料')}</h1></div><button class="button quiet" id="show-current-task">返回当前任务</button></header><section class="focused-reference-body">${tabBody}</section></main>`;
  }
  const referenceTabs = PROJECT_TABS.filter(([id]) => id !== 'overview').map(([id, label]) => `<button class="reference-link" data-project-tab="${id}"><span>${escapeHtml(label)}</span><b>→</b></button>`).join('');
  const manualPlanning = nextAction?.id === 'prepare_creative_brief' && project.directorInterview?.gate1DraftTask?.status === 'ready_for_director_engine'
    ? (project.routeDecision?.referenceRoleStatus === 'not_applicable' ? '<button class="button quiet" id="open-creative-brief">改为手动编辑剧情</button>' : '<button class="button quiet" id="open-full-creative-brief">改为手动规划剧情</button>') : '';
  const disclosure = `<details class="project-progress-disclosure" id="project-details" ${projectDetailsOpen ? 'open' : ''}><summary><span><strong>查看进度与资料</strong><small>当前：${projectStage} · 第 ${stepProgress.currentStep} / ${stepProgress.totalSteps} 步</small></span><i aria-hidden="true">⌄</i></summary><div class="project-progress-content"><nav class="gate-rail compact-gate-rail" aria-label="项目进度">${renderGateRail(project, gate)}</nav><div class="reference-link-grid">${referenceTabs}</div><div class="project-utility-actions">${manualPlanning}<button class="button quiet" id="open-upload">导入文件</button><button class="button quiet" data-open-operational-readiness>检查当前步骤</button><button class="button quiet" id="refresh">刷新状态</button><button class="button quiet" id="show-foundation">了解工作流原则</button></div></div></details>`;
  return `<main class="main project-workspace single-task-workspace"><header class="project-task-header"><button class="back-link" id="home">← 全部项目</button><div><div class="eyebrow">当前项目</div><h1 tabindex="-1">${projectTitle}</h1></div><span class="step-pill">${stepProgress.currentStep} / ${stepProgress.totalSteps}</span></header><section class="project-tab-body">${tabBody}</section>${disclosure}</main>`;
}

function legacyProjectTabView(project, context) {
  const { status, next, artifacts, segments = [], runs = [], reviews = [] } = project;
  const { grouped, nextAction, awaiting, locked, gate, focusButton } = context;
  const surface = actionSurface(project, nextAction);
  const wholeFilmComplete = project.studioFlow?.completion?.wholeFilmComplete === true;
  // 该值同时驱动当前焦点的文案与按钮；项目页的每个标签视图都是独立渲染函数，不能依赖外层局部变量。
  const creativeRevision = pendingCreativeRevision(project);
  const simpleRemakeReadySegment = !creativeRevision && project.workflowProfileId === 'simple_remake'
    ? (project.production ?? []).find(item => item.readyForCanvas)
    : null;
  if (activeProjectTab === 'director') return directorDeskView(project, surface, focusButton);
  if (activeProjectTab === 'workflow') return `<section><div class="section-head"><div><div class="eyebrow">内部状态机</div><h2>机器检查点与最小回流证据</h2></div><span class="meta">目标主干归并为三类关键决策</span></div><p class="notice boundary-card">以下六列是内部检查点，不是六次人工审批。出现失败时只回到提示词、资产、生成、剪辑等最小责任阶段；更早已锁定的证据保持冻结。</p><div class="workflow-board">${GATES.map(([id, name], index) => { const verified = project.gateStates?.find(item => item.gate === index); const blocked = verified?.status === 'blocked' ? `<p class="notice compact danger-note">${escapeHtml(gateExplanation(project, index, name))}</p>` : ''; return `<article class="gate-column ${index === gate ? 'current' : ''}"><header><span>检查点 ${index}</span><strong>${name}</strong><small>${verified?.status === 'passed' ? '完整验证通过' : `${(grouped[index] ?? []).length} 项证据`}</small></header>${blocked}<div>${(grouped[index] ?? []).map(artifactRow).join('') || '<p class="empty compact">暂无证据</p>'}</div></article>`; }).join('')}</div></section>`;
  if (activeProjectTab === 'assets') {
    const assets = artifacts.filter(item => ['project_asset', 'segment_asset', 'spatial_control_model', 'storyboard_panel'].includes(item.type));
    return `<section><div class="section-head"><div><div class="eyebrow">Gate 3 / 资产库</div><h2>项目和段落所需的最小资产</h2></div><button class="button primary" id="open-upload">导入资产</button></div><div class="asset-grid">${assets.map(assetCard).join('') || '<article class="panel empty">还没有资产。Gate 2 锁定后，按照镜头计划导入或生成真正需要的资产。</article>'}</div></section>`;
  }
  if (activeProjectTab === 'production') {
    const safeImageSegmentIds = new Set(safeGenerationSegments(project, 'image').map(segment => segment.id));
    const pendingImageAssets = (project.production ?? [])
      .filter(item => safeImageSegmentIds.has(item.segmentId))
      .reduce((sum, item) => sum + (item.pendingImageAssetCount ?? 0), 0);
    const productionPath = project.workflowProfileId === 'simple_remake'
      ? '每段按顺序完成：锁定资产清单 → 系统整理讲戏本 → 系统整理生成提示 → 整理生成包 → 系统生成前检查。完成后直接准备视频画布。'
      : '每段按顺序完成：锁定资产清单 → 系统整理讲戏本 → 系统整理生成提示 → 整理生成包 → 独立复核。';
    const narrativeContract = workflowContractState(project, 'narrative_block');
    return `<section><div class="section-head"><div><div class="eyebrow">双层分段</div><h2>剧情段决定叙事，生成单元决定调用</h2></div><div class="section-actions">${pendingImageAssets > 0 ? '<button class="button" id="open-paid-image">生成图片资产</button>' : ''}<span class="meta">${project.production?.length ?? 0} 个生成单元</span></div></div><div class="dual-segment-summary"><article><small>剧情段</small><strong>完整场景与剧情结构</strong><span class="status ${narrativeContract.tone}">${escapeHtml(narrativeContract.label)}</span><p>允许自然的 10、13、14 秒段，也允许 21 秒剧情拆成 15 秒＋6 秒生成单元。</p></article><article><small>生成单元</small><strong>一次模型调用的镜头范围</strong><span class="status ${(project.production ?? []).length ? 'awaiting_review' : 'draft'}">${(project.production ?? []).length ? `${project.production.length} 个已登记` : '尚未登记'}</span><p>模型多镜能力未在当前配置验证时，一律逐镜生成后再确定性拼接。</p></article></div><div class="notice boundary-card">${productionPath} 付费图片只会在确有待生成资产时显示，并且每次只允许一个已确认指纹，不会自动重试。</div><div class="production-grid">${(project.production ?? []).map(item => productionCard(item, project.workflowProfileId)).join('') || '<article class="panel empty">完整故事与镜头形成后，这里才会出现实际生成单元。</article>'}</div></section>`;
  }
  if (activeProjectTab === 'runs') {
    const readySegmentIds = new Set(safeGenerationSegments(project, 'video', { readyOnly: true }).map(item => item.id));
    const readySegments = (project.production ?? []).filter(item => item.readyForCanvas === true && readySegmentIds.has(item.segmentId));
    const jobs = project.generationJobs ?? [];
    const hasStudioFlow = Boolean(project.studioFlow);
    const lockedOutputs = hasStudioFlow ? project.studioFlow.completion?.unitOutputCount ?? 0 : 0;
    const projectedFinalEditId = project.studioFlow?.completion?.finalEditArtifactId ?? null;
    const finalEdit = hasStudioFlow
      ? artifacts.find(item => item.id === projectedFinalEditId && item.type === 'final_edit' && item.status === 'locked')
      : null;
    const completionLevel = project.studioFlow?.completion?.level;
    const deliveryState = !hasStudioFlow ? ['等待服务投影，无法验证交付状态', 'draft']
      : wholeFilmComplete ? ['已完成完整交付', 'locked']
      : completionLevel === 'final_edit_ready' || finalEdit ? ['整片已锁定，等待最终接受', 'awaiting_review']
        : lockedOutputs ? [`已有 ${lockedOutputs} 个生成单元结果，尚无完整成片`, 'awaiting_review']
          : ['尚未生成可验收视频', 'draft'];
    return `<section><div class="section-head"><div><div class="eyebrow">生成、剪辑与交付</div><h2>分段结果不等于最终成片</h2></div><div class="section-actions">${readySegments.length ? '<button class="button primary" id="open-paid-video">付费生成视频</button><button class="button" id="prepare-libtv">只准备画布</button>' : ''}${segments.length > 1 ? '<button class="button" id="open-upload">导入最终剪辑</button>' : ''}</div></div><article class="panel final-delivery-state"><div><small>最终交付状态</small><strong>${escapeHtml(deliveryState[0])}</strong><p>只有最终剪辑清单、全部生成单元溯源、技术验收和 Gate 5 创意接受同时成立，项目才能记为完成。</p></div><span class="status ${deliveryState[1]}">${!hasStudioFlow ? '无法验证' : wholeFilmComplete ? '已封存' : finalEdit ? '待接受' : '未完成'}</span></article><div class="notice boundary-card">每次付费调用都必须先显示模型、绑定资产、生成次数、精确指纹与实际费用，并取得本次单次授权；禁止自动付费重试。</div>${jobs.length ? `<div class="run-grid">${jobs.map(generationJobCard).join('')}</div>` : ''}<div class="run-grid">${runs.map(runCard).join('') || '<article class="panel empty">尚无视频生成运行记录。</article>'}</div>${segments.length ? `<article class="panel segment-strip"><div class="eyebrow">生成单元</div><div>${segments.map(segmentChip).join('')}</div></article>` : '<article class="panel empty">故事与镜头形成正式生成单元后，才会开放付费视频生成。</article>'}</section>`;
  }
  if (activeProjectTab === 'ledger') return executionLedgerView(project);
  if (activeProjectTab === 'reviews') return `<section><div class="section-head"><div><div class="eyebrow">三类关键人工决策</div><h2>创意方向 → 逐次付费生成包 → 最终成片</h2></div><span class="meta">${awaiting.length} 待审 · ${reviews.length} 记录</span></div><p class="notice boundary-card">新版目标把提示词、资产、连续性和技术检查交给机器；当前兼容项目仍可能出现旧故事、资产或分段审片操作。多镜失败后的“整段重试或逐镜重做”等异常付费选择必须单独展示，不能复用旧授权。</p><div class="review-layout"><article class="panel"><h2>等待判断</h2><div class="artifact-list">${awaiting.map(artifactRow).join('') || '<p class="empty">当前没有待人工审核的产物。</p>'}</div></article><article class="panel"><h2>决策与异常裁决历史</h2><div class="review-history">${reviews.map(reviewRow).join('') || '<p class="empty">暂无审核记录。</p>'}</div></article></div></section>`;
  if (activeProjectTab === 'evidence') {
    const receipt = project.deliveryReceipt && wholeFilmComplete ? `<article class="panel completion-receipt"><div><div class="eyebrow">最终交付回执</div><h2>项目已经完成执行、审核与复盘</h2><p>交付指纹 ${escapeHtml(project.deliveryReceipt.deliveryFingerprint.slice(0, 16))}… · ${project.deliveryReceipt.deliverable.length} 个生成单元</p></div><span class="status locked">COMPLETE</span></article>`
      : project.deliveryReceipt ? '<article class="panel"><div class="eyebrow">交付回执异常</div><p class="notice danger-note">发现回执，但它没有与当前锁定最终剪辑、项目归档状态和交付指纹形成完整绑定；不会据此显示项目完成。</p></article>' : '';
    return `<section>${receipt}<div class="section-head"><div><div class="eyebrow">事实源</div><h2>全部版本化证据</h2></div><span class="meta">${artifacts.length} 项</span></div><div class="evidence-table">${artifacts.map(artifactRow).join('') || '<p class="empty">尚无项目证据。</p>'}</div></section>`;
  }
  const routeGap = projectRouteGap(project);
  const [taskTitle, taskReason] = currentTaskCopy(nextAction);
  const simpleRemakeBriefReady = project.workflowProfileId === 'simple_remake' && nextAction?.id === 'prepare_creative_brief';
  const terminalProject = wholeFilmComplete || project.status?.phase === 'archived';
  const visibleTitle = routeGap ? '补齐最开始的需求' : creativeRevision ? '确认新版剧情段方案' : terminalProject ? '项目已完成并归档' : simpleRemakeReadySegment ? '生成前准备已完成' : simpleRemakeBriefReady ? '生成第一版复刻方案' : taskTitle;
  const visibleReason = routeGap ? '这个旧项目缺少最开始的需求记录。补齐后，系统才能保证后面的剧情和素材没有走错方向。' : creativeRevision ? '新的方案只替换需要返工的剧情段，已经确认过的内容继续保留。' : terminalProject ? '完整成片、审核记录和交付结果已经绑定，可以随时回查。' : simpleRemakeReadySegment ? '系统已经完成当前段的生成前检查。下一步只准备视频画布，不会生成视频，也不会产生费用。' : simpleRemakeBriefReady ? '系统只根据原片、替换范围和已选控制方式整理复刻方案；不改写原片剧情，不新增观众承诺、人物动机或产品宣称。' : taskReason;
  const routeTask = project.routeDecision?.executionClass === 'mechanical_asset_prompt' ? '' : !project.workflowProfileId ? workflowRoutePanel(project)
    : project.workflowProfileId === 'simple_remake' && !project.workflowProfileView?.remakeControlSelection
      ? remakeControlPanel(project, project.workflowProfileView)
      : '';
  const currentEvidence = creativeRevision ? `${sourceStoryboardCard(project)}${creativeRevisionCard(creativeRevision)}` : '';
  if (routeTask) return `<section class="single-task-page">${routeTask}</section>`;
  return `<section class="single-task-page"><article class="single-task-card ${routeGap || next?.blocked ? 'is-blocked' : ''}" aria-labelledby="current-task-title"><div class="single-task-kicker"><span>现在只做这一件事</span><i>${escapeHtml(surface.label)}</i></div><h2 id="current-task-title">${escapeHtml(visibleTitle)}</h2><p class="single-task-reason">${escapeHtml(visibleReason)}</p>${project.blockedReason ? `<p class="notice danger-note">${escapeHtml(project.blockedReason)}</p>` : ''}${currentEvidence}<div class="single-task-action">${focusButton || '<span class="status locked">当前不需要操作</span>'}</div></article></section>`;
}
