import { mkdir, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { assertQualityReview } from '../domain/quality-review.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { sha256Text } from '../storage/checksum.js';
import { inspectArtifactFile } from './artifact-file-service.js';

const DOCUMENT_DIRECTORIES = Object.freeze(['reviews', 'runs', 'deliveries']);
const APPROVAL_KINDS = new Set([
  'paid_generation_approval', 'batch_generation_approval', 'human_gpt_fallback_generation_authorization'
]);
const VIDEO_RUN_KINDS = new Set(['runninghub_video', 'libtv_video']);
const STATUSES = Object.freeze(['verified', 'partial', 'invalid']);
const NORMALIZATION_TYPES = Object.freeze([
  'paid_approval', 'generation_run_record', 'provider_task', 'generation_output', 'machine_video_audit',
  'gate5_review', 'final_edit', 'final_delivery'
]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function relativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

async function jsonFiles(root, directory) {
  const paths = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(target);
    }
  }
  await walk(join(root, directory));
  return paths;
}

async function scanDocuments(root) {
  const documents = [];
  const unreadablePaths = [];
  for (const directory of DOCUMENT_DIRECTORIES) {
    for (const path of await jsonFiles(root, directory)) {
      const sourcePath = relativePath(root, path);
      try { documents.push({ sourcePath, value: await readJson(path) }); }
      catch { unreadablePaths.push(sourcePath); }
    }
  }
  return { documents, unreadablePaths };
}

function fingerprint(value) {
  const candidate = value?.fingerprint?.sha256 ?? value?.fingerprintSha256;
  return /^[a-f0-9]{64}$/.test(candidate ?? '') ? candidate : null;
}

function candidate(type, sourcePath, status, reasonCodes, facts = {}, evidencePaths = [sourcePath]) {
  if (!NORMALIZATION_TYPES.includes(type) || !STATUSES.includes(status)) throw new TypeError('invalid legacy evidence candidate');
  return {
    id: `legacy-${type}-${sha256Text(`${type}:${sourcePath}`).slice(0, 20)}`,
    normalizationType: type,
    status,
    reasonCodes: [...new Set(reasonCodes)],
    sourcePath,
    evidencePaths: [...new Set(evidencePaths)],
    facts
  };
}

function byKind(documents, kinds) {
  const selected = kinds instanceof Set ? kinds : new Set([kinds]);
  return documents.filter(document => selected.has(document.value?.kind));
}

function approvalCandidates(approvals, runById, preflightById) {
  return approvals.map(document => {
    const approval = document.value;
    const approvalFingerprint = fingerprint(approval);
    const invalidReasons = [];
    const partialReasons = [];
    if (approval.actor !== 'human' || approval.decision !== 'approved') invalidReasons.push('approval_not_human_approved');
    if (!approvalFingerprint) invalidReasons.push('approval_fingerprint_missing');
    const preflight = approval.preflightId ? preflightById.get(approval.preflightId) : null;
    if (!approval.preflightId) partialReasons.push('approval_preflight_binding_unavailable');
    else if (!preflight) invalidReasons.push('approval_preflight_missing');
    else {
      if (preflight.value?.status !== 'READY') invalidReasons.push('approval_preflight_not_ready');
      if (preflight.value?.segmentId !== approval.segmentId) invalidReasons.push('approval_preflight_segment_mismatch');
      if (fingerprint(preflight.value) !== approvalFingerprint) invalidReasons.push('approval_preflight_fingerprint_mismatch');
    }
    const consumedRun = approval.consumedByRunId ? runById.get(approval.consumedByRunId) : null;
    if (approval.consumedByRunId && !consumedRun) invalidReasons.push('consumed_run_missing');
    if (consumedRun && consumedRun.value.segmentId !== approval.segmentId) invalidReasons.push('approval_run_segment_mismatch');
    if (consumedRun && fingerprint(consumedRun.value) !== approvalFingerprint) invalidReasons.push('approval_run_fingerprint_mismatch');
    const reasons = [...invalidReasons, ...partialReasons];
    const status = invalidReasons.length > 0 ? 'invalid' : partialReasons.length > 0 ? 'partial' : 'verified';
    return candidate('paid_approval', document.sourcePath, status, reasons, {
      approvalId: approval.id ?? null,
      segmentId: approval.segmentId ?? null,
      preflightId: approval.preflightId ?? null,
      fingerprintSha256: approvalFingerprint,
      consumption: approval.consumedByRunId ? 'consumed' : 'unused',
      consumedByRunId: approval.consumedByRunId ?? null,
      consumedRunStatus: consumedRun?.value?.status ?? null,
      providerTaskObserved: Boolean(consumedRun?.value?.taskId)
    }, [document.sourcePath, preflight?.sourcePath, consumedRun?.sourcePath].filter(Boolean));
  });
}

