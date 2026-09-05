import { access, mkdir, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { readJson } from '../storage/json-store.js';
import { writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { auditProjectReadiness } from './project-readiness-audit-service.js';
import { adaptLegacyProjectEvidence, readLegacyEvidencePortfolio } from './legacy-evidence-adapter-service.js';
import { readExecutionLedgerStatus } from './execution-ledger-service.js';
import { summarizeExecutionLedgerPortfolio } from './execution-ledger-portfolio-service.js';
import { buildShadowFunnelProjection } from './shadow-funnel-projection-service.js';

const ACTIVITY_FIELDS = new Set([
  'createdAt', 'updatedAt', 'occurredAt', 'recordedAt', 'reviewedAt', 'approvedAt',
  'completedAt', 'submittedAt', 'preparedAt', 'lockedAt', 'rejectedAt'
]);
const EVIDENCE_DIRECTORIES = Object.freeze(['reviews', 'runs', 'ledger/events', 'deliveries']);
const PROMPT_TYPES = new Set(['shot_narration', 'seedance_prompt', 'independent_creative_audit', 'segment_contract']);
const ASSET_TYPES = new Set(['project_asset', 'segment_asset', 'storyboard_panel', 'asset_visual_audit', 'human_visual_exception']);
const VIDEO_RUN_KINDS = new Set(['runninghub_video', 'libtv_video']);
const PAID_APPROVAL_KINDS = new Set(['paid_generation_approval', 'batch_generation_approval', 'human_gpt_fallback_generation_authorization']);
const PRE_GENERATION_STAGES = Object.freeze([
  Object.freeze(['source_analysis', new Set(['source_fact_analysis'])]),
  Object.freeze(['creative', new Set(['brief', 'creative_brief'])]),
  Object.freeze(['story', new Set(['script', 'shotlist', 'story_plan'])]),
  Object.freeze(['segmentation', new Set(['segmentation', 'capability_manifest'])]),
  Object.freeze(['storyboard', new Set(['storyboard_panel', 'spatial_control_model'])]),
  Object.freeze(['assets', ASSET_TYPES]),
  Object.freeze(['prompt', PROMPT_TYPES])
]);

function isoDay(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${field} must be YYYY-MM-DD`);
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new TypeError(`${field} must be a real calendar day`);
  return value;
}

function windowContract(input = {}) {
  const from = isoDay(input.from, 'from');
  const through = isoDay(input.through, 'through');
  const offset = input.timeZoneOffset ?? '+08:00';
  if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(offset)) throw new TypeError('timeZoneOffset must be a fixed UTC offset');
  const startMs = Date.parse(`${from}T00:00:00${offset}`);
  const throughStartMs = Date.parse(`${through}T00:00:00${offset}`);
  if (throughStartMs < startMs) throw new TypeError('through must not precede from');
  const endExclusiveMs = throughStartMs + 86_400_000;
  return {
    from, through, timeZoneOffset: offset,
    startInclusive: new Date(startMs).toISOString(),
    endExclusive: new Date(endExclusiveMs).toISOString(),
    startMs, endExclusiveMs
  };
}

function projectRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

async function jsonFiles(root, directory) {
  const base = join(root, directory);
  const paths = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of entries) {
      if (entry.name.startsWith('._') || entry.name.startsWith('.')) continue;
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(target);
    }
  }
  await walk(base);
  return paths;
}

function collectTimestamps(value, evidencePath, output, trail = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTimestamps(item, evidencePath, output, `${trail}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const field = trail ? `${trail}.${key}` : key;
    if (ACTIVITY_FIELDS.has(key) && typeof item === 'string' && Number.isFinite(Date.parse(item))) {
      output.push({ at: new Date(Date.parse(item)).toISOString(), path: evidencePath, field });
    }
    collectTimestamps(item, evidencePath, output, field);
  }
}

async function scanEvidenceDocuments(root) {
  const documents = [];
  const unreadablePaths = [];
  for (const directory of EVIDENCE_DIRECTORIES) {
    for (const path of await jsonFiles(root, directory)) {
      const evidencePath = projectRelative(root, path);
      try {
        documents.push({ path: evidencePath, value: await readJson(path) });
      } catch {
        unreadablePaths.push(evidencePath);
      }
    }
  }
  return { documents, unreadablePaths };
}

function docsOfKind(documents, kinds) {
  const wanted = kinds instanceof Set ? kinds : new Set([kinds]);
  return documents.filter(document => wanted.has(document.value?.kind));
}

function evidenceStage(id, documents) {
  return {
    id,
    status: documents.length > 0 ? 'observed' : 'not_observed',
    evidenceCount: documents.length,
    evidencePaths: documents.slice(0, 5).map(document => document.path)
  };
}

function artifactsForTypes(artifacts, types) {
  return artifacts.filter(artifact => types.has(artifact.type));
}

async function verifiedMachinePasses(root, reports) {
  let valid = 0;
  let stale = 0;
  for (const report of reports) {
    if (report.value?.machineDecision !== 'PASS') continue;
    try {
      const inspected = await inspectArtifactFile(root, report.value.videoPath);
      if (inspected.sha256 !== report.value.videoSha256) throw new Error('video SHA drift');
      valid += 1;
    } catch {
      stale += 1;
    }
  }
  return { valid, stale };
}

async function verifiedFinalEdits(root, artifacts) {
  let valid = 0;
  let stale = 0;
  for (const artifact of artifacts) {
    try {
      const inspected = await inspectArtifactFile(root, artifact.path);
      if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? '') || inspected.sha256 !== artifact.sha256.toLowerCase()) {
        throw new Error('final edit SHA drift');
      }
      valid += 1;
    } catch {
      stale += 1;
    }
  }
  return { valid, stale };
}

