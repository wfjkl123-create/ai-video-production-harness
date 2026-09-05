import { readArtifactEditor, saveArtifactEdit, previewArtifactEdit, applyArtifactEdit, rewriteArtifactEdit } from '../../src/services/artifact-edit-service.js';
import { getArtifactRewriteFingerprint, rewriteArtifactFields } from '../../src/services/artifact-rewrite-service.js';
import { loadChangeImpactPreview, recordChangeRequest, listChangeRequests } from '../../src/services/change-request-service.js';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { getCompactStatus } from '../../src/services/project-service.js';
import { initializeProject } from '../../src/services/project-service.js';
import { determineNextActions } from '../../src/services/next-action-service.js';
import { approveArtifact, rejectArtifact } from '../../src/services/review-service.js';
import { isHumanReviewType } from '../../src/domain/review-policy.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { persistVideoIntake } from '../../src/services/video-intake-service.js';
import {
  answerDirectorInterview,
  directorInterviewSummary,
  getDirectorInterview,
  prepareDirectorInterview,
  synchronizeDirectorInterviewForWorkflow
} from '../../src/services/director-interview-service.js';
import { createCreativeBrief } from '../../src/services/creative-brief-service.js';
import { createStoryPlan } from '../../src/services/story-plan-service.js';
import { submitForReview } from '../../src/services/review-service.js';
import { isAssetAnchoredReferenceWorkflow, resolveReferenceWorkflow } from '../../src/domain/reference-workflow.js';
import { workflowProfileIdOf, visibleStepsForProject } from '../../src/domain/workflow-profile.js';
import {
  prepareMechanicalAssetPromptPackage,
  prepareMechanicalLibTvCanvas
} from '../../src/services/mechanical-asset-prompt-service.js';
import {
  getWorkflowProfileView,
  setWorkflowProfile,
  setRemakeControlSelection,
  setAssetSelection,
  machineApproveDelegatedStoryPlan
} from '../../src/services/workflow-profile-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { runCheckpointApprove } from '../../src/commands/checkpoint-approve.js';
import { persistSegmentation } from '../../src/services/segmentation-workflow-service.js';
import { autoLockArtifact } from '../../src/services/review-service.js';
import { storyPlanSegmentationFingerprint } from '../../src/domain/story-plan.js';
import { finalizeDelivery, verifyDelivery } from '../../src/services/delivery-service.js';
import { assertQualityRubric } from '../../src/domain/quality-review.js';
import { createSegmentContract } from '../../src/services/segment-contract-service.js';
import { persistSourceFactAnalysis } from '../../src/services/source-fact-analysis-service.js';
import { REQUIRED_VISUAL_CHECKS } from '../../src/domain/asset-visual-audit.js';
import { runAssetVisualAudit } from '../../src/commands/asset-visual-audit.js';
import { recordQualityReview, requiredGate5Resolution } from '../../src/services/quality-review-service.js';
import { executeLibTvVideo, prepareLibTvVideoCanvas } from '../../src/services/libtv-video-generation-service.js';
import { persistSourceComparatorAudit } from '../../src/services/source-comparator-audit-service.js';
import { runProcess } from '../../src/adapters/process-runner.js';
import { createPaidGenerationApproval, createVideoPreflight, inspectVideoPackage } from '../../src/services/video-generation-service.js';
import { runGenerateAssets } from '../../src/commands/generate-assets.js';
import { compileProjectAssetManifest } from '../../src/commands/assets.js';
import { runReviewAssetManifest } from '../../src/commands/review-asset-manifest.js';
import { verifyAssetManifestEvidence } from '../../src/services/asset-manifest-evidence-service.js';
import { lintNarration } from '../../src/services/narration-lint-service.js';
import { runCompileSeedance } from '../../src/commands/compile-seedance.js';
import { assertSeedanceMediaBindingContract, assertSeedanceSourcePromptReferences } from '../../src/services/seedance-media-binding-service.js';
import { renderOrderedPhysicalActionInstruction } from '../../src/services/simple-remake-narration-sequence-service.js';
import { sha256File, sha256Text } from '../../src/storage/checksum.js';
import { writeTextAtomic } from '../../src/storage/text-store.js';
import { assertIndependentCreativeAudit } from '../../src/domain/independent-creative-audit.js';
import { verifyArtifactFile, verifyLockedArtifact } from '../../src/services/artifact-file-service.js';
import { currentLockedSegmentVideos } from '../../src/services/current-segment-video-service.js';
import { currentArtifactsOf } from '../../src/domain/current-artifact.js';
import { persistExternalAuditOnlyApproval, executeIndependentExternalAudit } from '../../src/services/external-audit-only-service.js';
import { assertExternalAuditOnlyApproval } from '../../src/domain/external-audit-only-approval.js';
import { OpenCodexDirectorAdapter, OpenCodexDirectorExecutionError } from '../../src/adapters/opencodex-director-adapter.js';
import {
  buildGate1DirectorPrompt,
  generateGate1CreativeBrief,
  recoverGate1CreativeBrief,
  resolveGate1DirectorRunWithManualFallback
} from '../../src/services/director-brief-engine-service.js';
import { runPrepareHandoff } from '../../src/commands/prepare-handoff.js';
import { runReviewHandoff } from '../../src/commands/review-handoff.js';
import { runRecordHandoff } from '../../src/commands/record-handoff.js';
import { assessStudioOperationalReadiness } from '../../src/services/studio-operational-readiness-service.js';
import { recoverJsonTransactions } from '../../src/storage/transaction-journal.js';
import { readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';
import { summarizeExecutionLedgerPortfolio } from '../../src/services/execution-ledger-portfolio-service.js';
import { projectHarness3060StudioProjection } from '../../src/services/harness-3060-studio-projection-service.js';
import {
  claimStudioGenerationJob,
  cancelRestartPausedStudioGenerationJob,
  cancelQueuedStudioGenerationJobs,
  completeStudioGenerationJob,
  createStudioGenerationJob,
  createStudioGenerationResumeApproval,
  createStudioImageGenerationApproval,
  failStudioGenerationJob,
  listStudioGenerationJobs,
  pauseQueuedStudioGenerationJobs,
  readBlockingStudioGenerationJob,
  readStudioGenerationJob,
  recoverInterruptedStudioGenerationJobs,
  requireStudioGenerationResumeApproval,
  requireStudioImageGenerationApproval,
  resumeStudioGenerationJob
} from '../../src/services/studio-generation-job-service.js';
import {
  assignStudioProjectOwner,
  authenticateStudioSession,
  canAccessStudioProject,
  consumeStudioInvite,
  createStudioInvite,
  issueOwnerSession,
  listStudioTeam,
  recordStudioTeamAudit,
  reissueStudioInvite,
  revokeStudioMember,
  updateStudioTeamSettings
} from '../../src/services/studio-team-access-service.js';
import {
  assertStudioRequestNetwork,
  assertStudioWriteOrigin,
  normalizeRemoteAddress,
  studioLanUrls
} from '../../src/services/studio-network-policy-service.js';
import { acquireStudioServerLease } from '../../src/services/studio-server-lease-service.js';
import { isProjectSlug, assertProjectId } from '../../src/domain/project-id.js';
import {
  prepareGate5ReworkWorkOrder,
  updateGate5ReworkWorkOrderProgress
} from '../../src/services/gate5-rework-work-order-service.js';

// The resident launchd service intentionally starts with a small PATH. Media
// validation and package compilation invoke Homebrew's ffprobe/ffmpeg, so add
// the installed tool directory once for Studio child-process calls.
if (existsSync('/opt/homebrew/bin/ffprobe') && !String(process.env.PATH ?? '').split(':').includes('/opt/homebrew/bin')) {
  process.env.PATH = `/opt/homebrew/bin:${process.env.PATH ?? ''}`;
}
// LibTV CLI is installed per-user at ~/.libtv/libtv. The resident service PATH
// does not include it, so canvas preparation and node queries fail with ENOENT.
const libtvDir = join(homedir(), '.libtv');
if (existsSync(join(libtvDir, 'libtv')) && !String(process.env.PATH ?? '').split(':').includes(libtvDir)) {
  process.env.PATH = `${libtvDir}:${process.env.PATH ?? ''}`;
}

const artifactRewriteChallenges = new Map();
const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repositoryRoot = resolve(appRoot, '../..');
const projectsRoot = resolve(process.env.HARNESS_PROJECTS_ROOT ?? join(repositoryRoot, 'projects'));
const publicRoot = join(appRoot, 'public');
const port = Number(process.env.HARNESS_STUDIO_PORT ?? 4177);
const listenHost = process.env.HARNESS_STUDIO_HOST ?? '127.0.0.1';
const teamStateRoot = resolve(process.env.HARNESS_STUDIO_STATE_ROOT ?? join(repositoryRoot, '.harness-studio'));
if (process.env.HARNESS_STUDIO_HTTPS === 'true') throw new Error('HARNESS_STUDIO_HTTPS requires a real TLS listener and is not available in the LAN pilot');
const httpsEnabled = false;
const sessionCookieName = 'harness_studio_session';
const requestContext = new AsyncLocalStorage();
function positiveIntegerSetting(value, fallback, name, ceiling) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > ceiling) {
    throw new Error(`${name} must be a positive integer no greater than ${ceiling}`);
  }
  return parsed;
}

const maxUploadBytes = positiveIntegerSetting(process.env.HARNESS_STUDIO_MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024, 'HARNESS_STUDIO_MAX_UPLOAD_BYTES', 8 * 1024 * 1024 * 1024);
const maxJsonBytes = positiveIntegerSetting(process.env.HARNESS_STUDIO_MAX_JSON_BYTES, 2 * 1024 * 1024, 'HARNESS_STUDIO_MAX_JSON_BYTES', 32 * 1024 * 1024);
const maxImageBytes = Math.min(maxUploadBytes, 100 * 1024 * 1024);
const maxAudioBytes = Math.min(maxUploadBytes, 500 * 1024 * 1024);
const DIRECTOR_MODEL_CHOICES = Object.freeze(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
const DEFAULT_DIRECTOR_MODEL = 'gpt-5.6-luna';
const directorAuthorizationChallenges = new Map();
const generationAuthorizationChallenges = new Map();
const directorMaxBudgetUsd = Number(process.env.HARNESS_DIRECTOR_MAX_BUDGET_USD ?? 0.25);
if (!Number.isFinite(directorMaxBudgetUsd) || directorMaxBudgetUsd <= 0 || directorMaxBudgetUsd > 5) {
  throw new Error('HARNESS_DIRECTOR_MAX_BUDGET_USD must be greater than 0 and no more than 5');
}

function positiveNumberSetting(value, fallback, name, ceiling = Number.MAX_SAFE_INTEGER) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > ceiling) {
    throw new Error(`${name} must be a positive number no greater than ${ceiling}`);
  }
  return parsed;
}

// 审查模型与费用保护策略属于主机配置，不让每位项目操作者在网页上填写。
// 固定为一条只读、单次调用的独立审查路线；实际回执缺失时仍会失败关闭。
const DEFAULT_INDEPENDENT_AUDIT_MODEL = 'kimi/k3';
const independentAuditMaxTurns = positiveIntegerSetting(process.env.HARNESS_STUDIO_AUDIT_MAX_TURNS, 2, 'HARNESS_STUDIO_AUDIT_MAX_TURNS', 4);
const independentAuditMaxCredits = positiveNumberSetting(process.env.HARNESS_STUDIO_AUDIT_MAX_CREDITS, 1200, 'HARNESS_STUDIO_AUDIT_MAX_CREDITS');
const independentAuditInputCreditsPerMillion = positiveNumberSetting(process.env.HARNESS_STUDIO_AUDIT_INPUT_CREDITS_PER_MILLION, 20_000, 'HARNESS_STUDIO_AUDIT_INPUT_CREDITS_PER_MILLION');
const independentAuditOutputCreditsPerMillion = positiveNumberSetting(process.env.HARNESS_STUDIO_AUDIT_OUTPUT_CREDITS_PER_MILLION, 30_000, 'HARNESS_STUDIO_AUDIT_OUTPUT_CREDITS_PER_MILLION');
const independentAuditPricingSource = process.env.HARNESS_STUDIO_AUDIT_PRICING_SOURCE ?? '本机独立审查默认配额';
const independentAuditPricingVerifiedAt = process.env.HARNESS_STUDIO_AUDIT_PRICING_VERIFIED_AT ?? '2026-08-21T00:00:00.000Z';

const mimeTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
});