function matchingApproval(run, approvals) {
  return approvals.filter(document => document.value?.consumedByRunId === run.id
    && document.value?.actor === 'human' && document.value?.decision === 'approved'
    && document.value?.segmentId === run.segmentId
    && fingerprint(document.value) !== null
    && fingerprint(document.value) === fingerprint(run));
}

async function runCandidates(root, runs, approvals) {
  const candidates = [];
  for (const document of runs) {
    const run = document.value;
    const exactApprovals = matchingApproval(run, approvals);
    const taskObserved = typeof run.taskId === 'string' && SAFE_TASK_ID.test(run.taskId);
    const status = run.status;
    if (status === 'RECONCILED_NOT_SUBMITTED' && run.taskId == null) {
      candidates.push(candidate('generation_run_record', document.sourcePath,
        exactApprovals.length === 1 ? 'verified' : 'partial',
        exactApprovals.length === 1 ? ['verified_not_submitted'] : ['not_submitted_authorization_binding_unknown'], {
          runId: run.id, segmentId: run.segmentId, providerTaskId: null, outcome: 'not_submitted'
        }, [document.sourcePath, ...exactApprovals.map(item => item.sourcePath)]));
      continue;
    }
    if (!taskObserved) {
      const runReasons = [];
      if (exactApprovals.length !== 1) runReasons.push(exactApprovals.length === 0 ? 'exact_paid_approval_missing' : 'multiple_exact_paid_approvals');
      runReasons.push('provider_task_id_missing');
      candidates.push(candidate('generation_run_record', document.sourcePath,
        runReasons.includes('multiple_exact_paid_approvals') ? 'invalid' : 'partial', runReasons, {
          runId: run.id, segmentId: run.segmentId, providerTaskId: null, outcome: status ?? null,
          exactApprovalId: exactApprovals[0]?.value?.id ?? null
        }, [document.sourcePath, ...exactApprovals.map(item => item.sourcePath)]));
      continue;
    }
    const taskReasons = [];
    if (exactApprovals.length !== 1) taskReasons.push(exactApprovals.length === 0 ? 'exact_paid_approval_missing' : 'multiple_exact_paid_approvals');
    const taskStatus = taskReasons.includes('multiple_exact_paid_approvals') ? 'invalid'
      : taskReasons.length > 0 ? 'partial' : 'verified';
    candidates.push(candidate('provider_task', document.sourcePath, taskStatus, taskReasons, {
      runId: run.id, segmentId: run.segmentId, providerTaskId: taskObserved ? run.taskId : null,
      outcome: status ?? null, exactApprovalId: exactApprovals[0]?.value?.id ?? null
    }, [document.sourcePath, ...exactApprovals.map(item => item.sourcePath)]));

    if (!Array.isArray(run.outputs) || run.outputs.length === 0) continue;
    for (const [index, output] of run.outputs.entries()) {
      const outputSource = `${document.sourcePath}#outputs[${index}]`;
      const reasons = [];
      let bytesVerified = false;
      try {
        const inspected = await inspectArtifactFile(root, output.path);
        bytesVerified = /^[a-f0-9]{64}$/.test(output.sha256 ?? '') && inspected.sha256 === output.sha256;
        if (!bytesVerified) reasons.push('output_sha_mismatch');
      } catch {
        reasons.push('output_file_unreadable');
      }
      if (run.status !== 'SUCCESS') reasons.push('run_not_successful');
      if (!taskObserved) reasons.push('provider_task_id_missing');
      if (exactApprovals.length !== 1) reasons.push('exact_paid_approval_missing');
      candidates.push(candidate('generation_output', outputSource,
        reasons.some(reason => ['output_sha_mismatch', 'output_file_unreadable', 'run_not_successful'].includes(reason)) ? 'invalid'
          : reasons.length > 0 ? 'partial' : 'verified', reasons, {
          runId: run.id, segmentId: run.segmentId, providerTaskId: taskObserved ? run.taskId : null,
          path: output.path ?? null, sha256: output.sha256 ?? null, bytesVerified
        }, [document.sourcePath, output.path, ...exactApprovals.map(item => item.sourcePath)].filter(Boolean)));
    }
  }
  return candidates;
}