function gate5Projection(current, reviews) {
  const byId = new Map(reviews.map(document => [document.value?.id, document.value]));
  const media = current.filter(artifact => ['video_segment', 'final_edit'].includes(artifact.type));
  let accepted = 0;
  let rejected = 0;
  for (const artifact of media) {
    const reviewId = artifact.status === 'locked' ? artifact.lockedByReviewId : artifact.rejectedByReviewId;
    const review = byId.get(reviewId);
    if (!review || review.actor !== 'human' || review.artifactId !== artifact.id || review.artifactSha256 !== artifact.sha256) continue;
    if (artifact.status === 'locked' && review.decision === 'approved') accepted += 1;
    if (artifact.status === 'rejected' && review.decision === 'rejected') rejected += 1;
  }
  const acceptedFinalEdit = current.some(artifact => {
    const review = byId.get(artifact.lockedByReviewId);
    return artifact.type === 'final_edit' && artifact.status === 'locked'
      && review?.decision === 'approved' && review.actor === 'human'
      && review.artifactId === artifact.id && review.artifactSha256 === artifact.sha256;
  });
  const status = acceptedFinalEdit ? 'final_edit_accepted'
    : rejected > 0 ? 'rejected'
      : accepted > 0 ? 'segment_acceptance_only' : 'not_reviewed';
  return { status, currentAcceptedArtifactCount: accepted, currentRejectedArtifactCount: rejected };
}

