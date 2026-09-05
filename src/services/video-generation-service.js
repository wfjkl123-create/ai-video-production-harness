import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RUNNINGHUB_CONTRACT, RUNNINGHUB_NODES } from '../adapters/runninghub-adapter.js';
import { RUNNINGHUB_DEFAULTS } from '../config/defaults.js';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { requireIndependentCreativeAudit, requireSimpleRemakeSystemReview } from './independent-creative-audit-service.js';
import { assertUniqueSelectedMediaSha } from './seedance-package-service.js';
import { videoModelProfileById } from '../domain/video-model-profile.js';
import { assertSeedanceMediaBindingContract } from './seedance-media-binding-service.js';
import { requireCleanSeedanceExecutionPrompt } from './seedance-prompt-lint-service.js';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';
import { assertGenerationFailureGate } from './generation-failure-service.js';
import { auditProjectReadiness } from './project-readiness-audit-service.js';
import { requireExecutionControlEvidence } from './execution-control-evidence-service.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LIBTV_PROJECT_UUID = /^[a-f0-9]{32}$/;
const SAFE_LIBTV_NODE_NAME = /^[A-Za-z0-9._-]+$/;

function outside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function verifiedFile(root, recordedPath, label) {
  if (typeof recordedPath !== 'string' || isAbsolute(recordedPath) || outside(root, resolve(root, recordedPath))) {
    throw new Error(`${label} must stay inside project root`);
  }
  const actualRoot = await realpath(root);
  let actual;
  try {
    actual = await realpath(resolve(root, recordedPath));
    if (outside(actualRoot, actual) || !(await stat(actual)).isFile()) throw new Error('invalid');
  } catch {
    throw new Error(`${label} must be a readable project file`);
  }
  return actual;
}

function fingerprintHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function assertNoStrictWorkflowDrift(root) {
  const state = await readJson(join(root, 'project-state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (state?.videoGovernanceVersion !== 2) return true;
  const audit = await auditProjectReadiness(root);
  const blockers = audit.findings.filter(item => item.severity === 'error');
  if (blockers.length > 0) {
    throw new Error(`strict video governance readiness BLOCKED: ${blockers.map(item => item.id).join(', ')}; reconcile project evidence before paid generation`);
  }
  return true;
}

const LIBTV_MODELS = new Set(['Seedance 2.0', 'Seedance 2.0 VIP', 'Seedance 2.5', 'Kling O3']);
const MEDIA_LIMITS_BY_PROFILE = Object.freeze({
  'seedance-2-5-libtv-v1': Object.freeze({ image: 30, video: 10, audio: 10 }),
  'seedance-2-libtv-v1': Object.freeze({ image: 9, video: 3, audio: 3 }),
  'seedance-2-vip-libtv-v1': Object.freeze({ image: 9, video: 3, audio: 3 }),
  'kling-o3-libtv-v1': Object.freeze({ image: 9, video: 3, audio: 0 }),
  'runninghub-seedance-v1': Object.freeze({ image: 9, video: 3, audio: 3 })
});

function buildGenerationContract(value, media, {
  executor = 'runninghub', libtvProjectUuid, nodeName = `${value.segmentId}-seedance-video`, model = 'Seedance 2.0 VIP'
} = {}) {
  const generateAudio = value.generateAudio ?? true;
  if (executor === 'runninghub') {
    return {
      provider: 'runninghub',
      endpoint: RUNNINGHUB_CONTRACT.endpoint,
      requiredApiType: RUNNINGHUB_CONTRACT.requiredApiType,
      request: {
        duration: value.duration,
        ratio: value.ratio,
        resolution: value.resolution,
        generateAudio,
        realPersonMode: RUNNINGHUB_DEFAULTS.realPersonMode
      }
    };
  }
  if (executor !== 'libtv') throw new Error('video executor must be runninghub or libtv');
  if (!LIBTV_MODELS.has(model)) throw new Error(`unsupported LibTV model: ${model}`);
  if (!LIBTV_PROJECT_UUID.test(libtvProjectUuid ?? '')) {
    throw new Error('LibTV project UUID must be 32 lowercase hexadecimal characters');
  }
  if (!SAFE_LIBTV_NODE_NAME.test(nodeName ?? '')) throw new Error('LibTV node name must use a safe identifier');
  const inputCount = media.images.length + media.videos.length + media.audio.length;
  const multiShot = value.executionControlContract?.executionUnitStrategy === 'platform_multi_shot';
  const request = model === 'Kling O3'
    ? { duration: value.duration, ratio: value.ratio, quality: 'high', enableSound: generateAudio, count: 1 }
    : {
        duration: value.duration, ratio: value.ratio, resolution: value.resolution,
        enableSound: generateAudio, count: 1, searchEnabled: 0, autoCompliance: true,
        ...(multiShot ? { multi_shots: true } : {})
      };
  return {
    provider: 'libtv',
    transport: 'official_cli',
    projectUuid: libtvProjectUuid,
    nodeName,
    model,
    modeType: inputCount === 0 ? 'text2video' : 'mixed2video',
    request
  };
}

export async function inspectVideoPackage(root, segmentId, options = {}) {
  const projectRoot = await realpath(resolve(root));
  const relativePackagePath = `prompts/${segmentId}/seedance-package.json`;
  const packagePath = await verifiedFile(projectRoot, relativePackagePath, 'Seedance package');
  const value = await readJson(packagePath);
  const state = await readJson(join(projectRoot, 'project-state.json')).catch(error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  const executionControlContract = value.executionControlContract === undefined
    ? null
    : structuredClone(assertExecutionControlContract(value.executionControlContract));
  if (state.videoGovernanceVersion === 2 && executionControlContract === null) {
    throw new Error('strict video governance requires a checksum-bound executionControlContract before preflight');
  }
  const boundProfile = value.videoModelProfileId ? videoModelProfileById(value.videoModelProfileId) : null;
  const executor = options.executor ?? boundProfile?.executor ?? 'runninghub';
  const model = options.model ?? boundProfile?.model ?? 'Seedance 2.0 VIP';
  if (boundProfile && (executor !== boundProfile.executor || model !== boundProfile.model)) {
    throw new Error(`video executor/model differs from compiled profile ${boundProfile.id}; recompile the exact package before preflight`);
  }
  const supportedResolutions = boundProfile?.supportedResolutions ?? ['480p', '720p'];
  if (value.ratio !== '9:16' || !supportedResolutions.includes(value.resolution)) {
    throw new Error(`Seedance package must use 9:16 and a resolution supported by ${boundProfile?.id ?? 'legacy package'}: ${supportedResolutions.join(', ')}`);
  }
  if (!Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 15) throw new Error('Seedance package duration must be at most 15 seconds');
  for (const list of ['imageInputs', 'videoInputs', 'audioInputs']) {
    if (!Array.isArray(value[list]) || value[list].some(item => item.status !== 'locked')) throw new Error(`${list} must contain only locked inputs`);
  }
  const limits = MEDIA_LIMITS_BY_PROFILE[boundProfile?.id ?? 'runninghub-seedance-v1'];
  if (value.imageInputs.length > limits.image || value.videoInputs.length > limits.video || value.audioInputs.length > limits.audio) {
    throw new Error(`Seedance package exceeds ${boundProfile?.id ?? 'RunningHub'} media slots`);
  }
  const promptPath = await verifiedFile(projectRoot, value.promptPath, 'Seedance prompt');
  const promptText = await readFile(promptPath, 'utf8');
  if (boundProfile || value.mediaBindingContractVersion !== undefined || value.mediaBindings !== undefined) {
    const bindings = assertSeedanceMediaBindingContract(value);
    requireCleanSeedanceExecutionPrompt(promptText, { bindings });
  } else {
    // Legacy packages remain readable, but even they may not send unresolved
    // conversational shorthand or free-form media aliases to a fresh model.
    requireCleanSeedanceExecutionPrompt(promptText);
  }
  const promptSha256 = await sha256File(promptPath);
  const inspectInputs = async (items, kind) => Promise.all(items.map(async item => {
    if (!/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error(`${kind} input ${item.id ?? ''} requires a persisted sha256`);
    const path = await verifiedFile(projectRoot, item.path, `${kind} input ${item.id ?? ''}`);
    const digest = await sha256File(path);
    if (digest !== item.sha256) throw new Error(`${kind} input checksum changed for ${item.id}`);
    return { id: item.id, path, relativePath: relative(projectRoot, path).split(sep).join('/'), sha256: digest };
  }));
  const media = {
    images: await inspectInputs(value.imageInputs, 'image'),
    videos: await inspectInputs(value.videoInputs, 'video'),
    audio: await inspectInputs(value.audioInputs, 'audio')
  };
  assertUniqueSelectedMediaSha({ image: media.images, video: media.videos, audio: media.audio });
  const generationContract = buildGenerationContract({ ...value, segmentId }, media, { ...options, executor, model });
  if (executionControlContract?.executionUnitStrategy === 'platform_multi_shot'
    && generationContract.provider !== 'libtv') {
    throw new Error('platform_multi_shot is only allowed on a LibTV node with write/readback verification; split other providers into one-shot paid units');
  }
  const fingerprint = {
    segmentId,
    ...(value.videoModelProfileId ? { videoModelProfileId: value.videoModelProfileId } : {}),
    generationContract,
    ...(executionControlContract ? { executionControlContract } : {}),
    packagePath: relativePackagePath,
    packageSha256: await sha256File(packagePath),
    promptPath: relative(projectRoot, promptPath).split(sep).join('/'),
    promptSha256,
    inputMedia: Object.fromEntries(Object.entries(media).map(([kind, items]) => [kind, items.map(({ id, relativePath: path, sha256 }) => ({ id, path, sha256 }))]))
  };
  if (options.allowMachineReviewedSimpleRemake === true) {
    const sourcePromptPath = typeof value.sourcePromptPath === 'string' ? value.sourcePromptPath : null;
    if (!sourcePromptPath) throw new Error('simple remake package requires a persisted source prompt path');
    fingerprint.systemReview = await requireSimpleRemakeSystemReview(root, segmentId, sourcePromptPath);
  } else {
    fingerprint.independentCreativeAudit = await requireIndependentCreativeAudit(root, segmentId, fingerprint);
  }
  fingerprint.sha256 = fingerprintHash(fingerprint);
  return {
    value,
    fingerprint,
    input: {
      prompt: promptText.trim(),
      duration: value.duration, ratio: value.ratio, resolution: value.resolution,
      generateAudio: generationContract.request.generateAudio ?? generationContract.request.enableSound,
      realPersonMode: generationContract.request.realPersonMode,
      imageInputs: media.images.map(({ path }) => path),
      videoInputs: media.videos.map(({ path }) => path),
      audioInputs: media.audio.map(({ path }) => path)
    },
    plan: {
      segmentId, executor: generationContract.provider,
      ...(generationContract.provider === 'libtv' ? { mutatesLibTv: false } : { mutatesRunningHub: false }),
      requiresPaidApproval: true,
      duration: value.duration, ratio: value.ratio, resolution: value.resolution,
      generationContract,
      ...(generationContract.provider === 'libtv' ? {
        sources: Object.fromEntries(Object.entries(media).map(([kind, items]) => [kind, items.map(({ relativePath: path }) => ({ path }))]))
      } : {
        slots: {
          images: media.images.map(({ relativePath: path }, index) => ({ nodeId: RUNNINGHUB_NODES.images[index], path })),
          videos: media.videos.map(({ relativePath: path }, index) => ({ nodeId: RUNNINGHUB_NODES.videos[index], path })),
          audio: media.audio.map(({ relativePath: path }, index) => ({ nodeId: RUNNINGHUB_NODES.audio[index], path }))
        }
      })
    }
  };
}

export async function createVideoPreflight(root, segmentId, {
  id = `preflight-${randomUUID()}`, executor = 'runninghub', libtvProjectUuid, nodeName, model,
  inspect = inspectVideoPackage
} = {}) {
  await assertNoStrictWorkflowDrift(root);
  const inspected = await inspect(root, segmentId, { executor, libtvProjectUuid, nodeName, ...(model ? { model } : {}) });
  await assertGenerationFailureGate(root, inspected.fingerprint);
  const record = {
    id, kind: 'video_preflight', status: 'READY', segmentId,
    fingerprint: inspected.fingerprint, plan: inspected.plan, createdAt: new Date().toISOString()
  };
  const persisted = await withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    await assertNoStrictWorkflowDrift(root);
    await assertGenerationFailureGate(root, inspected.fingerprint);
    const entries = await readdir(join(root, 'runs'), { withFileTypes: true })
      .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const existing = (await Promise.all(entries
      .filter(entry => entry.isFile() && !entry.name.startsWith('._') && entry.name.endsWith('.json'))
      .map(entry => readJson(join(root, 'runs', entry.name)).catch(() => null))))
      .filter(candidate => candidate?.kind === 'video_preflight' && candidate.status === 'READY'
        && candidate.segmentId === segmentId && candidate.fingerprint?.sha256 === inspected.fingerprint.sha256)
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0];
    if (existing) {
      const ledger = await prepareExecutionLedgerAppend(root, {
        type: 'preflight.ready', occurredAt: existing.createdAt,
        actor: { kind: 'system', id: null }, segmentId,
        correlationId: existing.id, causationId: null,
        idempotencyKey: `preflight.ready:${existing.id}`,
        references: [{ kind: 'video_preflight', id: existing.id, path: `runs/${encodeURIComponent(existing.id)}.json` }],
        facts: {
          preflightId: existing.id, fingerprintSha256: existing.fingerprint.sha256,
          executor: existing.fingerprint.generationContract?.provider ?? executor
        }
      });
      if (!ledger.reused) {
        await commitJsonTransaction(root, `video-preflight-ledger-${existing.id}`, ledger.writes);
      }
      return { record: existing, reused: true };
    }
    try {
      await readJson(join(root, 'runs', `${encodeURIComponent(id)}.json`));
      throw new Error(`video preflight already exists: ${id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const recordPath = join(root, 'runs', `${encodeURIComponent(id)}.json`);
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'preflight.ready', occurredAt: record.createdAt,
      actor: { kind: 'system', id: null }, segmentId,
      correlationId: record.id, causationId: null,
      idempotencyKey: `preflight.ready:${record.id}`,
      references: [{ kind: 'video_preflight', id: record.id, path: `runs/${encodeURIComponent(record.id)}.json` }],
      facts: {
        preflightId: record.id, fingerprintSha256: record.fingerprint.sha256,
        executor: record.fingerprint.generationContract?.provider ?? executor
      }
    });
    await commitJsonTransaction(root, `video-preflight-${record.id}`, [
      { path: recordPath, value: record },
      ...ledger.writes
    ]);
    return { record, reused: false };
  });
  return {
    ...persisted.record.plan,
    preflightId: persisted.record.id,
    fingerprint: persisted.record.fingerprint,
    reused: persisted.reused
  };
}

export async function createPaidGenerationApproval(root, input, { id = `review-${randomUUID()}`, operatorId = null, inspect = inspectVideoPackage } = {}) {
  await assertNoStrictWorkflowDrift(root);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    await assertNoStrictWorkflowDrift(root);
    const preflight = await readJson(join(root, 'runs', `${encodeURIComponent(input.preflightId)}.json`));
    if (preflight.kind !== 'video_preflight' || preflight.status !== 'READY' || preflight.segmentId !== input.segmentId) {
      throw new Error('paid approval requires a matching ready video preflight');
    }
    const runDirectory = join(root, 'runs');
    const runFiles = await readdir(runDirectory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of runFiles) {
      if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
      const run = await readJson(join(runDirectory, entry.name));
      if (run?.kind === 'runninghub_video' && run.segmentId === input.segmentId
        && run.status === 'SUBMITTING' && run.taskId === null) {
        throw new Error(`segment has an uncertain SUBMITTING run (${run.id}); reconcile it before creating another paid approval`);
      }
    }
    const contract = preflight.fingerprint.generationContract;
    const current = await inspect(root, input.segmentId, {
      executor: contract.provider === 'libtv' ? 'libtv' : 'runninghub',
      ...(contract.provider === 'libtv' ? { libtvProjectUuid: contract.projectUuid, nodeName: contract.nodeName, model: contract.model } : {})
    });
    if (current.fingerprint.sha256 !== preflight.fingerprint.sha256) throw new Error('video preflight fingerprint changed before approval');
    await assertGenerationFailureGate(root, current.fingerprint);
    const executionControlEvidence = await requireExecutionControlEvidence(root, current.fingerprint);
    const approval = {
      id, kind: 'paid_generation_approval', actor: 'human', operatorId, decision: 'approved',
      segmentId: input.segmentId, preflightId: preflight.id, fingerprint: current.fingerprint,
      note: input.note, executor: contract.provider,
      ...(contract.provider === 'libtv'
        ? { libtvProjectUuid: contract.projectUuid, nodeName: contract.nodeName }
        : {}),
      maxPaidAttempts: 1,
      executionControlEvidence,
      consumedByRunId: null, consumedAt: null, createdAt: new Date().toISOString()
    };
    try {
      await readJson(join(root, 'reviews', `${encodeURIComponent(id)}.json`));
      throw new Error(`paid approval already exists: ${id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const approvalPath = join(root, 'reviews', `${encodeURIComponent(id)}.json`);
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'paid_approval.granted', occurredAt: approval.createdAt,
      actor: { kind: 'human', id: null }, segmentId: input.segmentId,
      correlationId: approval.id, causationId: preflight.id,
      idempotencyKey: `paid_approval.granted:${approval.id}`,
      references: [
        { kind: 'paid_generation_approval', id: approval.id, path: `reviews/${encodeURIComponent(approval.id)}.json` },
        { kind: 'video_preflight', id: preflight.id, path: `runs/${encodeURIComponent(preflight.id)}.json` }
      ],
      facts: {
        approvalId: approval.id, preflightId: preflight.id,
        fingerprintSha256: approval.fingerprint.sha256, executor: approval.executor,
        maxPaidAttempts: approval.maxPaidAttempts
      }
    });
    await commitJsonTransaction(root, `paid-approval-${approval.id}`, [
      { path: approvalPath, value: approval },
      ...ledger.writes
    ]);
    return approval;
  });
}

export async function claimPaidGeneration(root, {
  segmentId, approvalId, runId = `runninghub-${randomUUID()}`, transactionOptions
}) {
  await assertNoStrictWorkflowDrift(root);
  return withProjectLock(root, async () => {
    await assertNoStrictWorkflowDrift(root);
    await recoverJsonTransactions(root);
    const claimTransactionId = `paid-claim-${approvalId}`;
    const claimJournalPath = join(root, '.transactions', `${encodeURIComponent(claimTransactionId)}.json`);
    const existingClaim = await readJson(claimJournalPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existingClaim) {
      throw new Error('paid approval already has a submit owner claim; reconcile the existing run instead of claiming again');
    }
    const approvalPath = join(root, 'reviews', `${encodeURIComponent(approvalId)}.json`);
    const approval = await readJson(approvalPath);
    const approvedActor = approval.actor === 'human' || approval.actor === 'delegated_batch_policy';
    if (approval.kind !== 'paid_generation_approval' || !approvedActor || approval.decision !== 'approved' || approval.segmentId !== segmentId) {
      throw new Error('live generation requires a matching persisted paid approval');
    }
    if (approval.actor === 'delegated_batch_policy') {
      if (approval.executor !== 'runninghub') throw new Error('this RunningHub command cannot consume a LibTV batch approval');
      const batch = await readJson(join(root, 'reviews', `${encodeURIComponent(approval.parentBatchApprovalId)}.json`));
      const audit = await readJson(join(root, 'reviews', `${encodeURIComponent(approval.externalAuditAttestationId)}.json`));
      if (batch.kind !== 'batch_generation_approval' || batch.actor !== 'human' || batch.decision !== 'approved') {
        throw new Error('delegated paid approval has no valid human batch parent');
      }
      if (audit.kind !== 'external_audit_attestation' || audit.decision !== 'PASS' || audit.fingerprintSha256 !== approval.fingerprint.sha256) {
        throw new Error('delegated paid approval has no matching external audit PASS');
      }
    }
    const current = await inspectVideoPackage(root, segmentId);
    await assertGenerationFailureGate(root, current.fingerprint);
    await requireExecutionControlEvidence(root, current.fingerprint, approval.executionControlEvidence);
    if (current.fingerprint.sha256 !== approval.fingerprint.sha256) throw new Error('approved generation fingerprint changed');
    if (approval.consumedByRunId) {
      const existing = await readJson(join(root, 'runs', `${encodeURIComponent(approval.consumedByRunId)}.json`)).catch(() => null);
      const status = existing?.status ?? 'missing';
      throw new Error(`paid approval already has a submit owner (${status}); reconcile the existing run instead of submitting again`);
    }
    try {
      await readJson(join(root, 'runs', `${encodeURIComponent(runId)}.json`));
      throw new Error(`generation run already exists: ${runId}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const ownerToken = randomUUID();
    const now = new Date().toISOString();
    const claimed = { ...approval, consumedByRunId: runId, consumedAt: new Date().toISOString() };
    const run = {
      id: runId, kind: 'runninghub_video', status: 'SUBMITTING', segmentId,
      paidApprovalId: approval.id, fingerprint: current.fingerprint, taskId: null,
      submitOwnerToken: ownerToken, submitOwnerPid: process.pid, submissionUncertain: false,
      outputs: [], createdAt: now, updatedAt: now
    };
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'generation.claimed', occurredAt: now,
      actor: { kind: 'system', id: null }, segmentId,
      correlationId: run.id, causationId: approval.id,
      idempotencyKey: `generation.claimed:${approval.id}`,
      references: [
        { kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` },
        { kind: 'paid_generation_approval', id: approval.id, path: `reviews/${encodeURIComponent(approval.id)}.json` }
      ],
      facts: {
        runId: run.id, approvalId: approval.id,
        fingerprintSha256: current.fingerprint.sha256, executor: approval.executor
      }
    });
    await commitJsonTransaction(root, claimTransactionId, [
      { path: join(root, 'runs', `${encodeURIComponent(runId)}.json`), value: run },
      { path: approvalPath, value: claimed },
      ...ledger.writes
    ], transactionOptions);
    return { run, inspected: current };
  });
}