async function machineAuditCandidates(root, reports, runById) {
  const candidates = [];
  for (const document of reports) {
    const report = document.value;
    const reasons = [];
    const run = runById.get(report.videoRunId);
    if (!run) reasons.push('video_run_missing');
    let reportSha256 = null;
    try { reportSha256 = (await inspectArtifactFile(root, document.sourcePath)).sha256; }
    catch { reasons.push('audit_report_unreadable'); }
    if (run && (run.value.auditPackage?.id !== report.id
      || run.value.auditPackage?.reportPath !== document.sourcePath
      || run.value.auditPackage?.reportSha256 !== reportSha256)) reasons.push('run_audit_reverse_binding_mismatch');
    const output = run?.value?.outputs?.find(item => item.path === report.videoPath && item.sha256 === report.videoSha256);
    if (!output) reasons.push('audit_output_binding_missing');
    try {
      const inspected = await inspectArtifactFile(root, report.videoPath);
      if (inspected.sha256 !== report.videoSha256) reasons.push('audited_video_sha_mismatch');
    } catch { reasons.push('audited_video_unreadable'); }
    if (!['PASS', 'FAIL'].includes(report.machineDecision)) reasons.push('machine_decision_invalid');
    candidates.push(candidate('machine_video_audit', document.sourcePath,
      reasons.length > 0 ? 'invalid' : 'verified', reasons, {
        auditId: report.id ?? null, runId: report.videoRunId ?? null, segmentId: report.segmentId ?? null,
        decision: report.machineDecision ?? null, videoPath: report.videoPath ?? null, videoSha256: report.videoSha256 ?? null
      }, [document.sourcePath, run?.sourcePath, report.videoPath].filter(Boolean)));
  }
  return candidates;
}

function qualityReviewCandidates(state, currentIds, reviews) {
  return reviews.map(document => {
    const review = document.value;
    const artifact = state.artifacts.find(item => item.id === review.artifactId);
    const reasons = [];
    try { assertQualityReview(review); } catch { reasons.push('quality_review_contract_invalid'); }
    if (!artifact || !['video_segment', 'final_edit'].includes(artifact.type)) reasons.push('reviewed_media_artifact_missing');
    if (artifact && artifact.sha256 !== review.artifactSha256) reasons.push('review_artifact_sha_mismatch');
    const expectedReviewId = review.decision === 'approved' ? artifact?.lockedByReviewId : artifact?.rejectedByReviewId;
    if (artifact && expectedReviewId !== review.id) reasons.push('artifact_review_reverse_binding_mismatch');
    return candidate('gate5_review', document.sourcePath, reasons.length > 0 ? 'invalid' : 'verified', reasons, {
      reviewId: review.id ?? null, artifactId: review.artifactId ?? null, artifactType: artifact?.type ?? null,
      artifactSha256: review.artifactSha256 ?? null,
      decision: review.decision ?? null, currentAuthority: artifact ? currentIds.has(artifact.id) : false
    }, [document.sourcePath, artifact?.path].filter(Boolean));
  });
}