function projectMetrics(state, current, documents, ledger, readiness, machinePasses, finalEdits) {
  const prompt = state.artifacts.filter(artifact => PROMPT_TYPES.has(artifact.type));
  const assets = state.artifacts.filter(artifact => ASSET_TYPES.has(artifact.type));
  const videoRuns = docsOfKind(documents, VIDEO_RUN_KINDS);
  const paidApprovals = docsOfKind(documents, PAID_APPROVAL_KINDS)
    .filter(document => document.value?.decision === 'approved');
  const qualityReviews = docsOfKind(documents, 'quality_review');
  const videoAudits = docsOfKind(documents, 'video_audit_package');
  const finalDeliveryReceipts = docsOfKind(documents, 'final_delivery_receipt');
  const providerTasks = videoRuns.filter(document => typeof document.value?.taskId === 'string' && document.value.taskId.trim() !== '');
  const gate5 = gate5Projection(current, qualityReviews);
  return {
    evidenceLevels: {
      artifactRegistered: state.artifacts.length > 0,
      machineVideoPassVerified: machinePasses.valid > 0,
      playableVideoVerified: machinePasses.valid > 0,
      finalEditBytesVerified: finalEdits.valid > 0,
      gate5Status: gate5.status,
      deliveryFinalized: (ledger?.consistency === 'consistent' && ledger.delivery.status === 'finalized')
        || finalDeliveryReceipts.length > 0
    },
    counts: {
      registeredArtifacts: state.artifacts.length,
      currentArtifacts: current.length,
      supersededArtifacts: state.artifacts.length - current.length,
      paidApprovals: paidApprovals.length,
      generationRunRecords: videoRuns.length,
      generationAttempts: providerTasks.length,
      generationSuccesses: providerTasks.filter(document => document.value?.status === 'SUCCESS').length,
      generationFailures: videoRuns.filter(document => ['FAILED', 'FAILURE'].includes(document.value?.status)).length,
      machineVideoPasses: machinePasses.valid,
      staleMachineVideoPasses: machinePasses.stale,
      machineVideoFailures: videoAudits.filter(document => document.value?.machineDecision === 'FAIL').length,
      finalEditArtifacts: state.artifacts.filter(artifact => artifact.type === 'final_edit').length,
      verifiedFinalEdits: finalEdits.valid,
      staleFinalEdits: finalEdits.stale,
      gate5AcceptedReviews: qualityReviews.filter(document => document.value?.decision === 'approved').length,
      gate5RejectedReviews: qualityReviews.filter(document => document.value?.decision === 'rejected').length,
      promptRejectedOrRework: prompt.filter(artifact => ['rejected', 'rework', 'blocked'].includes(artifact.status)).length,
      assetRejectedOrRework: assets.filter(artifact => ['rejected', 'rework', 'blocked'].includes(artifact.status)).length,
      explicitReadinessErrors: readiness?.findings?.filter(finding => finding.severity === 'error').length ?? null,
      observedPaidRetries: ledger?.consistency === 'consistent'
        ? ledger.observations.cost.paidRetryObservationCount : null
    },
    gate5,
    readiness: readiness ? {
      status: readiness.status,
      errorCodes: readiness.findings.filter(finding => finding.severity === 'error').map(finding => finding.id),
      warningCodes: readiness.findings.filter(finding => finding.severity === 'warning').map(finding => finding.id)
    } : null
  };
}

function funnel(state, documents, ledger) {
  const artifacts = state.artifacts;
  const qualityReviews = docsOfKind(documents, 'quality_review');
  const videoAudits = docsOfKind(documents, 'video_audit_package');
  const stages = [evidenceStage('intake', [{ path: 'project-state.json' }])];
  for (const [id, types] of PRE_GENERATION_STAGES) {
    stages.push(evidenceStage(id, artifactsForTypes(artifacts, types).map(artifact => ({ path: artifact.path }))));
  }
  stages.push(evidenceStage('paid_approval', docsOfKind(documents, PAID_APPROVAL_KINDS)));
  stages.push(evidenceStage('generation', [
    ...docsOfKind(documents, VIDEO_RUN_KINDS),
    ...artifactsForTypes(artifacts, new Set(['video_segment'])).map(artifact => ({ path: artifact.path }))
  ]));
  stages.push(evidenceStage('editing', artifactsForTypes(artifacts, new Set(['final_edit'])).map(artifact => ({ path: artifact.path }))));
  stages.push(evidenceStage('technical_review', videoAudits));
  stages.push(evidenceStage('gate5', qualityReviews));
  const deliveryEvidence = ledger?.consistency === 'consistent' && ledger.delivery.status === 'finalized'
    ? [{ path: 'ledger/projection.json' }] : docsOfKind(documents, 'final_delivery_receipt');
  stages.push(evidenceStage('delivery', deliveryEvidence));
  return stages;
}

