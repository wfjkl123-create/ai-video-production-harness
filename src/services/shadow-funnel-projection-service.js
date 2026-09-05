import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';

const STAGES = Object.freeze([
  ['approved_packages', '已验证付费审批包'],
  ['consumed_approvals', '已消费审批'],
  ['provider_tasks', '真实 Provider 任务'],
  ['verified_outputs', 'SHA 已验证生成输出'],
  ['machine_passes', '机器视频 PASS'],
  ['gate5_approved_media', 'Gate 5 接受媒体'],
  ['accepted_final_edits', 'Gate 5 接受最终剪辑'],
  ['verified_deliveries', '已验证最终交付']
]);

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function candidateKey(candidate, fallback) {
  const value = fallback(candidate);
  return typeof value === 'string' && value !== '' ? value : candidate.id;
}

function dedupe(candidates, keyOf, exclusions, stage) {
  const seen = new Set();
  const values = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate, keyOf);
    if (seen.has(key)) {
      exclusions.push({
        candidateId: candidate.id, normalizationType: candidate.normalizationType,
        sourcePath: candidate.sourcePath, status: candidate.status,
        excludedAtStage: stage, reasonCodes: ['duplicate_semantic_identity_suppressed']
      });
      continue;
    }
    seen.add(key);
    values.push(candidate);
  }
  return values;
}

function excluded(candidate, stage, reasonCodes) {
  return {
    candidateId: candidate.id, normalizationType: candidate.normalizationType,
    sourcePath: candidate.sourcePath, status: candidate.status,
    excludedAtStage: stage, reasonCodes: [...new Set(reasonCodes)]
  };
}