async function finalEditCandidates(root, state, currentIds, reviewById) {
  const candidates = [];
  for (const artifact of state.artifacts.filter(item => item.type === 'final_edit')) {
    const reasons = [];
    try {
      const inspected = await inspectArtifactFile(root, artifact.path);
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') || inspected.sha256 !== artifact.sha256) reasons.push('final_edit_sha_mismatch');
    } catch { reasons.push('final_edit_file_unreadable'); }
    const reviewId = artifact.status === 'locked' ? artifact.lockedByReviewId : artifact.rejectedByReviewId;
    const review = reviewById.get(reviewId);
    if (!review || review.artifactId !== artifact.id || review.artifactSha256 !== artifact.sha256
      || review.actor !== 'human' || !['approved', 'rejected'].includes(review.decision)) reasons.push('final_edit_gate5_binding_missing');
    candidates.push(candidate('final_edit', artifact.path, reasons.length > 0 ? 'invalid' : 'verified', reasons, {
      artifactId: artifact.id, revision: artifact.revision, status: artifact.status,
      sha256: artifact.sha256 ?? null, currentAuthority: currentIds.has(artifact.id), gate5Decision: review?.decision ?? null
    }, [artifact.path, review ? `reviews/${review.id}.json` : null].filter(Boolean)));
  }
  return candidates;
}

async function deliveryCandidates(root, receipts) {
  const candidates = [];
  for (const document of receipts) {
    const receipt = document.value;
    const reasons = [];
    if (receipt.status !== 'COMPLETE' || !Array.isArray(receipt.deliverable) || receipt.deliverable.length === 0) {
      reasons.push('delivery_receipt_incomplete');
    }
    for (const item of receipt.deliverable ?? []) {
      try {
        const inspected = await inspectArtifactFile(root, item.path);
        if (inspected.sha256 !== item.sha256) reasons.push('delivery_media_sha_mismatch');
      } catch { reasons.push('delivery_media_unreadable'); }
    }
    candidates.push(candidate('final_delivery', document.sourcePath, reasons.length > 0 ? 'invalid' : 'verified', reasons, {
      receiptId: receipt.id ?? null, status: receipt.status ?? null,
      deliveredMediaCount: Array.isArray(receipt.deliverable) ? receipt.deliverable.length : 0,
      deliverables: (receipt.deliverable ?? []).map(item => ({ path: item.path ?? null, sha256: item.sha256 ?? null }))
    }, [document.sourcePath, ...(receipt.deliverable ?? []).map(item => item.path)]));
  }
  return candidates;
}

function summarize(candidates, unreadableJsonCount) {
  const byStatus = Object.fromEntries(STATUSES.map(status => [status, candidates.filter(item => item.status === status).length]));
  const byType = Object.fromEntries(NORMALIZATION_TYPES.map(type => {
    const matching = candidates.filter(item => item.normalizationType === type);
    return [type, {
      total: matching.length,
      verified: matching.filter(item => item.status === 'verified').length,
      partial: matching.filter(item => item.status === 'partial').length,
      invalid: matching.filter(item => item.status === 'invalid').length
    }];
  }));
  return { candidateCount: candidates.length, byStatus, byType, unreadableJsonCount };
}

