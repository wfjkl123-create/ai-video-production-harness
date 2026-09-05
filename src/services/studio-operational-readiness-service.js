import { auditProjectReadiness } from './project-readiness-audit-service.js';
import { determineNextActions } from './next-action-service.js';

export const STUDIO_ACTION_COVERAGE = Object.freeze({
  reconcile_video_submit: { supported: false, recovery: true, reason: '未知外部提交尚未接入网页裁决' },
  resolve_director_run: { supported: true, recovery: true },
  recover_transactions: { supported: true, recovery: true },
  inspect_project_lock: { supported: false, recovery: true, reason: '项目锁检查尚未接入网页操作' },
  repair_project_evidence: { supported: false, recovery: true, reason: '证据修复尚未接入网页操作' },
  resolve_project_blocker: { supported: false, recovery: true, reason: '人工阻塞解除尚未接入网页操作' },
  capture_intake_route: { supported: true },
  resolve_reference_role: { supported: false, reason: '参考视频角色修订需要重新进入 Gate 0' },
  register_reference_videos: { supported: false, reason: '缺失参考视频需要重新进入 Gate 0' },
  register_mechanical_assets: { supported: false, reason: '缺失的机械任务输入资产需要重新进入素材导入' },
  prepare_mechanical_asset_prompt_package: {
    supported: true,
    assisted: true
  },
  prepare_mechanical_libtv_canvas: { supported: true, assisted: true },
  mechanical_canvas_ready: { supported: true },
  prepare_director_interview: { supported: true },
  answer_director_interview: { supported: true },
  record_generation_control_remediation: { supported: false, recovery: true, reason: '失败根因与控制路线修复需要人工复核' },
  generation_failure_limit_reached: { supported: false, recovery: true, reason: '项目生成失败上限已终止后续付费操作' },
  classify_gate5_rejection: { supported: false, recovery: true, reason: '历史 Gate 5 退回缺少明确根因和最小回流阶段，必须人工补证后才能继续' },
  prepare_gate5_rework_order: { supported: true, recovery: true },
  execute_gate5_failure_return: { supported: true, assisted: true, recovery: true },
  submit_gate5_video_review: { supported: true },
  human_review: { supported: true },
  prepare_creative_brief: { supported: true },
  prepare_source_fact_analysis: { supported: true, assisted: true },
  prepare_story_plan: { supported: true, assisted: true },
  machine_review_story_plan: { supported: true },
  run_source_comparator_audit: { supported: true },
  submit_story_plan_review: { supported: true },
  propose_segmentation: { supported: true },
  verify_delivery: { supported: true },
  complete_observed_handoff: { supported: true },
  create_quality_rubric: { supported: true },
  prepare_project_assets: { supported: true, assisted: true },
  create_segment_contract: { supported: true },
  prepare_segment_assets: { supported: true, assisted: true },
  prepare_generation_package: { supported: true },
  register_required_inputs: { supported: true, assisted: true }
});

const STAGES = Object.freeze([
  { id: 'gate0', label: '需求与路由', coverage: 'native', executable: true },
  { id: 'gate1', label: '导演创意', coverage: 'native_with_bounded_model', executable: true },
  { id: 'gate2', label: '剧本、人物与镜头', coverage: 'web_editor_assisted', executable: true, gap: '复杂项目仍需手工填写或导入完整规划' },
  { id: 'gate3', label: '资产生产与审核', coverage: 'import_and_review', executable: false, gap: '图片提示词计划与资产生成尚未接入网页' },
  { id: 'gate4', label: '生成准备与画布', coverage: 'native_plus_libtv_canvas', executable: true },
  { id: 'gate5', label: '成片审核', coverage: 'native', executable: true },
  { id: 'closure', label: '交付与复盘', coverage: 'native', executable: true }
]);

function dependencyStatus(dependencies) {
  return Object.entries(dependencies).map(([id, value]) => ({ id, ...value }));
}

export async function assessStudioOperationalReadiness(root, { dependencies, directorConfiguration }) {
  const [projectAudit, next] = await Promise.all([auditProjectReadiness(root), determineNextActions(root)]);
  const currentAction = next.actions?.[0]?.id ?? null;
  let actionCoverage = currentAction ? STUDIO_ACTION_COVERAGE[currentAction] ?? {
    supported: false, reason: '当前动作没有登记网页执行合同'
  } : { supported: true };
  if (currentAction === 'resolve_director_run') {
    const recoverable = next.actions[0].runs?.every(run => run.status === 'MODEL_SUCCEEDED_UNCOMMITTED'
      && run.paidModelCallCompleted === true);
    actionCoverage = recoverable
      ? { supported: true, recovery: true, mode: 'commit_saved_result_without_model_call' }
      : { supported: true, recovery: true, mode: 'manual_fallback_without_model_retry',
          caution: 'Director Engine 调用结果不确定，只允许保留证据后转手工编辑' };
  }
  const dependencyChecks = dependencyStatus(dependencies);
  const requiredDependencyFailure = dependencyChecks.some(item => item.required === true && item.available !== true);
  const blockers = [];
  if (projectAudit.status === 'BLOCKED') blockers.push(...projectAudit.findings.filter(item => item.severity === 'error').map(item => item.message));
  if (!actionCoverage.supported) blockers.push(actionCoverage.reason);
  for (const dependency of dependencyChecks.filter(item => item.required === true && item.available !== true)) {
    blockers.push(`${dependency.label} 不可用`);
  }
  if (currentAction === 'prepare_creative_brief' && directorConfiguration.available !== true) {
    blockers.push(directorConfiguration.reason ?? 'Gate 1 Director Engine 不可用');
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    executionReadiness: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    allWebCoverage: STAGES.every(stage => stage.executable) ? 'PASS' : 'PARTIAL',
    currentAction,
    currentActionCoverage: actionCoverage,
    projectAudit,
    dependencies: dependencyChecks,
    directorConfiguration,
    stages: STAGES,
    blockers,
    warnings: [
      ...STAGES.filter(stage => stage.gap).map(stage => `${stage.label}：${stage.gap}`),
      ...(actionCoverage.caution ? [actionCoverage.caution] : []),
      ...(requiredDependencyFailure ? ['至少一个当前必需的本机执行依赖不可用'] : [])
    ]
  };
}