function selectChain(candidates) {
  const exclusions = candidates
    .filter(item => item.status !== 'verified')
    .map(item => excluded(item, 'adapter', item.reasonCodes.length > 0 ? item.reasonCodes : [`adapter_status_${item.status}`]));
  const verified = candidates.filter(item => item.status === 'verified');
  const byType = type => verified.filter(item => item.normalizationType === type);

  const approved = dedupe(byType('paid_approval'), item => item.facts.approvalId ?? item.sourcePath, exclusions, 'approved_packages');
  const consumed = dedupe(approved.filter(item => item.facts.consumption === 'consumed' && item.facts.consumedByRunId),
    item => item.facts.approvalId ?? item.sourcePath, exclusions, 'consumed_approvals');
  const consumedByRun = new Map(consumed.map(item => [item.facts.consumedByRunId, item]));

  const taskCandidates = [];
  for (const item of byType('provider_task')) {
    const approval = consumedByRun.get(item.facts.runId);
    const reasons = [];
    if (!approval) reasons.push('consumed_approval_chain_missing');
    if (!SAFE_TASK_ID.test(item.facts.providerTaskId ?? '')) reasons.push('real_provider_task_id_missing');
    if (approval && item.facts.exactApprovalId !== approval.facts.approvalId) reasons.push('provider_task_approval_identity_mismatch');
    if (reasons.length > 0) exclusions.push(excluded(item, 'provider_tasks', reasons));
    else taskCandidates.push(item);
  }
  const tasks = dedupe(taskCandidates, item => item.facts.providerTaskId, exclusions, 'provider_tasks');
  const taskByRun = new Map(tasks.map(item => [item.facts.runId, item]));

  const outputCandidates = [];
  for (const item of byType('generation_output')) {
    const task = taskByRun.get(item.facts.runId);
    const reasons = [];
    if (!task) reasons.push('verified_provider_task_chain_missing');
    if (task && item.facts.providerTaskId !== task.facts.providerTaskId) reasons.push('output_provider_task_identity_mismatch');
    if (item.facts.bytesVerified !== true || !SHA256.test(item.facts.sha256 ?? '')) reasons.push('output_bytes_not_sha_verified');
    if (reasons.length > 0) exclusions.push(excluded(item, 'verified_outputs', reasons));
    else outputCandidates.push(item);
  }
  const outputs = dedupe(outputCandidates,
    item => `${item.facts.runId}:${item.facts.providerTaskId}:${item.facts.sha256}`, exclusions, 'verified_outputs');
  const outputsByRun = new Map();
  for (const item of outputs) {
    const values = outputsByRun.get(item.facts.runId) ?? [];
    values.push(item);
    outputsByRun.set(item.facts.runId, values);
  }

  const machineCandidates = [];
  for (const item of byType('machine_video_audit')) {
    const output = (outputsByRun.get(item.facts.runId) ?? []).find(value => value.facts.sha256 === item.facts.videoSha256);
    const reasons = [];
    if (item.facts.decision !== 'PASS') reasons.push('machine_decision_not_pass');
    if (!output) reasons.push('machine_pass_output_chain_missing');
    if (reasons.length > 0) exclusions.push(excluded(item, 'machine_passes', reasons));
    else machineCandidates.push(item);
  }
  const machinePasses = dedupe(machineCandidates,
    item => `${item.facts.runId}:${item.facts.videoSha256}`, exclusions, 'machine_passes');
  const machineShas = new Set(machinePasses.map(item => item.facts.videoSha256));

  const gate5Candidates = [];
  for (const item of byType('gate5_review')) {
    const reasons = [];
    if (item.facts.decision !== 'approved') reasons.push('gate5_decision_not_approved');
    if (item.facts.currentAuthority !== true) reasons.push('gate5_media_not_current_authority');
    if (!machineShas.has(item.facts.artifactSha256)) reasons.push('gate5_machine_pass_chain_missing');
    if (reasons.length > 0) exclusions.push(excluded(item, 'gate5_approved_media', reasons));
    else gate5Candidates.push(item);
  }
  const gate5 = dedupe(gate5Candidates,
    item => `${item.facts.artifactId}:${item.facts.reviewId}`, exclusions, 'gate5_approved_media');
  const gate5ByArtifact = new Map(gate5.map(item => [item.facts.artifactId, item]));

  const editCandidates = [];
  for (const item of byType('final_edit')) {
    const review = gate5ByArtifact.get(item.facts.artifactId);
    const reasons = [];
    if (item.facts.currentAuthority !== true) reasons.push('final_edit_not_current_authority');
    if (item.facts.gate5Decision !== 'approved') reasons.push('final_edit_not_gate5_approved');
    if (!review || review.facts.artifactType !== 'final_edit' || review.facts.artifactSha256 !== item.facts.sha256) {
      reasons.push('final_edit_gate5_chain_missing');
    }
    if (reasons.length > 0) exclusions.push(excluded(item, 'accepted_final_edits', reasons));
    else editCandidates.push(item);
  }
  const edits = dedupe(editCandidates,
    item => `${item.facts.artifactId}:${item.facts.sha256}`, exclusions, 'accepted_final_edits');
  const editShas = new Set(edits.map(item => item.facts.sha256));

  const deliveryCandidates = [];
  for (const item of byType('final_delivery')) {
    const deliverables = Array.isArray(item.facts.deliverables) ? item.facts.deliverables : [];
    const reasons = [];
    if (!deliverables.some(value => editShas.has(value.sha256))) reasons.push('delivery_accepted_final_edit_chain_missing');
    if (reasons.length > 0) exclusions.push(excluded(item, 'verified_deliveries', reasons));
    else deliveryCandidates.push(item);
  }
  const deliveries = dedupe(deliveryCandidates,
    item => item.facts.receiptId ?? item.sourcePath, exclusions, 'verified_deliveries');

  return { approved, consumed, tasks, outputs, machinePasses, gate5, edits, deliveries, exclusions };
}

function stageRows(counts) {
  return STAGES.map(([id, label], index) => {
    const denominatorId = index === 0 ? null : STAGES[index - 1][0];
    const denominatorCount = denominatorId ? counts[denominatorId] : null;
    return {
      id, label, count: counts[id],
      denominator: denominatorId ? { stageId: denominatorId, count: denominatorCount } : null,
      conversionRate: denominatorCount === null || denominatorCount === 0
        ? null : Number((counts[id] / denominatorCount).toFixed(4))
    };
  });
}