async function replayProject(root, slug, window, options = {}) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const scan = await scanEvidenceDocuments(root);
  const timestamps = [{ at: state.updatedAt, path: 'project-state.json', field: 'updatedAt' }];
  for (const document of scan.documents) collectTimestamps(document.value, document.path, timestamps);
  const activity = timestamps
    .filter(item => {
      const value = Date.parse(item.at);
      return value >= window.startMs && value < window.endExclusiveMs;
    })
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (activity.length === 0) return { inScope: false, slug, projectId: state.projectId };

  let current = [];
  let lineageError = null;
  try { current = resolveCurrentArtifacts(state.artifacts).current; } catch (error) { lineageError = error.message; }
  const ledger = await readExecutionLedgerStatus(root).catch(() => null);
  const readiness = await (options.readinessAuditor ?? auditProjectReadiness)(root).catch(() => null);
  const videoAudits = docsOfKind(scan.documents, 'video_audit_package');
  const machinePasses = await verifiedMachinePasses(root, videoAudits);
  const currentFinalEdits = current.filter(artifact => artifact.type === 'final_edit');
  const finalEdits = await verifiedFinalEdits(root, currentFinalEdits);
  const metrics = projectMetrics(state, current, scan.documents, ledger, readiness, machinePasses, finalEdits);
  const legacyEvidence = await (options.legacyEvidenceAdapter ?? adaptLegacyProjectEvidence)(root)
    .then(report => report.summary).catch(() => null);
  return {
    inScope: true,
    slug,
    projectId: state.projectId,
    phase: state.phase,
    activity: {
      firstObservedAt: activity[0].at,
      lastObservedAt: activity.at(-1).at,
      timestampEvidenceCount: activity.length,
      evidencePaths: [...new Set(activity.map(item => item.path))].slice(0, 10)
    },
    evidenceScan: { unreadableJsonCount: scan.unreadablePaths.length, unreadablePaths: scan.unreadablePaths.slice(0, 20) },
    lineage: lineageError ? { status: 'unknown', error: lineageError } : { status: 'resolved' },
    ledger: ledger ? { initialized: ledger.initialized, consistency: ledger.consistency, issueCodes: ledger.issueCodes } : null,
    legacyEvidence,
    funnel: funnel(state, scan.documents, ledger),
    ...metrics
  };
}

function aggregateProjects(projects) {
  const sums = {};
  const coverage = {};
  for (const project of projects) {
    for (const [key, value] of Object.entries(project.counts)) {
      coverage[key] ??= 0;
      if (typeof value === 'number') {
        sums[key] = (sums[key] ?? 0) + value;
        coverage[key] = (coverage[key] ?? 0) + 1;
      }
    }
  }
  for (const field of ['observedPaidRetries', 'explicitReadinessErrors']) {
    if ((coverage[field] ?? 0) !== projects.length) sums[field] = null;
  }
  const evidenceLevels = {
    artifactRegisteredProjects: projects.filter(project => project.evidenceLevels.artifactRegistered).length,
    machineVideoPassVerifiedProjects: projects.filter(project => project.evidenceLevels.machineVideoPassVerified).length,
    playableVideoVerifiedProjects: projects.filter(project => project.evidenceLevels.playableVideoVerified).length,
    finalEditBytesVerifiedProjects: projects.filter(project => project.evidenceLevels.finalEditBytesVerified).length,
    gate5AcceptedFinalEditProjects: projects.filter(project => project.evidenceLevels.gate5Status === 'final_edit_accepted').length,
    gate5SegmentAcceptanceOnlyProjects: projects.filter(project => project.evidenceLevels.gate5Status === 'segment_acceptance_only').length,
    gate5RejectedProjects: projects.filter(project => project.evidenceLevels.gate5Status === 'rejected').length,
    deliveryFinalizedProjects: projects.filter(project => project.evidenceLevels.deliveryFinalized).length
  };
  const funnel = [...new Set(projects.flatMap(project => project.funnel.map(stage => stage.id)))].map(id => ({
    id,
    observedProjects: projects.filter(project => project.funnel.find(stage => stage.id === id)?.status === 'observed').length,
    notObservedProjects: projects.filter(project => project.funnel.find(stage => stage.id === id)?.status === 'not_observed').length
  }));
  const readableLegacy = projects.filter(project => project.legacyEvidence !== null);
  const legacyEvidence = {
    readableProjects: readableLegacy.length,
    unavailableProjects: projects.length - readableLegacy.length,
    projectsWithVerifiedCandidates: readableLegacy.filter(project => project.legacyEvidence.byStatus.verified > 0).length,
    byStatus: {
      verified: readableLegacy.reduce((sum, project) => sum + project.legacyEvidence.byStatus.verified, 0),
      partial: readableLegacy.reduce((sum, project) => sum + project.legacyEvidence.byStatus.partial, 0),
      invalid: readableLegacy.reduce((sum, project) => sum + project.legacyEvidence.byStatus.invalid, 0)
    }
  };
  return { counts: sums, countCoverageProjects: coverage, evidenceLevels, legacyEvidence, funnel };
}