export async function adaptLegacyProjectEvidence(projectRoot) {
  const root = resolve(projectRoot);
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const scan = await scanDocuments(root);
  const runs = byKind(scan.documents, VIDEO_RUN_KINDS);
  const runById = new Map(runs.filter(document => document.value?.id).map(document => [document.value.id, document]));
  const approvals = byKind(scan.documents, APPROVAL_KINDS);
  const preflightById = new Map(byKind(scan.documents, 'video_preflight')
    .filter(document => document.value?.id).map(document => [document.value.id, document]));
  let currentIds = new Set();
  let lineageStatus = 'resolved';
  try { currentIds = new Set(resolveCurrentArtifacts(state.artifacts).current.map(item => item.id)); }
  catch { lineageStatus = 'unknown'; }
  const qualityReviews = byKind(scan.documents, 'quality_review');
  const reviewById = new Map(qualityReviews.filter(document => document.value?.id).map(document => [document.value.id, document.value]));
  const normalizedApprovals = approvalCandidates(approvals, runById, preflightById);
  const verifiedApprovalPaths = new Set(normalizedApprovals
    .filter(item => item.status === 'verified').map(item => item.sourcePath));
  const verifiedApprovals = approvals.filter(document => verifiedApprovalPaths.has(document.sourcePath));
  const candidates = [
    ...normalizedApprovals,
    ...await runCandidates(root, runs, verifiedApprovals),
    ...await machineAuditCandidates(root, byKind(scan.documents, 'video_audit_package'), runById),
    ...qualityReviewCandidates(state, currentIds, qualityReviews),
    ...await finalEditCandidates(root, state, currentIds, reviewById),
    ...await deliveryCandidates(root, byKind(scan.documents, 'final_delivery_receipt'))
  ].sort((left, right) => left.normalizationType.localeCompare(right.normalizationType)
    || left.sourcePath.localeCompare(right.sourcePath));
  return {
    schemaVersion: 1, kind: 'legacy_evidence_adapter_report', projectId: state.projectId,
    lineageStatus, summary: summarize(candidates, scan.unreadablePaths.length), candidates,
    unreadablePaths: scan.unreadablePaths,
    writebackEligible: false,
    limitations: [
      'verified_candidates_are_read_only_normalizations',
      'no_execution_ledger_events_are_created',
      'partial_candidates_remain_unknown',
      'machine_pass_does_not_imply_gate5_acceptance',
      'historical_cost_and_wait_time_require_separate_receipts'
    ]
  };
}

export async function readLegacyEvidencePortfolio(projectsRoot, projectSlugs) {
  const root = resolve(projectsRoot);
  if (!Array.isArray(projectSlugs)) throw new TypeError('projectSlugs must be an array');
  const projects = [];
  const unreadable = [];
  for (const slug of [...new Set(projectSlugs)].sort()) {
    if (typeof slug !== 'string' || slug === '' || slug.includes('/') || slug.includes('\\')) throw new TypeError('project slug is invalid');
    try { projects.push({ slug, report: await adaptLegacyProjectEvidence(join(root, slug)) }); }
    catch (error) { unreadable.push({ slug, reason: error.message }); }
  }
  const allCandidates = projects.flatMap(project => project.report.candidates);
  return {
    schemaVersion: 1, kind: 'legacy_evidence_adapter_portfolio',
    scope: { requestedProjects: projectSlugs.length, readableProjects: projects.length, unreadableProjects: unreadable.length },
    summary: summarize(allCandidates, projects.reduce((sum, project) => sum + project.report.summary.unreadableJsonCount, 0)),
    projects, unreadable,
    writebackEligible: false
  };
}

export function renderLegacyEvidencePortfolioMarkdown(portfolio) {
  const lines = [
    '# Harness 旧项目证据适配报告', '',
    `可读项目 ${portfolio.scope.readableProjects} 个；不可读 ${portfolio.scope.unreadableProjects} 个。`, '',
    '| 证据类型 | verified | partial | invalid |', '|---|---:|---:|---:|'
  ];
  for (const type of NORMALIZATION_TYPES) {
    const value = portfolio.summary.byType[type];
    lines.push(`| ${type} | ${value.verified} | ${value.partial} | ${value.invalid} |`);
  }
  lines.push('', 'verified 只表示来源文件、反向绑定和 SHA 在本地证据范围内一致；不自动写入执行账本，也不把机器 PASS 解释为 Gate 5 接受。', '');
  return `${lines.join('\n')}\n`;
}

export async function writeLegacyEvidencePortfolioReport(reportDirectory, portfolio, windowLabel) {
  if (typeof windowLabel !== 'string' || !/^\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}$/.test(windowLabel)) {
    throw new TypeError('windowLabel must be a safe date range');
  }
  const directory = resolve(reportDirectory);
  const baseName = `harness-legacy-evidence-adapter-${windowLabel}`;
  const jsonPath = join(directory, `${baseName}.json`);
  const markdownPath = join(directory, `${baseName}.md`);
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(jsonPath, portfolio);
  await writeTextAtomic(markdownPath, renderLegacyEvidencePortfolioMarkdown(portfolio));
  return { jsonPath, markdownPath };
}