function projectProjection(project) {
  const chain = selectChain(project.report.candidates);
  const counts = {
    approved_packages: chain.approved.length,
    consumed_approvals: chain.consumed.length,
    provider_tasks: chain.tasks.length,
    verified_outputs: chain.outputs.length,
    machine_passes: chain.machinePasses.length,
    gate5_approved_media: chain.gate5.length,
    accepted_final_edits: chain.edits.length,
    verified_deliveries: chain.deliveries.length
  };
  return {
    slug: project.slug, projectId: project.report.projectId,
    stages: stageRows(counts), exclusions: chain.exclusions
  };
}

export function buildShadowFunnelProjection(portfolio, scope = {}) {
  if (portfolio?.kind !== 'legacy_evidence_adapter_portfolio' || !Array.isArray(portfolio.projects)) {
    throw new TypeError('legacy evidence adapter portfolio is required');
  }
  const projects = portfolio.projects.map(projectProjection);
  const aggregateCounts = Object.fromEntries(STAGES.map(([id]) => [id,
    projects.reduce((sum, project) => sum + project.stages.find(stage => stage.id === id).count, 0)
  ]));
  return {
    schemaVersion: 1, kind: 'shadow_funnel_projection', generatedAt: scope.generatedAt ?? new Date().toISOString(),
    scope: {
      from: scope.from ?? null, through: scope.through ?? null,
      projectCount: projects.length, measurement: 'verified_legacy_evidence_chain_only'
    },
    stages: stageRows(aggregateCounts), projects,
    exclusions: projects.flatMap(project => project.exclusions.map(item => ({ slug: project.slug, ...item }))),
    writebackEligible: false,
    limitations: [
      'conversion_counts_verified_candidates_only',
      'unused_or_not_submitted_approvals_are_not_provider_tasks',
      'partial_and_invalid_candidates_are_excluded_and_listed',
      'zero_denominator_conversion_remains_null',
      'projection_does_not_write_project_state_or_execution_ledger'
    ]
  };
}

export function renderShadowFunnelMarkdown(report) {
  const lines = [
    '# Harness 历史证据影子漏斗', '',
    `项目 ${report.scope.projectCount} 个；统计口径：只计通过完整反向绑定与 SHA 验证的旧证据。`, '',
    '| 阶段 | 数量 | 上一步分母 | 转化率 |', '|---|---:|---:|---:|'
  ];
  for (const stage of report.stages) {
    lines.push(`| ${stage.label} | ${stage.count} | ${stage.denominator?.count ?? '—'} | ${stage.conversionRate === null ? '未知' : `${(stage.conversionRate * 100).toFixed(1)}%`} |`);
  }
  const partial = report.exclusions.filter(item => item.status === 'partial').length;
  const invalid = report.exclusions.filter(item => item.status === 'invalid').length;
  lines.push('', `另列但不进入分子：partial ${partial} 条，invalid ${invalid} 条。重复语义身份和断链的 verified 候选也会被排除并保留原因。`, '',
    '审批包存在、审批已消费和真实 Provider taskId 是三个不同层级；机器 PASS、Gate 5 接受与最终交付也不会互相替代。', '');
  return `${lines.join('\n')}\n`;
}

export async function writeShadowFunnelProjectionReport(reportDirectory, report, windowLabel) {
  if (typeof windowLabel !== 'string' || !/^\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}$/.test(windowLabel)) {
    throw new TypeError('windowLabel must be a safe date range');
  }
  const directory = resolve(reportDirectory);
  const baseName = `harness-shadow-funnel-${windowLabel}`;
  const jsonPath = join(directory, `${baseName}.json`);
  const markdownPath = join(directory, `${baseName}.md`);
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(jsonPath, report);
  await writeTextAtomic(markdownPath, renderShadowFunnelMarkdown(report));
  return { jsonPath, markdownPath };
}