export async function readHistoricalReplayBaseline(projectsRoot, input = {}, options = {}) {
  const root = resolve(projectsRoot);
  const window = windowContract(input);
  const directoryEntries = await readdir(root, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const projects = [];
  const excluded = [];
  const unreadable = [];
  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const projectRoot = join(root, entry.name);
    try { await access(join(projectRoot, 'project-state.json')); } catch (error) { if (error.code === 'ENOENT') continue; }
    try {
      const replay = await replayProject(projectRoot, entry.name, window, options);
      if (replay.inScope) projects.push(replay);
      else excluded.push({ slug: replay.slug, projectId: replay.projectId, reason: 'no_observed_activity_in_window' });
    } catch (error) {
      unreadable.push({ slug: entry.name, reason: error.message });
    }
  }
  const ledgerEntries = [];
  for (const project of projects) {
    try {
      ledgerEntries.push({ slug: project.slug, ledger: await readExecutionLedgerStatus(join(root, project.slug)) });
    } catch {
      ledgerEntries.push({ slug: project.slug, errorCode: 'ledger_unreadable' });
    }
  }
  const legacyPortfolio = await readLegacyEvidencePortfolio(root, projects.map(project => project.slug));
  const generatedAt = options.now ?? new Date().toISOString();
  const shadowFunnel = buildShadowFunnelProjection(legacyPortfolio, {
    from: window.from, through: window.through, generatedAt
  });
  return {
    schemaVersion: 1,
    kind: 'historical_replay_baseline',
    generatedAt,
    window: {
      from: window.from, through: window.through, timeZoneOffset: window.timeZoneOffset,
      startInclusive: window.startInclusive, endExclusive: window.endExclusive
    },
    scope: {
      discoveredProjects: projects.length + excluded.length + unreadable.length,
      includedProjects: projects.length,
      excludedOutsideWindow: excluded.length,
      unreadableProjects: unreadable.length,
      measurementScope: 'project_lifetime_evidence_for_window_activity_set'
    },
    aggregate: aggregateProjects(projects),
    ledgerBaseline: summarizeExecutionLedgerPortfolio(ledgerEntries),
    shadowFunnel,
    projects,
    excluded,
    unreadable,
    hardErrorRate: {
      value: null,
      status: 'unknown',
      reason: 'historical prompt and asset errors are not consistently bound one-to-one to paid approval packages'
    },
    limitations: [
      'not_observed_is_not_failure',
      'artifact_registration_is_not_machine_pass',
      'machine_video_pass_is_not_gate5_acceptance',
      'segment_acceptance_is_not_final_edit_acceptance',
      'missing_historical_cost_or_timing_evidence_remains_unknown',
      'activity_window_uses_structured_project_evidence_timestamps_only'
    ]
  };
}

