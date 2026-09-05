import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OpenCodexAuditAdapter } from '../adapters/opencodex-audit-adapter.js';
import { assertBatchGenerationApproval } from '../domain/batch-generation.js';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction } from '../storage/transaction-journal.js';
import { executionControlFingerprint } from '../domain/execution-control-contract.js';
import { recordGeneratedOutputFailure } from './generation-failure-service.js';

function safeRelative(root, value, label) {
  if (typeof value !== 'string' || isAbsolute(value)) throw new Error(`${label} must be a project-relative path`);
  const path = resolve(root, value);
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} must stay inside the project`);
  return { path, relativePath: rel.split(sep).join('/') };
}

function providerFor(model) {
  const match = model.match(/^(?:claude-ocx-)?(anthropic|kimi|qwen)(?:--|\/)/);
  if (!match) throw new Error('cannot identify the external audit provider');
  return match[1];
}

function outputFingerprint(outputs) {
  const normalized = outputs.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function fingerprintFor(root, input) {
  if (input.auditStage === 'pre_generation') {
    const preflight = await readJson(join(root, 'runs', `${encodeURIComponent(input.preflightId)}.json`));
    if (preflight.kind !== 'video_preflight' || preflight.status !== 'READY' || preflight.segmentId !== input.segmentId) {
      throw new Error('pre-generation external audit requires a matching ready preflight');
    }
    return preflight.fingerprint.sha256;
  }
  if (input.auditStage !== 'post_generation') throw new Error('auditStage must be pre_generation or post_generation');
  const run = await readJson(join(root, 'runs', `${encodeURIComponent(input.videoRunId)}.json`));
  if (run.segmentId !== input.segmentId || run.status !== 'SUCCESS' || !Array.isArray(run.outputs) || run.outputs.length === 0) {
    throw new Error('post-generation external audit requires a successful video run');
  }
  for (const output of run.outputs) {
    const file = safeRelative(root, output.path, 'video output');
    if (await sha256File(file.path) !== output.sha256) throw new Error('video output checksum changed before external audit');
  }
  return outputFingerprint(run.outputs);
}

async function uncertainAudit(root) {
  const entries = await readdir(join(root, 'runs'), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
    const record = await readJson(join(root, 'runs', entry.name));
    if (record?.kind === 'external_model_audit' && ['SUBMITTING', 'UNCERTAIN'].includes(record.status)) return record;
  }
  return null;
}

export async function executeExternalAudit(root, input, options = {}) {
  const batch = assertBatchGenerationApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(input.batchApprovalId)}.json`)));
  if (!batch.segments.some(segment => segment.segmentId === input.segmentId)) throw new Error('segment is outside the batch approval');
  const promptFile = safeRelative(root, input.promptPath, 'audit prompt');
  const prompt = await readFile(promptFile.path, 'utf8');
  let auditBrief;
  try { auditBrief = JSON.parse(prompt); } catch { throw new Error('external audit prompt must be a structured audit brief JSON'); }
  const requiredCoverage = input.auditStage === 'pre_generation' ? auditBrief.mandatoryCoverage : auditBrief.manualExternalChecksRequired;
  if (!Array.isArray(requiredCoverage) || requiredCoverage.length === 0 || requiredCoverage.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('external audit brief must declare every required coverage category');
  }
  const promptSha256 = await sha256File(promptFile.path);
  const fingerprintSha256 = await fingerprintFor(root, input);
  const runId = options.runId ?? `external-audit-${randomUUID()}`;
  const sessionId = options.sessionId ?? randomUUID();
  const runPath = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
  const now = new Date().toISOString();

  await withProjectLock(root, async () => {
    const blocked = await uncertainAudit(root);
    if (blocked) throw new Error(`external audit ${blocked.id} is uncertain; reconcile it before another model call`);
    if (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0 || input.maxBudgetUsd > batch.externalAuditBudget.perCallLimit) {
      throw new Error('external audit call exceeds the approved per-call USD limit');
    }
    const entries = await readdir(join(root, 'runs'), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    let usedUsd = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
      const existing = await readJson(join(root, 'runs', entry.name));
      if (existing?.kind === 'external_model_audit' && existing.status === 'SUCCESS') usedUsd += existing.costUsd ?? 0;
    }
    if (usedUsd + input.maxBudgetUsd > batch.externalAuditBudget.totalLimit) throw new Error('external audit total USD budget is exhausted');
    const record = {
      id: runId, kind: 'external_model_audit', status: 'SUBMITTING', batchApprovalId: batch.id,
      segmentId: input.segmentId, auditStage: input.auditStage, model: input.model, sessionId,
      fingerprintSha256, promptPath: promptFile.relativePath, promptSha256,
      maxBudgetUsd: input.maxBudgetUsd, createdAt: now, updatedAt: now
    };
    await writeJsonAtomic(runPath, record);
  });

  const adapter = options.adapter ?? new OpenCodexAuditAdapter({ cwd: root, model: input.model, maxBudgetUsd: input.maxBudgetUsd });
  try {
    const result = await adapter.audit({ prompt, sessionId, requiredCoverage });
    if (result.sessionId !== sessionId || result.cleanZeroContext !== true || result.model !== input.model) {
      throw new Error('external audit identity does not match the claimed isolated session');
    }
    const reportPath = join(root, 'reviews', 'external-audits', `${encodeURIComponent(runId)}.json`);
    await writeJsonAtomic(reportPath, result.report);
    const reportSha256 = await sha256File(reportPath);
    const attestation = {
      id: `${runId}-attestation`, kind: 'external_audit_attestation', segmentId: input.segmentId,
      auditStage: input.auditStage, provider: providerFor(input.model), model: input.model,
      providerTaskId: sessionId, auditRunId: runId, cleanZeroContext: true, decision: result.report.decision,
      fingerprintSha256, reportSha256, reviewedAt: new Date().toISOString(),
      reportPath: relative(root, reportPath).split(sep).join('/')
    };
    const completed = {
      ...(await readJson(runPath)), status: 'SUCCESS', decision: result.report.decision, costUsd: result.costUsd,
      attestationId: attestation.id, usage: result.usage ?? null, updatedAt: new Date().toISOString()
    };
    await withProjectLock(root, () => commitJsonTransaction(root, `external-audit-complete-${runId}`, [
      { path: runPath, value: completed },
      { path: join(root, 'reviews', `${encodeURIComponent(attestation.id)}.json`), value: attestation }
    ]));
    if (input.auditStage === 'post_generation' && result.report.decision === 'FAIL') {
      const state = await readJson(join(root, 'project-state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (state?.videoGovernanceVersion === 2) {
        const videoRun = await readJson(join(root, 'runs', `${encodeURIComponent(input.videoRunId)}.json`));
        const output = videoRun.outputs[0];
        const rootCauseKey = 'POST_GENERATION_EXTERNAL_AUDIT_FAIL';
        await recordGeneratedOutputFailure(root, {
          outputId: output.id ?? `${videoRun.id}-output-1`,
          outputSha256: output.sha256,
          failureType: 'third_party_video_audit_fail',
          rootCauseKey,
          causalAttribution: {
            kind: 'generation_failure_causal_attribution_v1', version: 1, rootCauseKey,
            primary: {
              key: rootCauseKey, stage: 'post_generation_external_audit',
              hypothesis: 'the generated output failed one or more locked perceptual or continuity requirements',
              confidence: 'medium',
              evidence: (result.report.findings ?? []).map(item => JSON.stringify(item)).concat([`report:${attestation.reportPath}`]),
              falsifier: 'independent frame-level review of the same output and locked requirement finds no cited mismatch'
            },
            contributors: [], counterEvidence: [],
            unknowns: ['the report proves the visible failure but not every upstream causal contributor'],
            nextMinimalCheck: {
              variable: 'first failing locked requirement',
              action: 'inspect that requirement against its source asset, prompt responsibility and execution control in isolation',
              expectedObservation: 'one stage becomes the earliest evidence-backed divergence point',
              changesOnePrimaryVariable: true, costClass: 'free'
            },
            promptOnlyRetryAllowed: false, controlRouteChangeRequired: true
          },
          segmentId: input.segmentId,
          failureObservation: {
            category: 'other',
            responsibilityStage: 'generation',
            returnStage: 'generation',
            retryKind: 'none'
          },
          controlRouteFingerprint: executionControlFingerprint(videoRun.fingerprint.executionControlContract),
          observableProblem: result.report.summary ?? 'Post-generation external audit failed',
          exactTimestampsOrRegions: (result.report.findings ?? []).flatMap(item => item.timestampsOrRegions ?? item.evidence ?? []).map(String).filter(Boolean).slice(0, 20).concat(['external_audit_report']),
          observedEvidence: (result.report.findings ?? []).map(item => JSON.stringify(item)).concat([`report:${attestation.reportPath}`]),
          expectedLockedRequirement: `External post-generation audit coverage: ${requiredCoverage.join(', ')}`,
          mostLikelyCause: 'Generated output failed one or more locked perceptual or continuity requirements',
          freeRevisionCompleted: 'external_post_generation_audit_completed'
        }, { id: `generation-failure-${runId}` });
      }
    }
    return { run: completed, attestation };
  } catch (error) {
    await withProjectLock(root, async () => {
      const record = await readJson(runPath);
      await writeJsonAtomic(runPath, { ...record, status: 'UNCERTAIN', errorMessage: error.message, updatedAt: new Date().toISOString() });
    });
    throw error;
  }
}