const mediaTypes = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
});
// launchd starts the resident Studio with a minimal PATH. On this Mac ffprobe
// is installed by Homebrew, so resolving it here keeps normal browser uploads
// independent from whichever terminal happened to launch the service.
const mediaProbeExecutable = process.env.HARNESS_FFPROBE_EXECUTABLE
  ?? (existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');

const uploadableTypes = new Set(['project_asset', 'segment_asset', 'final_edit']);

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function parseCookies(request) {
  const cookies = {};
  for (const item of String(request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    try { cookies[name] = decodeURIComponent(item.slice(separator + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return cookies;
}

function sessionCookie(token) {
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}${httpsEnabled ? '; Secure' : ''}`;
}

function currentAccess() {
  const access = requestContext.getStore();
  if (!access?.principal || !access?.session) throw httpError(401, 'valid Harness Studio link required');
  return access;
}

function currentPrincipal() {
  return currentAccess().principal;
}

function requireOwner() {
  const principal = currentPrincipal();
  if (principal.role !== 'owner') throw httpError(403, 'only the owner can manage team links');
  return principal;
}

async function configuredDirectorModel() {
  if (process.env.HARNESS_DIRECTOR_MODEL) return requiredText(process.env.HARNESS_DIRECTOR_MODEL, 'HARNESS_DIRECTOR_MODEL', 192);
  return DEFAULT_DIRECTOR_MODEL;
}

async function directorEngineConfiguration(projectRoot, requestedModel = null) {
  const configuredModel = await configuredDirectorModel();
  const model = requestedModel ?? configuredModel;
  if (!DIRECTOR_MODEL_CHOICES.includes(model)) {
    return { available: false, model, availableModels: [...DIRECTOR_MODEL_CHOICES], reason: `Director Engine 模型不在允许列表：${model}` };
  }
  try {
    const adapter = new OpenCodexDirectorAdapter({ cwd: projectRoot, model, maxBudgetUsd: directorMaxBudgetUsd });
    const preflight = await adapter.preflight();
    return {
      available: true,
      model,
      availableModels: [...DIRECTOR_MODEL_CHOICES],
      maxBudgetUsd: directorMaxBudgetUsd,
      authorizationScope: 'one_gate1_text_draft',
      modelCallExecuted: false,
      preflight
    };
  } catch (error) {
    return { available: false, model, maxBudgetUsd: directorMaxBudgetUsd, reason: error instanceof Error ? error.message : 'Director Engine preflight failed' };
  }
}

async function localToolCapability(executable, args, label, required = false) {
  try {
    const result = await runProcess(executable, args, { cwd: repositoryRoot });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').find(Boolean) ?? null;
    return { label, required, available: result.code === 0, evidence: output?.slice(0, 240) ?? null };
  } catch (error) {
    return { label, required, available: false, evidence: error instanceof Error ? error.message : 'unavailable' };
  }
}

function issueDirectorAuthorizationChallenge(projectSlug, request, configuration) {
  const principal = currentPrincipal();
  const id = `director-authorization-${randomUUID()}`;
  const now = Date.now();
  const challenge = {
    id,
    projectSlug,
    projectId: request.projectId,
    taskSha256: request.taskSha256,
    promptSha256: request.promptSha256,
    model: configuration.model,
    maxBudgetUsd: configuration.maxBudgetUsd,
    principalId: principal.id,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString()
  };
  directorAuthorizationChallenges.set(id, challenge);
  for (const [candidateId, candidate] of directorAuthorizationChallenges) {
    if (Date.parse(candidate.expiresAt) <= now) directorAuthorizationChallenges.delete(candidateId);
  }
  return structuredClone(challenge);
}

function consumeDirectorAuthorizationChallenge(projectSlug, input) {
  const principal = currentPrincipal();
  const id = requiredText(input.authorizationId, 'authorizationId', 96);
  const challenge = directorAuthorizationChallenges.get(id);
  directorAuthorizationChallenges.delete(id);
  if (!challenge || challenge.projectSlug !== projectSlug || challenge.principalId !== principal.id || Date.parse(challenge.expiresAt) <= Date.now()) {
    throw httpError(409, 'Director Engine authorization expired or was already consumed; reopen the authorization screen');
  }
  const exact = input.taskSha256 === challenge.taskSha256
    && input.promptSha256 === challenge.promptSha256
    && input.model === challenge.model
    && Number(input.maxBudgetUsd) === challenge.maxBudgetUsd;
  if (!exact) throw httpError(409, 'Director Engine authorization binding changed; reopen the authorization screen');
  return challenge;
}

function issueGenerationAuthorizationChallenge(projectSlug, kind, request, fingerprintSha256, summary) {
  const principal = currentPrincipal();
  const id = `generation-authorization-${randomUUID()}`;
  const now = Date.now();
  const challenge = {
    id, projectSlug, kind, request: structuredClone(request), fingerprintSha256, summary,
    principalId: principal.id,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString()
  };
  generationAuthorizationChallenges.set(id, challenge);
  for (const [candidateId, candidate] of generationAuthorizationChallenges) {
    if (Date.parse(candidate.expiresAt) <= now) generationAuthorizationChallenges.delete(candidateId);
  }
  return structuredClone(challenge);
}

function consumeGenerationAuthorizationChallenge(projectSlug, kind, input) {
  const principal = currentPrincipal();
  const id = requiredText(input.authorizationId, 'authorizationId', 96);
  const challenge = generationAuthorizationChallenges.get(id);
  generationAuthorizationChallenges.delete(id);
  if (!challenge || challenge.projectSlug !== projectSlug || challenge.kind !== kind
    || challenge.principalId !== principal.id || Date.parse(challenge.expiresAt) <= Date.now()) {
    throw httpError(409, '生成授权已过期或已经使用；请重新检查本次付费任务');
  }
  if (input.fingerprintSha256 !== challenge.fingerprintSha256) throw httpError(409, '生成指纹发生变化；请重新检查');
  if (input.confirm !== true || input.confirmationPhrase !== '我确认提交一次付费生成') {
    throw httpError(400, '必须明确确认只提交这一次付费生成');
  }
  return challenge;
}

let generationWorkerActive = false;
let studioControlTail = Promise.resolve();

function serializeStudioControl(work) {
  const result = studioControlTail.then(work, work);
  studioControlTail = result.catch(() => {});
  return result;
}

function imageGenerationArgs(projectRoot, request, live) {
  return ['--project', projectRoot, '--segment', request.segmentId, live ? '--live' : '--dry-run',
    ...(request.projectUuid ? ['--libtv-project', request.projectUuid] : []),
    ...(request.model ? ['--model', request.model] : [])];
}

async function preflightExistingStudioGenerationJob(project, job) {
  if (job.kind === 'video') {
    const preflight = await createVideoPreflight(project.root, job.request.segmentId, {
      executor: 'libtv',
      libtvProjectUuid: job.request.projectUuid,
      nodeName: job.request.nodeName,
      model: job.request.model
    });
    return {
      fingerprintSha256: preflight.fingerprint.sha256,
      summary: {
        provider: preflight.generationContract.provider,
        model: preflight.generationContract.model,
        duration: preflight.duration,
        ratio: preflight.ratio,
        resolution: preflight.resolution,
        inputCounts: Object.fromEntries(Object.entries(preflight.fingerprint.inputMedia).map(([kind, items]) => [kind, items.length])),
        maxPaidAttempts: 1,
        automaticRetry: false
      }
    };
  }
  const plan = await runGenerateAssets(imageGenerationArgs(project.root, job.request, false));
  return {
    fingerprintSha256: sha256Text(JSON.stringify(plan)),
    summary: {
      provider: 'libtv',
      model: job.request.model,
      taskCount: plan.assets.length,
      assetIds: plan.assets.map(item => item.assetId),
      maxPaidAttempts: 1,
      automaticRetry: false
    }
  };
}

async function executeStudioGenerationJob(job) {
  const projectRoot = safeFile(projectsRoot, job.projectSlug);
  await access(join(projectRoot, 'project-state.json'));
  await requireStudioGenerationResumeApproval(projectRoot, job);
  if (job.kind === 'video') {
    const result = await executeLibTvVideo(projectRoot, {
      segmentId: job.request.segmentId,
      projectUuid: job.request.projectUuid,
      nodeName: job.request.nodeName,
      paidApprovalId: job.paidApprovalId ?? `review-${job.id}`
    });
    return { runId: result.run.id, status: result.run.status, outputs: result.run.outputs };
  }
  const currentPlan = await runGenerateAssets(imageGenerationArgs(projectRoot, job.request, false));
  const currentFingerprint = sha256Text(JSON.stringify(currentPlan));
  if (currentFingerprint !== job.fingerprintSha256) throw Object.assign(new Error('image generation plan changed before submission'), { beforePaidSubmit: true });
  await requireStudioImageGenerationApproval(projectRoot, {
    approvalId: `review-${job.id}`,
    jobId: job.id,
    principalId: job.principalId,
    segmentId: job.request.segmentId,
    fingerprintSha256: job.fingerprintSha256
  });
  const result = await runGenerateAssets(imageGenerationArgs(projectRoot, job.request, true));
  return { runId: result.runId, status: 'SUCCESS', outputs: result.outputs };
}

async function processStudioGenerationJobs() {
  if (generationWorkerActive) return;
  generationWorkerActive = true;
  try {
    while (true) {
      const queued = (await listStudioGenerationJobs(teamStateRoot)).find(job => job.status === 'QUEUED');
      if (!queued) break;
      let job;
      try {
        job = await serializeStudioControl(async () => {
          const claimed = await claimStudioGenerationJob(teamStateRoot, queued.id);
          const team = await listStudioTeam(teamStateRoot);
          if (team.settings?.paidGenerationEnabled !== true) {
            await failStudioGenerationJob(teamStateRoot, claimed.id, '所有者已暂停团队付费生成；任务未提交。', { uncertain: false });
            return null;
          }
          const operatorId = claimed.authorizedByPrincipalId ?? claimed.principalId;
          const principal = operatorId === team.owner.id ? team.owner : team.members.find(item => item.id === operatorId);
          if (!principal || principal.status !== 'active' || !await canAccessStudioProject(teamStateRoot, claimed.projectSlug, principal)) {
            await failStudioGenerationJob(teamStateRoot, claimed.id, '操作者已撤销或不再拥有此项目，任务未提交。', { uncertain: false });
            return null;
          }
          return claimed;
        });
        if (!job) continue;
      }
      catch { continue; }
      try {
        const result = await executeStudioGenerationJob(job);
        await completeStudioGenerationJob(teamStateRoot, job.id, result);
      } catch (error) {
        const beforePaidSubmit = error?.beforePaidSubmit === true;
        const safeMessage = beforePaidSubmit
          ? '提交前指纹或审批校验失败；未向供应商提交。'
          : '生成执行未确认成功；请核对供应商任务与本机运行证据，禁止直接重试。';
        await failStudioGenerationJob(teamStateRoot, job.id, safeMessage, { uncertain: !beforePaidSubmit });
      }
    }
  } finally {
    generationWorkerActive = false;
  }
}

function kickStudioGenerationWorker() {
  void processStudioGenerationJobs().catch(error => console.error('[Harness Studio generation worker]', error));
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireWriteAuthorization(request) {
  assertStudioWriteOrigin(request, { port, https: httpsEnabled });
  if (request.headers['x-harness-csrf'] !== currentAccess().session.csrfToken) throw httpError(403, 'invalid Harness session token');
  const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== 'application/octet-stream' && !type.startsWith('image/') && !type.startsWith('audio/') && !type.startsWith('video/')) {
    throw httpError(415, 'unsupported request content type');
  }
}

function safeFile(base, relativePath) {
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('invalid file path');
  return target;
}

async function projectEntries() {
  const principal = currentPrincipal();
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!await canAccessStudioProject(teamStateRoot, entry.name, principal)) continue;
    const root = safeFile(projectsRoot, entry.name);
    try {
      await access(join(root, 'project-state.json'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      projects.push({ slug: entry.name, root, error: error.message });
      continue;
    }
    try {
      const [status, next, state, directorInterview, executionLedger] = await Promise.all([
        getCompactStatus(root),
        determineNextActions(root),
        readJson(join(root, 'project-state.json')),
        getDirectorInterview(root),
        readExecutionLedgerStatus(root, { latestEventLimit: 1 })
      ]);
      projects.push({
        slug: entry.name,
        root,
        status,
        next,
        directorInterview: directorInterviewSummary(directorInterview),
        routeDecision: state.routeDecision ?? null,
        workflowVersion: state.workflowVersion ?? 1,
        ingressPolicyVersion: state.ingressPolicyVersion ?? null
        , workflowProfileId: workflowProfileIdOf(state),
        visibleSteps: visibleStepsForProject(state),
        executionLedger
      });
    } catch (error) {
      projects.push({ slug: entry.name, root, error: error.message });
    }
  }
  return projects.sort((left, right) => {
    const leftDate = left.status?.updatedAt ?? '';
    const rightDate = right.status?.updatedAt ?? '';
    return rightDate.localeCompare(leftDate) || left.slug.localeCompare(right.slug);
  });
}

async function findProject(slug) {
  if (!isProjectSlug(slug)) throw badRequest('invalid project identifier');
  if (!await canAccessStudioProject(teamStateRoot, slug, currentPrincipal())) throw httpError(404, 'project not found');
  const root = safeFile(projectsRoot, slug);
  try {
    await access(join(root, 'project-state.json'));
    const [status, next] = await Promise.all([getCompactStatus(root), determineNextActions(root)]);
    return { slug, root, status, next };
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'project not found');
    throw error;
  }
}

function requiredText(value, field, maxLength = 4000) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${field} is required`);
  if (value.trim().length > maxLength) throw badRequest(`${field} is too long`);
  return value.trim();
}

function projectSlug(projectId) {
  try {
    return assertProjectId(requiredText(projectId, 'projectId', 96));
  } catch (error) {
    throw badRequest(error.message);
  }
}

function textLines(value, field, minimum = 1) {
  const items = requiredText(value, field, 12000).split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  if (items.length < minimum) throw badRequest(`${field} requires at least ${minimum} line${minimum === 1 ? '' : 's'}`);
  return items;
}

function compactCreativeBrief(projectId, routeDecision, input) {
  if (!routeDecision?.harnessRequired) throw badRequest('Gate 1 requires a persisted Harness intake route');
  if (routeDecision.referenceRoleStatus !== 'not_applicable') {
    throw badRequest('reference-based creative briefs need source-media intake, which is not connected to this editor yet');
  }
  const value = (name, maxLength = 4000) => requiredText(input[name], name, maxLength);
  const duration = Number(input.targetDurationSec);
  if (!Number.isFinite(duration) || duration < 1 || duration > 120) throw badRequest('targetDurationSec must be between 1 and 120');
  const logline = value('logline');
  const desiredEffect = value('desiredAudienceEffect');
  const purpose = value('purpose');
  const audience = value('audience');
  const productFunction = value('productDramaticFunction');
  const opening = {
    firstFrame: value('firstFrame'), trigger: value('trigger'), audienceQuestion: value('audienceQuestion'),
    storyBridge: value('storyBridge'), rationale: value('openingRationale')
  };
  const recommendationRationale = {
    audienceEffect: value('audienceRationale'), storyCausality: value('causalityRationale'),
    productFunction: value('productRationale'), executionRisk: value('executionRisk')
  };
  const referenceWorkflow = resolveReferenceWorkflow({ referenceIntent: 'idea_only', sourceVideoIds: [] });
  const fixedDeferral = {
    variable: '精确分段与最终最小资产范围', disposition: 'deferred_to_gate2', owner: 'director', status: 'deferred',
    resolution: '由 Gate 2 从锁定 Shotlist 反推，不影响当前创意方向',
    evidenceOrReason: 'Gate 1 只锁创意方向；镜头与最小资产范围必须在 Gate 2 精确确定', revisitAt: 'Gate 2 故事与镜头规划'
  };
  return {
    schemaVersion: 3,
    id: `creative-brief-${Date.now()}`,
    projectId,
    targetDurationSec: duration,
    creativeDecision: {
      storyDirection: logline,
      successDefinition: desiredEffect,
      segmentationStrategy: 'hybrid',
      segmentationRationale: 'Gate 1 暂定采用混合分段；Gate 2 依据完整故事与 Shotlist 锁定最终执行边界',
      executionMode: 'mixed', assetExecutionMode: 'parallel', videoExecutionMode: 'mixed',
      referenceWorkflow,
      parallelPlan: ['Gate 2 只为锁定 Shot 反推的资产并行制作', '存在连续衔接依赖的视频段保持串行'],
      estimatedAssetCombination: ['Gate 2 根据锁定 Shotlist 确定最小资产集合'],
      directorCreativeContract: {
        structureMode: 'product_demo', characterMode: 'subject_only',
        projectIntent: { purpose, audience, desiredAudienceEffect: desiredEffect, deliveryContext: `${duration} 秒竖屏视频，移动端观看`, commercialIntent: true, productDramaticFunction: productFunction },
        recommendedDirection: {
          directionId: 'direction-primary', logline, coreMeaning: value('coreMeaning'), extensionOfUserIdea: value('extensionOfUserIdea'),
          openingDesign: opening, centralConflict: value('centralConflict'), coreTurn: value('coreTurn'), endingPayoff: value('endingPayoff'),
          progressionLogic: value('progressionLogic'), recommendationRationale
        },
        alternativesConsidered: [], characters: [], storyOutline: textLines(input.storyOutline, 'storyOutline', 3),
        scenePriorities: textLines(input.scenePriorities, 'scenePriorities'),
        emotionAndRhythm: { emotionCurve: value('emotionCurve'), rhythmStrategy: value('rhythmStrategy') },
        audiovisualStrategy: { pointOfView: value('pointOfView'), cameraMotive: value('cameraMotive'), editingStrategy: value('editingStrategy'), soundStrategy: value('soundStrategy'), specialTechniques: [] },
        creativeBoundaries: { mustKeep: textLines(input.mustKeep, 'mustKeep'), mustAvoid: textLines(input.mustAvoid, 'mustAvoid') },
        uncertaintyLedger: [fixedDeferral],
        decisionLedger: {
          confirmedFacts: textLines(input.confirmedFacts, 'confirmedFacts'), professionalRecommendations: [value('professionalRecommendation')],
          lockedVariables: textLines(input.lockedVariables, 'lockedVariables'), rejectedPatterns: []
        },
        provisionalExecution: { segmentation: 'provisional_until_gate2', assetScope: 'provisional_until_gate2', parallelism: 'provisional_until_gate2' }
      },
      revisionImpact: {
        previousCreativeBriefId: null, changeSummary: 'The service derives revision impact from the current project state during publication',
        changedDecisionPaths: [], affectedStages: [], affectedArtifactIds: [], requiredRework: [], preservedDecisions: [], impactPolicy: 'conservative_v1'
      }
    },
    lockedConstraints: ['Gate 0 文字讨论不新增审核门，创意只在 Gate 1 正式确认一次', 'Gate 1 只锁创意母版；精确分段、Shotlist 和最小资产范围在 Gate 2 锁定', '完整导演审计不进入最终视频提示词，提示词只保留镜内可执行内容']
  };
}

function compactStoryPlan(projectId, creativeArtifact, creativeBrief, input, profileId = null) {
  return compactStoryPlanInner(projectId, creativeArtifact, creativeBrief, input, profileId);
}

function buildPlanCharacters(contract) {
  const source = Array.isArray(contract?.characters) ? contract.characters : [];
  const mapped = source.map((c, i) => ({
    characterId: c?.characterId ?? `character-${i + 1}`,
    tag: c?.tag ?? (c?.importance === 'lead' ? '主角' : '对手'),
    role: c?.role ?? c?.importance ?? 'lead',
    background: c?.background ?? c?.dramaticFunction ?? '由原片与创意单锁定的人物背景。',
    personality: c?.personality ?? c?.emotionalBaseline ?? '克制、真实，不脸谱化。',
    stance: c?.stance ?? c?.audienceRelationship ?? '与观众建立可信关系。',
    objective: c?.objective ?? '完成本段可见目标。',
    obstacle: c?.obstacle ?? '需要靠可见证据而非口头说明。',
    appearance: c?.appearance ?? c?.visibleBehavior ?? '沿用原片人物外形与动作。',
    wardrobeLock: c?.wardrobeLock ?? '服装与造型沿用原片，禁止改动。',
    relationshipMap: c?.relationshipMap ?? c?.tactic ?? '通过动作与可见证据互动。',
    arc: c?.arc ?? '从被动到主动的可见转变。'
  }));
  if (contract?.characterMode === 'character_driven' && mapped.length === 0) {
    mapped.push({
      characterId: 'character-a', tag: '主角', role: 'lead',
      background: '由原片与创意单锁定的人物背景。', personality: '克制、真实，不脸谱化。',
      stance: '与观众建立可信关系。', objective: '完成本段可见目标。', obstacle: '需要靠可见证据而非口头说明。',
      appearance: '沿用原片人物外形与动作。', wardrobeLock: '服装与造型沿用原片，禁止改动。',
      relationshipMap: '通过动作与可见证据互动。', arc: '从被动到主动的可见转变。'
    });
  }
  return mapped;
}

const SIMPLE_REMAKE_UNIT_SEC = 15;

// Long simple-remake projects are split into fixed windows that follow the
// source timeline one-to-one. Each generation unit opens from its own source
// window, so no unit inherits identity or state from a previous unit's output.
function simpleRemakeTimeWindows(durationSec) {
  const count = Math.ceil(durationSec / SIMPLE_REMAKE_UNIT_SEC);
  const windows = [];
  for (let index = 0; index < count; index += 1) {
    const startSec = index * SIMPLE_REMAKE_UNIT_SEC;
    const endSec = Math.min(durationSec, (index + 1) * SIMPLE_REMAKE_UNIT_SEC);
    windows.push({ index, startSec, endSec });
  }
  return windows;
}

function formatWindowSec(value) {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

// Deterministic Gate 2 plan for a long simple-remake project: one scene, one
// fixed source-aligned window per generation unit, one shot per unit. The
// selected remake control modes decide which control assets each shot
// requires; the product reference is always required because identity comes
// only from the locked product image.
function compactSimpleRemakeLongPlan(projectId, creativeArtifact, creativeBrief, input) {
  const contract = creativeBrief.creativeDecision.directorCreativeContract;
  const duration = creativeBrief.targetDurationSec;
  const modes = Array.isArray(input.selectedModes) && input.selectedModes.length > 0
    ? input.selectedModes
    : ['native_source'];
  if (modes.includes('koc_remake')) {
    throw badRequest('KOC 复刻不能使用整片固定时间窗或产品替换计划；请先完成 A-roll 全量账本和匿名控制审查，再用 koc-remake-plan 编译并行执行计划。');
  }
  const windows = simpleRemakeTimeWindows(duration);
  const nativeOnly = modes.every(mode => mode === 'native_source');
  const controlBasis = nativeOnly
    ? '原片对应时间窗是本单元唯一的时序、动作与构图依据'
    : '已选复刻控制资产与原片对应时间窗共同约束本单元';
  const requiredShotAssets = [
    ...(modes.includes('storyboard_control') ? ['storyboard'] : []),
    ...(modes.includes('depth_control') ? ['depth_video_reference', 'initial_blocking'] : []),
    'product_reference'
  ];
  const roughPreviewPath = typeof input.roughStoryboardPreviewPath === 'string'
    ? input.roughStoryboardPreviewPath.trim()
    : '';
  if (windows.length > 12 && !roughPreviewPath) {
    throw badRequest('超过 12 个生成单元的简单复刻需要系统先根据原片生成粗分镜预览。');
  }
  const declaredCharacters = buildPlanCharacters(contract);
  const planCharacters = contract.characterMode === 'character_driven'
    ? [declaredCharacters.find(character => character.role === 'lead') ?? declaredCharacters[0]].filter(Boolean)
    : [];
  const characterIds = planCharacters.map(item => item.characterId);
  const id = typeof input.planId === 'string' && input.planId.trim() !== '' ? input.planId.trim() : `story-plan-${Date.now()}`;
  const sceneId = 'scene-001';
  const totalLabel = formatWindowSec(duration);
  return {
    schemaVersion: 2,
    id,
    projectId,
    creativeBriefId: creativeArtifact.id,
    finalExecutionDecision: {
      segmentationStrategy: 'hybrid',
      segmentationRationale: `源片前 ${totalLabel} 秒保持原有时序；受单次生成 ${SIMPLE_REMAKE_UNIT_SEC} 秒上限约束，按固定时间窗拆为 ${windows.length} 个生成单元，逐段复刻替换后确定性拼接。`,
      assetExecutionMode: 'parallel',
      videoExecutionMode: 'sequential',
      parallelPlan: ['产品参考图为项目级资产，一次准备、全片复用；各生成单元只读自身源片时间窗，串行执行，互不继承上一段的生成结果。'],
      assetScopeBasis: '最终资产范围由已选复刻控制方式反推：已锁定原视频提供逐段时序与动态，产品图锁定替换对象身份；未选择的控制方式不生产任何资产。'
    },
    directorPlan: {
      projectType: 'faithful_remake',
      transformMode: 'faithful_remake',
      controlMode: 'standard',
      fidelityTarget: 'faithful',
      directorialVoice: nativeOnly
        ? '克制、写实；原片各时间窗是唯一时序与动态依据，产品图只锁定替换对象身份。'
        : '克制、写实；已选控制资产锁定各自负责的维度，产品图只锁定替换对象身份。',
      audienceFeltIntent: '观众看到与原片一致的动作与节奏，同时产品替换自然可信。',
      visualStrategy: '每个生成单元以原片对应时间窗的实际画面为唯一视觉依据；产品图只负责产品身份与结构。',
      rhythmStrategy: '沿原片固有节奏推进，不新增镜头、不压缩或拉伸任何时间窗。',
      realismStrategy: '保持原片光向、尺度、遮挡和运动连续；产品结构以产品参考图为唯一身份依据。'
    },
    story: {
      logline: contract.recommendedDirection.logline,
      storyPromise: `在不增加额外剧情的前提下，让观众看见与原片一致、产品被自然替换的完整前 ${totalLabel} 秒。`,
      initialCondition: '每个生成单元从原片对应时间窗的实际画面状态开场。',
      objective: `保持原片前 ${totalLabel} 秒的动作、时序与构图关系，同时完成产品对象替换。`,
      centralConflict: '空间运动和产品替换必须在每个时间窗内同时保持连续，不能出现结构漂移或遮挡跳变。',
      turn: '产品在原有注意力路径中清晰出现，并与动作保持同一空间关系。',
      climax: '产品结构在各时间窗动作完成时仍然可辨，人物、产品与背景的相对位置没有跳变。',
      progression: `${windows.length} 个时间窗按原片时序依次复刻；产品只在对应动作阶段完成身份替换；各单元结尾与原片该时刻状态一致。`,
      finalOutcome: `原片前 ${totalLabel} 秒的完整复刻候选，产品替换贯穿始终且无额外剧情。`,
      tone: '真实、克制、连续，不添加原片之外的表演。'
    },
    characters: planCharacters,
    script: {
      scenes: [{
        sceneId,
        location: '与原片画面所见空间保持一致。',
        timeOfDay: '与原片光线方向和明暗关系保持一致。',
        sceneFunction: `在 0–${totalLabel} 秒源片窗口内保持原有动作与构图，仅完成产品对象替换。`,
        pov: '沿用原片视角与景别关系。',
        powerShift: '注意力从原产品位置自然转移到替换后的产品结构。',
        subtext: '可信感来自动作、空间和产品结构的连续，而不是额外解释。',
        beats: [
          '原片时序与动作在各时间窗内完整保留',
          '产品图只负责替换对象的身份、结构与颜色',
          '各生成单元以自身源片时间窗开场，不依赖上一段的生成结果'
        ],
        dialogue: []
      }]
    },
    videoSegments: windows.map(({ index, startSec, endSec }) => ({
      segmentId: `segment-${String(index + 1).padStart(3, '0')}`,
      startSec,
      endSec,
      sceneIds: [sceneId],
      storyBeat: `源片 ${formatWindowSec(startSec)}–${formatWindowSec(endSec)} 秒窗口：完整保留该窗口的动作、时序、构图与声音，仅将画面中手持产品替换为已锁定的目标产品。`,
      splitReason: index === 0
        ? `单次生成上限 ${SIMPLE_REMAKE_UNIT_SEC} 秒；源片前 ${totalLabel} 秒按时间窗顺序拆分，本段为第 1 窗。`
        : `单次生成上限 ${SIMPLE_REMAKE_UNIT_SEC} 秒；本段为第 ${index + 1} 窗，承接同一源片时间轴。`,
      continuityStrategy: 'canonical_open'
    })),
    shotPlanning: {
      mode: 'shotlist',
      shots: windows.map(({ index, startSec, endSec }) => ({
        shotId: `S${String(index + 1).padStart(2, '0')}_SH01`,
        segmentId: `segment-${String(index + 1).padStart(3, '0')}`,
        sceneId,
        characterIds,
        visibleCharacterIds: characterIds,
        offscreenCharacterIds: [],
        visibleSpeakerIds: [],
        durationSec: endSec - startSec,
        startSec,
        endSec,
        purpose: `在源片 ${formatWindowSec(startSec)}–${formatWindowSec(endSec)} 秒窗口内保留原有动作与镜头关系，并完成产品替换。`,
        subjectAction: '人物沿原片该窗口的可见动作连续执行；替换产品在原产品出现的同一动作阶段保持可辨。',
        shotContract: `${controlBasis}；不新增机位、不改变切镜、不压缩或拉伸该窗口时长。`,
        blocking: '人物与背景的空间关系以原片该窗口实际画面为准；产品仅在其原出现位置完成身份替换，禁止重新排位或改变遮挡。',
        startState: `本单元从源片 ${formatWindowSec(startSec)} 秒的实际画面状态开场，不把上一生成单元的输出当作身份依据。`,
        endState: `本单元结束于源片 ${formatWindowSec(endSec)} 秒的实际画面状态，产品结构在结尾仍可辨认。`,
        continuityAnchors: ['原片该时间窗的动作、时序与画面方向', '产品图的结构、材质、颜色与比例', '原有光向、场景与人物外形'],
        audio: '沿用原片该窗口的原始声音与节奏；不新增台词、配音或音效。',
        risks: ['产品结构被模型改写', '窗口内动作节奏被压缩或拉伸', '原产品外观污染替换后的产品身份'],
        mustSee: ['该窗口内人物动作与原片一致', '替换产品在原产品出现阶段清晰可辨', '结尾帧的产品与空间关系连续'],
        directorIntent: {
          narrativeFunction: '用该时间窗内与原片一致的连续动作，证明产品替换没有破坏原有视觉逻辑。',
          valueTurn: '从原产品在该窗口的位置被识别，到替换产品在同一动作逻辑中被确认。',
          povCharacter: '沿用原片所确定的观看位置。',
          powerShift: '从原产品占据注意力，到替换后的产品自然承接注意力。',
          subtext: '替换不靠解释成立，而靠动作和空间连续成立。',
          feltIntent: '观众感到自然、可信、没有被额外流程打断。',
          whyThisShot: `${controlBasis}；窗口受单次生成上限约束，跨段状态漂移风险最低。`,
          audienceAttention: '先看到与原片一致的动作与构图，再确认产品结构已被替换。',
          expressiveDetail: '产品结构在该窗口的动作终点仍保持稳定、可辨和有重量感。',
          intentCarriers: [
            { channel: 'camera', instruction: '严格沿用原片该窗口的镜头路径、景别、尺度与画面方向。', visibleEvidence: '窗口开场、中段与结尾的主体位置和运动关系与原片一致。' },
            { channel: 'performance', instruction: '只执行原片该窗口中可见的原有动作，不补写新的表演动机。', visibleEvidence: '动作起点、过程与结束状态均可对照原片该窗口核验。' }
          ],
          signals: {
            hasDialogue: false, emotionalTurn: false, relationshipBeat: false, closePerformance: false,
            requiresMutualEyeLine: false, complexBlocking: false, complexPhysicalAction: false, viralRemake: false,
            productInteraction: 'display',
            requiredAssetTypes: requiredShotAssets
          }
        }
      })),
      continuousTakePlan: null,
      roughStoryboardPreview: roughPreviewPath ? { path: roughPreviewPath } : null
    },
    assetPlan: [
      { assetType: 'product_reference', decision: 'required', reason: '产品图是替换对象的唯一身份依据：结构、材质、颜色与比例；禁止被原片产品外观污染。' },
      modes.includes('storyboard_control')
        ? { assetType: 'storyboard', decision: 'required', reason: '分镜图是本次明确选择的复刻控制输入，负责构图、景别、动作节点与切镜顺序。' }
        : { assetType: 'storyboard', decision: 'skipped', reason: '本次未选择分镜图控制方式，镜头关系以原片时间窗为准。' },
      modes.includes('depth_control')
        ? { assetType: 'depth_video_reference', decision: 'required', reason: '深度视频是本次明确选择的复刻控制输入，负责动作、遮挡与镜头运动。' }
        : { assetType: 'depth_video_reference', decision: 'skipped', reason: '本次未选择深度视频控制方式，动作与运镜以原片时间窗为准。' },
      modes.includes('depth_control')
        ? { assetType: 'initial_blocking', decision: 'required', reason: '首帧负责每个生成单元的开场构图与主体位置。' }
        : { assetType: 'initial_blocking', decision: 'skipped', reason: '每个生成单元的开场画面由原片对应时间窗直接提供。' },
      { assetType: 'scene_multiview', decision: 'skipped', reason: '场景空间以原片画面为唯一依据，不另建多视图基准。' },
      { assetType: 'character_board', decision: 'skipped', reason: '未要求替换人物身份，沿用原片人物外形。' }
    ],
    assetScope: {
      requiredBeforeGate3: [...new Set(requiredShotAssets)]
    }
  };
}

// Builds the low-cost rough storyboard preview for long simple-remake plans:
// one real source frame per generation window, tiled into a single contact
// sheet stored inside the project so the story plan can bind its SHA.
async function ensureSimpleRemakeRoughPreview(root, state, segmentCount) {
  const reference = state.artifacts.find(item => item.type === 'reference_video' && item.status === 'locked'
    && typeof item.invalidatedByScopeRevisionId !== 'string');
  if (!reference) throw badRequest('长片简单复刻需要一条已锁定的原视频来生成粗分镜预览。');
  const directory = safeFile(root, 'planning/storyboard-previews');
  await mkdir(directory, { recursive: true });
  const relativePath = `planning/storyboard-previews/rough-preview-${Date.now()}.jpg`;
  const target = safeFile(root, relativePath);
  const columns = Math.ceil(Math.sqrt(segmentCount));
  const rows = Math.ceil(segmentCount / columns);
  const result = await runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', safeFile(root, reference.path),
    '-vf', `fps=1/${SIMPLE_REMAKE_UNIT_SEC},scale=320:-2,tile=${columns}x${rows}:nb_frames=${segmentCount}:padding=6:margin=6:color=white`,
    '-frames:v', '1', target
  ], { cwd: repositoryRoot });
  if (result.code !== 0) throw badRequest(`粗分镜预览生成失败：${String(result.stderr || result.stdout || 'ffmpeg error').slice(0, 300)}`);
  return relativePath;
}

async function ensureSimpleRemakeNativeSourceClip(root, state, segmentId) {
  const existing = state.artifacts.find(item => item.type === 'reference_video' && item.segmentId === segmentId
    && item.status === 'locked' && typeof item.invalidatedByScopeRevisionId !== 'string');
  if (existing) return existing;
  const source = state.artifacts.find(item => item.type === 'reference_video' && !item.segmentId
    && item.status === 'locked' && typeof item.invalidatedByScopeRevisionId !== 'string');
  if (!source) throw badRequest('简单复刻原生替换需要一条已锁定的项目原视频。');
  const segmentation = state.artifacts.filter(item => item.type === 'segmentation' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  if (!segmentation) throw badRequest('拆分原视频前需要已锁定的正式分段。');
  const payload = await readJson(safeFile(root, segmentation.path));
  const index = payload.segments.findIndex(item => item.id === segmentId);
  if (index < 0) throw badRequest(`正式分段中找不到 ${segmentId}。`);
  const startSec = payload.segments.slice(0, index).reduce((sum, item) => sum + item.duration, 0);
  const durationSec = payload.segments[index].duration;
  const id = `${source.id}-${segmentId}`;
  const extension = extname(source.path).toLowerCase() || '.mp4';
  const relativePath = `brief/reference/segments/${id}${extension}`;
  const target = safeFile(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  const result = await runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', String(startSec), '-i', safeFile(root, source.path), '-t', String(durationSec),
    '-map', '0:v:0', '-map', '0:a?', '-vf', 'scale=496:864:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target
  ], { cwd: repositoryRoot });
  if (result.code !== 0) throw badRequest(`原视频 ${segmentId} 拆分失败：${String(result.stderr || result.stdout || 'ffmpeg error').slice(0, 300)}`);
  await validateMediaFile(target, 'video');
  const artifact = await registerArtifact(root, {
    id, type: 'reference_video', revision: index + 2, status: 'draft', path: relativePath,
    segmentId, mediaKind: 'video', sourceVideoId: source.id,
    sourceTimeRange: [startSec, startSec + durationSec], segmentationId: segmentation.id, segmentationSha256: segmentation.sha256
  });
  await autoLockArtifact(root, artifact.id,
    `auto-locked: deterministic ${formatWindowSec(startSec)}–${formatWindowSec(startSec + durationSec)} second source window decoded successfully for ${segmentId}`);
  const refreshed = await readJson(join(root, 'project-state.json'));
  return refreshed.artifacts.find(item => item.id === artifact.id);
}

function compactStoryPlanInner(projectId, creativeArtifact, creativeBrief, input, profileId = null) {
  const contract = creativeBrief?.creativeDecision?.directorCreativeContract;
  if (!contract || creativeBrief?.schemaVersion !== 3) {
    throw badRequest('Gate 2 editor currently requires a schemaVersion 3 creative brief created by Harness Studio');
  }
  const lightweightReplication = isAssetAnchoredReferenceWorkflow(
    creativeBrief?.creativeDecision?.referenceWorkflow,
    creativeBrief?.creativeDecision
  ) || profileId === 'simple_remake';
  if (!lightweightReplication && (contract.structureMode !== 'product_demo' || contract.characterMode !== 'subject_only')) {
    throw badRequest('the compact Gate 2 editor currently supports subject-only product demos; use the full Harness planner for character or reference-authority projects');
  }
  if (creativeBrief.targetDurationSec > 15) {
    if (profileId === 'simple_remake') {
      return compactSimpleRemakeLongPlan(projectId, creativeArtifact, creativeBrief, input);
    }
    throw badRequest('the compact Gate 2 editor supports one generation segment up to 15 seconds; use the multi-segment planner for longer projects');
  }
  const lightweightDefaults = lightweightReplication ? {
    directorialVoice: '克制、写实；系统以深度视频锁定运动与空间，以首帧锁定开场构图，以产品图锁定替换对象。',
    audienceFeltIntent: '观众清楚感到原片动作关系被保留，同时产品替换自然可信。',
    visualStrategy: '首帧只建立已可见的人物、空间与画面关系，深度视频持续控制运动和遮挡，产品图只负责产品身份与结构。产品不在首帧中出现时，不预设其已出现。',
    rhythmStrategy: '沿深度视频的原有动作节奏推进，不新增镜头、不人为加速，不要求操作者手写时间线。',
    realismStrategy: '保持原始光向、尺度、遮挡和运动连续，产品结构以产品参考图为唯一身份依据。',
    storyPromise: '在不增加额外剧情的前提下，让观众看见一次自然、连续、可信的产品替换。',
    initialCondition: '首帧建立源片中已可见的人物、空间、构图和光向；产品是否在首帧出现只以实际画面为准。',
    objective: '保持源片动作与构图关系，同时完成产品对象替换。',
    centralConflict: '空间运动和产品替换必须同时保持连续，不能出现结构漂移或遮挡跳变。',
    turn: '产品在原有注意力路径中清晰出现，并与动作保持同一空间关系。',
    climax: '产品结构在动作完成时仍然可辨，人物、产品与背景的相对位置没有跳变。',
    progression: '首帧建立已可见的关系；深度视频承接动作、尺度和遮挡；产品只在对应动作阶段完成身份替换；结尾保持连续状态。',
    finalOutcome: '一段不超过十五秒的单段复刻候选，三项资产职责清晰且无额外资产扩张。',
    tone: '真实、克制、连续，不添加源片之外的表演。',
    location: '按原片首帧与深度视频所见空间保持一致。',
    timeOfDay: '按深度视频中的光线方向和明暗关系保持一致。',
    sceneFunction: '在原有动作与构图中完成产品替换并保持可信连续。',
    pov: '沿用首帧与深度视频所确定的观众视角。',
    scenePowerShift: '注意力从原产品位置自然转移到替换后的产品结构。',
    sceneSubtext: '可信感来自动作、空间和产品结构的连续，而不是额外解释。',
    beats: '首帧建立已可见的人物、空间与构图\n深度视频保持动作、尺度、遮挡与节奏\n产品图只在对应动作阶段锁定替换对象并完成收束',
    segmentStoryBeat: '在一个连续生成单元内完成三项资产的职责协同。',
    splitReason: '本项目目标是单段轻量复刻，不拆分，不引入跨段衔接成本。',
    shotPurpose: '在同一镜头中完成源片动作关系保留与产品对象替换。',
    subjectAction: '沿深度视频的原有动作完成连续运动，产品在对应位置保持可辨。',
    shotContract: '首帧锁定开场构图；深度视频锁定相机路径、主体尺度与遮挡；不新增机位和切镜。',
    blocking: '人物和背景的开场空间关系以首帧为准；产品仅在深度视频对应的动作阶段进入其应有位置，禁止重新排位或改变遮挡。',
    startState: '首帧中实际可见的人物、空间、画面方向和光向已建立；不把未出现的产品当作开场事实。',
    endState: '动作完成后产品结构仍清晰，主体尺度和空间方向连续。',
    continuityAnchors: '首帧构图与画面方向\n深度视频的运动、尺度与遮挡\n产品图的结构、材质与颜色\n原有光向和背景关系',
    audio: '沿用原有声音节奏；若当前任务没有锁定音频，则保持安静，不新增台词。',
    risks: '产品结构被模型改写\n深度层级闪烁或遮挡跳变\n首帧构图被重新布局',
    mustSee: '首帧中的主体、空间与构图\n产品出现后的空间连续\n结尾仍可辨认的产品结构',
    narrativeFunction: '用一次连续动作证明产品替换没有破坏原有视觉逻辑。',
    valueTurn: '从源片产品位置被识别，到替换产品在同一动作逻辑中被确认。',
    povCharacter: '沿用源片深度视频所确定的观看位置。',
    powerShift: '从原产品占据注意力，到替换后的产品自然承接注意力。',
    subtext: '替换不靠解释成立，而靠动作和空间连续成立。',
    feltIntent: '观众感到自然、可信、没有被额外流程打断。',
    whyThisShot: '三项资产已经分别承担构图、运动和产品身份，增加镜头只会提高返工成本。',
    audienceAttention: '先看首帧中实际可见的构图，再跟随深度视频的动作，最后确认产品结构。',
    expressiveDetail: '产品结构在动作终点仍保持稳定、可辨和有重量感。',
    cameraInstruction: '严格沿用深度视频的相机路径、景别、尺度和画面方向。',
    cameraEvidence: '首帧、中段和结束状态的主体位置与运动关系连续。',
    performanceInstruction: '只执行深度视频中可见的原有动作，不补写新的表演动机。',
    performanceEvidence: '动作起点、运动过程和结束状态均可由深度视频与首帧核验。',
    productReferenceReason: '锁定产品结构、材质、颜色、比例和扣件细节，禁止被深度视频或源片产品外观污染。'
  } : {};
  const value = (name, maxLength = 4000) => requiredText(input[name] ?? lightweightDefaults[name], name, maxLength);
  const lines = (name, minimum = 1) => textLines(input[name] ?? lightweightDefaults[name], name, minimum);
  const duration = creativeBrief.targetDurationSec;
  // 简单复刻不因人物出镜而自动增加人物参考图；但角色型创意仍须保留
  // 已锁定的角色叙事信息，供故事、讲戏与独立复核核验。
  const declaredCharacters = buildPlanCharacters(contract);
  const planCharacters = lightweightReplication && contract.characterMode === 'character_driven'
    ? [declaredCharacters.find(character => character.role === 'lead') ?? declaredCharacters[0]].filter(Boolean)
    : lightweightReplication ? [] : declaredCharacters;
  const characterIds = planCharacters.map(item => item.characterId);
  const id = `story-plan-${Date.now()}`;
  const sceneId = 'scene-001';
  const segmentId = 'segment-001';
  const shotId = 'S01_SH01';
  return {
    schemaVersion: 2,
    id,
    projectId,
    creativeBriefId: creativeArtifact.id,
    finalExecutionDecision: {
      segmentationStrategy: 'single_clip',
      segmentationRationale: '锁定创意可在一个不超过 15 秒的产品演示生成单元内完成，避免无必要的跨段状态交接。',
      assetExecutionMode: 'parallel',
      videoExecutionMode: 'sequential',
      parallelPlan: ['只并行制作已锁定镜头明确需要的产品参考资产；视频生成保持单段串行。'],
      assetScopeBasis: '最终资产范围由本 Gate 2 的单镜产品证据、风险与 assetPlan 反推，不继承 Gate 1 预估数量。'
    },
    directorPlan: {
      projectType: lightweightReplication ? 'faithful_remake' : 'product_demo',
      transformMode: lightweightReplication ? 'faithful_remake' : 'story_creation',
      controlMode: 'standard',
      fidelityTarget: lightweightReplication ? 'faithful' : 'adapted',
      directorialVoice: value('directorialVoice'), audienceFeltIntent: value('audienceFeltIntent'),
      visualStrategy: value('visualStrategy'), rhythmStrategy: value('rhythmStrategy'), realismStrategy: value('realismStrategy')
    },
    story: {
      logline: contract.recommendedDirection.logline,
      storyPromise: value('storyPromise'), initialCondition: value('initialCondition'), objective: value('objective'),
      centralConflict: value('centralConflict'), turn: value('turn'), climax: value('climax'),
      progression: value('progression'), finalOutcome: value('finalOutcome'), tone: value('tone')
    },
    ...(lightweightReplication && contract.characterMode === 'character_driven' ? {
      sourceFidelityDecision: {
        decision: '单人执行收敛',
        reason: '当前锁定原片与深度视频的可视化证据只显示一名可交互主体。为避免把创意草案中的未证实角色当作执行事实，本段只保留该主体，不新增第二人物、对手动作或互动表演。',
        preserved: '保留原片的单人动作、镜头路径、空间遮挡与产品替换目标。',
        deferred: '如需双人冲突剧情，必须使用包含双方互动的原片并新建相应创意版本。'
      }
    } : {}),
    characters: planCharacters,
    script: {
      scenes: [{
        sceneId, location: value('location'), timeOfDay: value('timeOfDay'), sceneFunction: value('sceneFunction'),
        pov: value('pov'), powerShift: value('scenePowerShift'), subtext: value('sceneSubtext'), beats: lines('beats'), dialogue: []
      }]
    },
    videoSegments: [{
      segmentId, startSec: 0, endSec: duration, sceneIds: [sceneId], storyBeat: value('segmentStoryBeat'),
      splitReason: value('splitReason'), continuityStrategy: 'canonical_open'
    }],
    shotPlanning: {
      mode: 'shotlist',
      shots: [{
        shotId, segmentId, sceneId, characterIds, visibleCharacterIds: characterIds, offscreenCharacterIds: [], visibleSpeakerIds: [],
        durationSec: duration, startSec: 0, endSec: duration,
        purpose: value('shotPurpose'), subjectAction: value('subjectAction'), shotContract: value('shotContract'),
        blocking: value('blocking'), startState: value('startState'), endState: value('endState'),
        continuityAnchors: lines('continuityAnchors'), audio: value('audio'), risks: lines('risks'), mustSee: lines('mustSee'),
        directorIntent: {
          narrativeFunction: value('narrativeFunction'), valueTurn: value('valueTurn'), povCharacter: value('povCharacter'),
          powerShift: value('powerShift'), subtext: value('subtext'), feltIntent: value('feltIntent'),
          whyThisShot: value('whyThisShot'), audienceAttention: value('audienceAttention'), expressiveDetail: value('expressiveDetail'),
          intentCarriers: [
            { channel: 'camera', instruction: value('cameraInstruction'), visibleEvidence: value('cameraEvidence') },
            { channel: 'performance', instruction: value('performanceInstruction'), visibleEvidence: value('performanceEvidence') }
          ],
          signals: {
            hasDialogue: false, emotionalTurn: false, relationshipBeat: false, closePerformance: false,
            requiresMutualEyeLine: false, complexBlocking: false, complexPhysicalAction: false, viralRemake: false,
            productInteraction: 'display',
            requiredAssetTypes: lightweightReplication
              ? ['depth_video_reference', 'initial_blocking', 'product_reference']
              : ['product_reference']
          }
        }
      }],
      continuousTakePlan: null,
      roughStoryboardPreview: null
    },
    assetPlan: [
      ...(lightweightReplication ? [
        { assetType: 'depth_video_reference', decision: 'required', reason: '深度视频负责相机路径、主体尺度、遮挡和动作时序。' },
        { assetType: 'initial_blocking', decision: 'required', reason: '首帧负责开场构图、主体位置和画面方向。' }
      ] : []),
      { assetType: 'product_reference', decision: 'required', reason: value('productReferenceReason') },
      { assetType: 'scene_multiview', decision: 'skipped', reason: '本次为单镜产品证据，不需要多机位空间基准。' },
      { assetType: 'storyboard', decision: 'skipped', reason: '本次只有一个完整镜头，镜头合同已覆盖构图、动作终点与注意力顺序。' },
      { assetType: 'character_board', decision: 'skipped', reason: '本次 Gate 1 已锁定为 subject_only，不制作人物身份资产。' }
    ],
    assetScope: {
      requiredBeforeGate3: lightweightReplication
        ? ['depth_video_reference', 'initial_blocking', 'product_reference']
        : ['product_reference']
    }
  };
}

async function latestLockedCreativeBrief(root, state) {
  const artifact = state.artifacts
    .filter(item => item.type === 'creative_brief' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  if (!artifact) return null;
  const value = await readJson(safeFile(root, artifact.path));
  return { artifact, value };
}

async function latestPendingCreativeBrief(root, state) {
  const artifact = state.artifacts
    .filter(item => item.type === 'creative_brief' && ['draft', 'rework', 'awaiting_review'].includes(item.status))
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  if (!artifact) return null;
  const value = await readJson(safeFile(root, artifact.path));
  return { artifact, value };
}

function creativeSummary(creative) {
  if (!creative) return null;
  const contract = creative.value?.creativeDecision?.directorCreativeContract;
  return {
    id: creative.artifact.id,
    revision: creative.artifact.revision,
    targetDurationSec: creative.value?.targetDurationSec ?? null,
    logline: contract?.recommendedDirection?.logline ?? null,
    purpose: contract?.projectIntent?.purpose ?? null,
    audience: contract?.projectIntent?.audience ?? null,
    productDramaticFunction: contract?.projectIntent?.productDramaticFunction ?? null,
    structureMode: contract?.structureMode ?? null,
    characterMode: contract?.characterMode ?? null,
    storyDirection: creative.value?.creativeDecision?.storyDirection ?? null,
    successDefinition: creative.value?.creativeDecision?.successDefinition ?? null,
    reviewHighlights: Array.isArray(contract?.storyOutline) ? contract.storyOutline.slice(0, 3) : []
  };
}

function compactGate2Eligibility(state, creative) {
  if (!creative) return { supported: false, reason: '先锁定 Gate 1 创意母版。' };
  const summary = creativeSummary(creative);
  const lightweightReplication = isAssetAnchoredReferenceWorkflow(
    creative.value?.creativeDecision?.referenceWorkflow,
    creative.value?.creativeDecision
  );
  const simpleRemake = workflowProfileIdOf(state) === 'simple_remake';
  if (simpleRemake) {
    return {
      supported: true,
      mode: 'simple_remake',
      reason: '简单复刻路线由系统自动整理原片并生成故事与镜头草稿，不要求手写原片事实。'
    };
  }
  if (lightweightReplication) {
    if (!Number.isFinite(summary.targetDurationSec) || summary.targetDurationSec > 15) {
      return { supported: false, reason: '资产锚定复刻的紧凑编辑器只支持 15 秒以内单段；长片请使用多段规划器或改走简单复刻路线。' };
    }
    return {
      supported: true,
      mode: 'asset_anchored',
      reason: '深度视频、首帧和产品图三项核心资产由系统统一编排，不要求手写原片事实。'
    };
  }
  if (state.routeDecision?.referenceRoleStatus === 'authority') {
    return { supported: false, reason: '原片事实权威项目必须先完成源事实分析与完整 Gate 2 规划。' };
  }
  if (summary.structureMode !== 'product_demo' || summary.characterMode !== 'subject_only') {
    return { supported: false, reason: '当前紧凑编辑器只支持无人物身份资产的产品演示；角色或复杂叙事应使用完整规划器。' };
  }
  if (!Number.isFinite(summary.targetDurationSec) || summary.targetDurationSec > 15) {
    return { supported: false, reason: '当前紧凑编辑器只支持 15 秒以内的单段生成单元；长片应使用多段规划器。' };
  }
  return { supported: true, reason: '可使用单段、单镜的产品证据编辑器。' };
}

function artifactSummary(artifact) {
  return {
    id: artifact.id,
    type: artifact.type,
    status: artifact.status,
    segmentId: artifact.segmentId ?? null,
    revision: artifact.revision,
    path: artifact.path,
    sha256: artifact.sha256 ?? null,
    lockedByReviewId: artifact.lockedByReviewId ?? null,
    invalidatedByScopeRevisionId: artifact.invalidatedByScopeRevisionId ?? null,
    assetType: artifact.assetType ?? null,
    mediaKind: artifact.mediaKind ?? null,
    segmentationId: artifact.segmentationId ?? null,
    segmentationSha256: artifact.segmentationSha256 ?? null,
    ownerScope: artifact.ownerScope ?? null,
    characterId: artifact.characterId ?? null,
    supersedesArtifactId: artifact.supersedesArtifactId ?? null,
    runId: artifact.runId ?? artifact.videoRunId ?? null
  };
}

async function sourceStoryboardSummary(project) {
  const manifestPath = join(project.root, 'planning', 'source-storyboard-r10', 'storyboard-manifest.json');
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (manifest?.version !== 'r10' || !Array.isArray(manifest.panels) || manifest.panels.length === 0) return null;
  const panels = manifest.panels.map(panel => {
    const sourceFile = String(panel?.sourceFile ?? '');
    if (!/^source-panels\/P\d{2}-\d+_\d+\.jpg$/.test(sourceFile)) {
      throw new Error('source storyboard contains an unsafe panel path');
    }
    return {
      id: requiredText(panel.id, 'storyboard panel id', 16),
      range: requiredText(panel.range, 'storyboard panel range', 40),
      shot: requiredText(panel.shot, 'storyboard panel shot', 40),
      title: requiredText(panel.title, 'storyboard panel title', 100),
      action: requiredText(panel.action, 'storyboard panel action', 300),
      endpoint: requiredText(panel.endpoint, 'storyboard panel endpoint', 300),
      sourceFile: basename(sourceFile)
    };
  });
  const templateBoards = [
    {
      title: '第一段：画线、受力与同位复检',
      range: '0.0–15.0 秒',
      panelCount: 12,
      filename: '第一段逐格线稿-十二格.png',
      sourceDir: 'source-storyboard-r13-real-source'
    },
    {
      title: '第二段：球拍测试、下围复检与坐姿测试',
      range: '15.0–31.0 秒',
      panelCount: 12,
      filename: '第二段逐格线稿-十二格.png',
      sourceDir: 'source-storyboard-r13-real-source'
    }
  ];
  return {
    version: manifest.version,
    lockedDurationSeconds: manifest.lockedDurationSeconds,
    renderStatus: 'source_and_lineart_ready',
    purpose: '原片真实分镜与逐格转换的黑白线稿均已完成。线稿只改变表现媒介，保留原片的动作、切镜、标线与物体关系。',
    panels,
    templateBoards,
    templateReviewStatus: '逐格线稿已复核'
  };
}

async function readJsonDirectory(root, directory) {
  const path = safeFile(root, directory);
  const entries = await readdir(path, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const values = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('._')) continue;
    try { values.push(await readJson(join(path, entry.name))); } catch { /* malformed evidence is represented by project health elsewhere */ }
  }
  return values;
}

function runSummary(run) {
  return {
    id: run.id ?? null,
    kind: run.kind ?? null,
    status: run.status ?? null,
    segmentId: run.segmentId ?? null,
    model: run.model ?? run.fingerprint?.generationContract?.request?.model ?? null,
    projectUuid: run.projectUuid ?? run.fingerprint?.generationContract?.projectUuid ?? null,
    nodeName: run.nodeName ?? null,
    nodeKey: run.nodeKey ?? null,
    taskId: run.taskId ?? null,
    artifactId: run.artifactId ?? null,
    costUsd: run.costEvidence?.amountUsd ?? null,
    outputCount: Array.isArray(run.outputs) ? run.outputs.length : 0,
    sceneWarnings: Array.isArray(run.sceneCheck?.warnings) && run.sceneCheck.warnings.length > 0 ? run.sceneCheck.warnings : null,
    sceneCheck: run.sceneCheck ? { promptScenes: run.sceneCheck.promptScenes ?? [], mediaDeclarations: run.sceneCheck.mediaDeclarations ?? [] } : null,
    prepVerification: run.verification ? 'PASS' : (Array.isArray(run.verificationDiffs) && run.verificationDiffs.length > 0 ? 'FAIL' : null),
    verificationDiffs: run.verificationDiffs ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null
  };
}

function reviewSummary(review, artifactIds = null) {
  return {
    id: review.id ?? null,
    artifactId: review.artifactId ?? null,
    artifactAvailable: artifactIds ? artifactIds.has(review.artifactId) : true,
    decision: review.decision ?? null,
    actor: review.actor ?? null,
    note: review.note ?? null,
    correction: review.correction ?? null,
    createdAt: review.createdAt ?? review.reviewedAt ?? null
  };
}

function segmentSummary(segment) {
  return {
    id: segment.id,
    status: segment.status ?? null,
    duration: segment.duration ?? null,
    startSec: segment.startSec ?? null,
    endSec: segment.endSec ?? null,
    continuityStrategy: segment.continuityStrategy ?? null,
    previousSegmentId: segment.previousSegmentId ?? null,
    nextSegmentId: segment.nextSegmentId ?? null,
    lockedByReviewId: segment.lockedByReviewId ?? null,
    projectAssetIds: segment.projectAssetIds ?? [],
    segmentAssetRequirements: segment.segmentAssetRequirements ?? []
  };
}

function safeUploadId(value) {
  const id = requiredText(value, 'artifactId', 192);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw badRequest('artifactId contains unsupported characters');
  return id;
}

function safeSegmentId(value) {
  const id = requiredText(value, 'segmentId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw badRequest('segmentId contains unsupported characters');
  return id;
}

function uploadDescriptor(state, search, extension, relativePath) {
  const type = search.get('artifactType');
  if (!uploadableTypes.has(type)) throw badRequest('artifactType is not uploadable');
  const id = safeUploadId(search.get('artifactId'));
  const revision = Math.max(0, ...state.artifacts.filter(item => item.type === type).map(item => item.revision)) + 1;
  const mediaKind = search.get('mediaKind') || (mediaTypes[extension]?.startsWith('video/') ? 'video' : mediaTypes[extension]?.startsWith('audio/') ? 'audio' : 'image');
  const descriptor = { id, type, revision, status: 'draft', path: relativePath, mediaKind };
  const assetType = search.get('assetType');
  const segmentId = search.get('segmentId');
  const characterId = search.get('characterId');
  const supersedesArtifactId = search.get('supersedesArtifactId');
  if (assetType) descriptor.assetType = requiredText(assetType, 'assetType', 192);
  if (segmentId) descriptor.segmentId = safeSegmentId(segmentId);
  if (characterId) descriptor.characterId = requiredText(characterId, 'characterId', 192);
  if (supersedesArtifactId) descriptor.supersedesArtifactId = requiredText(supersedesArtifactId, 'supersedesArtifactId', 192);
  if (type === 'segment_asset' || type === 'video_segment') {
    if (!descriptor.segmentId) throw badRequest(`${type} requires segmentId`);
  }
  const lockedSegmentation = type === 'segment_asset'
    ? state.artifacts.filter(item => item.type === 'segmentation' && item.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0]
    : null;
  if (type === 'segment_asset' && descriptor.segmentId && lockedSegmentation?.id && lockedSegmentation?.sha256) {
    // Every newly uploaded segment input belongs to the currently locked
    // segmentation. This prevents a valid user upload from being silently
    // ignored as if it were a stale asset from a prior cut of the project.
    descriptor.segmentationId = lockedSegmentation.id;
    descriptor.segmentationSha256 = lockedSegmentation.sha256;
  }
  if (['project_asset', 'segment_asset'].includes(type) && !descriptor.assetType) throw badRequest(`${type} requires assetType`);
  if (search.get('simpleRemakeIdentityReference') === 'true') {
    if (type !== 'segment_asset' || descriptor.assetType !== 'expression_board' || mediaKind !== 'image') {
      throw badRequest('simpleRemakeIdentityReference must be an image expression_board for the current segment');
    }
    descriptor.simpleRemakeIdentityReference = true;
  }
  if (descriptor.assetType === 'character_board') {
    if (!descriptor.characterId) throw badRequest('character_board requires characterId');
    descriptor.visualContractVersion = 1;
  }
  if (['project_asset', 'segment_asset'].includes(type) && mediaKind === 'image') {
    descriptor.visualAuditId = `${id}-visual-audit-r${revision}`;
  }
  if (type === 'final_edit') {
    const sourceVideoArtifactIds = String(search.get('sourceVideoArtifactIds') ?? '').split(',').map(item => item.trim()).filter(Boolean);
    if (sourceVideoArtifactIds.length < 2 || new Set(sourceVideoArtifactIds).size !== sourceVideoArtifactIds.length) {
      throw badRequest('final_edit requires at least two unique sourceVideoArtifactIds');
    }
    descriptor.sourceVideoArtifactIds = sourceVideoArtifactIds;
    descriptor.editContract = {
      pictureLock: search.get('pictureLock') === 'true',
      soundMix: search.get('soundMix') === 'true',
      colorContinuity: search.get('colorContinuity') === 'true',
      continuityReview: search.get('continuityReview') === 'true'
    };
    if (Object.values(descriptor.editContract).some(value => value !== true)) {
      throw badRequest('final_edit requires every edit contract confirmation');
    }
  }
  return descriptor;
}

function uploadLimitFor(extension) {
  const type = mediaTypes[extension];
  if (type?.startsWith('image/')) return maxImageBytes;
  if (type?.startsWith('audio/')) return maxAudioBytes;
  return maxUploadBytes;
}

function uploadLimiter(limit) {
  let received = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > limit) {
        const error = new Error(`upload exceeds ${limit} bytes`);
        error.statusCode = 413;
        return callback(error);
      }
      callback(null, chunk);
    }
  });
}