export function renderHistoricalReplayMarkdown(report) {
  const lines = [
    `# Harness 历史项目离线重放基线`, '',
    `时间窗：${report.window.from} 至 ${report.window.through}（UTC${report.window.timeZoneOffset}）`, '',
    `纳入 ${report.scope.includedProjects} 个项目；窗外 ${report.scope.excludedOutsideWindow} 个；不可读 ${report.scope.unreadableProjects} 个。`, '',
    '## 证据分层', '',
    '| 层级 | 项目数 |', '|---|---:|',
    `| 已登记产物 | ${report.aggregate.evidenceLevels.artifactRegisteredProjects} |`,
    `| 机器视频 PASS 且媒体 SHA 可读 | ${report.aggregate.evidenceLevels.machineVideoPassVerifiedProjects} |`,
    `| 已验证最终剪辑字节 | ${report.aggregate.evidenceLevels.finalEditBytesVerifiedProjects} |`,
    `| Gate 5 接受最终剪辑 | ${report.aggregate.evidenceLevels.gate5AcceptedFinalEditProjects} |`,
    `| 仅分段 Gate 5 接受 | ${report.aggregate.evidenceLevels.gate5SegmentAcceptanceOnlyProjects} |`,
    `| 最终交付完成 | ${report.aggregate.evidenceLevels.deliveryFinalizedProjects} |`, '',
    '## 旧证据适配覆盖', '',
    `适配器可读 ${report.aggregate.legacyEvidence.readableProjects} 个项目；verified ${report.aggregate.legacyEvidence.byStatus.verified} 条，partial ${report.aggregate.legacyEvidence.byStatus.partial} 条，invalid ${report.aggregate.legacyEvidence.byStatus.invalid} 条。所有候选保持只读，不自动回填账本。`, '',
    '## 影子漏斗', '',
    '| 阶段 | 数量 | 上一步转化率 |', '|---|---:|---:|',
    ...report.shadowFunnel.stages.map(stage => `| ${stage.label} | ${stage.count} | ${stage.conversionRate === null ? '未知' : `${(stage.conversionRate * 100).toFixed(1)}%`} |`), '',
    '## 项目账本', '',
    '| 项目 | 阶段 | 机器视频 | 最终剪辑 | Gate 5 | 交付 | 明确错误/返工 |',
    '|---|---|---:|---:|---|---:|---:|'
  ];
  for (const project of report.projects) {
    lines.push(`| ${project.slug} | ${project.phase} | ${project.counts.machineVideoPasses} | ${project.counts.verifiedFinalEdits} | ${project.gate5.status} | ${project.evidenceLevels.deliveryFinalized ? 1 : 0} | ${project.counts.promptRejectedOrRework + project.counts.assetRejectedOrRework + project.counts.generationFailures + project.counts.machineVideoFailures + project.counts.gate5RejectedReviews} |`);
  }
  lines.push('', '## 解释边界', '', '- 未观察到不等于失败。', '- 产物已登记不等于机器通过。', '- 机器视频 PASS 不等于 Gate 5 用户接受。', '- 分段接受不等于整片接受。', '- 历史错误与付费审批包缺少稳定的一对一绑定，因此硬错误率保持未知，不制造百分比。', '');
  return `${lines.join('\n')}\n`;
}

export async function writeHistoricalReplayBaselineReport(reportDirectory, report) {
  const directory = resolve(reportDirectory);
  const baseName = `harness-historical-replay-${report.window.from}_to_${report.window.through}`;
  const jsonPath = join(directory, `${baseName}.json`);
  const markdownPath = join(directory, `${baseName}.md`);
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(jsonPath, report);
  await writeTextAtomic(markdownPath, renderHistoricalReplayMarkdown(report));
  return { jsonPath, markdownPath };
}