export function recordSubmittedTask(root, runId, ownerToken, taskId) {
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
    const run = await readJson(path);
    if (run.status !== 'SUBMITTING' || run.taskId !== null || run.submitOwnerToken !== ownerToken) {
      throw new Error('only the active submit owner may attach the first taskId');
    }
    const updated = {
      ...run, status: 'SUBMITTED', taskId, submissionUncertain: false,
      submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'generation.submitted', occurredAt: updated.submittedAt,
      actor: { kind: 'system', id: null }, segmentId: run.segmentId,
      correlationId: run.id, causationId: run.paidApprovalId,
      idempotencyKey: `generation.submitted:${run.id}:${taskId}`,
      references: [{ kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` }],
      facts: {
        runId: run.id, taskId, approvalId: run.paidApprovalId,
        fingerprintSha256: run.fingerprint.sha256, status: updated.status
      }
    });
    await commitJsonTransaction(root, `generation-submitted-${run.id}`, [
      { path, value: updated },
      ...ledger.writes
    ]);
    return updated;
  });
}

export function markSubmissionUncertain(root, runId, ownerToken, error) {
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
    const run = await readJson(path);
    if (run.status !== 'SUBMITTING' || run.taskId !== null || run.submitOwnerToken !== ownerToken) return run;
    if (run.submissionUncertain) return run;
    const updated = {
      ...run, submissionUncertain: true, errorKind: error.kind ?? 'unknown',
      errorMessage: error.message, updatedAt: new Date().toISOString()
    };
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'generation.submission_uncertain', occurredAt: updated.updatedAt,
      actor: { kind: 'system', id: null }, segmentId: run.segmentId,
      correlationId: run.id, causationId: run.paidApprovalId,
      idempotencyKey: `generation.submission_uncertain:${run.id}`,
      references: [{ kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` }],
      facts: { runId: run.id, approvalId: run.paidApprovalId, errorKind: updated.errorKind, status: updated.status }
    });
    await commitJsonTransaction(root, `generation-submission-uncertain-${run.id}`, [
      { path, value: updated },
      ...ledger.writes
    ]);
    return updated;
  });
}