async function validateMediaFile(file, expectedKind, extension = extname(file).toLowerCase()) {
  const result = await runProcess(mediaProbeExecutable, [
    '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name,codec_type,width,height,duration', '-of', 'json', file
  ], { cwd: repositoryRoot });
  if (result.code !== 0) throw httpError(422, 'uploaded file is not a decodable supported media file');
  let probe;
  try { probe = JSON.parse(result.stdout); } catch { throw httpError(422, 'media probe returned invalid evidence'); }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const formats = String(probe.format?.format_name ?? '').split(',');
  const requiredCodecType = expectedKind === 'image' ? 'video' : expectedKind;
  if (!streams.some(stream => stream.codec_type === requiredCodecType)) {
    throw httpError(422, `uploaded file does not contain a valid ${expectedKind} stream`);
  }
  if (expectedKind === 'image' && !streams.some(stream => Number(stream.width) > 0 && Number(stream.height) > 0)) {
    throw httpError(422, 'uploaded image has no decodable dimensions');
  }
  const imageCodec = { '.png': 'png', '.jpg': 'mjpeg', '.jpeg': 'mjpeg', '.webp': 'webp' }[extension];
  const compatible = imageCodec ? streams.some(stream => stream.codec_name === imageCodec)
    : extension === '.mp3' ? formats.includes('mp3')
      : extension === '.wav' ? formats.includes('wav')
        : extension === '.webm' ? formats.some(format => ['webm', 'matroska'].includes(format))
    : ['.mp4', '.mov'].includes(extension) ? formats.some(format => ['mov', 'mp4'].includes(format)) : false;
  if (!compatible) throw httpError(422, 'media bytes do not match the declared file extension');
  return probe;
}

function probeFrameRate(value) {
  if (typeof value !== 'string' || !value.includes('/')) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}

// D 项内容层：从成片抽三张代表画面拼成一张总览图（与外部审查代理同一确定性做法），
// 按 artifact id + sha 缓存；仅供人眼观察，内容是否通过仍以 Gate 5 人审为准。
async function acceptanceFrameStrip(root, artifact) {
  const cacheDir = safeFile(root, 'outputs/.acceptance-frames');
  const fileName = `${artifact.id.replace(/[^A-Za-z0-9._-]/g, '_')}-${artifact.sha256.slice(0, 8)}.jpg`;
  const cachePath = join(cacheDir, fileName);
  const cached = await access(cachePath).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (!cached) {
    const sourcePath = safeFile(root, artifact.path);
    await mkdir(cacheDir, { recursive: true });
    const result = await runProcess('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', sourcePath,
      '-vf', 'fps=1/4,scale=320:-2,tile=3x1:padding=6:margin=6:color=white', '-frames:v', '1', cachePath
    ], { cwd: repositoryRoot });
    if (result.code !== 0) return null;
  }
  const bytes = await readFile(cachePath);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

// D 项：分层验收证据。任务状态 SUCCESS 只代表平台任务完成，不等于验收通过；
// 把验收拆成三层展示——规格层（ffprobe 实测）、绑定层（画布读回快照）、
// 内容层（抽帧，供人眼判断）。
async function videoAcceptanceEvidence(project, artifact) {
  const evidence = { spec: null, binding: null, contentFrameStrip: null };
  try {
    const probe = await validateMediaFile(safeFile(project.root, artifact.path), 'video');
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStream = streams.find(stream => stream.codec_type === 'video') ?? null;
    const audioStream = streams.find(stream => stream.codec_type === 'audio') ?? null;
    const durationSec = Number(probe.format?.duration ?? videoStream?.duration);
    evidence.spec = {
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      durationSec: Number.isFinite(durationSec) ? Math.round(durationSec * 100) / 100 : null,
      frameRate: probeFrameRate(videoStream?.avg_frame_rate),
      videoCodec: videoStream?.codec_name ?? null,
      hasAudio: Boolean(audioStream),
      audioCodec: audioStream?.codec_name ?? null
    };
  } catch (error) {
    evidence.spec = { error: error.message };
  }
  if (artifact.videoRunId) {
    const run = await readJson(join(project.root, 'runs', `${artifact.videoRunId}.json`)).catch(() => null);
    evidence.binding = run?.bindingSnapshot ?? null;
  }
  evidence.contentFrameStrip = await acceptanceFrameStrip(project.root, artifact).catch(() => null);
  return evidence;
}

async function readRequestBody(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxJsonBytes) throw httpError(413, `request body exceeds ${maxJsonBytes} bytes`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('request body must be JSON');
  }
}

async function currentSegments(root, state) {
  if (Array.isArray(state.segments) && state.segments.length > 0) return state.segments;
  const artifact = state.artifacts
    .filter(item => item.type === 'segmentation' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  if (!artifact) return [];
  const value = await readJson(safeFile(root, artifact.path));
  return Array.isArray(value) ? value : Array.isArray(value?.segments) ? value.segments : [];
}

async function latestLockedStoryPlan(root, state) {
  const artifact = state.artifacts
    .filter(item => item.type === 'story_plan' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  if (!artifact) return null;
  return { artifact, value: await readJson(safeFile(root, artifact.path)) };
}

async function automaticSimpleRemakeNarration(root, state, segmentId) {
  if (workflowProfileIdOf(state) !== 'simple_remake') throw httpError(409, '只有简单复刻路线可以自动整理讲戏本。');
  const story = await latestLockedStoryPlan(root, state);
  const capabilityArtifact = state.artifacts.find(item => item.id === state.verifiedCapabilityManifestId && item.type === 'capability_manifest' && item.status === 'locked');
  if (!story || !capabilityArtifact) throw httpError(409, '自动整理讲戏本需要已锁定的故事与导演能力清单。');
  const capability = await readJson(safeFile(root, capabilityArtifact.path));
  const plannedShots = (story.value?.shotPlanning?.shots ?? []).filter(shot => shot.segmentId === segmentId);
  const routedShots = (capability.shots ?? []).filter(shot => shot.segmentId === segmentId);
  if (plannedShots.length === 0 || routedShots.length !== plannedShots.length) throw httpError(409, '当前段落的镜头与导演能力清单无法一一对应，暂不能自动整理讲戏本。');
  const routesByShotId = new Map(routedShots.map(shot => [shot.shotId, shot]));
  const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'shot_narration' && item.segmentId === segmentId).map(item => item.revision)) + 1;
  return {
    id: `narration-${segmentId}-auto-r${revision}`, segmentId, sourceSegmentId: segmentId, revision, status: 'draft',
    capabilityManifestId: capabilityArtifact.id, capabilityManifestSha256: capabilityArtifact.sha256,
    shots: plannedShots.map(shot => {
      const route = routesByShotId.get(shot.shotId);
      if (!route) throw httpError(409, '当前段落的镜头与导演能力清单无法一一对应，暂不能自动整理讲戏本。');
      const characterIds = route.characterIds ?? [];
      const focusedCharacter = characterIds[0] ?? '画面主体';
      const narration = {
        shotId: shot.shotId, physicalActions: [shot.subjectAction],
        cameraMove: shot.directorIntent?.intentCarriers?.find(item => item.channel === 'camera')?.instruction ?? shot.shotContract,
        lightSources: ['保持原片中已经可见的主光方向、明暗关系和背景光向，不新增光源。'],
        emotionThroughAction: '人物按深度视频完成原有动作，保留自然呼吸、短暂停顿和未完全做满的动作收束，不额外补写表演。',
        skillsApplied: route.requiredSkillIds
      };
      if (route.capabilities?.some(item => item.id === 'character-performance-v1')) {
        narration.realismPlan = {
          focusedCharacter, motivatedAction: shot.subjectAction, physicalEndpoint: shot.endState,
          naturalVariation: '动作节奏、停顿与轻微不对称以深度视频的可见运动为准，不补写机械手势。',
          persistentMicroMotions: characterIds.filter(id => id !== focusedCharacter).map(id => ({ characterId: id, action: `${id}保持原片可见的自然呼吸和姿势微动，不新增动作。` })),
          forbiddenGenericActions: ['无动机挥手', '呆滞凝视', '标准笑容', '机械重复']
        };
      }
      return narration;
    })
  };
}

async function automaticSimpleRemakeSourcePrompt(root, state, segmentId) {
  if (workflowProfileIdOf(state) !== 'simple_remake') throw httpError(409, '只有简单复刻路线可以自动整理生成提示。');
  const narration = latestSegmentArtifact(state, 'shot_narration', segmentId);
  if (!narration || narration.status !== 'locked') throw httpError(409, '自动整理生成提示需要已锁定的讲戏本。');
  const narrationPayload = await readJson(safeFile(root, narration.path));
  const orderedActionInstruction = renderOrderedPhysicalActionInstruction(narrationPayload);
  const manifest = await readJson(join(root, 'assets', `${segmentId}-asset-manifest.json`)).catch(error => {
    if (error.code === 'ENOENT') throw httpError(409, '自动整理生成提示需要已锁定的资产清单。');
    throw error;
  });
  if (manifest?.status !== 'locked') throw httpError(409, '自动整理生成提示需要已锁定的资产清单。');
  if (state.remakeControlSelection?.selectedModes?.includes('koc_remake')) {
    throw httpError(409, 'KOC 复刻不得退化为产品替换或深度提示路线；请使用已通过准备屏障的 koc-remake-plan 和 KOC 专用 Skill。');
  }
  const product = manifest.items?.find(item => item.type === 'product_reference' && item.status === 'locked' && item.mediaKind === 'image');
  const firstFrame = manifest.items?.find(item => item.type === 'initial_blocking' && item.status === 'locked' && item.mediaKind === 'image');
  const depthVideo = manifest.items?.find(item => item.type === 'depth_video_reference' && item.status === 'locked' && item.mediaKind === 'video');
  const sourceAudio = manifest.items?.find(item => item.type === 'source_audio_candidate' && item.status === 'locked' && item.mediaKind === 'audio');
  if (!product) throw httpError(409, '自动整理生成提示需要已锁定的产品图。');
  const story = await latestLockedStoryPlan(root, state);
  const shot = story?.value?.shotPlanning?.shots?.find(item => item.segmentId === segmentId);
  if (!shot) throw httpError(409, '当前段落缺少已锁定的镜头计划，暂不能自动整理生成提示。');
  const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'seedance_prompt' && item.segmentId === segmentId).map(item => item.revision)) + 1;
  const nativeOnly = state.remakeControlSelection?.selectedModes?.length > 0
    && state.remakeControlSelection.selectedModes.every(mode => mode === 'native_source');
  if (nativeOnly) {
    const sourceVideo = state.artifacts.find(item => item.type === 'reference_video' && item.segmentId === segmentId
      && item.status === 'locked' && typeof item.invalidatedByScopeRevisionId !== 'string')
      ?? await ensureSimpleRemakeNativeSourceClip(root, state, segmentId);
    const durationSec = shot.endSec - shot.startSec;
    const promptText = [
      `竖屏 9:16，总时长 ${formatWindowSec(durationSec)} 秒。严格复刻原片当前时间窗，只做一项修改：把画面中原有手持产品替换成目标产品；不改剧情、人物、动作、台词、场景、构图、运镜、剪辑节奏和声音。`,
      `@素材[${sourceVideo.id}]是本段画面与声音的唯一事实权威，负责人物、服装、场景、构图、动作、遮挡、运镜、切镜、时序、台词、口型、环境声和原始节奏；不得迁移原产品的身份、结构、材质、颜色、纹理、标识或细节。`,
      `@素材[${product.id}]是替换后产品身份的唯一权威，只负责产品的轮廓、结构、比例、材质、颜色和可见细节；不得迁移白底、构图、光线、场景、人物、动作或镜头。`,
      '从开镜到结束逐帧沿用原片当前时间窗的可见动作与剪辑。仅当原产品在原片中出现时，在同一位置、同一尺度、同一朝向和同一遮挡关系中替换为目标产品；手与产品的接触、衣料受力、阴影、高光和运动模糊随原动作自然变化。原产品未出现的画面保持原样。',
      '开启生成声音并完整保留原片当前时间窗的台词、口型、停顿、环境声和节奏，不新增配乐、旁白、台词、音效或产品宣称。结尾保持原片该时间窗的真实末态。无新增字幕、文字、logo、水印或界面；禁止产品变形、结构漂移、颜色串染、手物穿插、遮挡闪烁、人物换脸、服装改变、背景重绘、动作重编或镜头重排。'
    ].join('\n');
    assertSeedanceSourcePromptReferences(promptText);
    return { id: `prompt-${segmentId}-auto-r${revision}`, revision, promptText, narration };
  }
  if (!firstFrame || !depthVideo || !sourceAudio) throw httpError(409, '深度复刻路线需要已锁定的深度视频、首帧画面、产品图与原片音频。');
  const promptText = [
    '竖屏画面，十五秒，一个连续镜头，真实、克制的产品演示。画面内不出现字幕、文字、标识或界面。',
    `@素材[${firstFrame.id}]只负责开场构图、人物位置、画面方向、相对尺度和已可见的光向；不得迁移人物身份、服装细节、产品外观或背景纹理。`,
    `@素材[${product.id}]只负责产品的结构、材质、颜色、比例和扣件细节；不得迁移人物身份、服装、场景、机位或动作。`,
    `@素材[${depthVideo.id}]只负责连续动作、相机路径、主体尺度、遮挡和动作节奏；不得迁移人物身份、服装外观、产品外观、背景纹理、台词或声音。`,
    `@素材[${sourceAudio.id}]只负责原始台词、声线、停顿、环境声、口型时钟和最终音轨；不得改变画面、人物身份、服装、产品、场景、镜头或动作。`,
    '开镜严格保持首帧中实际可见的人物、空间、构图、画面方向和光向。产品不被假定在首帧中出现：只在深度视频所对应的动作阶段，以产品图锁定的结构替换原片中应出现的产品位置。产品可见后保持清晰可辨，人物与背景的遮挡、尺度和画面方向连续不跳变。',
    orderedActionInstruction,
    '摄影机保持开场的观看位置与景别，只沿着动作做一次平稳、连续的跟随，不切镜、不重新构图、不增加额外人物动作。已有光源方向和明暗关系保持稳定，产品表面的高光、阴影与材质纹理随镜头和动作自然变化。',
    '动作结束时，产品结构、颜色和比例清晰稳定，人物、产品与背景仍维持同一空间方向。原片音频是口型与动作节拍的唯一时钟；模型不生成新的配乐、音效或人声，最终保留原视频音频。保持自然呼吸、短暂停顿和动作惯性，不出现机械重复、无动机挥手、夸张表情、产品变形、结构漂移、遮挡闪烁或画面重排。'
  ].join('\n');
  assertSeedanceSourcePromptReferences(promptText);
  return {
    id: `prompt-${segmentId}-auto-r${revision}`,
    revision,
    promptText,
    narration
  };
}

function simpleRemakeStoryNeedsRepair(story) {
  const text = JSON.stringify(story ?? {});
  const visibleCharacters = story?.shotPlanning?.shots?.flatMap(shot => shot.visibleCharacterIds ?? []) ?? [];
  return text.includes('首帧中的人物、产品位置、画面方向和光向均已建立')
    || text.includes('首帧中的主体与产品关系')
    || text.includes('首帧建立人物、空间与产品关系')
    || new Set(visibleCharacters).size > 1
    || (Array.isArray(story?.characters) && story.characters.length > 1)
    || (story?.sourceFidelityDecision !== undefined
      && story.sourceFidelityDecision?.decision !== '单人执行收敛');
}

function simpleRemakePromptNeedsRepair(promptText) {
  return promptText.includes('开镜立即建立与首帧相同的人物、产品和空间关系');
}

async function refreshSimpleRemakePlanning(root, state, segmentId) {
  if (workflowProfileIdOf(state) !== 'simple_remake') return state;
  const story = await latestLockedStoryPlan(root, state);
  if (story && simpleRemakeStoryNeedsRepair(story.value)) {
    const creative = await latestLockedCreativeBrief(root, state);
    if (!creative) throw httpError(409, '自动修正需要已锁定的导演创意。');
    const repairInput = {
      autoGenerate: true,
      selectedModes: state.remakeControlSelection?.selectedModes ?? ['native_source']
    };
    const repairDuration = creative.value?.targetDurationSec;
    if (Number.isFinite(repairDuration) && repairDuration > SIMPLE_REMAKE_UNIT_SEC) {
      repairInput.roughStoryboardPreviewPath = await ensureSimpleRemakeRoughPreview(
        root, state, Math.ceil(repairDuration / SIMPLE_REMAKE_UNIT_SEC)
      );
    }
    const refreshedPlan = compactStoryPlan(state.projectId, creative.artifact, creative.value, repairInput, 'simple_remake');
    await createStoryPlan(root, refreshedPlan);
    await machineApproveDelegatedStoryPlan(root, '简单复刻路线：系统已修正首帧仅约束实际可见内容，并重新完成故事与镜头机审。');
    state = await readJson(join(root, 'project-state.json'));
  }

  const capability = state.artifacts.find(item => item.id === state.verifiedCapabilityManifestId
    && item.type === 'capability_manifest' && item.status === 'locked');
  const narration = latestSegmentArtifact(state, 'shot_narration', segmentId);
  if (!capability) throw httpError(409, '自动修正需要已锁定的导演能力清单。');
  if (!narration || narration.status !== 'locked'
    || narration.capabilityManifestId !== capability.id
    || narration.capabilityManifestSha256 !== capability.sha256) {
    const refreshedNarration = await automaticSimpleRemakeNarration(root, state, segmentId);
    const path = `prompts/${segmentId}/${refreshedNarration.id}.json`;
    await writeJsonAtomic(join(root, path), refreshedNarration);
    const artifact = await registerArtifact(root, {
      id: refreshedNarration.id, type: 'shot_narration', revision: refreshedNarration.revision,
      status: 'draft', path, segmentId,
      capabilityManifestId: refreshedNarration.capabilityManifestId,
      capabilityManifestSha256: refreshedNarration.capabilityManifestSha256
    });
    await autoLockArtifact(root, artifact.id,
      'auto-locked: simple-remake narration was refreshed after the corrected first-frame contract and passed capability binding checks');
    state = await readJson(join(root, 'project-state.json'));
  }
  return state;
}

async function ensureSimpleRemakeDepthPrompt(root, state, segmentId) {
  const current = latestSegmentArtifact(state, 'seedance_prompt', segmentId);
  const narration = latestSegmentArtifact(state, 'shot_narration', segmentId);
  const manifest = await readJson(join(root, 'assets', `${segmentId}-asset-manifest.json`));
  if (state.remakeControlSelection?.selectedModes?.includes('koc_remake')) {
    throw httpError(409, 'KOC 复刻不得由深度提示修复器接管；请按 KOC 并行计划整理当前段提示词。');
  }
  const nativeOnly = state.remakeControlSelection?.selectedModes?.length > 0
    && state.remakeControlSelection.selectedModes.every(mode => mode === 'native_source');
  if (nativeOnly) {
    const source = state.artifacts.find(item => item.type === 'reference_video' && item.segmentId === segmentId
      && item.status === 'locked' && typeof item.invalidatedByScopeRevisionId !== 'string')
      ?? await ensureSimpleRemakeNativeSourceClip(root, state, segmentId);
    if (current?.status === 'locked') {
      const text = await readFile(safeFile(root, current.path), 'utf8');
      if (text.includes(`@素材[${source.id}]`) && current.narrationSourceId === narration?.id
        && current.narrationSha256 === narration?.sha256) return current;
      if (!current.id.startsWith(`prompt-${segmentId}-auto-`)) {
        throw httpError(409, '当前生成提示尚未绑定本段原片窗口；请先在网页重新整理生成提示。');
      }
    }
    const refreshedState = await readJson(join(root, 'project-state.json'));
    const generated = await automaticSimpleRemakeSourcePrompt(root, refreshedState, segmentId);
    const path = `prompts/${segmentId}/${generated.id}.txt`;
    await writeTextAtomic(join(root, path), `${generated.promptText.trim()}\n`);
    const artifact = await registerArtifact(root, {
      id: generated.id, type: 'seedance_prompt', revision: generated.revision, status: 'draft', path, segmentId,
      narrationSourceId: generated.narration.id, narrationSha256: generated.narration.sha256,
      promptSkill: 'seedance2-prompt-skill',
      promptSelfAudit: {
        arrangement: 'PASS', semantics: 'PASS',
        revisionNote: '系统按 Seedance 2.0 原生替换路线绑定当前 15 秒原片窗口与产品图；原片负责动态和原声，产品图只负责产品身份。'
      }
    });
    await autoLockArtifact(root, artifact.id,
      'auto-locked: native-source simple-remake prompt bound the exact source window and product reference and passed zero-context source reference lint');
    return artifact;
  }
  const depthId = manifest.items?.find(item => item.type === 'depth_video_reference' && item.status === 'locked' && item.mediaKind === 'video')?.id;
  if (!depthId) throw httpError(409, '当前段落缺少已锁定的深度视频，不能整理生成包。');
  if (current?.status === 'locked') {
    const source = await readFile(safeFile(root, current.path), 'utf8');
    if (source.includes(`@素材[${depthId}]`) && !simpleRemakePromptNeedsRepair(source)
      && current.narrationSourceId === narration?.id && current.narrationSha256 === narration?.sha256) return current;
    if (!current.id.startsWith(`prompt-${segmentId}-auto-`)) {
      throw httpError(409, '当前生成提示尚未包含深度视频控制；请先在网页重新整理生成提示。');
    }
  }
  const generated = await automaticSimpleRemakeSourcePrompt(root, state, segmentId);
  const path = `prompts/${segmentId}/${generated.id}.txt`;
  await writeTextAtomic(join(root, path), `${generated.promptText.trim()}\n`);
  const artifact = await registerArtifact(root, {
    id: generated.id, type: 'seedance_prompt', revision: generated.revision, status: 'draft', path, segmentId,
    narrationSourceId: generated.narration.id, narrationSha256: generated.narration.sha256,
    promptSkill: 'seedance2-prompt-skill',
    promptSelfAudit: {
      arrangement: 'PASS', semantics: 'PASS',
      revisionNote: '系统已将已完成的深度视频加入动作与镜头控制，同时保持首帧与产品图各自的独立职责。'
    }
  });
  await autoLockArtifact(root, artifact.id,
    'auto-locked: simple-remake prompt was refreshed with the locked depth-video control and passed zero-context source reference lint');
  return artifact;
}

function commandValue(args, flag) {
  const index = Array.isArray(args) ? args.indexOf(flag) : -1;
  return index >= 0 ? args[index + 1] : undefined;
}

function assertPreparedCanvasNode(node, preparation) {
  if (node?.nodeKey !== preparation.nodeKey || node?.data?.type !== 'video' || node?.name !== preparation.nodeName) {
    throw httpError(409, 'LibTV node identity no longer matches the prepared canvas evidence');
  }
  const createCommand = (preparation.commands ?? []).find(command => Array.isArray(command.args) && command.args[0] === 'node' && command.args.includes('create'));
  let expectedPrompt = commandValue(createCommand?.args, '--prompt');
  const params = node.data.params ?? {};
  for (const source of params.mixedList ?? []) {
    if (typeof source?.label === 'string' && typeof source?.nodeId === 'string') {
      expectedPrompt = expectedPrompt?.split(`{{Node "${source.label}"}}`).join(`{{Node ${source.nodeId}}}`);
    }
  }
  const contract = preparation.fingerprint?.generationContract;
  const request = contract?.request ?? {};
  const actualSound = params.settings?.enableSound;
  const expectedSound = request.enableSound === false ? 'off' : 'on';
  if (!createCommand || params.prompt !== expectedPrompt || params.model !== contract?.model || params.modeType !== contract?.modeType
    || Number(params.count) !== Number(request.count) || params.settings?.ratio !== request.ratio
    || Number(params.settings?.duration) !== Number(request.duration)
    || (request.resolution !== undefined && params.settings?.resolution !== request.resolution)
    || actualSound !== expectedSound) {
    throw httpError(409, 'LibTV node settings changed after Gate 4 preparation; prepare a fresh exact canvas node');
  }
  const task = node.data.taskInfo;
  if (task?.loading !== false || ![2, 'SUCCESS'].includes(task?.status) || typeof task?.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(task.taskId)) {
    throw httpError(409, 'LibTV node has no confirmed successful user-started generation to sync');
  }
  if (!Array.isArray(node.data.url) || node.data.url.length !== 1 || typeof node.data.url[0] !== 'string') {
    throw httpError(409, 'LibTV node success must expose exactly one video output');
  }
  return task;
}