export async function reconcileVideoSubmission(root, { runId, taskId, confirmedNotSubmitted, note }) {
  const normalizedTaskId = typeof taskId === 'string' ? taskId.trim() : taskId;
  if (taskId !== undefined && (typeof taskId !== 'string' || !SAFE_TASK_ID.test(normalizedTaskId))) {
    throw new Error('taskId must be a non-empty safe token');
  }
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    if (Boolean(normalizedTaskId) === Boolean(confirmedNotSubmitted)) {
      throw new Error('reconcile requires exactly one of taskId or confirmed_not_submitted');
    }
    if (typeof note !== 'string' || note.trim() === '') throw new Error('human reconcile note is required');
    const path = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
    const run = await readJson(path);
    if (run.kind !== 'runninghub_video' || run.status !== 'SUBMITTING' || run.taskId !== null) {
      throw new Error('only an uncertain SUBMITTING run without taskId can be reconciled');
    }
    if (!run.submissionUncertain && processIsAlive(run.submitOwnerPid)) {
      throw new Error('submit owner is still active; stop it before human reconciliation');
    }
    const now = new Date().toISOString();
    const reconciliation = { actor: 'human', note, reconciledAt: now };
    const updated = normalizedTaskId
      ? { ...run, status: 'SUBMITTED', taskId: normalizedTaskId, submissionUncertain: false, reconciliation, submittedAt: now, updatedAt: now }
      : { ...run, status: 'CONFIRMED_NOT_SUBMITTED', submissionUncertain: false, reconciliation, updatedAt: now };
    const eventType = normalizedTaskId ? 'generation.reconciled' : 'generation.confirmed_not_submitted';
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: eventType, occurredAt: now,
      actor: { kind: 'human', id: null }, segmentId: run.segmentId,
      correlationId: run.id, causationId: run.paidApprovalId,
      idempotencyKey: `${eventType}:${run.id}`,
      references: [{ kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` }],
      facts: {
        runId: run.id, approvalId: run.paidApprovalId, status: updated.status,
        reconciliationOutcome: normalizedTaskId ? 'task_adopted' : 'confirmed_not_submitted',
        ...(normalizedTaskId ? { taskId: normalizedTaskId } : {})
      }
    });
    await commitJsonTransaction(root, `generation-reconcile-${run.id}`, [
      { path, value: updated },
      ...ledger.writes
    ]);
    return updated;
  });
}

export async function loadResumableGeneration(root, runId, segmentId) {
  const run = await readJson(join(root, 'runs', `${encodeURIComponent(runId)}.json`));
  if (run.kind !== 'runninghub_video' || run.segmentId !== segmentId
    || !['SUBMITTED', 'INTERRUPTED'].includes(run.status)
    || typeof run.taskId !== 'string' || run.taskId.trim() === '') {
    throw new Error('resume requires a non-terminal SUBMITTED or INTERRUPTED run with a persisted taskId; reconcile uncertain submissions first');
  }
  const inspected = await inspectVideoPackage(root, segmentId);
  if (run.fingerprint.sha256 !== inspected.fingerprint.sha256) throw new Error('resumable generation fingerprint changed');
  return { run, inspected };
}

export function updateGenerationRun(root, runId, patch) {
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
    const run = await readJson(path);
    const updated = { ...run, ...patch, updatedAt: new Date().toISOString() };
    const eventType = {
      SUCCESS: 'generation.succeeded', FAILED: 'generation.failed', FAILED_TECHNICAL: 'generation.failed',
      INTERRUPTED: 'generation.interrupted'
    }[updated.status];
    if (!eventType) {
      await writeJsonAtomic(path, updated);
      return updated;
    }
    const references = [{ kind: 'generation_run', id: run.id, path: `runs/${encodeURIComponent(run.id)}.json` }];
    for (const [index, output] of (updated.outputs ?? []).entries()) {
      references.push({ kind: 'generated_output', id: `output-${index + 1}`, path: output.path, sha256: output.sha256 });
    }
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: eventType, occurredAt: updated.updatedAt,
      actor: { kind: 'system', id: null }, segmentId: run.segmentId,
      correlationId: run.id, causationId: run.paidApprovalId,
      idempotencyKey: `${eventType}:${run.id}`,
      references,
      facts: {
        runId: run.id, approvalId: run.paidApprovalId, taskId: run.taskId,
        fingerprintSha256: run.fingerprint.sha256, status: updated.status,
        outputCount: (updated.outputs ?? []).length,
        ...(updated.errorKind ? { errorKind: updated.errorKind } : {})
      }
    });
    await commitJsonTransaction(root, `${eventType}-${run.id}`, [
      { path, value: updated },
      ...ledger.writes
    ]);
    return updated;
  });
}