// 绑定层快照：同步用户画布生成结果时，把读回校验通过的节点真实绑定状态
// （模型/设置/mixedList 媒体清单）留存到运行记录，供分层验收证据展示。
// 快照只包含展示所需字段，不含提示词全文。
function bindingSnapshotFromNode(node) {
  const params = node?.data?.params ?? {};
  const value = key => params?.settings?.[key] ?? params?.[key] ?? null;
  return {
    capturedAt: new Date().toISOString(),
    model: params.model ?? null,
    modeType: params.modeType ?? null,
    settings: {
      ratio: value('ratio'),
      resolution: value('resolution'),
      duration: value('duration'),
      enableSound: value('enableSound')
    },
    mixedList: (Array.isArray(params.mixedList) ? params.mixedList : []).map(item => ({
      label: item?.label ?? null,
      mediaType: item?.mediaType ?? null,
      nodeId: item?.nodeId ?? null,
      durationSec: item?.durationSec ?? null,
      width: item?.width ?? null,
      height: item?.height ?? null
    }))
  };
}

function sameCanvasResult(left, right) {
  return left?.data?.taskInfo?.taskId === right?.data?.taskInfo?.taskId
    && isDeepStrictEqual(left?.data?.url, right?.data?.url)
    && isDeepStrictEqual(left?.data?.params, right?.data?.params);
}

async function requireIndependentReviewRun(root, evidenceRunId, expected) {
  let run;
  if (typeof evidenceRunId === 'string' && evidenceRunId.trim()) {
    const rawId = requiredText(evidenceRunId, 'evidenceRunId', 192);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(rawId)) throw badRequest('evidenceRunId contains unsupported characters');
    run = await readJson(join(root, 'runs', `${rawId}.json`)).catch(error => {
      if (error.code === 'ENOENT') throw httpError(409, 'independent review provenance run was not found');
      throw error;
    });
  } else {
    const matches = (await readJsonDirectory(root, 'runs')).filter(candidate => candidate.kind === 'independent_external_model_audit'
      && candidate.sessionId === expected.taskId && candidate.decision === expected.decision);
    if (matches.length !== 1) throw httpError(409, `需要从网页运行一次与当前输入精确绑定的外部独立审查；当前找到 ${matches.length} 条可验证记录`);
    [run] = matches;
  }
  if (run.kind !== 'independent_external_model_audit' || run.status !== 'SUCCESS'
    || !requiredText(run.provider, 'review provider', 192) || run.sessionId !== expected.taskId
    || run.decision !== expected.decision || !requiredText(run.approvalId, 'approvalId', 192)) {
    throw httpError(409, 'independent review run is not a successful isolated external audit');
  }
  const approval = assertExternalAuditOnlyApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(run.approvalId)}.json`)));
  if (approval.model !== run.model || approval.maxCalls !== 1 || approval.permissions.readOnly !== true
    || approval.permissions.automaticRetries !== false || approval.permissions.imageGeneration !== false
    || approval.permissions.videoGeneration !== false || approval.permissions.externalMessages !== false) {
    throw httpError(409, 'independent review approval does not preserve the one-call read-only boundary');
  }
  if (expected.kind === 'independent_creative_review') {
    const binding = approval.binding;
    if (run.reportSha256 !== expected.outputSha256 || binding.prompt.sha256 !== expected.inputs.promptSha256
      || binding.package.sha256 !== expected.inputs.packageSha256 || !isDeepStrictEqual(binding.inputMedia, expected.inputs.inputMedia)) {
      throw httpError(409, 'external creative review does not bind the current prompt, package, media, and report SHA');
    }
  } else if (expected.kind === 'independent_asset_review') {
    const boundImages = approval.binding.inputMedia.images;
    if (run.auditType !== 'asset_visual_audit' || !isDeepStrictEqual(run.assetBinding, expected.inputs)
      || run.machineOutputSha256 !== expected.outputSha256 || boundImages.length !== 1
      || boundImages[0].id !== expected.inputs.assetId || boundImages[0].sha256 !== expected.inputs.assetSha256) {
      throw httpError(409, 'external pixel review does not bind the current asset and audit output SHA');
    }
  } else {
    throw httpError(409, 'unsupported independent review evidence kind');
  }
  return run;
}

async function validateAssetAuditProvenance(root, state, item) {
  if (!item.visualAuditId) return true;
  const artifact = state.artifacts.find(candidate => candidate.id === item.visualAuditId
    && candidate.type === 'asset_visual_audit' && candidate.status === 'locked');
  if (!artifact) throw new Error(`${item.id} 缺少锁定的视觉审查产物 ${item.visualAuditId}`);
  await verifyLockedArtifact(root, artifact);
  const audit = await readJson(safeFile(root, artifact.path));
  if (audit.decision !== 'PASS' || audit.assetId !== item.id || audit.assetRevision !== item.revision
    || audit.assetSha256 !== item.sha256 || audit.blockerCount !== 0) {
    throw new Error(`${item.id} 的视觉审查未绑定当前资产版本与 SHA`);
  }
  const matchingRuns = (await readJsonDirectory(root, 'runs')).filter(run => run.kind === 'independent_external_model_audit'
    && run.auditType === 'asset_visual_audit' && run.status === 'SUCCESS'
    && run.decision === 'PASS' && isDeepStrictEqual(run.assetBinding, {
      assetId: item.id, assetType: audit.assetType, assetRevision: item.revision, assetSha256: item.sha256
    }));
  if (matchingRuns.length !== 1) throw new Error(`${item.id} 需要恰好一条当前资产输入指纹的外部像素审查，当前找到 ${matchingRuns.length} 条`);
  const evidenceRun = matchingRuns[0];
  const provenanceArtifact = state.artifacts.find(candidate => candidate.id === evidenceRun.artifactId
    && candidate.type === 'asset_visual_audit' && candidate.status === 'locked');
  if (!provenanceArtifact) throw new Error(`${item.id} 的外部像素审查尚未登记并锁定其本次机器结果`);
  await verifyLockedArtifact(root, provenanceArtifact);
  const provenanceAudit = await readJson(safeFile(root, provenanceArtifact.path));
  if (provenanceAudit.decision !== 'PASS' || provenanceAudit.assetId !== item.id || provenanceAudit.assetType !== audit.assetType
    || provenanceAudit.assetRevision !== item.revision || provenanceAudit.assetSha256 !== item.sha256
    || provenanceAudit.inspectorTaskId !== evidenceRun.sessionId || provenanceAudit.evidenceRunId !== evidenceRun.id) {
    throw new Error(`${item.id} 的外部像素审查机器结果与当前资产或 provider 任务不一致`);
  }
  await requireIndependentReviewRun(root, evidenceRun.id, {
    kind: 'independent_asset_review', taskId: evidenceRun.sessionId, decision: provenanceAudit.decision,
    inputs: { assetId: item.id, assetType: audit.assetType, assetRevision: item.revision, assetSha256: item.sha256 },
    outputSha256: provenanceArtifact.sha256
  });
  return true;
}

async function syncUserCanvasGeneration(project, input) {
  const preparationId = requiredText(input.preparationRunId, 'preparationRunId', 192);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(preparationId)) throw badRequest('preparationRunId must be a safe identifier');
  const preparation = await readJson(join(project.root, 'runs', `${preparationId}.json`)).catch(error => {
    if (error.code === 'ENOENT') throw httpError(404, 'canvas preparation run not found');
    throw error;
  });
  if (preparation.kind !== 'libtv_canvas_preparation' || preparation.status !== 'READY_FOR_USER_CANVAS_GENERATION'
    || preparation.paidGenerationTriggered !== false || !preparation.nodeKey) {
    throw httpError(409, 'run is not a completed non-generating LibTV canvas preparation');
  }
  const projectState = await readJson(join(project.root, 'project-state.json'));
  const allowMachineReviewedSimpleRemake = workflowProfileIdOf(projectState) === 'simple_remake'
    && preparation.fingerprint?.systemReview?.mode === 'simple_remake_system_review';
  const current = await inspectVideoPackage(project.root, preparation.segmentId, {
    executor: 'libtv', libtvProjectUuid: preparation.projectUuid, nodeName: preparation.nodeName, model: preparation.model,
    allowMachineReviewedSimpleRemake
  });
  if (current.fingerprint.sha256 !== preparation.fingerprint?.sha256) {
    throw httpError(409, 'local prompt, assets, package, or independent audit changed after canvas preparation');
  }
  const queryArgs = ['node', preparation.nodeKey, '-p', preparation.projectUuid];
  const queried = await runProcess('libtv', queryArgs, { cwd: project.root });
  if (queried.code !== 0) throw httpError(502, 'LibTV node query failed; confirm login and canvas access');
  let node;
  try { node = JSON.parse(queried.stdout.trim()); } catch { throw httpError(502, 'LibTV node query returned invalid JSON'); }
  const task = assertPreparedCanvasNode(node, preparation);
  const existingRuns = await readJsonDirectory(project.root, 'runs');
  const existing = existingRuns.find(run => run.kind === 'libtv_video' && run.status === 'SUCCESS'
    && run.taskId === task.taskId && run.nodeKey === preparation.nodeKey && run.fingerprint?.sha256 === current.fingerprint.sha256);
  if (existing) {
    const state = await readJson(join(project.root, 'project-state.json'));
    const output = Array.isArray(existing.outputs) && existing.outputs.length === 1 ? existing.outputs[0] : null;
    const artifact = output ? state.artifacts.find(item => item.type === 'video_segment' && item.videoRunId === existing.id
      && item.path === output.path && item.sha256 === output.sha256) : null;
    if (!artifact) throw httpError(409, 'existing SUCCESS run no longer has one matching registered video artifact');
    await verifyArtifactFile(project.root, artifact);
    await validateMediaFile(safeFile(project.root, artifact.path), 'video');
    return { reused: true, run: existing, artifact };
  }
  const recoverable = existingRuns.find(run => ['COMMITTING', 'RECOVERY_REQUIRED'].includes(run.status)
    && run.taskId === task.taskId && run.nodeKey === preparation.nodeKey && run.fingerprint?.sha256 === current.fingerprint.sha256);
  if (recoverable) {
    const state = await readJson(join(project.root, 'project-state.json'));
    const output = Array.isArray(recoverable.outputs) && recoverable.outputs.length === 1 ? recoverable.outputs[0] : null;
    const artifact = output ? state.artifacts.find(item => item.type === 'video_segment' && item.videoRunId === recoverable.id
      && item.path === output.path && item.sha256 === output.sha256) : null;
    if (artifact) {
      await verifyArtifactFile(project.root, artifact);
      await validateMediaFile(safeFile(project.root, artifact.path), 'video');
      const recovered = { ...recoverable, status: 'SUCCESS', recoveryCompletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeJsonAtomic(join(project.root, 'runs', `${recoverable.id}.json`), recovered);
      return { reused: true, recovered: true, run: recovered, artifact };
    }
    await writeJsonAtomic(join(project.root, 'runs', `${recoverable.id}.json`), {
      ...recoverable, status: 'ABANDONED', abandonedReason: 'process stopped before artifact registration', updatedAt: new Date().toISOString()
    });
  }
  if (input.validateOnly === true) {
    return {
      reused: false,
      validatedOnly: true,
      run: {
        id: null, kind: 'libtv_video', status: 'VALIDATED_USER_CANVAS_SUCCESS', segmentId: preparation.segmentId,
        model: preparation.model, nodeName: preparation.nodeName, taskId: task.taskId, outputs: [],
        bindingSnapshot: bindingSnapshotFromNode(node)
      }
    };
  }

  const artifactId = safeUploadId(input.artifactId ?? `${preparation.segmentId}-video-${task.taskId}`);
  const attemptId = `attempt-${randomUUID()}`;
  const runId = `libtv-user-canvas-${task.taskId}-${attemptId}`;
  const outputRoot = join(project.root, 'outputs', '.libtv-user-canvas-runs', runId, attemptId, preparation.segmentId);
  await mkdir(outputRoot, { recursive: true });
  const downloadArgs = ['download', '-p', preparation.projectUuid, '--node', preparation.nodeKey, '--out', outputRoot];
  const downloaded = await runProcess('libtv', downloadArgs, { cwd: project.root });
  if (downloaded.code !== 0) throw httpError(502, 'LibTV output download failed; no video was registered');
  const files = (await readdir(outputRoot, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('._'));
  if (files.length !== 1) throw httpError(422, 'LibTV sync requires exactly one downloaded video file');
  const outputPath = join(outputRoot, files[0].name);
  await validateMediaFile(outputPath, 'video');
  const queriedAfterDownload = await runProcess('libtv', queryArgs, { cwd: project.root });
  if (queriedAfterDownload.code !== 0) throw httpError(502, 'LibTV post-download node query failed; no video was registered');
  let nodeAfterDownload;
  try { nodeAfterDownload = JSON.parse(queriedAfterDownload.stdout.trim()); } catch { throw httpError(502, 'LibTV post-download node query returned invalid JSON'); }
  assertPreparedCanvasNode(nodeAfterDownload, preparation);
  if (!sameCanvasResult(node, nodeAfterDownload)) {
    throw httpError(409, 'LibTV task or output changed during download; retry sync against the stable current task');
  }
  const state = await readJson(join(project.root, 'project-state.json'));
  const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'video_segment').map(item => item.revision)) + 1;
  const relativePath = relative(project.root, outputPath).split(sep).join('/');
  const completedAt = new Date().toISOString();
  const outputSha256 = await sha256File(outputPath);
  const run = {
    id: runId, kind: 'libtv_video', tool: 'libtv', status: 'COMMITTING', segmentId: preparation.segmentId,
    projectUuid: preparation.projectUuid, nodeName: preparation.nodeName, nodeKey: preparation.nodeKey,
    taskId: task.taskId, fingerprint: current.fingerprint, paidApprovalId: null,
    executionMode: 'user_canvas_click', observedFromPreparationRunId: preparation.id,
    bindingSnapshot: bindingSnapshotFromNode(nodeAfterDownload),
    commands: [
      { executable: 'libtv', args: queryArgs, exitCode: queried.code },
      { executable: 'libtv', args: downloadArgs, exitCode: downloaded.code },
      { executable: 'libtv', args: queryArgs, exitCode: queriedAfterDownload.code, purpose: 'post_download_identity_check' }
    ],
    outputs: [{ path: relativePath, sha256: outputSha256 }],
    createdAt: completedAt, updatedAt: completedAt
  };
  await writeJsonAtomic(join(project.root, 'runs', `${runId}.json`), run);
  let artifact = null;
  try {
    artifact = await registerArtifact(project.root, {
      id: artifactId, type: 'video_segment', revision, status: 'draft', path: relativePath,
      mediaKind: 'video', segmentId: preparation.segmentId, videoRunId: runId
    });
    const succeeded = { ...run, status: 'SUCCESS', outputs: [{ path: artifact.path, sha256: artifact.sha256 }], completedAt, updatedAt: completedAt };
    await writeJsonAtomic(join(project.root, 'runs', `${runId}.json`), succeeded);
    return { reused: false, run: succeeded, artifact };
  } catch (error) {
    const failed = { ...run, status: artifact ? 'RECOVERY_REQUIRED' : 'COMMIT_FAILED',
      outputs: artifact ? [{ path: artifact.path, sha256: artifact.sha256 }] : run.outputs,
      failureCode: error?.code ?? 'SYNC_COMMIT_FAILED', updatedAt: new Date().toISOString() };
    await writeJsonAtomic(join(project.root, 'runs', `${runId}.json`), failed).catch(() => {});
    throw error;
  }
}

async function boundSuccessRun(root, video) {
  const runs = await readJsonDirectory(root, 'runs');
  const candidates = runs.filter(run => run.kind === 'libtv_video' && run.status === 'SUCCESS'
    && run.segmentId === video.segmentId && run.taskId && run.fingerprint?.sha256
    && run.outputs?.some(output => output.path === video.path && output.sha256 === video.sha256));
  const matches = [];
  for (const run of candidates) {
    const current = await inspectVideoPackage(root, video.segmentId, {
      executor: 'libtv', libtvProjectUuid: run.projectUuid ?? run.fingerprint?.generationContract?.projectUuid,
      nodeName: run.nodeName ?? run.fingerprint?.generationContract?.nodeName,
      model: run.model ?? run.fingerprint?.generationContract?.model
    });
    if (run.fingerprint.sha256 === current.fingerprint.sha256) matches.push(run);
  }
  if (matches.length !== 1) throw httpError(409, `Gate 5 requires exactly one fingerprint-bound SUCCESS LibTV run; found ${matches.length}`);
  await verifyArtifactFile(root, video);
  await validateMediaFile(safeFile(root, video.path), 'video');
  return matches[0];
}

async function validateSegmentUploadBinding(root, state, descriptor) {
  const segments = await currentSegments(root, state);
  if (!segments.some(segment => segment.id === descriptor.segmentId)) {
    throw httpError(409, 'segment asset must bind an existing canonical segment');
  }
}

async function validateFinalEditSources(root, state, descriptor) {
  const segments = await currentSegments(root, state);
  if (segments.length < 2) throw httpError(409, 'final_edit is only valid for a multi-segment project');
  const expected = [];
  for (const segment of segments) {
    const videos = await currentLockedSegmentVideos(root, state, segment.id);
    if (videos.length !== 1) throw httpError(409, `segment ${segment.id} must have exactly one current locked video before final edit upload`);
    await boundSuccessRun(root, videos[0]);
    expected.push(videos[0].id);
  }
  if (!isDeepStrictEqual([...descriptor.sourceVideoArtifactIds].sort(), expected.sort())) {
    throw httpError(409, 'final_edit sourceVideoArtifactIds must cover every current canonical segment video exactly once');
  }
}

function latestSegmentArtifact(state, type, segmentId) {
  return state.artifacts.filter(item => item.type === type && item.segmentId === segmentId)
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0] ?? null;
}

function auditDecisionFromRun(run) {
  if (run?.decision === 'PASS' || run?.decision === 'FAIL') return run.decision;
  const value = run?.executionEvidence?.envelope?.result;
  if (typeof value === 'object' && value && (value.decision === 'PASS' || value.decision === 'FAIL')) return value.decision;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.decision === 'PASS' || parsed?.decision === 'FAIL' ? parsed.decision : null;
  } catch {
    return null;
  }
}

function auditBlockerCountFromRun(run) {
  const value = run?.executionEvidence?.envelope?.result;
  if (typeof value === 'object' && value) return Array.isArray(value.findings) ? value.findings.filter(item => item?.severity === 'blocker').length : 0;
  if (typeof value !== 'string') return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed?.findings) ? parsed.findings.filter(item => item?.severity === 'blocker').length : 0;
  } catch {
    return 0;
  }
}

function productionExecutionStatus({ manifest, assetManifestVerified, narration, prompt, packageReady, audit, latestAuditRun, latestAuditMatchesCurrentPackage, readyForCanvas, canvasPreparation = null, simpleRemake = false }) {
  if (canvasPreparation?.status === 'READY_FOR_USER_CANVAS_GENERATION') {
    return {
      tone: 'ready', label: '等待你在画布生成', title: '视频画布已准备完成',
      detail: '已锁定的素材和生成说明已经写入视频画布。当前没有视频任务、没有扣费；下一步只需打开画布，由你决定是否点击生成。',
      actionHint: '下一步：打开视频画布', updatedAt: canvasPreparation.updatedAt ?? canvasPreparation.createdAt ?? null
    };
  }
  // 简单复刻的第三道人工门就是“生成前确认”。故事、资产和生成包的
  // 确定性校验已在后台完成；外部模型复核只能作为补充证据，不能再变成
  // 一道需要操作者理解、等待或重试的隐藏关卡。
  if (simpleRemake && readyForCanvas) {
    return {
      tone: 'ready', label: '可以进行下一步', title: '生成前准备已完成',
      detail: '当前段的已选素材、故事与生成包已经完成系统检查。下一步只需准备视频画布；此操作不会生成视频，也不会产生费用。',
      actionHint: '下一步：准备视频画布', updatedAt: null
    };
  }
  const latestRunStatus = latestAuditRun?.status ?? null;
  if (!simpleRemake && latestAuditMatchesCurrentPackage && ['SUBMITTING', 'RUNNING', 'QUEUED'].includes(latestRunStatus)) {
    return {
      tone: 'running', label: '正在运行', title: '正在进行独立复核',
      detail: '系统正在只读核对故事、镜头、素材与生成包的一致性。请不要重复点击，完成后页面会自动更新。',
      actionHint: '现在无需操作', updatedAt: latestAuditRun.updatedAt ?? latestAuditRun.createdAt ?? null
    };
  }
  const auditDecision = auditDecisionFromRun(latestAuditRun);
  if (!simpleRemake && latestAuditMatchesCurrentPackage && auditDecision === 'FAIL') {
    const blockerCount = auditBlockerCountFromRun(latestAuditRun);
    return {
      tone: 'blocked', label: '需要修正', title: '独立复核已完成，生成包需要修正',
      detail: `发现${blockerCount ? ` ${blockerCount} 项必须修正` : '需要修正的内容'}。视频尚未开始生成，后台当前没有继续运行的任务。`,
      actionHint: '当前无需重复操作；修正后才会重新进入复核', updatedAt: latestAuditRun.updatedAt ?? latestAuditRun.createdAt ?? null
    };
  }
  if (!simpleRemake && latestAuditMatchesCurrentPackage && latestRunStatus === 'UNCERTAIN') {
    return {
      tone: 'blocked', label: '待核对', title: '独立复核没有形成完整结论',
      detail: '这次只读复核已停止，视频尚未开始生成。为避免重复消耗，系统不会自动再次提交。',
      actionHint: '需要先核对原因后再处理', updatedAt: latestAuditRun.updatedAt ?? latestAuditRun.createdAt ?? null
    };
  }
  if (!simpleRemake && audit?.status === 'locked' && readyForCanvas) {
    return {
      tone: 'ready', label: '已就绪', title: '生成前准备已完成',
      detail: '故事、素材、生成包和独立复核均已锁定，可以进入视频画布进行最终生成。',
      actionHint: '下一步：在视频画布中检查后生成', updatedAt: audit.updatedAt ?? null
    };
  }
  if (manifest?.status !== 'locked' || !assetManifestVerified) {
    return {
      tone: 'waiting', label: '等待处理', title: '正在准备资产清单',
      detail: '当前还不能整理生成包；需要先锁定本段真正会使用的资产。',
      actionHint: '下一步：完成资产清单', updatedAt: null
    };
  }
  if (narration?.status !== 'locked') {
    return {
      tone: 'waiting', label: '等待处理', title: '等待整理讲戏本',
      detail: '资产已就绪，下一步由系统把镜头动作、节奏和画面控制整理成讲戏本。',
      actionHint: '下一步：整理讲戏本', updatedAt: null
    };
  }
  if (prompt?.status !== 'locked') {
    return {
      tone: 'waiting', label: '等待处理', title: '等待整理生成提示',
      detail: '讲戏本已锁定，下一步由系统生成并校验视频生成提示。',
      actionHint: '下一步：整理生成提示', updatedAt: null
    };
  }
  if (!packageReady) {
    return {
      tone: 'waiting', label: '等待处理', title: '等待整理生成包',
      detail: '生成提示已锁定，下一步把素材、提示和执行规则整理为可复核的生成包。',
      actionHint: '下一步：整理生成包', updatedAt: null
    };
  }
  return {
    tone: 'waiting', label: '等待复核', title: '生成包已准备好，等待独立复核',
    detail: '视频尚未开始生成。完成一次只读独立复核后，才会开放视频画布。',
    actionHint: '下一步：开始独立复核', updatedAt: null
  };
}

async function segmentProductionStatus(root, state, segments) {
  const runs = await readJsonDirectory(root, 'runs');
  const simpleRemake = workflowProfileIdOf(state) === 'simple_remake';
  return Promise.all(segments.map(async segment => {
    const narration = latestSegmentArtifact(state, 'shot_narration', segment.id);
    const prompt = latestSegmentArtifact(state, 'seedance_prompt', segment.id);
    const audit = latestSegmentArtifact(state, 'independent_creative_audit', segment.id);
    const manifest = await readJson(join(root, 'assets', `${segment.id}-asset-manifest.json`)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const packagePath = join(root, 'prompts', segment.id, 'seedance-package.json');
    const packageReady = await access(packagePath).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
    let currentPackageEvidence = null;
    if (packageReady && prompt?.status === 'locked') {
      try { currentPackageEvidence = await exactPackageEvidence(root, segment.id); } catch { /* existing blocked reasons explain the unavailable package */ }
    }
    const pendingImageAssetCount = (manifest?.items ?? []).filter(item => item.scope === 'segment'
      && item.status === 'awaiting_review' && !item.path
      && !['dialogue_audio_reference', 'timing_audio_reference', 'source_audio_candidate'].includes(item.type)).length;
    const blockedReasons = [];
    if (manifest?.status !== 'locked') blockedReasons.push('资产清单尚未锁定');
    let assetManifestVerified = false;
    if (manifest?.status === 'locked') {
      try {
        await verifyAssetManifestEvidence(root, state, manifest, `assets/${segment.id}-asset-manifest.json`);
        assetManifestVerified = true;
      } catch (error) { blockedReasons.push(error.message); }
    }
    if (narration?.status !== 'locked') blockedReasons.push('讲戏本尚未锁定');
    if (prompt?.status !== 'locked') blockedReasons.push('生成提示尚未锁定');
    if (!packageReady) blockedReasons.push('生成包尚未整理');
    if (!simpleRemake && audit?.status !== 'locked') blockedReasons.push('独立审查尚未锁定');
    if (blockedReasons.length === 0) {
      try {
        const requiredArtifacts = [narration, prompt];
        if (!simpleRemake) requiredArtifacts.push(audit);
        await Promise.all(requiredArtifacts.map(artifact => verifyLockedArtifact(root, artifact)));
        const evidence = await exactPackageEvidence(root, segment.id);
        if (!simpleRemake) {
          const auditValue = assertIndependentCreativeAudit(await readJson(safeFile(root, audit.path)));
          if (auditValue.decision !== 'PASS' || auditValue.promptSha256 !== evidence.promptSha256
            || auditValue.packageSha256 !== evidence.packageSha256 || !isDeepStrictEqual(auditValue.inputMedia, evidence.inputMedia)) {
            throw new Error('独立审查未绑定当前生成包');
          }
          const reportSha256 = await sha256File(safeFile(root, auditValue.reportPath));
          if (reportSha256 !== auditValue.reportSha256) throw new Error('独立审查报告 SHA 已变化');
          await requireIndependentReviewRun(root, auditValue.evidenceRunId, {
            kind: 'independent_creative_review', taskId: auditValue.agentTaskId, decision: auditValue.decision,
            inputs: { segmentId: segment.id, promptSha256: evidence.promptSha256, packageSha256: evidence.packageSha256, inputMedia: evidence.inputMedia },
            outputSha256: auditValue.reportSha256
          });
        }
      } catch (error) {
        blockedReasons.push(error.message);
      }
    }
    const latestAuditRun = runs.filter(run => run?.kind === 'independent_external_model_audit'
      && run.auditPurpose === 'creative_package' && run.segmentId === segment.id)
      .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')))[0] ?? null;
    const latestAuditMatchesCurrentPackage = Boolean(currentPackageEvidence && latestAuditRun?.targetBinding
      && latestAuditRun.targetBinding.promptSha256 === currentPackageEvidence.promptSha256
      && latestAuditRun.targetBinding.packageSha256 === currentPackageEvidence.packageSha256
      && isDeepStrictEqual(latestAuditRun.targetBinding.inputMedia, currentPackageEvidence.inputMedia));
    const readyForCanvas = blockedReasons.length === 0;
    const canvasPreparation = readyForCanvas && currentPackageEvidence
      ? runs.filter(run => run?.kind === 'libtv_canvas_preparation'
        && run.status === 'READY_FOR_USER_CANVAS_GENERATION'
        && run.segmentId === segment.id
        && run.fingerprint?.packageSha256 === currentPackageEvidence.packageSha256
        && run.fingerprint?.promptSha256 === currentPackageEvidence.promptSha256
        && isDeepStrictEqual(run.fingerprint?.inputMedia, currentPackageEvidence.inputMedia))
        .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')))[0] ?? null
      : null;
    return {
      segmentId: segment.id,
      assetManifestStatus: manifest?.status ?? 'missing',
      assetManifestVerified,
      pendingImageAssetCount,
      narration: narration ? artifactSummary(narration) : null,
      prompt: prompt ? artifactSummary(prompt) : null,
      packageReady,
      packageEvidence: currentPackageEvidence ? {
        packageSha256: currentPackageEvidence.packageSha256,
        promptSha256: currentPackageEvidence.promptSha256,
        governanceBindings: currentPackageEvidence.governanceBindings,
        mediaBindings: currentPackageEvidence.mediaBindings,
        mediaBindingCount: currentPackageEvidence.mediaBindingCount
      } : null,
      independentAudit: audit ? artifactSummary(audit) : null,
      readyForCanvas,
      canvasPreparation: canvasPreparation ? runSummary(canvasPreparation) : null,
      blockedReasons,
      executionStatus: productionExecutionStatus({
        manifest, assetManifestVerified, narration, prompt, packageReady, audit,
        latestAuditRun, latestAuditMatchesCurrentPackage, readyForCanvas, canvasPreparation, simpleRemake
      })
    };
  }));
}

async function computeGateStates(root, state, segments, production, directorInterview = null) {
  const checks = [];
  const result = (gate, name, passed, reasons = [], evidenceIds = []) => checks.push({ gate, name, status: passed ? 'passed' : 'blocked', blockedReasons: reasons, evidenceIds });
  const gate0Passed = state.routeDecision?.harnessRequired === true && (!directorInterview || directorInterview.status === 'complete');
  const gate0Reasons = state.routeDecision?.harnessRequired !== true ? ['尚未完成 Harness 路由']
    : directorInterview?.status === 'awaiting_answers' ? ['Gate 0 导演访谈尚未完成'] : [];
  result(0, '需求路由', gate0Passed, gate0Reasons, directorInterview?.status === 'complete' ? [directorInterview.id] : []);
  const lockedCreative = state.artifacts.filter(item => item.type === 'creative_brief' && item.status === 'locked').sort((a, b) => b.revision - a.revision)[0];
  try {
    if (!lockedCreative) throw new Error('没有锁定的导演创意母版');
    await verifyLockedArtifact(root, lockedCreative);
    result(1, '导演创意', true, [], [lockedCreative.id]);
  } catch (error) { result(1, '导演创意', false, [error.message]); }
  const story = state.artifacts.filter(item => item.type === 'story_plan' && item.status === 'locked').sort((a, b) => b.revision - a.revision)[0];
  const segmentation = state.artifacts.filter(item => item.type === 'segmentation' && item.status === 'locked').sort((a, b) => b.revision - a.revision)[0];
  const capability = state.artifacts.find(item => item.id === state.verifiedCapabilityManifestId && item.type === 'capability_manifest' && item.status === 'locked');
  try {
    if (!story || !segmentation || !capability) throw new Error('故事、正式分段或能力清单尚未全部锁定');
    await Promise.all([verifyLockedArtifact(root, story), verifyLockedArtifact(root, segmentation), verifyLockedArtifact(root, capability)]);
    result(2, '故事与镜头', true, [], [story.id, segmentation.id, capability.id]);
  } catch (error) { result(2, '故事与镜头', false, [error.message]); }
  const gate3Passed = production.length > 0 && production.every(item => item.assetManifestVerified === true);
  result(3, '资产审核', gate3Passed, gate3Passed ? [] : production.flatMap(item => item.assetManifestVerified ? [] : item.blockedReasons), production.filter(item => item.assetManifestVerified).map(item => `${item.segmentId}-asset-manifest`));
  const gate4Reasons = [];
  const gate4Evidence = [];
  for (const segment of segments) {
    try {
      const productionState = production.find(item => item.segmentId === segment.id);
      if (!productionState?.readyForCanvas) throw new Error(`${segment.id} 当前生成包或独立审查尚未通过完整验证`);
      const videos = currentArtifactsOf(state.artifacts, item => item.type === 'video_segment'
        && item.segmentId === segment.id && ['draft', 'awaiting_review', 'locked'].includes(item.status));
      const bound = [];
      for (const video of videos) {
        try { bound.push({ video, run: await boundSuccessRun(root, video) }); } catch { /* stale or unbound takes do not pass Gate 4 */ }
      }
      if (bound.length !== 1) throw new Error(`${segment.id} 需要恰好一个绑定当前指纹的已同步 LibTV 成功结果，当前找到 ${bound.length} 个`);
      gate4Evidence.push(bound[0].run.id, bound[0].video.id);
    } catch (error) { gate4Reasons.push(error.message); }
  }
  result(4, '生成准备', segments.length > 0 && gate4Reasons.length === 0, segments.length ? gate4Reasons : ['尚无正式分段'], gate4Evidence);
  try {
    const delivery = await verifyDelivery(root);
    result(5, '成片审核', delivery.blocked.length === 0, delivery.blocked.flatMap(item => item.reasons ?? []), [
      ...delivery.deliverable.map(item => item.videoArtifactId), ...(delivery.finalEdit ? [delivery.finalEdit.artifactId] : [])
    ]);
  } catch (error) { result(5, '成片审核', false, [error.message]); }
  return checks;
}

async function exactPackageEvidence(root, segmentId) {
  const packagePath = `prompts/${segmentId}/seedance-package.json`;
  const packageValue = await readJson(join(root, packagePath));
  const promptPath = requiredText(packageValue.promptPath, 'compiled package promptPath', 512);
  const media = {};
  for (const [target, source] of [['images', 'imageInputs'], ['videos', 'videoInputs'], ['audio', 'audioInputs']]) {
    if (!Array.isArray(packageValue[source])) throw httpError(409, `compiled package ${source} is missing`);
    media[target] = packageValue[source].map(item => ({ id: item.id, path: item.path, sha256: item.sha256 }));
  }
  const governanceBindings = {};
  for (const name of ['segmentContract', 'shotNarration', 'seedancePrompt', 'assetManifest']) {
    const binding = packageValue.governanceBindings?.[name];
    if (binding?.status === 'locked' && /^[a-f0-9]{64}$/.test(binding.sha256 ?? '')) {
      governanceBindings[name] = { id: binding.id, status: binding.status, sha256: binding.sha256 };
    }
  }
  const mediaBindings = assertSeedanceMediaBindingContract(packageValue).map(binding => ({
    tag: binding.tag,
    semanticToken: binding.semanticToken,
    id: binding.id,
    mediaKind: binding.mediaKind,
    sha256: binding.sha256,
    controls: binding.controls,
    mustNotControl: binding.mustNotControl
  }));
  return {
    packagePath,
    packageSha256: await sha256File(join(root, packagePath)),
    promptPath,
    promptSha256: await sha256File(safeFile(root, promptPath)),
    inputMedia: media,
    governanceBindings,
    mediaBindings,
    mediaBindingCount: mediaBindings.length
  };
}

function auditExecutionSettings(input) {
  if (input?.useDefaultAuditPolicy !== true) {
    throw badRequest('独立复核只能使用主机已设置的默认审查策略');
  }
  const model = DEFAULT_INDEPENDENT_AUDIT_MODEL;
  const perCallLimit = independentAuditMaxCredits;
  const inputCreditsPerMillion = independentAuditInputCreditsPerMillion;
  const outputCreditsPerMillion = independentAuditOutputCreditsPerMillion;
  // 第一个回合读取绑定证据，第二个回合才输出结构化结论。
  // 这是单次独立审查任务，不是第二次模型调用。
  const maxTurns = independentAuditMaxTurns;
  const maxInputTokensPerTurn = 24000;
  const maxOutputTokensPerTurn = 4000;
  const worstCaseCredits = maxTurns * (
    maxInputTokensPerTurn * inputCreditsPerMillion + maxOutputTokensPerTurn * outputCreditsPerMillion
  ) / 1_000_000;
  if (worstCaseCredits > perCallLimit) throw badRequest('本次完整复核所需的主机配额超过当前保护上限，请由系统所有者调整后台设置');
  return {
    model,
    budget: { unit: 'CREDITS', perCallLimit, totalLimit: perCallLimit },
    executionPolicy: {
      // Kimi 的本机网关提供可核对的用量，但不返回单独的积分回执；
      // 以主机锁定单价换算并留存用量，避免把已完成的只读复核误记为“没有结论”。
      costEvidenceRequired: 'usage_derived_consumed_credits', maxTurns, maxInputTokensPerTurn, maxOutputTokensPerTurn,
      requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
      pricing: {
        unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion, outputCreditsPerMillion,
        source: requiredText(independentAuditPricingSource, 'HARNESS_STUDIO_AUDIT_PRICING_SOURCE', 512),
        verifiedAt: requiredText(independentAuditPricingVerifiedAt, 'HARNESS_STUDIO_AUDIT_PRICING_VERIFIED_AT', 64)
      },
      worstCaseCredits
    }
  };
}

async function evidenceBinding(root, artifact) {
  await verifyLockedArtifact(root, artifact);
  return { id: artifact.id, type: artifact.type, path: artifact.path, sha256: artifact.sha256 ?? await sha256File(safeFile(root, artifact.path)) };
}

function auditProxyFileName(binding) {
  const id = String(binding.id ?? 'video').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
  return `${id}-${binding.sha256.slice(0, 16)}-抽帧总览.png`;
}

async function visualProxyForAudit(root, binding) {
  const sourcePath = safeFile(root, binding.path);
  if (await sha256File(sourcePath) !== binding.sha256) throw httpError(409, `视频证据「${binding.id}」已变化，不能继续复核。`);
  const relativePath = `reviews/external-audit-proxies/${auditProxyFileName(binding)}`;
  const proxyPath = safeFile(root, relativePath);
  const exists = await access(proxyPath).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (!exists) {
    await mkdir(dirname(proxyPath), { recursive: true });
    const result = await runProcess('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', sourcePath,
      '-vf', 'fps=1/5,scale=480:-2,tile=3x1:padding=8:margin=8:color=white', '-frames:v', '1', proxyPath
    ], { cwd: repositoryRoot });
    if (result.code !== 0) throw httpError(422, `无法为视频证据「${binding.id}」生成可视化抽帧：${result.stderr.trim() || '转换失败'}`);
  }
  return {
    source: { id: binding.id, path: binding.path, sha256: binding.sha256 },
    proxy: {
      id: `${binding.id}-抽帧总览`, type: 'video_visual_proxy', path: relativePath,
      sha256: await sha256File(proxyPath)
    },
    sampling: '从视频开场到结束按时间抽取三张代表画面，仅用于独立复核的可视化观察。'
  };
}

function externalAuditFingerprint(value) {
  return sha256Text(`${JSON.stringify(value)}\n`);
}

async function onePriorExternalAudit(root, fingerprint) {
  const allRuns = await readJsonDirectory(root, 'runs');
  const retriedUncertainRunIds = new Set(allRuns.map(run => run.retryOfRunId).filter(Boolean));
  const matches = allRuns.filter(run => run.kind === 'independent_external_model_audit'
    && run.auditRequestFingerprint === fingerprint && ['SUBMITTING', 'UNCERTAIN', 'SUCCESS'].includes(run.status)
    && !(run.status === 'UNCERTAIN' && retriedUncertainRunIds.has(run.id)));
  if (matches.length > 1) throw httpError(409, `同一审查输入存在 ${matches.length} 条不可重放运行，需先人工核对证据`);
  return matches[0] ?? null;
}

async function finalizeStudioCreativeAudit(project, run) {
  if (run.status !== 'SUCCESS' || run.auditPurpose !== 'creative_package') throw httpError(409, `外部审查 ${run.id} 不是可恢复的创意 SUCCESS 运行`);
  if (await sha256File(safeFile(project.root, run.reportPath)) !== run.reportSha256
    || await sha256File(safeFile(project.root, run.machineOutputPath)) !== run.machineOutputSha256) {
    throw httpError(409, `外部审查 ${run.id} 的报告或机器结果 SHA 已变化`);
  }
  const audit = assertIndependentCreativeAudit(await readJson(safeFile(project.root, run.machineOutputPath)));
  if (audit.evidenceRunId !== run.id || audit.agentTaskId !== run.sessionId || audit.decision !== run.decision
    || audit.reportSha256 !== run.reportSha256) throw httpError(409, `外部审查 ${run.id} 的身份或输出绑定不一致`);
  if (audit.decision === 'PASS' && audit.blockerCount !== 0) throw httpError(409, `外部审查 ${run.id} 的 PASS 与 blocker 结论矛盾`);
  let state = await readJson(join(project.root, 'project-state.json'));
  let artifact = state.artifacts.find(item => item.id === audit.id && item.type === 'independent_creative_audit');
  if (!artifact) artifact = await registerArtifact(project.root, {
    id: audit.id, type: 'independent_creative_audit', revision: audit.revision,
    status: 'draft', path: run.machineOutputPath, segmentId: audit.segmentId
  });
  let review = null;
  if (audit.decision === 'PASS' && audit.blockerCount === 0 && artifact.status !== 'locked') {
    review = await autoLockArtifact(project.root, artifact.id, 'auto-locked: recovered one-call read-only external creative audit bound the exact package and passed');
    state = await readJson(join(project.root, 'project-state.json'));
    artifact = state.artifacts.find(item => item.id === artifact.id);
  }
  return { run, audit, artifact, review, reusedPaidResult: true };
}

async function executeStudioCreativeAudit(project, segmentId, state, input) {
  const evidence = await exactPackageEvidence(project.root, segmentId);
  const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'independent_creative_audit' && item.segmentId === segmentId).map(item => item.revision)) + 1;
  const runId = `studio-external-creative-${segmentId}-${randomUUID()}`;
  const artifactId = `${segmentId}-independent-audit-r${revision}-${runId.slice(-8)}`;
  const requestBase = `reviews/external-audit-requests/${runId}`;
  const briefPath = `${requestBase}-brief.json`;
  const reportPath = `reviews/external-audits/${runId}.md`;
  const machinePath = `reviews/external-audits/${runId}-audit.json`;
  const story = state.artifacts.filter(item => item.type === 'story_plan' && item.status === 'locked')
    .sort((a, b) => b.revision - a.revision)[0];
  const narration = latestSegmentArtifact(state, 'shot_narration', segmentId);
  if (!story || !narration || narration.status !== 'locked') throw httpError(409, '外部审查需要当前锁定的 Gate 2 故事计划与逐镜讲戏本');
  const sources = [await evidenceBinding(project.root, story), await evidenceBinding(project.root, narration)];
  const reference = state.artifacts.filter(item => item.type === 'reference_video' && item.status === 'locked')
    .sort((a, b) => b.revision - a.revision)[0];
  const videoEvidence = [
    ...(reference ? [await evidenceBinding(project.root, reference)] : []),
    ...(evidence.inputMedia.videos ?? []).map(item => ({ id: item.id, path: item.path, sha256: item.sha256 }))
  ].filter((item, index, list) => list.findIndex(candidate => candidate.id === item.id && candidate.sha256 === item.sha256) === index);
  const visualProxies = await Promise.all(videoEvidence.map(item => visualProxyForAudit(project.root, item)));
  sources.push(...visualProxies.map(item => item.proxy));
  const requestFingerprint = externalAuditFingerprint({
    purpose: 'creative_package', projectId: state.projectId, segmentId,
    sources, visualProxies, promptSha256: evidence.promptSha256, packageSha256: evidence.packageSha256, inputMedia: evidence.inputMedia
  });
  const prior = await onePriorExternalAudit(project.root, requestFingerprint);
  if (prior?.status === 'SUCCESS') return finalizeStudioCreativeAudit(project, prior);
  const retryOfRunId = prior?.status === 'UNCERTAIN' && input?.explicitRetryUncertainAudit === true ? prior.id : null;
  if (prior && !retryOfRunId) throw httpError(409, `当前生成包已有 ${prior.status} 外部审查 ${prior.id}；为避免重复扣费，禁止再次提交`);
  const brief = {
    kind: 'independent_creative_audit_brief', segmentId, sourceRange: `${segmentId} full range`,
    task: '阅读所有已绑定的文本与图片证据，独立复核最终生成包，不得改写内容。视频二进制文件只通过其已绑定的抽帧总览进行可视化观察，不直接读取视频文件。证据缺失、不一致、不可验证或违反审核边界时必须判定不通过。',
    requiredInspector: { contextMode: 'clean_zero_context', readOnly: true }, sourceEvidence: sources, visualProxies,
    generationEvidence: {
      prompt: { id: `prompt-${segmentId}`, path: evidence.promptPath, sha256: evidence.promptSha256 },
      package: { path: evidence.packagePath, sha256: evidence.packageSha256 }, inputMedia: evidence.inputMedia
    },
    mandatoryCoverage: [
      'source_and_requirement_fidelity',
      'director_emotion_conflict_performance_camera_causality',
      'delivery_completeness_continuity_asset_prompt_gate_boundaries'
    ],
    passRule: 'PASS only if every mandatory category is PASS with concrete evidence from the bound files.',
    expectedOutputs: { reportMarkdown: reportPath, machineJson: machinePath }
  };
  await writeJsonAtomic(safeFile(project.root, briefPath), brief);
  const settings = auditExecutionSettings(input);
  const approval = {
    id: `${runId}-approval`, kind: 'external_audit_only_approval', actor: 'human', decision: 'approved',
    projectId: state.projectId, segmentId, model: settings.model, maxCalls: 1,
    budget: settings.budget, executionPolicy: settings.executionPolicy,
    permissions: { readOnly: true, automaticRetries: false, imageGeneration: false, videoGeneration: false, externalMessages: false },
    binding: {
      auditBrief: { path: briefPath, sha256: await sha256File(safeFile(project.root, briefPath)) },
      prompt: brief.generationEvidence.prompt, package: brief.generationEvidence.package, inputMedia: evidence.inputMedia
    },
    approvedAt: new Date().toISOString()
  };
  await persistExternalAuditOnlyApproval(project.root, approval);
  const result = await executeIndependentExternalAudit(project.root, { approvalId: approval.id }, {
    runId, artifactId, revision, requestFingerprint, auditPurpose: 'creative_package',
    targetBinding: { segmentId, promptSha256: evidence.promptSha256, packageSha256: evidence.packageSha256, inputMedia: evidence.inputMedia },
    ...(retryOfRunId ? { retryOfRunId, explicitRetryAuthorization: true } : {})
  });
  return finalizeStudioCreativeAudit(project, result.run);
}

async function finalizeStudioAssetAudit(project, asset, externalRun) {
  if (externalRun.status !== 'SUCCESS' || externalRun.auditPurpose !== 'asset_visual') {
    throw httpError(409, `外部审查 ${externalRun.id} 不是可恢复的资产 SUCCESS 运行`);
  }
  const providerPath = safeFile(project.root, externalRun.providerReportPath);
  if (await sha256File(providerPath) !== externalRun.providerReportSha256) throw httpError(409, '外部像素审查 provider 报告 SHA 已变化');
  const providerReport = await readJson(providerPath);
  const required = REQUIRED_VISUAL_CHECKS[asset.assetType] ?? ['asset_role_fidelity'];
  const characterAsset = asset.assetType?.startsWith('character_') || ['character_board', 'character_identity_single_view'].includes(asset.assetType);
  const coverage = characterAsset ? [...required, 'observed_identity_count_exactly_one'] : required;
  const byCategory = new Map(providerReport.coverage.map(item => [item.category, item]));
  const checks = required.map(id => {
    const finding = byCategory.get(id);
    return { id, result: finding?.status === 'PASS' ? 'PASS' : 'FAIL', evidence: finding?.evidence ?? 'External review omitted this required check.' };
  });
  const providerBlockers = providerReport.findings.filter(item => item.severity === 'blocker');
  const decision = providerReport.decision === 'PASS' && providerBlockers.length === 0
    && coverage.every(id => byCategory.get(id)?.status === 'PASS') ? 'PASS' : 'FAIL';
  let state = await readJson(join(project.root, 'project-state.json'));
  const previousMachine = await readJson(safeFile(project.root, externalRun.machineOutputPath)).catch(() => null);
  const matchingRecoveredMachine = previousMachine?.kind === 'asset_visual_audit'
    && previousMachine.assetId === asset.id && previousMachine.assetRevision === asset.revision
    && previousMachine.assetSha256 === asset.sha256 && previousMachine.inspectorTaskId === externalRun.sessionId
    && previousMachine.evidenceRunId === externalRun.id;
  const expectedIdAvailable = !state.artifacts.some(item => item.id === asset.visualAuditId);
  const auditId = matchingRecoveredMachine ? previousMachine.id
    : expectedIdAvailable ? asset.visualAuditId : `${asset.id}-external-visual-audit-${externalRun.id.slice(-8)}`;
  const audit = {
    id: auditId, kind: 'asset_visual_audit', assetId: asset.id, assetType: asset.assetType,
    assetRevision: asset.revision, assetSha256: asset.sha256, decision,
    inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: externalRun.sessionId, evidenceRunId: externalRun.id,
    observedIdentityCount: characterAsset && decision === 'PASS' ? 1 : 0,
    checks, blockerCount: decision === 'PASS' ? 0 : Math.max(1, providerBlockers.length + checks.filter(item => item.result !== 'PASS').length),
    reviewedAt: matchingRecoveredMachine ? previousMachine.reviewedAt : externalRun.updatedAt
  };
  await writeJsonAtomic(safeFile(project.root, externalRun.machineOutputPath), audit);
  const machineOutputSha256 = await sha256File(safeFile(project.root, externalRun.machineOutputPath));
  const completedRun = {
    ...externalRun, decision, auditType: 'asset_visual_audit', sourceAuditId: audit.id,
    assetBinding: { assetId: asset.id, assetType: asset.assetType, assetRevision: asset.revision, assetSha256: asset.sha256 },
    machineOutputSha256, artifactId: audit.id, updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(join(project.root, 'runs', `${encodeURIComponent(externalRun.id)}.json`), completedRun);
  state = await readJson(join(project.root, 'project-state.json'));
  let artifact = state.artifacts.find(item => item.id === audit.id && item.type === 'asset_visual_audit');
  let review = null;
  if (!artifact) {
    const registered = await runAssetVisualAudit(['--project', project.root, '--input', safeFile(project.root, completedRun.machineOutputPath)]);
    artifact = registered.artifact; review = registered.review;
  }
  if (!review && decision === 'PASS' && artifact.status !== 'locked') {
    review = await autoLockArtifact(project.root, artifact.id, 'auto-locked: recovered one-call read-only external pixel audit passed');
    state = await readJson(join(project.root, 'project-state.json'));
    artifact = state.artifacts.find(item => item.id === artifact.id);
  }
  return { run: completedRun, audit, artifact, review, reusedPaidResult: true };
}

async function executeStudioAssetAudit(project, asset, state, input) {
  await verifyArtifactFile(project.root, asset);
  const required = REQUIRED_VISUAL_CHECKS[asset.assetType] ?? ['asset_role_fidelity'];
  const characterAsset = asset.assetType?.startsWith('character_') || ['character_board', 'character_identity_single_view'].includes(asset.assetType);
  const coverage = characterAsset ? [...required, 'observed_identity_count_exactly_one'] : required;
  const requestFingerprint = externalAuditFingerprint({
    purpose: 'asset_visual', projectId: state.projectId,
    assetId: asset.id, assetType: asset.assetType, assetRevision: asset.revision, assetSha256: asset.sha256, requiredChecks: coverage
  });
  const prior = await onePriorExternalAudit(project.root, requestFingerprint);
  if (prior?.status === 'SUCCESS') return finalizeStudioAssetAudit(project, asset, prior);
  if (prior) throw httpError(409, `当前资产已有 ${prior.status} 外部审查 ${prior.id}；为避免重复扣费，禁止再次提交`);
  const runId = `studio-external-asset-${asset.id}-${randomUUID()}`;
  const requestBase = `reviews/external-audit-requests/${runId}`;
  const promptPath = `${requestBase}-instruction.txt`;
  const packagePath = `${requestBase}-package.json`;
  const briefPath = `${requestBase}-brief.json`;
  const reportPath = `reviews/external-audits/${runId}.md`;
  const machinePath = `reviews/external-audits/${runId}-audit.json`;
  const image = { id: asset.id, path: asset.path, sha256: asset.sha256 };
  await writeTextAtomic(safeFile(project.root, promptPath), `Inspect the actual image pixels at ${asset.path}. Asset type: ${asset.assetType}. Asset SHA-256: ${asset.sha256}.\n`);
  await writeJsonAtomic(safeFile(project.root, packagePath), { kind: 'asset_visual_audit_package', asset: image, requiredChecks: coverage });
  const brief = {
    kind: 'independent_creative_audit_brief', segmentId: asset.segmentId ?? `asset-${asset.id}`,
    sourceRange: 'single still image',
    task: `Use the Read tool to inspect the actual pixels in ${asset.path}. Evaluate each mandatory category independently. Return FAIL for any missing, failed, or unverifiable check. Do not infer PASS from the filename or metadata.`,
    requiredInspector: { contextMode: 'clean_zero_context', readOnly: true },
    sourceEvidence: [{ ...image, type: asset.type }],
    generationEvidence: {
      prompt: { id: `${asset.id}-pixel-audit-instruction`, path: promptPath, sha256: await sha256File(safeFile(project.root, promptPath)) },
      package: { path: packagePath, sha256: await sha256File(safeFile(project.root, packagePath)) },
      inputMedia: { images: [image], videos: [], audio: [] }
    },
    mandatoryCoverage: coverage,
    passRule: 'PASS only when every required visual check is PASS from direct pixel inspection.',
    expectedOutputs: { reportMarkdown: reportPath, machineJson: machinePath }
  };
  await writeJsonAtomic(safeFile(project.root, briefPath), brief);
  const settings = auditExecutionSettings(input);
  const approval = {
    id: `${runId}-approval`, kind: 'external_audit_only_approval', actor: 'human', decision: 'approved',
    projectId: state.projectId, segmentId: brief.segmentId, model: settings.model, maxCalls: 1,
    budget: settings.budget, executionPolicy: settings.executionPolicy,
    permissions: { readOnly: true, automaticRetries: false, imageGeneration: false, videoGeneration: false, externalMessages: false },
    binding: {
      auditBrief: { path: briefPath, sha256: await sha256File(safeFile(project.root, briefPath)) },
      prompt: brief.generationEvidence.prompt, package: brief.generationEvidence.package, inputMedia: brief.generationEvidence.inputMedia
    },
    approvedAt: new Date().toISOString()
  };
  await persistExternalAuditOnlyApproval(project.root, approval);
  const external = await executeIndependentExternalAudit(project.root, { approvalId: approval.id }, {
    runId, artifactId: `${asset.id}-temporary-creative-audit-${runId.slice(-8)}`, revision: asset.revision,
    requestFingerprint, auditPurpose: 'asset_visual',
    targetBinding: { assetId: asset.id, assetType: asset.assetType, assetRevision: asset.revision, assetSha256: asset.sha256 }
  });
  return finalizeStudioAssetAudit(project, asset, external.run);
}

function canonicalSegmentsFromStoryPlan(plan, capability) {
  const routedIds = Object.keys(capability?.requiredAssetsBySegment ?? {});
  return plan.videoSegments.map((segment, index, segments) => {
    const id = `segment-${String(index + 1).padStart(3, '0')}`;
    const shots = plan.shotPlanning?.mode === 'shotlist'
      ? plan.shotPlanning.shots.filter(shot => shot.segmentId === segment.segmentId)
      : [];
    const required = capability?.requiredAssetsBySegment?.[segment.segmentId]
      ?? capability?.requiredAssetsBySegment?.[routedIds[index]]
      ?? [];
    return {
      id,
      duration: segment.endSec - segment.startSec,
      narrativeTask: segment.storyBeat,
      startState: { description: shots[0]?.startState ?? plan.story.initialCondition },
      actionNodes: shots.map(shot => shot.shotId),
      endState: { description: shots.at(-1)?.endState ?? plan.story.finalOutcome },
      projectAssetIds: [],
      segmentAssetRequirements: [...new Set(required)],
      continuityStrategy: index === 0 ? 'canonical_open' : segment.continuityStrategy,
      previousSegmentId: index === 0 ? null : `segment-${String(index).padStart(3, '0')}`,
      nextSegmentId: index === segments.length - 1 ? null : `segment-${String(index + 2).padStart(3, '0')}`,
      status: 'awaiting_review'
    };
  });
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = safeFile(publicRoot, normalize(requested));
  if (!file.startsWith(`${publicRoot}${sep}`) && file !== publicRoot) return sendError(response, 403, 'forbidden');
  const extension = extname(file);
  if (!mimeTypes[extension]) return sendError(response, 404, 'not found');
  try {
    await access(file);
    response.writeHead(200, { 'content-type': mimeTypes[extension], 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  } catch {
    sendError(response, 404, 'not found');
  }
}

async function serveMedia(request, response, file, type) {
  const info = await stat(file);
  const common = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { ...common, 'content-length': info.size });
    if (request.method === 'HEAD') return response.end();
    return createReadStream(file).pipe(response);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
  if (!match) {
    response.writeHead(416, { ...common, 'content-range': `bytes */${info.size}` });
    return response.end();
  }
  const requestedStart = match[1] === '' ? null : Number(match[1]);
  const requestedEnd = match[2] === '' ? null : Number(match[2]);
  let start = requestedStart;
  let end = requestedEnd;
  if (start === null) {
    const suffixLength = end;
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      response.writeHead(416, { ...common, 'content-range': `bytes */${info.size}` });
      return response.end();
    }
    start = Math.max(0, info.size - suffixLength);
    end = info.size - 1;
  } else {
    if (!Number.isSafeInteger(start) || start < 0) {
      response.writeHead(416, { ...common, 'content-range': `bytes */${info.size}` });
      return response.end();
    }
    end = end === null ? info.size - 1 : Math.min(end, info.size - 1);
  }
  if (!Number.isSafeInteger(end) || start >= info.size || end < start) {
    response.writeHead(416, { ...common, 'content-range': `bytes */${info.size}` });
    return response.end();
  }
  response.writeHead(206, {
    ...common,
    'content-range': `bytes ${start}-${end}/${info.size}`,
    'content-length': end - start + 1
  });
  if (request.method === 'HEAD') return response.end();
  return createReadStream(file, { start, end }).pipe(response);
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  if (request.method === 'GET' && pathname === '/api/session') {
    const { principal, session } = currentAccess();
    return sendJson(response, 200, {
      csrfToken: session.csrfToken,
      principal,
      localOnly: listenHost === '127.0.0.1' || listenHost === 'localhost',
      teamMode: listenHost !== '127.0.0.1' && listenHost !== 'localhost',
      lanUrls: studioLanUrls(port, { https: httpsEnabled }),
      generationPolicy: {
        memberQuota: null,
        paidAttemptRequiresExplicitConfirmation: true,
        automaticPaidRetry: false
      },
      transport: httpsEnabled ? 'https' : 'http'
    });
  }
  if (!['GET', 'HEAD'].includes(request.method)) requireWriteAuthorization(request);
  if (request.method === 'GET' && pathname === '/api/team') {
    requireOwner();
    return sendJson(response, 200, await listStudioTeam(teamStateRoot));
  }
  if (request.method === 'POST' && pathname === '/api/team/invites') {
    requireOwner();
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const created = await createStudioInvite(teamStateRoot, requiredText(input.label, 'label', 80), { resident: input.resident === true });
    return sendJson(response, 201, {
      principal: created.principal,
      invite: { id: created.invite.id, expiresAt: created.invite.expiresAt, resident: created.invite.resident === true },
      invitePath: `/join/${encodeURIComponent(created.token)}`
    });
  }
  const reissueInviteRoute = /^\/api\/team\/members\/([^/]+)\/reissue-invite$/.exec(pathname);
  if (request.method === 'POST' && reissueInviteRoute) {
    requireOwner();
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const created = await reissueStudioInvite(teamStateRoot, decodeURIComponent(reissueInviteRoute[1]), { resident: input.resident === true });
    return sendJson(response, 201, {
      principal: created.principal,
      invite: { id: created.invite.id, expiresAt: created.invite.expiresAt, resident: created.invite.resident === true },
      invitePath: `/join/${encodeURIComponent(created.token)}`
    });
  }
  if (request.method === 'POST' && pathname === '/api/team/settings') {
    requireOwner();
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const settings = await serializeStudioControl(async () => {
      const updated = await updateStudioTeamSettings(teamStateRoot, {
        defaultLibTvProjectUuid: input.defaultLibTvProjectUuid ? requiredText(input.defaultLibTvProjectUuid, 'defaultLibTvProjectUuid', 32) : null,
        paidGenerationEnabled: input.paidGenerationEnabled === true
      });
      if (!updated.paidGenerationEnabled) await cancelQueuedStudioGenerationJobs(teamStateRoot, null, 'owner disabled paid generation before provider submission');
      return updated;
    });
    return sendJson(response, 200, { settings });
  }
  const revokeMemberRoute = /^\/api\/team\/members\/([^/]+)\/revoke$/.exec(pathname);
  if (request.method === 'POST' && revokeMemberRoute) {
    requireOwner();
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const principalId = decodeURIComponent(revokeMemberRoute[1]);
    const { principal, canceledJobs } = await serializeStudioControl(async () => ({
      principal: await revokeStudioMember(teamStateRoot, principalId),
      canceledJobs: await cancelQueuedStudioGenerationJobs(teamStateRoot, principalId)
    }));
    return sendJson(response, 200, { principal, canceledQueuedJobCount: canceledJobs.length });
  }
  if (request.method === 'GET' && pathname === '/api/projects') {
    const projects = await projectEntries();
    const executionPortfolio = summarizeExecutionLedgerPortfolio(projects.map(project => project.error
      ? { slug: project.slug, errorCode: 'project_state_unreadable' }
      : { slug: project.slug, ledger: project.executionLedger }));
    return sendJson(response, 200, {
      executionPortfolio,
      projects: projects.map(({ slug, status, next, directorInterview, routeDecision, workflowVersion, ingressPolicyVersion, workflowProfileId, visibleSteps, error }) => ({
        slug,
        status,
        next,
        directorInterview: directorInterview ?? null,
        routeDecision: routeDecision ?? null,
        workflowVersion: workflowVersion ?? null,
        ingressPolicyVersion: ingressPolicyVersion ?? null,
        workflowProfileId: workflowProfileId ?? null,
        visibleSteps: visibleSteps ?? [],
        error: error ?? null
      }))
    });
  }
  if (request.method === 'GET' && pathname === '/api/execution-ledger/portfolio') {
    const projects = await projectEntries();
    return sendJson(response, 200, summarizeExecutionLedgerPortfolio(projects.map(project => project.error
      ? { slug: project.slug, errorCode: 'project_state_unreadable' }
      : { slug: project.slug, ledger: project.executionLedger })));
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const principal = currentPrincipal();
    const projectId = projectSlug(input.projectId);
    const memberNamespace = principal.role === 'owner' ? '' : `${principal.id.slice('member-'.length, 'member-'.length + 8)}-`;
    const slug = `${memberNamespace}${projectId}`;
    const root = safeFile(projectsRoot, slug);
    const state = await initializeProject(root, {
      projectId,
      workflowVersion: 2,
      realismContractsVersion: 2,
      realismContractsWriteMode: 'enabled'
    });
    await assignStudioProjectOwner(teamStateRoot, slug, principal.id);
    return sendJson(response, 201, { slug, state });
  }

  const editRoute = /^\/api\/projects\/([^/]+)\/artifact-edits\/([^/]+)(?:\/(save|preview|apply|prepare-rewrite|rewrite))?$/.exec(pathname);
  if (editRoute && ['GET','POST'].includes(request.method)) {
    const project = await findProject(decodeURIComponent(editRoute[1]));
    const artifactId = decodeURIComponent(editRoute[2]);
    const action = editRoute[3];
    if (request.method === 'GET' && !action) return sendJson(response, 200, await readArtifactEditor(project.root, artifactId));
    if (request.method !== 'POST') return sendError(response, 405, '修改操作请使用提交请求。');
    const input = await readRequestBody(request);
    const args = {...input, artifactId};
    if (action === 'save') return sendJson(response, 200, await saveArtifactEdit(project.root, args));
    if (action === 'preview') return sendJson(response, 200, await previewArtifactEdit(project.root, args));
    if (action === 'apply') return sendJson(response, 200, await applyArtifactEdit(project.root, args));
    if (action === 'prepare-rewrite') {
      if (request.method !== 'POST') return sendError(response,405,'请使用提交操作。');
      for (const [key, value] of artifactRewriteChallenges) if (value.expiresAt < Date.now()) artifactRewriteChallenges.delete(key);
      const editor = await readArtifactEditor(project.root, artifactId);
      const instruction = requiredText(input.instruction, '修改要求', 12000);
      const configuration = await directorEngineConfiguration(project.root);
      if (!configuration.available) return sendJson(response, 200, {available:false,reason:'文字修改服务当前不可用，可以先直接修改文字。'});
      const spec = {root:project.root,model:configuration.model,maxBudgetUsd:configuration.maxBudgetUsd,instruction,fields:editor.fields};
      const inputSha256 = getArtifactRewriteFingerprint(spec);
      const id = randomUUID();
      const challenge = {id,projectSlug:project.slug,artifactId,principalId:currentPrincipal().id,expiresAt:Date.now()+300000,sourceSha256:editor.sourceSha256,expectedDraftRevision:editor.draftRevision,spec,inputSha256};
      artifactRewriteChallenges.set(id,challenge);
      return sendJson(response,200,{available:true,authorizationId:id,model:spec.model,maxBudgetUsd:spec.maxBudgetUsd,instruction,inputSha256,notice:'仅修改这份文字，不生成图片或视频。'});
    }
    if (action === 'rewrite') {
      if (request.method !== 'POST') return sendError(response,405,'请使用提交操作。');
      if (input.confirm !== true) return sendError(response,400,'请先确认本次文字修改与费用上限。');
      const challenge = artifactRewriteChallenges.get(input.authorizationId);
      if (!challenge || challenge.projectSlug!==project.slug || challenge.artifactId!==artifactId || challenge.principalId!==currentPrincipal().id || challenge.expiresAt<Date.now()) return sendError(response,409,'本次确认已失效，请重新查看修改与费用。');
      artifactRewriteChallenges.delete(input.authorizationId);
      const result = await rewriteArtifactEdit(project.root,{artifactId,sourceSha256:challenge.sourceSha256,expectedDraftRevision:challenge.expectedDraftRevision,instruction:challenge.spec.instruction},{rewrite:async ({fields,instruction})=>{
        const spec={...challenge.spec,fields,instruction};
        if(getArtifactRewriteFingerprint(spec)!==challenge.inputSha256) throw httpError(409,'原稿已变化，请重新确认。');
        const evidenceRoot = join(project.root,'runs','rewrite-authorizations');
        let claimed = false;
        try {
          return await rewriteArtifactFields({...spec,authorization:{scope:'artifact-text-rewrite',approved:true,requestId:challenge.id,inputSha256:challenge.inputSha256}},{consumeAuthorization:async authorization=>{
            await mkdir(evidenceRoot,{recursive:true});
            await writeFile(join(evidenceRoot,`${challenge.id}.json`),JSON.stringify({...authorization,projectSlug:challenge.projectSlug,principalId:challenge.principalId,artifactId,model:spec.model,maxBudgetUsd:spec.maxBudgetUsd,claimedAt:new Date().toISOString()}),{flag:'wx'});
            claimed = true;
            return true;
          },onExecutionResult:async metadata=>{
            await writeFile(join(evidenceRoot,`${challenge.id}.result.json`),JSON.stringify({...metadata,recordedAt:new Date().toISOString()}),{flag:'wx'});
          }});
        } catch (error) {
          if (claimed) {
            // Never persist arbitrary error text: executor stderr may contain private data.
            await writeFile(join(evidenceRoot,`${challenge.id}.failure.json`),JSON.stringify({requestId:challenge.id,inputSha256:challenge.inputSha256,status:'failed_or_unconfirmed',retryAuthorized:false,recordedAt:new Date().toISOString()}),{flag:'wx'});
          }
          throw error;
        }
      }});
      return sendJson(response,200,result);
    }
    return sendError(response,400,'不支持这项修改操作。');
  }

  const changePreviewRoute = /^\/api\/projects\/([^/]+)\/change-impact-preview$/.exec(pathname);
  if (request.method === 'POST' && changePreviewRoute) {
    const project = await findProject(decodeURIComponent(changePreviewRoute[1]));
    const input = await readRequestBody(request);
    return sendJson(response, 200, await loadChangeImpactPreview(project.root, input));
  }

  const changeRequestsRoute = /^\/api\/projects\/([^/]+)\/change-requests$/.exec(pathname);
  if (changeRequestsRoute && ['GET','POST'].includes(request.method)) {
    const project = await findProject(decodeURIComponent(changeRequestsRoute[1]));
    if (request.method === 'GET') return sendJson(response, 200, {requests: await listChangeRequests(project.root)});
    const input = await readRequestBody(request);
    return sendJson(response, 200, await recordChangeRequest(project.root, input));
  }

  const generationJobsRoute = /^\/api\/projects\/([^/]+)\/generation-jobs$/.exec(pathname);
  if (request.method === 'GET' && generationJobsRoute) {
    const project = await findProject(decodeURIComponent(generationJobsRoute[1]));
    const jobs = (await listStudioGenerationJobs(teamStateRoot)).filter(job => job.projectSlug === project.slug);
    return sendJson(response, 200, { jobs });
  }
  const generationJobRoute = /^\/api\/projects\/([^/]+)\/generation-jobs\/([^/]+)$/.exec(pathname);
  if (request.method === 'GET' && generationJobRoute) {
    const project = await findProject(decodeURIComponent(generationJobRoute[1]));
    const job = await readStudioGenerationJob(teamStateRoot, decodeURIComponent(generationJobRoute[2]));
    if (job.projectSlug !== project.slug) return sendError(response, 404, 'generation job not found');
    return sendJson(response, 200, { job });
  }
  const resumeGenerationJobPreflightRoute = /^\/api\/projects\/([^/]+)\/generation-jobs\/([^/]+)\/resume-preflight$/.exec(pathname);
  if (request.method === 'POST' && resumeGenerationJobPreflightRoute) {
    const project = await findProject(decodeURIComponent(resumeGenerationJobPreflightRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const principal = currentPrincipal();
    const id = decodeURIComponent(resumeGenerationJobPreflightRoute[2]);
    const job = await readStudioGenerationJob(teamStateRoot, id);
    if (job.projectSlug !== project.slug || job.status !== 'PAUSED_REQUIRES_CONFIRMATION'
      || (principal.role !== 'owner' && job.principalId !== principal.id)) return sendError(response, 404, 'generation job not found');
    if ((await listStudioTeam(teamStateRoot)).settings?.paidGenerationEnabled !== true) throw httpError(403, '所有者已暂停团队付费生成');
    const preflight = await preflightExistingStudioGenerationJob(project, job);
    if (preflight.fingerprintSha256 !== job.fingerprintSha256) throw httpError(409, '原付费任务指纹已经变化，不能恢复，也不能绕过原任务新建同段任务；请由所有者先终结或核对原任务。');
    const authorization = issueGenerationAuthorizationChallenge(project.slug, `resume-${job.kind}`, { jobId: job.id }, job.fingerprintSha256, preflight.summary);
    return sendJson(response, 200, {
      authorizationId: authorization.id,
      expiresAt: authorization.expiresAt,
      fingerprintSha256: authorization.fingerprintSha256,
      summary: authorization.summary,
      originalSubmitterId: job.originalSubmitterId ?? job.principalId
    });
  }
  const resumeGenerationJobRoute = /^\/api\/projects\/([^/]+)\/generation-jobs\/([^/]+)\/resume$/.exec(pathname);
  if (request.method === 'POST' && resumeGenerationJobRoute) {
    const project = await findProject(decodeURIComponent(resumeGenerationJobRoute[1]));
    const input = await readRequestBody(request);
    const principal = currentPrincipal();
    const id = decodeURIComponent(resumeGenerationJobRoute[2]);
    const { job, approval } = await serializeStudioControl(async () => {
      const current = await readStudioGenerationJob(teamStateRoot, id);
      if (current.projectSlug !== project.slug || (principal.role !== 'owner' && current.principalId !== principal.id)) throw httpError(404, 'generation job not found');
      if ((await listStudioTeam(teamStateRoot)).settings?.paidGenerationEnabled !== true) throw httpError(403, '所有者已暂停团队付费生成');
      const challenge = consumeGenerationAuthorizationChallenge(project.slug, `resume-${current.kind}`, input);
      if (challenge.request.jobId !== current.id || challenge.fingerprintSha256 !== current.fingerprintSha256) {
        throw httpError(409, '恢复授权不属于这笔原付费任务');
      }
      const approval = await createStudioGenerationResumeApproval(project.root, {
        authorizationId: challenge.id,
        jobId: current.id,
        kind: current.kind,
        originalSubmitterId: current.originalSubmitterId ?? current.principalId,
        authorizedByPrincipalId: principal.id,
        fingerprintSha256: challenge.fingerprintSha256,
        note: requiredText(input.note, 'note', 2000)
      });
      const job = await resumeStudioGenerationJob(teamStateRoot, id, {
        authorizedByPrincipalId: principal.id,
        resumeApprovalId: approval.id,
        fingerprintSha256: challenge.fingerprintSha256
      });
      return { job, approval };
    });
    kickStudioGenerationWorker();
    return sendJson(response, 200, { job, approval: { id: approval.id, maxPaidAttempts: 1, automaticRetry: false } });
  }
  const cancelPausedGenerationJobRoute = /^\/api\/projects\/([^/]+)\/generation-jobs\/([^/]+)\/cancel-paused$/.exec(pathname);
  if (request.method === 'POST' && cancelPausedGenerationJobRoute) {
    const project = await findProject(decodeURIComponent(cancelPausedGenerationJobRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const principal = currentPrincipal();
    const id = decodeURIComponent(cancelPausedGenerationJobRoute[2]);
    const current = await readStudioGenerationJob(teamStateRoot, id);
    if (current.projectSlug !== project.slug || (principal.role !== 'owner' && current.principalId !== principal.id)) throw httpError(404, 'generation job not found');
    const job = await cancelRestartPausedStudioGenerationJob(teamStateRoot, id, `由 ${principal.id} 明确取消重启后尚未提交供应商的暂停任务。`);
    return sendJson(response, 200, { job });
  }
  const videoPreflightRoute = /^\/api\/projects\/([^/]+)\/paid-video\/preflight$/.exec(pathname);
  if (request.method === 'POST' && videoPreflightRoute) {
    const project = await findProject(decodeURIComponent(videoPreflightRoute[1]));
    if ((await listStudioTeam(teamStateRoot)).settings?.paidGenerationEnabled !== true) throw httpError(403, '所有者已暂停团队付费生成');
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const segmentId = requiredText(input.segmentId, 'segmentId', 128);
    const blockingJob = await readBlockingStudioGenerationJob(teamStateRoot, { projectSlug: project.slug, kind: 'video', segmentId });
    if (blockingJob) throw httpError(409, `当前段已有未完成或待核对的视频任务 ${blockingJob.id}（${blockingJob.status}）；请先刷新状态或完成对账，不能新建同段付费任务。`);
    const team = await listStudioTeam(teamStateRoot);
    const projectUuid = requiredText(team.settings?.defaultLibTvProjectUuid, 'owner default LibTV project UUID', 32);
    const nodeName = requiredText(input.nodeName || `${segmentId}-seedance-video`, 'nodeName', 128);
    const model = requiredText(input.model || 'Seedance 2.0 VIP', 'model', 64);
    const preflight = await createVideoPreflight(project.root, segmentId, {
      executor: 'libtv', libtvProjectUuid: projectUuid, nodeName, model
    });
    const requestBinding = { segmentId, projectUuid, nodeName, model, preflightId: preflight.preflightId };
    const summary = {
      provider: preflight.generationContract.provider,
      model: preflight.generationContract.model,
      duration: preflight.duration,
      ratio: preflight.ratio,
      resolution: preflight.resolution,
      inputCounts: Object.fromEntries(Object.entries(preflight.fingerprint.inputMedia).map(([kind, items]) => [kind, items.length])),
      maxPaidAttempts: 1,
      automaticRetry: false
    };
    const blockerAfterPreflight = await readBlockingStudioGenerationJob(teamStateRoot, { projectSlug: project.slug, kind: 'video', segmentId });
    if (blockerAfterPreflight) throw httpError(409, `预检期间出现同段未决视频任务 ${blockerAfterPreflight.id}（${blockerAfterPreflight.status}）；本次不签发付费授权。`);
    const authorization = issueGenerationAuthorizationChallenge(project.slug, 'video', requestBinding, preflight.fingerprint.sha256, summary);
    return sendJson(response, 200, { authorizationId: authorization.id, expiresAt: authorization.expiresAt, fingerprintSha256: authorization.fingerprintSha256, summary });
  }
  const imagePreflightRoute = /^\/api\/projects\/([^/]+)\/paid-image\/preflight$/.exec(pathname);
  if (request.method === 'POST' && imagePreflightRoute) {
    const project = await findProject(decodeURIComponent(imagePreflightRoute[1]));
    if ((await listStudioTeam(teamStateRoot)).settings?.paidGenerationEnabled !== true) throw httpError(403, '所有者已暂停团队付费生成');
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const segmentId = requiredText(input.segmentId, 'segmentId', 128);
    const blockingJob = await readBlockingStudioGenerationJob(teamStateRoot, { projectSlug: project.slug, kind: 'image', segmentId });
    if (blockingJob) throw httpError(409, `当前段已有未完成或待核对的图片任务 ${blockingJob.id}（${blockingJob.status}）；请先刷新状态或完成对账，不能新建同段付费任务。`);
    const team = await listStudioTeam(teamStateRoot);
    const projectUuid = team.settings?.defaultLibTvProjectUuid ?? null;
    const model = requiredText(input.model || 'Seedream 4.5', 'model', 64);
    const requestBinding = { segmentId, projectUuid, model };
    const plan = await runGenerateAssets(imageGenerationArgs(project.root, requestBinding, false));
    const fingerprintSha256 = sha256Text(JSON.stringify(plan));
    const summary = { provider: 'libtv', model, taskCount: plan.assets.length, assetIds: plan.assets.map(item => item.assetId), maxPaidAttempts: 1, automaticRetry: false };
    const blockerAfterPreflight = await readBlockingStudioGenerationJob(teamStateRoot, { projectSlug: project.slug, kind: 'image', segmentId });
    if (blockerAfterPreflight) throw httpError(409, `预检期间出现同段未决图片任务 ${blockerAfterPreflight.id}（${blockerAfterPreflight.status}）；本次不签发付费授权。`);
    const authorization = issueGenerationAuthorizationChallenge(project.slug, 'image', requestBinding, fingerprintSha256, summary);
    return sendJson(response, 200, { authorizationId: authorization.id, expiresAt: authorization.expiresAt, fingerprintSha256, summary });
  }
  const paidSubmitRoute = /^\/api\/projects\/([^/]+)\/paid-(image|video)\/submit$/.exec(pathname);
  if (request.method === 'POST' && paidSubmitRoute) {
    const project = await findProject(decodeURIComponent(paidSubmitRoute[1]));
    const kind = paidSubmitRoute[2];
    const input = await readRequestBody(request);
    const principal = currentPrincipal();
    const { job, approval } = await serializeStudioControl(async () => {
      if ((await listStudioTeam(teamStateRoot)).settings?.paidGenerationEnabled !== true) throw httpError(403, '所有者已暂停团队付费生成');
      const challenge = consumeGenerationAuthorizationChallenge(project.slug, kind, input);
      const note = requiredText(input.note, 'note', 2000);
      const job = await createStudioGenerationJob(teamStateRoot, {
        kind,
        principalId: principal.id,
        projectSlug: project.slug,
        fingerprintSha256: challenge.fingerprintSha256,
        request: challenge.request,
        paidApprovalId: null
      });
      let approval;
      try {
        approval = kind === 'video'
          ? await createPaidGenerationApproval(project.root, {
            segmentId: challenge.request.segmentId,
            preflightId: challenge.request.preflightId,
            note
          }, { id: `review-${job.id}`, operatorId: principal.id })
          : await createStudioImageGenerationApproval(project.root, {
            jobId: job.id,
            principalId: principal.id,
            segmentId: challenge.request.segmentId,
            fingerprintSha256: challenge.fingerprintSha256,
            note
          });
      } catch (error) {
        const claimed = await claimStudioGenerationJob(teamStateRoot, job.id).catch(() => null);
        if (claimed) await failStudioGenerationJob(teamStateRoot, job.id, '审批记录未能持久化；任务未向供应商提交。', { uncertain: false });
        throw error;
      }
      return { job, approval };
    });
    kickStudioGenerationWorker();
    return sendJson(response, 202, { job, approval: { id: approval.id, maxPaidAttempts: 1, automaticRetry: false } });
  }

  const stagedReferenceRoute = /^\/api\/projects\/([^/]+)\/reference-staging$/.exec(pathname);
  if (request.method === 'POST' && stagedReferenceRoute) {
    const project = await findProject(decodeURIComponent(stagedReferenceRoute[1]));
    if (url.searchParams.get('confirm') !== 'true') return sendError(response, 400, 'human confirmation is required');
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) return sendError(response, 400, 'upload must contain a video');
    if (declaredLength > maxUploadBytes) return sendError(response, 413, `upload exceeds ${maxUploadBytes} bytes`);
    const filename = basename(url.searchParams.get('filename') ?? 'reference.mp4');
    const extension = extname(filename).toLowerCase();
    if (!mediaTypes[extension]?.startsWith('video/')) return sendError(response, 415, 'reference input must be a supported video file');
    const token = randomUUID();
    const relativePath = `brief/staging/${token}${extension}`;
    const file = safeFile(project.root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    let created = false;
    const destination = createWriteStream(file, { flags: 'wx' });
    destination.once('open', () => { created = true; });
    try {
      await pipeline(request, uploadLimiter(maxUploadBytes), destination);
      await validateMediaFile(file, 'video');
      return sendJson(response, 201, { token, filename, mimeType: mediaTypes[extension] });
    } catch (error) {
      if (created) await rm(file, { force: true }).catch(() => {});
      throw error;
    }
  }

  const detail = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  const gate5ReworkOrderRoute = /^\/api\/projects\/([^/]+)\/gate5-rework-orders$/.exec(pathname);
  if (request.method === 'POST' && gate5ReworkOrderRoute) {
    const project = await findProject(decodeURIComponent(gate5ReworkOrderRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const expected = project.next.actions?.[0];
    if (expected?.id !== 'prepare_gate5_rework_order' || expected.failureReturnId !== input.failureReturnId) {
      return sendError(response, 409, 'the Gate 5 failure return is no longer the current preparation action');
    }
    const result = await prepareGate5ReworkWorkOrder(project.root, {
      failureReturnId: input.failureReturnId,
      confirm: true
    });
    return sendJson(response, result.reused ? 200 : 201, result);
  }
  const gate5ReworkProgressRoute = /^\/api\/projects\/([^/]+)\/gate5-rework-orders\/([^/]+)\/progress$/.exec(pathname);
  if (request.method === 'POST' && gate5ReworkProgressRoute) {
    const project = await findProject(decodeURIComponent(gate5ReworkProgressRoute[1]));
    const workOrderId = decodeURIComponent(gate5ReworkProgressRoute[2]);
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const expected = project.next.actions?.find(action => action.workOrder?.id === workOrderId);
    if (!expected) return sendError(response, 409, 'the Gate 5 rework work order is no longer an active project action');
    const result = await updateGate5ReworkWorkOrderProgress(project.root, {
      workOrderId,
      action: input.action,
      stage: input.stage ?? null,
      reason: input.reason ?? null,
      note: input.note ?? null,
      evidence: input.evidence ?? [],
      confirm: true
    });
    return sendJson(response, result.reused ? 200 : 201, result);
  }
  const executionLedgerRoute = /^\/api\/projects\/([^/]+)\/execution-ledger$/.exec(pathname);
  if (request.method === 'GET' && executionLedgerRoute) {
    const project = await findProject(decodeURIComponent(executionLedgerRoute[1]));
    return sendJson(response, 200, await readExecutionLedgerStatus(project.root));
  }
  const workflowProfileRoute = /^\/api\/projects\/([^/]+)\/workflow-profile$/.exec(pathname);
  if (workflowProfileRoute) {
    const project = await findProject(decodeURIComponent(workflowProfileRoute[1]));
    if (request.method === 'GET') {
      return sendJson(response, 200, await getWorkflowProfileView(project.root));
    }
    if (request.method === 'POST') {
      const input = await readRequestBody(request);
      if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
      try {
        const record = await setWorkflowProfile(project.root, input);
        const interview = await synchronizeDirectorInterviewForWorkflow(project.root);
        return sendJson(response, 200, { workflowProfile: record, directorInterview: directorInterviewSummary(interview) });
      } catch (error) {
        return sendError(response, 409, error.message);
      }
    }
  }
  const remakeControlsRoute = /^\/api\/projects\/([^/]+)\/remake-controls$/.exec(pathname);
  if (remakeControlsRoute) {
    const project = await findProject(decodeURIComponent(remakeControlsRoute[1]));
    if (request.method === 'GET') {
      return sendJson(response, 200, await getWorkflowProfileView(project.root));
    }
    if (request.method === 'POST') {
      const input = await readRequestBody(request);
      if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
      try {
        const result = await setRemakeControlSelection(project.root, input);
        const interview = await synchronizeDirectorInterviewForWorkflow(project.root);
        return sendJson(response, 200, { ...result, directorInterview: directorInterviewSummary(interview) });
      } catch (error) {
        return sendError(response, 409, error.message);
      }
    }
  }
  const assetSelectionRoute = /^\/api\/projects\/([^/]+)\/asset-selection$/.exec(pathname);
  if (assetSelectionRoute) {
    const project = await findProject(decodeURIComponent(assetSelectionRoute[1]));
    if (request.method === 'GET') {
      return sendJson(response, 200, await getWorkflowProfileView(project.root));
    }
    if (request.method === 'POST') {
      const input = await readRequestBody(request);
      if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
      try {
        const record = await setAssetSelection(project.root, input);
        return sendJson(response, 200, { assetSelection: record });
      } catch (error) {
        return sendError(response, 409, error.message);
      }
    }
  }
  const simpleRemakeInputsRoute = /^\/api\/projects\/([^/]+)\/segments\/([^/]+)\/simple-remake-inputs$/.exec(pathname);
  if (request.method === 'POST' && simpleRemakeInputsRoute) {
    const project = await findProject(decodeURIComponent(simpleRemakeInputsRoute[1]));
    const segmentId = safeSegmentId(decodeURIComponent(simpleRemakeInputsRoute[2]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    let state = await readJson(join(project.root, 'project-state.json'));
    if (workflowProfileIdOf(state) !== 'simple_remake') return sendError(response, 409, '只有简单复刻项目可以直接绑定人物参考和原片音频。');
    if (!(await currentSegments(project.root, state)).some(segment => segment.id === segmentId)) {
      return sendError(response, 404, 'canonical segment not found');
    }
    const identityId = safeUploadId(input.identityArtifactId);
    const audioId = safeUploadId(input.audioArtifactId);
    const identity = state.artifacts.find(item => item.id === identityId);
    const audio = state.artifacts.find(item => item.id === audioId);
    if (!identity || identity.type !== 'segment_asset' || identity.segmentId !== segmentId
      || identity.assetType !== 'expression_board' || identity.mediaKind !== 'image'
      || identity.simpleRemakeIdentityReference !== true) {
      return sendError(response, 409, '人物参考图必须是本段已导入的表情参考图。');
    }
    if (!audio || audio.type !== 'segment_asset' || audio.segmentId !== segmentId
      || audio.assetType !== 'source_audio_candidate' || audio.mediaKind !== 'audio') {
      return sendError(response, 409, '原片音频必须是本段已导入的音频文件。');
    }
    await autoLockArtifact(project.root, identity.id,
      'auto-locked: 用户已指定此表情参考图只用于主角人脸身份与表情范围，不迁移服装、白底、九宫格版式、场景或镜头。',
      { delegatedByProfile: 'simple_remake' });
    await autoLockArtifact(project.root, audio.id,
      'auto-locked: 从锁定原片裁出的当前段原音频只用于台词、声线、节奏、环境声和口型时钟，不控制画面内容。',
      { delegatedByProfile: 'simple_remake' });
    state = await readJson(join(project.root, 'project-state.json'));
    const prior = state.assetSelection?.selected ?? [];
    const priorProvided = state.assetSelection?.userProvided ?? [];
    const assetSelection = await setAssetSelection(project.root, {
      selected: [...new Set([...prior, 'character_reference', 'voice_reference'])],
      userProvided: [...new Set([...priorProvided, 'character_reference', 'voice_reference'])]
    });
    const manifest = await compileProjectAssetManifest(project.root, segmentId);
    const unresolved = manifest.items.filter(item => item.status !== 'locked' || !item.path);
    if (unresolved.length > 0) {
      return sendError(response, 409, `当前段仍有未绑定输入：${unresolved.map(item => item.type).join('、')}。请重新导入对应文件后再继续。`);
    }
    await writeJsonAtomic(join(project.root, 'assets', `${segmentId}-asset-manifest.json`), manifest);
    const manifestReview = await runReviewAssetManifest([
      '--project', project.root, '--segment', segmentId,
      '--note', '简单复刻：系统已核对用户指定的人脸参考与当前段原片音频，并将其加入最小生成输入。'
    ], { delegatedByProfile: 'simple_remake' });
    return sendJson(response, 201, {
      assetSelection,
      manifest: { id: manifest.id, status: 'locked', itemCount: manifest.items.length, reviewId: manifestReview.id },
      message: '人物身份参考和原片音频已绑定；下一步只需重新整理生成提示与画布，不会生成视频。'
    });
  }
  if (request.method === 'GET' && detail) {
    const project = await findProject(decodeURIComponent(detail[1]));
    const state = await readJson(join(project.root, 'project-state.json'));
    const artifactIds = new Set(state.artifacts.map(artifact => artifact.id));
    const [creative, pendingCreative] = await Promise.all([
      latestLockedCreativeBrief(project.root, state),
      latestPendingCreativeBrief(project.root, state)
    ]);
    const [runs, reviews, segments, directorInterview, deliveryReceipt, generationJobs, sourceStoryboard, executionLedger] = await Promise.all([
      readJsonDirectory(project.root, 'runs'),
      readJsonDirectory(project.root, 'reviews'),
      currentSegments(project.root, state),
      getDirectorInterview(project.root),
      readJson(join(project.root, 'deliveries', 'final-delivery-receipt.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)),
      listStudioGenerationJobs(teamStateRoot),
      sourceStoryboardSummary(project),
      readExecutionLedgerStatus(project.root)
    ]);
    const production = await segmentProductionStatus(project.root, state, segments);
    const gateStates = await computeGateStates(project.root, state, segments, production, directorInterview);
    const projectGenerationJobs = generationJobs
      .filter(job => job.projectSlug === project.slug)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const studioFlow = projectHarness3060StudioProjection({
      state,
      routeDecision: state.routeDecision ?? null,
      segments,
      production,
      runs,
      reviews,
      generationJobs: projectGenerationJobs,
      nextAction: project.next?.actions?.[0] ?? null,
      deliveryReceipt
    });
    return sendJson(response, 200, {
      slug: project.slug,
      status: project.status,
      next: project.next,
      routeDecision: state.routeDecision ?? null,
      mechanicalCanvas: state.mechanicalCanvas ?? null,
      referenceWorkflow: state.referenceWorkflow ?? null,
      workflowVersion: state.workflowVersion ?? 1,
      ingressPolicyVersion: state.ingressPolicyVersion ?? null,
      directorInterview: directorInterviewSummary(directorInterview),
      creativeBrief: creativeSummary(creative),
      creativeRevision: creativeSummary(pendingCreative),
      compactGate2: compactGate2Eligibility(state, creative),
      workflowProfile: state.workflowProfile ?? null,
      workflowProfileId: workflowProfileIdOf(state),
      visibleSteps: visibleStepsForProject(state),
      assetSelection: state.assetSelection ?? null,
      workflowProfileView: await getWorkflowProfileView(project.root),
      sourceStoryboard,
      artifacts: state.artifacts.map(artifactSummary),
      segments: segments.map(segmentSummary),
      production,
      studioFlow,
      gateStates,
      runs: runs.filter(run => ['director_gate1', 'libtv_video', 'runninghub_video', 'libtv_canvas_preparation', 'video_preflight'].includes(run?.kind)).map(runSummary)
        .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? ''))),
      generationJobs: projectGenerationJobs,
      reviews: reviews.filter(review => review?.artifactId).map(review => reviewSummary(review, artifactIds))
        .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''))),
      blockedReason: state.blockedReason ?? null,
      verifiedCapabilityManifestId: state.verifiedCapabilityManifestId ?? null,
      deliveryReceipt,
      executionLedger
    });
  }

  const intakeRoute = /^\/api\/projects\/([^/]+)\/intake$/.exec(pathname);
  if (request.method === 'POST' && intakeRoute) {
    const project = await findProject(decodeURIComponent(intakeRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const requestText = requiredText(input.requestText, 'requestText', 12000);
    const referenceIntent = ['idea_only', 'inspiration_only', 'faithful_remake', 'source_modification'].includes(input.referenceIntent)
      ? input.referenceIntent : 'idea_only';
    let inputs = [];
    let stagedPath = null;
    if (input.stagedReference) {
      const token = requiredText(input.stagedReference.token, 'stagedReference.token', 64);
      if (!/^[a-f0-9-]{36}$/.test(token)) throw badRequest('stagedReference.token is invalid');
      const entries = await readdir(join(project.root, 'brief', 'staging')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const name = entries.find(entry => entry.startsWith(`${token}.`) && mediaTypes[extname(entry).toLowerCase()]?.startsWith('video/'));
      if (!name) throw badRequest('staged reference video was not found');
      stagedPath = join(project.root, 'brief', 'staging', name);
      inputs = [{
        id: requiredText(input.stagedReference.id, 'stagedReference.id', 192),
        type: 'video',
        path: stagedPath,
        mimeType: mediaTypes[extname(name).toLowerCase()]
      }];
    }
    const taskClass = ['creative_production', 'mechanical_asset_prompt'].includes(input.taskClass)
      ? input.taskClass : undefined;
    if (taskClass === 'mechanical_asset_prompt') {
      const existingProductAssets = (project.status.artifacts ?? []).filter(artifact => (
        artifact.type === 'project_asset'
          && artifact.assetType === 'product_reference'
          && typeof artifact.path === 'string'
      ));
      for (const artifact of existingProductAssets) {
        const extension = extname(artifact.path).toLowerCase();
        const mimeType = mediaTypes[extension];
        if (!mimeType?.startsWith('image/')) continue;
        inputs.push({ id: artifact.id, type: 'image', path: join(project.root, artifact.path), mimeType });
      }
    }
    const result = await persistVideoIntake(project.root, {
      requestText,
      requestKind: 'video_creation',
      explicitReferenceIntent: referenceIntent,
      explicitExecutionClass: taskClass,
      inputs
    });
    // Keep the staged source as recovery evidence: the response may be lost
    // after intake commits, and the same token must remain safe to replay.
    // persistVideoIntake verifies existing reference content before reuse.
    return sendJson(response, 200, {
      ...result,
      directorInterview: result.directorInterview ? directorInterviewSummary(result.directorInterview) : null
    });
  }

  const directorInterviewRoute = /^\/api\/projects\/([^/]+)\/director-interview$/.exec(pathname);
  if (request.method === 'GET' && directorInterviewRoute) {
    const project = await findProject(decodeURIComponent(directorInterviewRoute[1]));
    const interview = await getDirectorInterview(project.root);
    if (!interview) return sendError(response, 404, 'director interview has not been prepared for this project');
    return sendJson(response, 200, { interview });
  }

  if (request.method === 'POST' && directorInterviewRoute) {
    const project = await findProject(decodeURIComponent(directorInterviewRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (!['answer_director_interview', 'prepare_creative_brief'].includes(project.next.actions?.[0]?.id)) {
      return sendError(response, 409, 'Gate 0 director answers can only be completed while the interview is current and before a Gate 1 draft exists');
    }
    const state = await readJson(join(project.root, 'project-state.json'));
    const interview = await answerDirectorInterview(project.root, {
      answers: input.answers,
      routeDecision: state.routeDecision
    });
    return sendJson(response, 200, { interview });
  }

  const directorEngineRoute = /^\/api\/projects\/([^/]+)\/director-engine$/.exec(pathname);
  if (request.method === 'GET' && directorEngineRoute) {
    const project = await findProject(decodeURIComponent(directorEngineRoute[1]));
    const interview = await getDirectorInterview(project.root);
    if (interview?.status !== 'complete' || interview.gate1DraftTask?.status !== 'ready_for_director_engine') {
      return sendError(response, 409, 'complete the Gate 0 director interview before opening the Director Engine');
    }
    const requestedModel = url.searchParams.get('model') || null;
    const configuration = await directorEngineConfiguration(project.root, requestedModel);
    const directorRequest = await buildGate1DirectorPrompt(project.root);
    const authorizationChallenge = configuration.available
      ? issueDirectorAuthorizationChallenge(project.slug, directorRequest, configuration)
      : null;
    return sendJson(response, 200, { configuration, task: interview.gate1DraftTask, authorizationChallenge });
  }

  const readinessRoute = /^\/api\/projects\/([^/]+)\/operational-readiness$/.exec(pathname);
  if (request.method === 'GET' && readinessRoute) {
    const project = await findProject(decodeURIComponent(readinessRoute[1]));
    const currentAction = project.next.actions?.[0]?.id ?? null;
    const readinessState = await readJson(join(project.root, 'project-state.json'));
    const readinessSegments = await currentSegments(project.root, readinessState);
    const readinessProduction = await segmentProductionStatus(project.root, readinessState, readinessSegments);
    const mechanicalPackageAction = currentAction === 'prepare_mechanical_asset_prompt_package';
    const mechanicalCanvasAction = currentAction === 'prepare_mechanical_libtv_canvas';
    const libtvRequired = readinessProduction.some(item => item.readyForCanvas === true) || mechanicalCanvasAction;
    const [directorConfiguration, ffmpeg, ffprobe, libtv] = await Promise.all([
      directorEngineConfiguration(project.root),
      localToolCapability('ffmpeg', ['-version'], 'FFmpeg', currentAction === 'complete_observed_handoff' || mechanicalPackageAction),
      localToolCapability('ffprobe', ['-version'], 'FFprobe', currentAction === 'complete_observed_handoff' || mechanicalPackageAction),
      localToolCapability('libtv', ['--help'], 'LibTV CLI', libtvRequired)
    ]);
    const readiness = await assessStudioOperationalReadiness(project.root, {
      directorConfiguration,
      dependencies: { ffmpeg, ffprobe, libtv }
    });
    return sendJson(response, 200, readiness);
  }

  const directorGenerateRoute = /^\/api\/projects\/([^/]+)\/director-engine\/generate$/.exec(pathname);
  if (request.method === 'POST' && directorGenerateRoute) {
    const project = await findProject(decodeURIComponent(directorGenerateRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true || input.authorization !== 'AUTHORIZE_ONE_GATE1_TEXT_DRAFT') {
      return sendError(response, 400, 'explicit one-call Director Engine authorization is required');
    }
    const authorizationChallenge = consumeDirectorAuthorizationChallenge(project.slug, input);
    const configuration = await directorEngineConfiguration(project.root, input.model);
    if (!configuration.available) return sendError(response, 409, configuration.reason);
    if (input.model !== configuration.model || Number(input.maxBudgetUsd) !== configuration.maxBudgetUsd) {
      return sendError(response, 409, 'Director Engine model or budget changed; review the current authorization screen again');
    }
    try {
      const adapter = new OpenCodexDirectorAdapter({
        cwd: project.root,
        model: configuration.model,
        maxBudgetUsd: configuration.maxBudgetUsd
      });
      const result = await generateGate1CreativeBrief(project.root, {
        adapter,
        authorization: {
          id: authorizationChallenge.id,
          scope: 'one_gate1_text_draft',
          projectId: authorizationChallenge.projectId,
          taskSha256: authorizationChallenge.taskSha256,
          promptSha256: authorizationChallenge.promptSha256,
          model: configuration.model,
          maxBudgetUsd: configuration.maxBudgetUsd,
          confirmedAt: new Date().toISOString(),
          expiresAt: authorizationChallenge.expiresAt,
          actor: 'local_user_via_studio'
        }
      });
      return sendJson(response, 201, { artifact: artifactSummary(result.artifact), run: runSummary(result.run) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Director Engine failed';
      const status = error instanceof OpenCodexDirectorExecutionError ? 502
        : /draft must|creativeDecision|schema|required|must be/.test(message) ? 422 : 409;
      return sendError(response, status, message);
    }
  }

  const directorRecoverRoute = /^\/api\/projects\/([^/]+)\/director-engine\/recover$/.exec(pathname);
  if (request.method === 'POST' && directorRecoverRoute) {
    const project = await findProject(decodeURIComponent(directorRecoverRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const action = project.next.actions?.find(item => item.id === 'resolve_director_run');
    const runId = requiredText(input.runId, 'runId', 192);
    const candidate = action?.runs?.find(run => run.id === runId);
    if (!candidate || candidate.status !== 'MODEL_SUCCEEDED_UNCOMMITTED' || candidate.paidModelCallCompleted !== true) {
      return sendError(response, 409, 'this Director Engine run has no verified saved result that can be committed safely');
    }
    try {
      const result = await recoverGate1CreativeBrief(project.root, runId);
      return sendJson(response, 201, { artifact: artifactSummary(result.artifact), run: runSummary(result.run), reused: result.reused });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Director Engine recovery failed';
      return sendError(response, /draft must|creativeDecision|schema|required|must be/.test(message) ? 422 : 409, message);
    }
  }

  const directorResolveRoute = /^\/api\/projects\/([^/]+)\/director-engine\/resolve$/.exec(pathname);
  if (request.method === 'POST' && directorResolveRoute) {
    const project = await findProject(decodeURIComponent(directorResolveRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true || input.decision !== 'manual_fallback_without_model_retry') {
      return sendError(response, 400, 'explicit manual fallback confirmation is required');
    }
    const action = project.next.actions?.find(item => item.id === 'resolve_director_run');
    const runId = requiredText(input.runId, 'runId', 192);
    if (!action?.runs?.some(run => run.id === runId)) {
      return sendError(response, 409, 'this Director Engine run is not awaiting a recovery decision');
    }
    try {
      const run = await resolveGate1DirectorRunWithManualFallback(project.root, runId, input.note);
      return sendJson(response, 200, { run: runSummary(run), retryProhibitedForTask: true });
    } catch (error) {
      return sendError(response, error instanceof TypeError ? 422 : 409, error instanceof Error ? error.message : 'Director Engine resolution failed');
    }
  }

  const creativeTemplateRoute = /^\/api\/projects\/([^/]+)\/creative-brief-template$/.exec(pathname);
  if (request.method === 'GET' && creativeTemplateRoute) {
    const project = await findProject(decodeURIComponent(creativeTemplateRoute[1]));
    const state = await readJson(join(project.root, 'project-state.json'));
    if (!state.routeDecision?.harnessRequired) return sendError(response, 409, 'a persisted Harness intake route is required');
    const template = await readJson(join(repositoryRoot, 'templates', 'project', 'creative-brief-input.json'));
    template.id = `creative-brief-${Date.now()}`;
    template.projectId = state.projectId;
    template.creativeDecision.referenceWorkflow = structuredClone(state.referenceWorkflow);
    return sendJson(response, 200, { template, routeDecision: state.routeDecision });
  }

  const creativeBriefRoute = /^\/api\/projects\/([^/]+)\/creative-briefs$/.exec(pathname);
  if (request.method === 'POST' && creativeBriefRoute) {
    const project = await findProject(decodeURIComponent(creativeBriefRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const state = await readJson(join(project.root, 'project-state.json'));
    const directorInterview = await getDirectorInterview(project.root);
    if (directorInterview && directorInterview.status !== 'complete') {
      return sendError(response, 409, 'complete the Gate 0 director interview before creating a Gate 1 draft');
    }
    const brief = compactCreativeBrief(state.projectId, state.routeDecision, input);
    const artifact = await createCreativeBrief(project.root, brief);
    return sendJson(response, 201, { artifact });
  }

  const fullCreativeBriefRoute = /^\/api\/projects\/([^/]+)\/creative-briefs\/full$/.exec(pathname);
  if (request.method === 'POST' && fullCreativeBriefRoute) {
    const project = await findProject(decodeURIComponent(fullCreativeBriefRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (project.next.actions?.[0]?.id !== 'prepare_creative_brief') {
      return sendError(response, 409, 'Gate 1 can only be created when the current project action is prepare_creative_brief');
    }
    if (!input.brief || typeof input.brief !== 'object' || Array.isArray(input.brief)) return sendError(response, 400, 'brief must be a JSON object');
    const state = await readJson(join(project.root, 'project-state.json'));
    const directorInterview = await getDirectorInterview(project.root);
    if (directorInterview && directorInterview.status !== 'complete') {
      return sendError(response, 409, 'complete the Gate 0 director interview before creating a Gate 1 draft');
    }
    const brief = structuredClone(input.brief);
    brief.schemaVersion = 3;
    brief.projectId = state.projectId;
    brief.creativeDecision ??= {};
    brief.creativeDecision.referenceWorkflow = structuredClone(state.referenceWorkflow);
    const artifact = await createCreativeBrief(project.root, brief);
    return sendJson(response, 201, { artifact });
  }

  const storyPlanRoute = /^\/api\/projects\/([^/]+)\/story-plans$/.exec(pathname);
  const lightweightStoryPlanRoute = /^\/api\/projects\/([^/]+)\/story-plans\/auto-lightweight$/.exec(pathname);
  const machineReviewStoryPlanRoute = /^\/api\/projects\/([^/]+)\/story-plans\/machine-review$/.exec(pathname);
  const storyPlanTemplateRoute = /^\/api\/projects\/([^/]+)\/story-plan-template$/.exec(pathname);
  if (request.method === 'GET' && storyPlanTemplateRoute) {
    const project = await findProject(decodeURIComponent(storyPlanTemplateRoute[1]));
    const state = await readJson(join(project.root, 'project-state.json'));
    const creative = await latestLockedCreativeBrief(project.root, state);
    if (!creative) return sendError(response, 409, 'a locked Gate 1 creative brief is required before Gate 2');
    const template = await readJson(join(repositoryRoot, 'templates', 'project', 'story-plan-input.json'));
    template.id = `story-plan-${Date.now()}`;
    template.projectId = state.projectId;
    template.creativeBriefId = creative.artifact.id;
    delete template.targetDurationSec;
    delete template.creativeDecision;
    return sendJson(response, 200, { template, creativeBrief: creativeSummary(creative) });
  }

  const sourceFactTemplateRoute = /^\/api\/projects\/([^/]+)\/source-fact-template$/.exec(pathname);
  if (request.method === 'GET' && sourceFactTemplateRoute) {
    const project = await findProject(decodeURIComponent(sourceFactTemplateRoute[1]));
    const state = await readJson(join(project.root, 'project-state.json'));
    const sourceVideoId = project.next.actions?.find(action => action.id === 'prepare_source_fact_analysis')?.sourceVideoIds?.[0]
      ?? state.routeDecision?.sourceVideoIds?.[0];
    const reference = state.artifacts.find(item => item.id === sourceVideoId && item.type === 'reference_video' && item.status === 'locked');
    if (!reference) return sendError(response, 409, 'a locked reference video is required');
    return sendJson(response, 200, {
      template: {
        projectId: state.projectId,
        referenceVideo: { artifactId: reference.id, artifactRevision: reference.revision, artifactSha256: reference.sha256 },
        durationSec: 0,
        samplingStrategy: {
          version: 'adaptive-source-sampling-v1',
          normal: { mode: 'uniform_low_frequency', targetFps: 1 },
          strongAction: { mode: 'dense_action_sampling', targetFps: 6 }
        },
        timeline: []
      },
      notice: 'Fill durationSec and a contiguous evidence timeline from actual video observation. Empty or invented evidence is rejected.'
    });
  }

  const sourceFactRoute = /^\/api\/projects\/([^/]+)\/source-facts$/.exec(pathname);
  if (request.method === 'POST' && sourceFactRoute) {
    const project = await findProject(decodeURIComponent(sourceFactRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (project.next.actions?.[0]?.id !== 'prepare_source_fact_analysis') {
      return sendError(response, 409, 'source facts can only be imported when the current action is prepare_source_fact_analysis');
    }
    if (!input.analysis || typeof input.analysis !== 'object' || Array.isArray(input.analysis)) return sendError(response, 400, 'analysis must be a JSON object');
    const state = await readJson(join(project.root, 'project-state.json'));
    const analysis = structuredClone(input.analysis);
    analysis.projectId = state.projectId;
    const result = await persistSourceFactAnalysis(project.root, analysis);
    return sendJson(response, 201, result);
  }

  if (request.method === 'POST' && storyPlanRoute) {
    const project = await findProject(decodeURIComponent(storyPlanRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const state = await readJson(join(project.root, 'project-state.json'));
    const creative = await latestLockedCreativeBrief(project.root, state);
    if (!creative) return sendError(response, 409, 'a locked Gate 1 creative brief is required before Gate 2');
    const eligibility = compactGate2Eligibility(state, creative);
    if (!eligibility.supported) return sendError(response, 409, eligibility.reason);
    if (project.next.actions?.[0]?.id !== 'prepare_story_plan') {
      return sendError(response, 409, 'Gate 2 can only be created when the current project action is prepare_story_plan');
    }
    const plan = compactStoryPlan(state.projectId, creative.artifact, creative.value, input, workflowProfileIdOf(state));
    const artifact = await createStoryPlan(project.root, plan);
    return sendJson(response, 201, { artifact });
  }

  if (request.method === 'POST' && lightweightStoryPlanRoute) {
    const project = await findProject(decodeURIComponent(lightweightStoryPlanRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const state = await readJson(join(project.root, 'project-state.json'));
    const creative = await latestLockedCreativeBrief(project.root, state);
    if (!creative) return sendError(response, 409, 'a locked Gate 1 creative brief is required before Gate 2');
    const profileId = workflowProfileIdOf(state);
    const assetAnchored = isAssetAnchoredReferenceWorkflow(creative.value?.creativeDecision?.referenceWorkflow, creative.value?.creativeDecision);
    if (!assetAnchored && profileId !== 'simple_remake') {
      return sendError(response, 409, '当前项目不是轻量路线');
    }
    if (project.next.actions?.[0]?.id !== 'prepare_story_plan') {
      return sendError(response, 409, '轻量 Gate 2 只能在当前项目动作是 prepare_story_plan 时创建');
    }
    const durationSec = creative.value?.targetDurationSec;
    const autoInput = { autoGenerate: true };
    if (profileId === 'simple_remake') {
      autoInput.selectedModes = state.remakeControlSelection?.selectedModes ?? ['native_source'];
      if (Number.isFinite(durationSec) && durationSec > SIMPLE_REMAKE_UNIT_SEC) {
        autoInput.roughStoryboardPreviewPath = await ensureSimpleRemakeRoughPreview(
          project.root, state, Math.ceil(durationSec / SIMPLE_REMAKE_UNIT_SEC)
        );
      }
    }
    const plan = compactStoryPlan(state.projectId, creative.artifact, creative.value, autoInput, profileId);
    const artifact = await createStoryPlan(project.root, plan);
    if (profileId === 'simple_remake') {
      const machine = await machineApproveDelegatedStoryPlan(project.root);
      return sendJson(response, 201, { artifact, mode: 'simple_remake', machineReviewed: true, machine });
    }
    return sendJson(response, 201, { artifact, mode: 'asset_anchored' });
  }

  if (request.method === 'POST' && machineReviewStoryPlanRoute) {
    const project = await findProject(decodeURIComponent(machineReviewStoryPlanRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (project.next.actions?.[0]?.id !== 'machine_review_story_plan') {
      return sendError(response, 409, '故事与镜头机审只能处理当前待机审草稿');
    }
    const machine = await machineApproveDelegatedStoryPlan(project.root);
    return sendJson(response, 201, { machineReviewed: true, machine });
  }

  const mechanicalPackageRoute = /^\/api\/projects\/([^/]+)\/mechanical-package$/.exec(pathname);
  if (request.method === 'POST' && mechanicalPackageRoute) {
    const project = await findProject(decodeURIComponent(mechanicalPackageRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (!['prepare_mechanical_asset_prompt_package', 'prepare_mechanical_libtv_canvas', 'mechanical_canvas_ready']
      .includes(project.next.actions?.[0]?.id)) {
      return sendError(response, 409, '当前项目不处于机械资产与提示词快路径');
    }
    const options = {};
    if (input.segmentDurationSec !== undefined) {
      const value = Number(input.segmentDurationSec);
      if (!Number.isInteger(value) || value < 4 || value > 15) return sendError(response, 400, 'segmentDurationSec must be an integer from 4 to 15');
      options.segmentDurationSec = value;
    }
    if (input.maxDurationSec !== undefined && input.maxDurationSec !== null) {
      const value = Number(input.maxDurationSec);
      if (!Number.isFinite(value) || value < 4) return sendError(response, 400, 'maxDurationSec must be a finite number of at least 4');
      options.maxDurationSec = value;
    }
    const prepared = await prepareMechanicalAssetPromptPackage(project.root, options);
    let canvas = null;
    if (input.projectUuid !== undefined && input.projectUuid !== null && String(input.projectUuid).trim() !== '') {
      canvas = await prepareMechanicalLibTvCanvas(project.root, { projectUuid: String(input.projectUuid).trim() });
    }
    return sendJson(response, 201, { artifact: prepared.artifact, package: prepared.package, reused: prepared.reused, canvas });
  }

  const mechanicalCanvasRoute = /^\/api\/projects\/([^/]+)\/mechanical-canvas$/.exec(pathname);
  if (request.method === 'POST' && mechanicalCanvasRoute) {
    const project = await findProject(decodeURIComponent(mechanicalCanvasRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (project.next.actions?.[0]?.id !== 'prepare_mechanical_libtv_canvas') {
      return sendError(response, 409, '机械任务必须先完成本地切分与提示词编译');
    }
    const projectUuid = String(input.projectUuid ?? '').trim();
    if (!/^[a-f0-9]{32}$/.test(projectUuid)) return sendError(response, 400, 'projectUuid must be a 32-character lowercase LibTV UUID');
    const canvas = await prepareMechanicalLibTvCanvas(project.root, { projectUuid });
    return sendJson(response, 201, { canvas });
  }

  const fullStoryPlanRoute = /^\/api\/projects\/([^/]+)\/story-plans\/full$/.exec(pathname);
  if (request.method === 'POST' && fullStoryPlanRoute) {
    const project = await findProject(decodeURIComponent(fullStoryPlanRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (project.next.actions?.[0]?.id !== 'prepare_story_plan') {
      return sendError(response, 409, 'Gate 2 can only be created when the current project action is prepare_story_plan');
    }
    const state = await readJson(join(project.root, 'project-state.json'));
    const creative = await latestLockedCreativeBrief(project.root, state);
    if (!creative) return sendError(response, 409, 'a locked Gate 1 creative brief is required before Gate 2');
    if (!input.plan || typeof input.plan !== 'object' || Array.isArray(input.plan)) return sendError(response, 400, 'plan must be a JSON object');
    const plan = structuredClone(input.plan);
    plan.schemaVersion = 2;
    plan.projectId = state.projectId;
    plan.creativeBriefId = creative.artifact.id;
    delete plan.targetDurationSec;
    delete plan.creativeDecision;
    const artifact = await createStoryPlan(project.root, plan);
    return sendJson(response, 201, { artifact });
  }

  const uploadRoute = /^\/api\/projects\/([^/]+)\/uploads$/.exec(pathname);
  if (request.method === 'POST' && uploadRoute) {
    const project = await findProject(decodeURIComponent(uploadRoute[1]));
    if (url.searchParams.get('confirm') !== 'true') return sendError(response, 400, 'human confirmation is required');
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) return sendError(response, 400, 'upload must contain a file');
    if (declaredLength > maxUploadBytes) return sendError(response, 413, `upload exceeds ${maxUploadBytes} bytes`);
    const filename = basename(url.searchParams.get('filename') ?? 'upload.bin');
    const extension = extname(filename).toLowerCase();
    if (!mediaTypes[extension]) return sendError(response, 415, 'only supported image, audio, or video files can be uploaded');
    const uploadLimit = uploadLimitFor(extension);
    if (declaredLength > uploadLimit) return sendError(response, 413, `upload exceeds ${uploadLimit} bytes for this media type`);
    const state = await readJson(join(project.root, 'project-state.json'));
    const type = url.searchParams.get('artifactType');
    if (!uploadableTypes.has(type)) return sendError(response, 400, 'artifactType is not uploadable');
    if (['video_segment', 'final_edit'].includes(type) && !mediaTypes[extension].startsWith('video/')) {
      return sendError(response, 415, `${type} must be a supported video file`);
    }
    const artifactId = safeUploadId(url.searchParams.get('artifactId'));
    const provisionalPath = `uploads/${artifactId}${extension}`;
    const descriptor = uploadDescriptor(state, url.searchParams, extension, provisionalPath);
    if (type === 'segment_asset') await validateSegmentUploadBinding(project.root, state, descriptor);
    if (type === 'final_edit') await validateFinalEditSources(project.root, state, descriptor);
    const segmentId = descriptor.segmentId;
    const directory = type === 'project_asset' ? join('assets', 'project', 'uploads')
      : type === 'segment_asset' ? join('assets', segmentId, 'uploads')
        : type === 'final_edit' ? join('outputs', 'final')
          : join('outputs', segmentId);
    const relativePath = join(directory, `${artifactId}${extension}`).split(sep).join('/');
    const file = safeFile(project.root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    let created = false;
    const destination = createWriteStream(file, { flags: 'wx' });
    destination.once('open', () => { created = true; });
    try {
      await pipeline(request, uploadLimiter(uploadLimit), destination);
      const expectedKind = mediaTypes[extension].startsWith('video/') ? 'video' : mediaTypes[extension].startsWith('audio/') ? 'audio' : 'image';
      await validateMediaFile(file, expectedKind);
      descriptor.path = relativePath;
      const artifact = await registerArtifact(project.root, descriptor);
      return sendJson(response, 201, { artifact: artifactSummary(artifact) });
    } catch (error) {
      if (created) await rm(file, { force: true }).catch(() => {});
      throw error;
    }
  }

  const segmentationRoute = /^\/api\/projects\/([^/]+)\/operations\/canonical-segmentation$/.exec(pathname);
  if (request.method === 'POST' && segmentationRoute) {
    const project = await findProject(decodeURIComponent(segmentationRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (project.next.actions?.[0]?.id !== 'propose_segmentation') {
      return sendError(response, 409, 'canonical segmentation can only be created when the current action is propose_segmentation');
    }
    const state = await readJson(join(project.root, 'project-state.json'));
    const story = await latestLockedStoryPlan(project.root, state);
    if (!story) return sendError(response, 409, 'a locked story plan is required');
    const capabilityArtifact = state.artifacts.find(item => item.id === state.verifiedCapabilityManifestId
      && item.type === 'capability_manifest' && item.status === 'locked');
    if (!capabilityArtifact) return sendError(response, 409, 'a verified capability manifest is required');
    const capability = await readJson(safeFile(project.root, capabilityArtifact.path));
    const segments = canonicalSegmentsFromStoryPlan(story.value, capability);
    const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'segmentation').map(item => item.revision)) + 1;
    const id = `segmentation-r${revision}`;
    const artifact = await persistSegmentation(project.root, {
      id,
      revision,
      path: `segments/${id}.json`,
      segments,
      storyPlanBinding: {
        storyPlanId: story.artifact.id,
        storyPlanSemanticSha256: storyPlanSegmentationFingerprint(story.value)
      }
    });
    const review = await autoLockArtifact(project.root, artifact.id,
      'auto-locked: canonical segments were deterministically derived from the exact locked Gate 2 story plan and capability route');
    return sendJson(response, 201, { artifactId: artifact.id, reviewId: review.id, segments });
  }

  const sourceComparatorRoute = /^\/api\/projects\/([^/]+)\/operations\/source-comparator$/.exec(pathname);
  if (request.method === 'POST' && sourceComparatorRoute) {
    const project = await findProject(decodeURIComponent(sourceComparatorRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const action = project.next.actions?.find(item => item.id === 'run_source_comparator_audit');
    if (!action) return sendError(response, 409, 'source comparator is not the current project action');
    const state = await readJson(join(project.root, 'project-state.json'));
    const story = state.artifacts.find(item => item.id === action.storyPlanId && item.type === 'story_plan');
    if (!story) return sendError(response, 409, 'current story plan was not found');
    const storyValue = await readJson(safeFile(project.root, story.path));
    const sourceVideoIds = storyValue.sourceFactContract?.sourceVideoIds;
    if (!Array.isArray(sourceVideoIds) || sourceVideoIds.length !== 1) {
      return sendError(response, 409, 'source comparator requires exactly one source video bound by the current story plan');
    }
    const source = state.artifacts
      .filter(item => item.type === 'source_fact_analysis' && item.status === 'locked' && item.sourceVideoId === sourceVideoIds[0])
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!source) return sendError(response, 409, `a locked source fact analysis for ${sourceVideoIds[0]} is required`);
    const result = await persistSourceComparatorAudit(project.root, { sourceAnalysisId: source.id, storyPlanId: story.id });
    return sendJson(response, 201, result);
  }

  const rubricRoute = /^\/api\/projects\/([^/]+)\/operations\/quality-rubric$/.exec(pathname);
  if (request.method === 'POST' && rubricRoute) {
    const project = await findProject(decodeURIComponent(rubricRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (!project.next.actions?.some(action => action.id === 'create_quality_rubric')) {
      return sendError(response, 409, 'quality rubric is not a current project prerequisite');
    }
    const state = await readJson(join(project.root, 'project-state.json'));
    const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'quality_rubric').map(item => item.revision)) + 1;
    const rubric = assertQualityRubric(await readJson(join(repositoryRoot, 'templates', 'project', 'quality-rubric.json')));
    rubric.id = `quality-rubric-r${revision}`;
    // `version` is the rubric schema/contract version, not the artifact
    // revision.  Overwriting v2 with revision 1 makes every new workflow-v2
    // project fail when its first segment contract is created.
    rubric.version = Math.max(2, rubric.version);
    const path = `brief/${rubric.id}.json`;
    await writeJsonAtomic(join(project.root, path), rubric);
    const artifact = await registerArtifact(project.root, {
      id: rubric.id, type: 'quality_rubric', revision, status: 'draft', path
    });
    const review = await autoLockArtifact(project.root, artifact.id,
      'auto-locked: canonical quality rubric passed schema and weight validation');
    return sendJson(response, 201, { artifactId: artifact.id, reviewId: review.id, rubric });
  }

  const contractRoute = /^\/api\/projects\/([^/]+)\/operations\/segment-contract$/.exec(pathname);
  if (request.method === 'POST' && contractRoute) {
    const project = await findProject(decodeURIComponent(contractRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const action = project.next.actions?.find(item => item.id === 'create_segment_contract');
    if (!action) return sendError(response, 409, 'segment contract is not the current project action');
    const state = await readJson(join(project.root, 'project-state.json'));
    let rubric = state.artifacts
      .filter(item => item.type === 'quality_rubric' && item.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!rubric) return sendError(response, 409, 'a locked quality rubric is required');
    // Repair rubrics created by the old Studio bug that confused artifact
    // revision 1 with rubric contract version 1. Publish a fresh v2 artifact;
    // preserve the old locked artifact as historical evidence.
    const rubricPayload = await readJson(join(project.root, rubric.path));
    if (state.videoGovernanceVersion === 2 && rubricPayload.version < 2) {
      const rubricRevision = Math.max(0, ...state.artifacts.filter(item => item.type === 'quality_rubric').map(item => item.revision)) + 1;
      const repairedRubric = assertQualityRubric(await readJson(join(repositoryRoot, 'templates', 'project', 'quality-rubric.json')));
      repairedRubric.id = `quality-rubric-r${rubricRevision}`;
      repairedRubric.version = Math.max(2, repairedRubric.version);
      const repairedPath = `brief/${repairedRubric.id}.json`;
      await writeJsonAtomic(join(project.root, repairedPath), repairedRubric);
      const repairedArtifact = await registerArtifact(project.root, {
        id: repairedRubric.id, type: 'quality_rubric', revision: rubricRevision, status: 'draft', path: repairedPath,
        supersedesArtifactId: rubric.id
      });
      await autoLockArtifact(project.root, repairedArtifact.id,
        'auto-locked: repaired Studio rubric schema version while preserving the prior artifact as historical evidence');
      rubric = repairedArtifact;
    }
    const segmentId = action.segmentId;
    const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'segment_contract' && item.segmentId === segmentId).map(item => item.revision)) + 1;
    const artifact = await createSegmentContract(project.root, {
      id: `${segmentId}-contract-r${revision}`,
      segmentId,
      revision,
      rubricId: rubric.id,
      immutableConstraints: [
        '执行必须忠于已锁定 Gate 2 故事与镜头合同',
        '不得使用未锁定或已被取代的资产',
        '付费视频生成只能由用户在 LibTV 画布内点击'
      ],
      assetResponsibilities: {},
      executionControl: {
        version: 1,
        plannedShotCount: 1,
        generatedUnitShotCount: 1,
        executionUnitStrategy: 'segmented_editorial',
        requiresIndependentShotControl: false,
        platformCapability: {
          surface: 'LibTV Seedance node',
          profileId: 'seedance-2-libtv-v1',
          parameter: 'multi_shots',
          exposed: false,
          enabled: false,
          evidence: '当前生成单元按一个 15 秒源片时间窗独立生成，不声明或依赖多镜控制能力'
        }
      },
      allowedStrategies: ['refine', 'pivot', 'escalate'],
      attemptPolicy: { automaticPaidRetries: false, maxPaidAttempts: 1, maxAssetAttempts: 2 },
      completionEvidence: ['锁定资产清单', '提示词及输入指纹', '独立预审结论', '用户 Gate 5 审片记录']
    });
    const review = await autoLockArtifact(project.root, artifact.id,
      'auto-locked: segment contract is bound to current canonical segmentation and quality rubric');
    return sendJson(response, 201, { artifactId: artifact.id, reviewId: review.id, segmentId });
  }

  const productionRoute = /^\/api\/projects\/([^/]+)\/segments\/([^/]+)\/production\/(asset-manifest|asset-manifest-approval|narration|narration-auto|prompt|prompt-auto|compile|independent-audit-template|independent-audit)$/.exec(pathname);
  if (productionRoute) {
    const project = await findProject(decodeURIComponent(productionRoute[1]));
    const segmentId = safeSegmentId(decodeURIComponent(productionRoute[2]));
    const operation = productionRoute[3];
    const state = await readJson(join(project.root, 'project-state.json'));
    const segments = await currentSegments(project.root, state);
    if (!segments.some(segment => segment.id === segmentId)) return sendError(response, 404, 'canonical segment not found');

    if (request.method === 'GET' && operation === 'narration') {
      const template = await readJson(join(repositoryRoot, 'templates', 'project', 'shot-narration-input.json'));
      const capability = state.artifacts.find(item => item.id === state.verifiedCapabilityManifestId && item.type === 'capability_manifest' && item.status === 'locked');
      const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'shot_narration' && item.segmentId === segmentId).map(item => item.revision)) + 1;
      template.id = `narration-${segmentId}-r${revision}`;
      template.segmentId = segmentId;
      template.sourceSegmentId = segmentId;
      template.revision = revision;
      template.status = 'draft';
      if (capability) {
        template.capabilityManifestId = capability.id;
        template.capabilityManifestSha256 = capability.sha256;
      }
      return sendJson(response, 200, { template, notice: 'Replace every example shot with the exact locked segment shots before linting.' });
    }

    if (request.method === 'GET' && operation === 'asset-manifest') {
      const manifest = await readJson(join(project.root, 'assets', `${segmentId}-asset-manifest.json`)).catch(error => {
        if (error.code === 'ENOENT') throw httpError(404, 'asset manifest not found');
        throw error;
      });
      return sendJson(response, 200, { manifest });
    }

    if (request.method === 'GET' && operation === 'independent-audit-template') {
      const evidence = await exactPackageEvidence(project.root, segmentId);
      return sendJson(response, 200, {
        segmentId, evidence,
        // 此处只给前端展示上一次是否未形成结论；真正的指纹会在提交时以完整证据重算。
        retryRequired: (await readJsonDirectory(project.root, 'runs')).some(run => run.kind === 'independent_external_model_audit'
          && run.segmentId === segmentId && run.status === 'UNCERTAIN' && run.auditPurpose === 'creative_package'
          && !run.retryOfRunId),
        limits: { maxCalls: 1, maxTurns: independentAuditMaxTurns, maxInputTokensPerTurn: 24000, maxOutputTokensPerTurn: 4000 },
        permissions: { readOnly: true, automaticRetries: false, imageGeneration: false, videoGeneration: false, externalMessages: false }
      });
    }

    if (request.method !== 'POST') return sendError(response, 405, 'method not allowed');
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');

    if (operation === 'asset-manifest') {
      if (workflowProfileIdOf(state) === 'simple_remake') {
        if (state.remakeControlSelection?.selectedModes?.includes('native_source')) {
          await ensureSimpleRemakeNativeSourceClip(project.root, state, segmentId);
        }
        const capability = state.artifacts.find(item => item.id === state.verifiedCapabilityManifestId
          && item.type === 'capability_manifest' && item.status === 'locked');
        const requiredTypes = capability?.requiredAssetsBySegment?.[segmentId] ?? [];
        for (const assetType of requiredTypes) {
          const lockedMatches = state.artifacts.filter(item => item.type === 'project_asset'
            && item.assetType === assetType && item.status === 'locked'
            && typeof item.invalidatedByScopeRevisionId !== 'string');
          if (lockedMatches.length > 0) continue;
          const draftMatches = state.artifacts.filter(item => item.type === 'project_asset'
            && item.assetType === assetType && ['draft', 'rework', 'awaiting_review'].includes(item.status)
            && typeof item.invalidatedByScopeRevisionId !== 'string');
          if (draftMatches.length === 1) {
            await autoLockArtifact(project.root, draftMatches[0].id,
              `简单复刻路线机审：已上传并解码的 ${assetType} 是当前唯一候选，锁定供 ${segmentId} 使用。`, {
                delegatedByProfile: 'simple_remake',
                machineEvidence: { mediaDecodedAtUpload: true, exactCandidateCount: 1, segmentId, assetType }
              });
          }
        }
      }
      const manifest = await compileProjectAssetManifest(project.root, segmentId);
      await writeJsonAtomic(join(project.root, 'assets', `${segmentId}-asset-manifest.json`), manifest);
      if (workflowProfileIdOf(state) === 'simple_remake') {
        const review = await runReviewAssetManifest([
          '--project', project.root, '--segment', segmentId,
          '--note', '简单复刻路线：系统已验证当前段只绑定锁定原片控制与唯一锁定产品参考，并自动锁定最小资产清单。'
        ], { delegatedByProfile: 'simple_remake' });
        return sendJson(response, 201, { manifest: await readJson(join(project.root, 'assets', `${segmentId}-asset-manifest.json`)), review });
      }
      return sendJson(response, 201, { manifest });
    }
    if (operation === 'asset-manifest-approval') {
      const review = await runReviewAssetManifest([
        '--project', project.root, '--segment', segmentId, '--note', requiredText(input.note, 'note', 4000)
      ]);
      return sendJson(response, 200, { review });
    }
    if (operation === 'narration') {
      if (!input.narration || typeof input.narration !== 'object' || Array.isArray(input.narration)) return sendError(response, 400, 'narration must be a JSON object');
      const narration = structuredClone(input.narration);
      narration.segmentId = segmentId;
      narration.sourceSegmentId = segmentId;
      narration.status = 'draft';
      const id = safeUploadId(narration.id);
      if (state.artifacts.some(item => item.id === id)) return sendError(response, 409, 'artifact id already exists');
      const path = `prompts/${segmentId}/${id}.json`;
      await writeJsonAtomic(join(project.root, path), narration);
      await registerArtifact(project.root, {
        id, type: 'shot_narration', revision: narration.revision, status: 'draft', path, segmentId,
        capabilityManifestId: narration.capabilityManifestId,
        capabilityManifestSha256: narration.capabilityManifestSha256
      });
      const result = await lintNarration(project.root, id);
      return sendJson(response, 201, result);
    }
    if (operation === 'narration-auto') {
      if (workflowProfileIdOf(state) !== 'simple_remake') return sendError(response, 409, '只有简单复刻路线可由系统自动整理讲戏本。');
      if (latestSegmentArtifact(state, 'shot_narration', segmentId)?.status === 'locked') {
        return sendError(response, 409, '当前段落已经有锁定的讲戏本，无需再次生成。');
      }
      const narration = await automaticSimpleRemakeNarration(project.root, state, segmentId);
      const path = `prompts/${segmentId}/${narration.id}.json`;
      await writeJsonAtomic(join(project.root, path), narration);
      await registerArtifact(project.root, {
        id: narration.id, type: 'shot_narration', revision: narration.revision, status: 'draft', path, segmentId,
        capabilityManifestId: narration.capabilityManifestId,
        capabilityManifestSha256: narration.capabilityManifestSha256
      });
      const result = await lintNarration(project.root, narration.id);
      return sendJson(response, 201, result);
    }
    if (operation === 'prompt') {
      const promptText = requiredText(input.promptText, 'promptText', 100000);
      const id = safeUploadId(input.artifactId);
      if (state.artifacts.some(item => item.id === id)) return sendError(response, 409, 'artifact id already exists');
      if (input.selfAuditA !== 'PASS' || input.selfAuditB !== 'PASS') return sendError(response, 409, 'director arrangement and prompt semantic self-audits must both PASS before locking');
      const narration = latestSegmentArtifact(state, 'shot_narration', segmentId);
      if (!narration || narration.status !== 'locked') return sendError(response, 409, 'a locked shot narration is required');
      assertSeedanceSourcePromptReferences(promptText);
      const revision = Math.max(0, ...state.artifacts.filter(item => item.type === 'seedance_prompt' && item.segmentId === segmentId).map(item => item.revision)) + 1;
      const path = `prompts/${segmentId}/${id}.txt`;
      await writeTextAtomic(join(project.root, path), `${promptText.trim()}\n`);
      const artifact = await registerArtifact(project.root, {
        id, type: 'seedance_prompt', revision, status: 'draft', path, segmentId,
        narrationSourceId: narration.id, narrationSha256: narration.sha256,
        promptSkill: 'seedance2-prompt-skill',
        promptSelfAudit: { arrangement: 'PASS', semantics: 'PASS', revisionNote: requiredText(input.revisionNote, 'revisionNote', 4000) }
      });
      const review = await autoLockArtifact(project.root, artifact.id,
        'auto-locked: zero-context prompt lint and recorded A/B director self-audits passed');
      return sendJson(response, 201, { artifact, review });
    }
    if (operation === 'prompt-auto') {
      if (workflowProfileIdOf(state) !== 'simple_remake') return sendError(response, 409, '只有简单复刻路线可由系统自动整理生成提示。');
      if (latestSegmentArtifact(state, 'seedance_prompt', segmentId)?.status === 'locked') {
        return sendError(response, 409, '当前段落已经有锁定的生成提示，无需再次生成。');
      }
      const generated = await automaticSimpleRemakeSourcePrompt(project.root, state, segmentId);
      const path = `prompts/${segmentId}/${generated.id}.txt`;
      await writeTextAtomic(join(project.root, path), `${generated.promptText.trim()}\n`);
      const artifact = await registerArtifact(project.root, {
        id: generated.id, type: 'seedance_prompt', revision: generated.revision, status: 'draft', path, segmentId,
        narrationSourceId: generated.narration.id, narrationSha256: generated.narration.sha256,
        promptSkill: 'seedance2-prompt-skill',
        promptSelfAudit: {
          arrangement: 'PASS', semantics: 'PASS',
          revisionNote: '系统已按锁定首帧、产品图、讲戏本与简单复刻的最小资产范围整理；未新增人物、场景、镜头或付费输入。'
        }
      });
      const review = await autoLockArtifact(project.root, artifact.id,
        'auto-locked: simple-remake prompt was compiled from locked first frame, product reference and narration, then passed zero-context source reference lint');
      return sendJson(response, 201, { artifact, review });
    }
    if (operation === 'compile') {
      const model = ['Seedance 2.0', 'Seedance 2.0 VIP', 'Seedance 2.5', 'Kling O3'].includes(input.model) ? input.model : 'Seedance 2.0';
      const compileArgs = ['--project', project.root, '--segment', segmentId, '--video-executor', 'libtv', '--video-model', model];
      if (['480p', '720p', '1080p', '4k'].includes(input.resolution)) compileArgs.push('--resolution', input.resolution);
      if (workflowProfileIdOf(state) === 'simple_remake') {
        const refreshedState = await refreshSimpleRemakePlanning(project.root, state, segmentId);
        await ensureSimpleRemakeDepthPrompt(project.root, refreshedState, segmentId);
        const manifest = await readJson(join(project.root, 'assets', `${segmentId}-asset-manifest.json`));
        compileArgs.push('--user-confirmed-video-upload');
        if (refreshedState.remakeControlSelection?.selectedModes?.includes('native_source')) {
          compileArgs.push('--include-source-video');
        }
        // 原片音频是当前段的动作节拍基准。必须保持音频能力开启，让画布中的
        // 深度视频与首帧能按同一时间轴准备；成片验收仍以精确回灌的原片音频为准。
      }
      try {
        const result = await runCompileSeedance(compileArgs);
        return sendJson(response, 201, result);
      } catch (error) {
        // This is an operator-facing, non-paid preparation failure. Surface a
        // recoverable Chinese message instead of the generic server dialog.
        const detail = error instanceof Error ? error.message : '生成包校验未通过';
        return sendError(response, 409, `生成包暂未整理完成：${detail}`);
      }
    }
    if (operation === 'independent-audit') {
      const result = await executeStudioCreativeAudit(project, segmentId, state, input);
      return sendJson(response, 201, {
        decision: result.audit.decision, artifact: artifactSummary(result.artifact),
        reviewId: result.review?.id ?? null, run: runSummary(result.run),
        consumedCredits: result.run.consumedCredits ?? null, reusedPaidResult: result.reusedPaidResult === true
      });
    }
  }

  const deliveryRoute = /^\/api\/projects\/([^/]+)\/operations\/verify-delivery$/.exec(pathname);
  if (request.method === 'POST' && deliveryRoute) {
    const project = await findProject(decodeURIComponent(deliveryRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const result = await verifyDelivery(project.root);
    return sendJson(response, 200, {
      ...result,
      ok: result.blocked.length === 0,
      reason: result.blocked.length === 0 ? null : result.blocked.flatMap(item => item.reasons ?? []).join('; ')
    });
  }

  const recoverTransactionsRoute = /^\/api\/projects\/([^/]+)\/operations\/recover-transactions$/.exec(pathname);
  if (request.method === 'POST' && recoverTransactionsRoute) {
    const project = await findProject(decodeURIComponent(recoverTransactionsRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const action = project.next.actions?.find(item => item.id === 'recover_transactions');
    if (!action) return sendError(response, 409, 'the project has no pending transaction journals');
    await recoverJsonTransactions(project.root);
    const next = await determineNextActions(project.root);
    if (next.actions?.[0]?.id === 'recover_transactions') {
      return sendError(response, 409, 'transaction recovery did not clear every pending journal');
    }
    return sendJson(response, 200, { recoveredTransactionIds: action.transactionIds ?? [], next });
  }

  const finalizeDeliveryRoute = /^\/api\/projects\/([^/]+)\/operations\/finalize-delivery$/.exec(pathname);
  if (request.method === 'POST' && finalizeDeliveryRoute) {
    const project = await findProject(decodeURIComponent(finalizeDeliveryRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    try {
      const result = await finalizeDelivery(project.root, {
        outcome: input.outcome,
        whatWorked: input.whatWorked,
        whatFailed: input.whatFailed,
        nextProjectChange: input.nextProjectChange,
        ruleCandidates: input.ruleCandidates ?? []
      });
      return sendJson(response, 201, result);
    } catch (error) {
      return sendError(response, error instanceof TypeError ? 422 : 409, error instanceof Error ? error.message : 'delivery cannot be finalized');
    }
  }

  const prepareHandoffRoute = /^\/api\/projects\/([^/]+)\/handoffs\/([^/]+)\/prepare$/.exec(pathname);
  if (request.method === 'POST' && prepareHandoffRoute) {
    const project = await findProject(decodeURIComponent(prepareHandoffRoute[1]));
    const segmentId = safeSegmentId(decodeURIComponent(prepareHandoffRoute[2]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const state = await readJson(join(project.root, 'project-state.json'));
    const videos = await currentLockedSegmentVideos(project.root, state, segmentId);
    if (videos.length !== 1) return sendError(response, 409, `handoff preparation requires exactly one current locked video for ${segmentId}`);
    try {
      const result = await runPrepareHandoff(['--project', project.root, '--artifact', videos[0].id]);
      if (result.status === 'blocked') return sendError(response, 409, result.blockedReason);
      const updated = await readJson(join(project.root, 'project-state.json'));
      const prepared = updated.artifacts.find(item => item.type === 'handoff' && item.prepared === true
        && item.segmentId === segmentId && item.status === 'awaiting_review');
      if (!prepared) return sendError(response, 500, 'prepared handoff evidence was not persisted');
      return sendJson(response, 201, {
        prepared: artifactSummary(prepared),
        evidenceTimestamps: prepared.evidenceTimestamps,
        candidates: prepared.candidateFrames.map((candidate, index) => ({
          ...candidate,
          mediaUrl: `/api/projects/${encodeURIComponent(project.slug)}/handoffs/${encodeURIComponent(segmentId)}/candidates/${index}`
        }))
      });
    } catch (error) {
      return sendError(response, 409, error instanceof Error ? error.message : 'handoff preparation failed');
    }
  }

  const handoffCandidateRoute = /^\/api\/projects\/([^/]+)\/handoffs\/([^/]+)\/candidates\/(\d+)$/.exec(pathname);
  if (request.method === 'GET' && handoffCandidateRoute) {
    const project = await findProject(decodeURIComponent(handoffCandidateRoute[1]));
    const segmentId = safeSegmentId(decodeURIComponent(handoffCandidateRoute[2]));
    const index = Number(handoffCandidateRoute[3]);
    const state = await readJson(join(project.root, 'project-state.json'));
    const prepared = state.artifacts.find(item => item.type === 'handoff' && item.prepared === true
      && item.segmentId === segmentId && item.status === 'awaiting_review');
    const candidate = prepared?.candidateFrames?.[index];
    if (!candidate) return sendError(response, 404, 'handoff candidate not found');
    const file = safeFile(project.root, candidate.path);
    if (await sha256File(file) !== candidate.sha256) return sendError(response, 409, 'handoff candidate checksum changed');
    return serveMedia(request, response, file, mediaTypes[extname(file).toLowerCase()] ?? 'image/png');
  }

  const reviewHandoffRoute = /^\/api\/projects\/([^/]+)\/handoffs\/([^/]+)\/review$/.exec(pathname);
  if (request.method === 'POST' && reviewHandoffRoute) {
    const project = await findProject(decodeURIComponent(reviewHandoffRoute[1]));
    const segmentId = safeSegmentId(decodeURIComponent(reviewHandoffRoute[2]));
    const input = await readRequestBody(request);
    if (input.confirm !== true || !['approved', 'rejected'].includes(input.decision)) {
      return sendError(response, 400, 'a confirmed approved or rejected handoff decision is required');
    }
    const state = await readJson(join(project.root, 'project-state.json'));
    const prepared = state.artifacts.find(item => item.type === 'handoff' && item.prepared === true
      && item.segmentId === segmentId && item.status === 'awaiting_review');
    if (!prepared) return sendError(response, 409, 'prepared handoff is missing or no longer current');
    const observation = input.decision === 'approved' && input.observation && typeof input.observation === 'object'
      ? structuredClone(input.observation) : {};
    const handoffInput = {
      ...observation,
      id: `handoff-${segmentId}`,
      segmentId,
      revision: 1,
      preparedHandoffId: prepared.id,
      evidenceTimestamps: prepared.evidenceTimestamps,
      acceptDeviation: input.acceptDeviation === true,
      decision: input.decision,
      ...(input.decision === 'rejected' ? { correction: requiredText(input.correction, 'correction', 4000) } : {})
    };
    const inputPath = `reviews/handoff-input-${segmentId}-${randomUUID()}.json`;
    await writeJsonAtomic(join(project.root, inputPath), handoffInput);
    try {
      const review = await runReviewHandoff([
        '--project', project.root, '--input', inputPath, '--decision', input.decision,
        '--note', requiredText(input.note, 'note', 4000),
        ...(input.decision === 'rejected' ? ['--correction', handoffInput.correction] : [])
      ]);
      const result = await runRecordHandoff(['--project', project.root, '--input', inputPath, '--review', review.id]);
      return sendJson(response, 201, { review, handoff: result.handoff ?? null, rework: result.segment ?? null });
    } catch (error) {
      return sendError(response, 422, error instanceof Error ? error.message : 'handoff review failed');
    }
  }

  const libTvCanvasRoute = /^\/api\/projects\/([^/]+)\/operations\/prepare-libtv-canvas$/.exec(pathname);
  if (request.method === 'POST' && libTvCanvasRoute) {
    const project = await findProject(decodeURIComponent(libTvCanvasRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const segmentId = safeSegmentId(input.segmentId);
    const projectUuid = requiredText((await listStudioTeam(teamStateRoot)).settings?.defaultLibTvProjectUuid, 'owner default LibTV project UUID', 32);
    // 节点名是画布内部编号，不能让中文项目名或可见文案进入底层命令。
    // 如果浏览器缓存或外部调用带来了不兼容的名称，回退到稳定的后台名称，
    // 而不是把技术格式错误抛给用户并表现成“服务器处理失败”。
    // A fixed node name collides whenever a revised package is prepared for the
    // same segment.  Scope the default name to the exact compiled package so
    // the visible workflow can safely prepare a new canvas after a revision.
    const packageSha256 = await sha256File(join(project.root, 'prompts', segmentId, 'seedance-package.json'));
    const requestedNodeName = input.nodeName || `${segmentId}-seedance-${packageSha256.slice(0, 12)}`;
    const nodeName = /^[A-Za-z0-9._-]+$/.test(String(requestedNodeName))
      ? requiredText(String(requestedNodeName), 'nodeName', 192)
      : `${segmentId}-seedance-video`;
    const model = ['Seedance 2.0', 'Seedance 2.0 VIP', 'Seedance 2.5', 'Kling O3'].includes(input.model) ? input.model : 'Seedance 2.0';
    const state = await readJson(join(project.root, 'project-state.json'));
    const segments = await currentSegments(project.root, state);
    const production = await segmentProductionStatus(project.root, state, segments);
    const status = production.find(item => item.segmentId === segmentId);
    if (!status?.readyForCanvas) return sendError(response, 409, `segment is not ready for LibTV canvas: ${(status?.blockedReasons ?? ['canonical segment not found']).join('; ')}`);
    const result = await prepareLibTvVideoCanvas(project.root, { segmentId, projectUuid, nodeName, model }, {
      // 简单复刻的中间审查已由系统完成并在上面的 readyForCanvas 校验中验证；
      // 仅将这条受限策略传给非生成的画布准备，不影响其他路线或任何付费提交。
      allowMachineReviewedSimpleRemake: workflowProfileIdOf(state) === 'simple_remake'
    });
    return sendJson(response, 201, {
      run: runSummary(result.run),
      requiresUserCanvasGeneration: result.requiresUserCanvasGeneration,
      paidGenerationTriggered: result.paidGenerationTriggered,
      nodeName: result.nodeName,
      projectUuid: result.projectUuid
    });
  }

  const syncLibTvCanvasRoute = /^\/api\/projects\/([^/]+)\/operations\/sync-libtv-canvas-result$/.exec(pathname);
  if (request.method === 'POST' && syncLibTvCanvasRoute) {
    const project = await findProject(decodeURIComponent(syncLibTvCanvasRoute[1]));
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const result = await syncUserCanvasGeneration(project, input);
    return sendJson(response, result.reused ? 200 : 201, {
      reused: result.reused,
      validatedOnly: result.validatedOnly === true,
      run: runSummary(result.run),
      artifact: result.artifact ? artifactSummary(result.artifact) : null,
      paidGenerationTriggeredByStudio: false
    });
  }

  const artifactRoute = /^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
  if (request.method === 'GET' && artifactRoute) {
    const project = await findProject(decodeURIComponent(artifactRoute[1]));
    const artifactId = decodeURIComponent(artifactRoute[2]);
    const state = await readJson(join(project.root, 'project-state.json'));
    const artifact = state.artifacts.find(item => item.id === artifactId);
    if (!artifact) return sendError(response, 404, '未找到该产物，可能已归档，或当前页面仍停留在旧版本。请刷新项目后重试。');
    const file = safeFile(project.root, artifact.path);
    const extension = extname(file).toLowerCase();
    const content = ['.json', '.md', '.txt'].includes(extension) ? await readFile(file, 'utf8') : null;
    return sendJson(response, 200, {
      artifact: artifactSummary(artifact), content,
      mediaUrl: mediaTypes[extension] ? `/api/projects/${encodeURIComponent(project.slug)}/media/${encodeURIComponent(artifact.id)}` : null,
      mediaType: mediaTypes[extension] ?? null,
      videoAcceptance: artifact.type === 'video_segment' ? await videoAcceptanceEvidence(project, artifact) : null
    });
  }

  const sourceStoryboardMediaRoute = /^\/api\/projects\/([^/]+)\/source-storyboard\/source\/([^/]+)$/.exec(pathname);
  if (['GET', 'HEAD'].includes(request.method) && sourceStoryboardMediaRoute) {
    const project = await findProject(decodeURIComponent(sourceStoryboardMediaRoute[1]));
    const filename = decodeURIComponent(sourceStoryboardMediaRoute[2]);
    const storyboard = await sourceStoryboardSummary(project);
    if (!storyboard) return sendError(response, 404, '当前项目没有可用的原片动作故事板。');
    const expectedFiles = new Set(storyboard.panels.map(panel => panel.sourceFile));
    if (!expectedFiles.has(filename)) return sendError(response, 404, '未找到该故事板画面。');
    const file = safeFile(project.root, join('planning', 'source-storyboard-r10', 'source-panels', filename));
    return serveMedia(request, response, file, mediaTypes[extname(file).toLowerCase()] ?? 'image/png');
  }

  const sourceStoryboardTemplateRoute = /^\/api\/projects\/([^/]+)\/source-storyboard\/template\/([^/]+)$/.exec(pathname);
  if (['GET', 'HEAD'].includes(request.method) && sourceStoryboardTemplateRoute) {
    const project = await findProject(decodeURIComponent(sourceStoryboardTemplateRoute[1]));
    const filename = decodeURIComponent(sourceStoryboardTemplateRoute[2]);
    const storyboard = await sourceStoryboardSummary(project);
    if (!storyboard) return sendError(response, 404, '当前项目没有可用的原片动作故事板。');
    const expectedFiles = new Set((storyboard.templateBoards ?? []).map(board => board.filename));
    if (!expectedFiles.has(filename)) return sendError(response, 404, '未找到该完整故事板。');
    const board = (storyboard.templateBoards ?? []).find(item => item.filename === filename);
    const file = safeFile(project.root, join('planning', board.sourceDir, filename));
    return serveMedia(request, response, file, mediaTypes[extname(file).toLowerCase()] ?? 'image/png');
  }

  const assetAuditTemplateRoute = /^\/api\/projects\/([^/]+)\/assets\/([^/]+)\/audit-template$/.exec(pathname);
  if (request.method === 'GET' && assetAuditTemplateRoute) {
    const project = await findProject(decodeURIComponent(assetAuditTemplateRoute[1]));
    const assetId = decodeURIComponent(assetAuditTemplateRoute[2]);
    const state = await readJson(join(project.root, 'project-state.json'));
    const asset = state.artifacts.find(item => item.id === assetId && ['project_asset', 'segment_asset'].includes(item.type));
    if (!asset) return sendError(response, 404, 'asset not found');
    if (asset.mediaKind !== 'image') return sendError(response, 409, 'pixel visual audit applies to image assets');
    const required = REQUIRED_VISUAL_CHECKS[asset.assetType] ?? ['asset_role_fidelity'];
    return sendJson(response, 200, {
      asset: artifactSummary(asset),
      requiredChecks: required,
      limits: { maxCalls: 1, maxTurns: independentAuditMaxTurns, maxInputTokensPerTurn: 24000, maxOutputTokensPerTurn: 4000 },
      permissions: { readOnly: true, automaticRetries: false, imageGeneration: false, videoGeneration: false, externalMessages: false },
      legacyTemplate: {
        id: asset.visualAuditId ?? `${asset.id}-visual-audit-r${asset.revision}`,
        kind: 'asset_visual_audit',
        assetId: asset.id, assetType: asset.assetType, assetRevision: asset.revision, assetSha256: asset.sha256,
        decision: 'FAIL', inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
        inspectorTaskId: '', evidenceRunId: '',
        observedIdentityCount: asset.assetType?.startsWith('character_') ? 1 : 0,
        checks: required.map(id => ({ id, result: 'NA', evidence: '填写独立查看当前图片像素后得到的具体证据' })),
        blockerCount: 1,
        reviewedAt: new Date().toISOString()
      }
    });
  }

  const assetAuditRoute = /^\/api\/projects\/([^/]+)\/assets\/([^/]+)\/audits$/.exec(pathname);
  if (request.method === 'POST' && assetAuditRoute) {
    const project = await findProject(decodeURIComponent(assetAuditRoute[1]));
    const assetId = decodeURIComponent(assetAuditRoute[2]);
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const state = await readJson(join(project.root, 'project-state.json'));
    const asset = state.artifacts.find(item => item.id === assetId && ['project_asset', 'segment_asset'].includes(item.type));
    if (!asset) return sendError(response, 404, 'asset not found');
    if (asset.mediaKind !== 'image') return sendError(response, 409, 'pixel visual audit applies to image assets');
    const result = await executeStudioAssetAudit(project, asset, state, input);
    return sendJson(response, 201, {
      decision: result.run.decision, artifact: artifactSummary(result.artifact),
      reviewId: result.review?.id ?? null, run: runSummary(result.run),
      authenticatedExistingAudit: result.authenticatedExistingAudit,
      consumedCredits: result.run.consumedCredits ?? null, reusedPaidResult: result.reusedPaidResult === true
    });
  }

  const mediaRoute = /^\/api\/projects\/([^/]+)\/media\/([^/]+)$/.exec(pathname);
  if (['GET', 'HEAD'].includes(request.method) && mediaRoute) {
    const project = await findProject(decodeURIComponent(mediaRoute[1]));
    const artifactId = decodeURIComponent(mediaRoute[2]);
    const state = await readJson(join(project.root, 'project-state.json'));
    const artifact = state.artifacts.find(item => item.id === artifactId);
    if (!artifact) return sendError(response, 404, '未找到该产物，可能已归档，或当前页面仍停留在旧版本。请刷新项目后重试。');
    const file = safeFile(project.root, artifact.path);
    const type = mediaTypes[extname(file).toLowerCase()];
    if (!type) return sendError(response, 415, 'artifact is not previewable media');
    return serveMedia(request, response, file, type);
  }

  const videoReviewTemplateRoute = /^\/api\/projects\/([^/]+)\/videos\/([^/]+)\/review-template$/.exec(pathname);
  if (request.method === 'GET' && videoReviewTemplateRoute) {
    const project = await findProject(decodeURIComponent(videoReviewTemplateRoute[1]));
    const artifactId = decodeURIComponent(videoReviewTemplateRoute[2]);
    const state = await readJson(join(project.root, 'project-state.json'));
    const video = state.artifacts.find(item => item.id === artifactId && ['video_segment', 'final_edit'].includes(item.type));
    if (!video) return sendError(response, 404, 'Gate 5 video artifact not found');
    const generationRun = video.type === 'video_segment' ? await boundSuccessRun(project.root, video) : null;
    if (video.type === 'final_edit') {
      await verifyArtifactFile(project.root, video);
      await validateMediaFile(safeFile(project.root, video.path), 'video');
      await validateFinalEditSources(project.root, state, video);
    }
    const rubricArtifact = state.artifacts
      .filter(item => item.type === 'quality_rubric' && item.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!rubricArtifact) return sendError(response, 409, 'a locked quality rubric is required');
    const rubric = assertQualityRubric(await readJson(safeFile(project.root, rubricArtifact.path)));
    const requiredResolution = await requiredGate5Resolution(project.root, state, video);
    return sendJson(response, 200, {
      rubric,
      rubricArtifact: artifactSummary(rubricArtifact),
      video: artifactSummary(video),
      generationRun: generationRun ? runSummary(generationRun) : null,
      requiredResolution
    });
  }

  const videoReviewRoute = /^\/api\/projects\/([^/]+)\/videos\/([^/]+)\/reviews$/.exec(pathname);
  if (request.method === 'POST' && videoReviewRoute) {
    const project = await findProject(decodeURIComponent(videoReviewRoute[1]));
    const artifactId = decodeURIComponent(videoReviewRoute[2]);
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const state = await readJson(join(project.root, 'project-state.json'));
    const video = state.artifacts.find(item => item.id === artifactId && ['video_segment', 'final_edit'].includes(item.type));
    if (!video) return sendError(response, 404, 'Gate 5 video artifact not found');
    if (video.type === 'video_segment') await boundSuccessRun(project.root, video);
    else {
      await verifyArtifactFile(project.root, video);
      await validateMediaFile(safeFile(project.root, video.path), 'video');
      await validateFinalEditSources(project.root, state, video);
    }
    const review = await recordQualityReview(project.root, {
      artifactId,
      rubricId: requiredText(input.rubricId, 'rubricId', 192),
      decision: input.decision,
      note: requiredText(input.note, 'note', 4000),
      correction: input.correction ?? null,
      scores: input.scores,
      evidenceByDimension: input.evidenceByDimension,
      triggeredVetoIds: input.triggeredVetoIds ?? [],
      overrideReason: input.overrideReason ?? null,
      failureObservation: input.failureObservation,
      resolvesReviewId: input.resolvesReviewId
    });
    return sendJson(response, 200, { review });
  }

  const reviewRoute = /^\/api\/projects\/([^/]+)\/reviews\/([^/]+)$/.exec(pathname);
  if (request.method === 'POST' && reviewRoute) {
    const project = await findProject(decodeURIComponent(reviewRoute[1]));
    const artifactId = decodeURIComponent(reviewRoute[2]);
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    if (!['approve', 'reject'].includes(input.decision)) return sendError(response, 400, 'decision must be approve or reject');
    if (typeof input.note !== 'string' || input.note.trim() === '') return sendError(response, 400, 'review note is required');
    if (input.decision === 'reject' && (typeof input.correction !== 'string' || input.correction.trim() === '')) {
      return sendError(response, 400, 'rejection correction is required');
    }
    const state = await readJson(join(project.root, 'project-state.json'));
    const artifact = state.artifacts.find(item => item.id === artifactId);
    if (!artifact) return sendError(response, 404, '未找到该审核产物，请刷新项目后重新打开审核页面。');
    if (!isHumanReviewType(artifact.type)) return sendError(response, 409, 'this artifact is not a human review checkpoint');
    if (input.decision === 'approve' && ['video_segment', 'final_edit'].includes(artifact.type)) {
      return sendError(response, 409, 'video segments and final edits must be approved through the Gate 5 quality rubric');
    }
    if (input.decision === 'approve' && artifact.type === 'creative_brief') {
      const checkpoint = await runCheckpointApprove([
        '--project', project.root, '--checkpoint', 'checkpoint_creative', '--note', input.note.trim()
      ]);
      return sendJson(response, 200, { checkpoint });
    }
    if (input.decision === 'approve' && artifact.type === 'story_plan') {
      const checkpoint = await runCheckpointApprove([
        '--project', project.root, '--checkpoint', 'checkpoint_story', '--note', input.note.trim()
      ]);
      return sendJson(response, 200, { checkpoint });
    }
    const review = input.decision === 'approve'
      ? await approveArtifact(project.root, artifactId, input.note.trim())
      : await rejectArtifact(project.root, artifactId, input.note.trim(), input.correction.trim());
    return sendJson(response, 200, { review });
  }

  const submitReviewRoute = /^\/api\/projects\/([^/]+)\/reviews\/([^/]+)\/submit$/.exec(pathname);
  if (request.method === 'POST' && submitReviewRoute) {
    const project = await findProject(decodeURIComponent(submitReviewRoute[1]));
    const artifactId = decodeURIComponent(submitReviewRoute[2]);
    const input = await readRequestBody(request);
    if (input.confirm !== true) return sendError(response, 400, 'human confirmation is required');
    const state = await readJson(join(project.root, 'project-state.json'));
    const artifact = state.artifacts.find(item => item.id === artifactId);
    if (!artifact) return sendError(response, 404, '未找到该审核产物，请刷新项目后重新打开审核页面。');
    if (!isHumanReviewType(artifact.type)) return sendError(response, 409, 'this artifact is not a human review checkpoint');
    if (!['draft', 'rework'].includes(artifact.status)) return sendError(response, 409, 'only a draft or rework artifact can be submitted for review');
    try {
      const submitted = await submitForReview(project.root, artifactId);
      return sendJson(response, 200, { artifact: submitted });
    } catch (error) {
      return sendError(response, 409, error instanceof Error ? error.message : 'artifact cannot be submitted in its current state');
    }
  }

  return sendError(response, 404, 'not found');
}

async function accessForRequest(request, response, pathname) {
  const cookies = parseCookies(request);
  let access = await authenticateStudioSession(teamStateRoot, cookies[sessionCookieName]);
  const remote = normalizeRemoteAddress(request.socket?.remoteAddress);
  const loopback = remote === '127.0.0.1' || remote === '::1';
  if (!access && pathname === '/api/session' && loopback && process.env.HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER !== 'true') {
    const issued = await issueOwnerSession(teamStateRoot);
    response.setHeader('set-cookie', sessionCookie(issued.token));
    access = { session: issued.session, principal: issued.principal };
  }
  return access;
}

async function redeemInvite(response, pathname) {
  const match = /^\/join\/([^/]+)$/.exec(pathname);
  if (!match) return false;
  let joined;
  try {
    joined = await consumeStudioInvite(teamStateRoot, decodeURIComponent(match[1]));
  } catch {
    throw httpError(410, '这条专属链接无效、已过期或已经使用；请让所有者重新生成');
  }
  response.writeHead(303, {
    location: '/',
    'set-cookie': sessionCookie(joined.token),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  });
  response.end();
  return true;
}

const server = createServer(async (request, response) => {
  try {
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    assertStudioRequestNetwork(request, { port });
    const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
    if (await redeemInvite(response, url.pathname)) return;
    const access = await accessForRequest(request, response, url.pathname);
    if (url.pathname.startsWith('/api/')) {
      if (!access) return sendError(response, 401, '请使用你的专属邀请链接进入 Harness Studio');
      if (!['GET', 'HEAD'].includes(request.method)) {
        const audit = { principalId: access.principal.id, method: request.method, path: url.pathname };
        response.once('finish', () => recordStudioTeamAudit(teamStateRoot, { ...audit, statusCode: response.statusCode }).catch(error => console.error('[Harness Studio audit]', error)));
      }
      return await requestContext.run(access, () => handleApi(request, response, url));
    }
    return await serveStatic(response, url.pathname);
  } catch (error) {
    const status = error?.statusCode ?? (error instanceof TypeError ? 400 : 500);
    if (status >= 500 && status !== 502) console.error('[Harness Studio]', error);
    const message = status === 500 ? '服务器处理失败，请刷新后重试；如仍出现，请联系所有者查看运行状态。' : error instanceof Error ? error.message : '请求处理失败';
    return sendError(response, status, message);
  }
});

const studioServerLease = await acquireStudioServerLease(teamStateRoot);
await recoverInterruptedStudioGenerationJobs(teamStateRoot);
await pauseQueuedStudioGenerationJobs(teamStateRoot);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await studioServerLease.release().catch(() => {});
      process.exit(0);
    });
  });
}

server.listen(port, listenHost, () => {
  console.log(`Harness Studio: http://127.0.0.1:${port}`);
  for (const url of studioLanUrls(port, { https: httpsEnabled })) console.log(`LAN: ${url}`);
  if (listenHost !== '127.0.0.1' && listenHost !== 'localhost' && !httpsEnabled) {
    console.log('LAN pilot warning: HTTP is suitable only for a trusted private LAN; invite/session traffic is not encrypted.');
  }
  console.log(`Projects root: ${projectsRoot}`);
  kickStudioGenerationWorker();
});
