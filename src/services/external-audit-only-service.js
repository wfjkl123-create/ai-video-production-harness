import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OpenCodexAuditAdapter } from '../adapters/opencodex-audit-adapter.js';
import { assertExternalAuditOnlyApproval } from '../domain/external-audit-only-approval.js';
import { assertIndependentCreativeAudit } from '../domain/independent-creative-audit.js';
import { deriveExecutionObservationBestEffort } from './authoritative-trace-observation-service.js';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction } from '../storage/transaction-journal.js';

function safeRelative(root, value, label) {
  if (typeof value !== 'string' || isAbsolute(value)) throw new Error(`${label} must be a project-relative path`);
  const path = resolve(root, value);
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} must stay inside the project`);
  return { path, relativePath: rel.split(sep).join('/') };
}

function normalized(value) {
  return JSON.stringify(value);
}

function providerFor(model) {
  const match = model.match(/^(?:claude-ocx-)?(anthropic|kimi|qwen)(?:--|\/)/);
  if (!match) throw new Error('cannot identify the external audit provider');
  return match[1];
}

async function verifyFile(root, binding, label) {
  const file = safeRelative(root, binding.path, label);
  if (await sha256File(file.path) !== binding.sha256) throw new Error(`${label} checksum changed after approval`);
}

async function verifyBinding(root, approval) {
  await verifyFile(root, approval.binding.auditBrief, 'audit brief');
  await verifyFile(root, approval.binding.prompt, 'prompt');
  await verifyFile(root, approval.binding.package, 'compiled package');
  for (const kind of ['images', 'videos', 'audio']) {
    for (const item of approval.binding.inputMedia[kind]) await verifyFile(root, item, `${kind} input ${item.id}`);
  }
  const brief = await readJson(safeRelative(root, approval.binding.auditBrief.path, 'audit brief').path);
  if (brief.kind !== 'independent_creative_audit_brief' || brief.segmentId !== approval.segmentId) throw new Error('approval requires a matching independent creative audit brief');
  if (!Array.isArray(brief.sourceEvidence) || brief.sourceEvidence.length === 0) throw new Error('audit brief must bind source evidence');
  for (const item of brief.sourceEvidence) await verifyFile(root, item, `source evidence ${item.id ?? item.path}`);
  if (brief.visualProxies !== undefined) {
    if (!Array.isArray(brief.visualProxies)) throw new Error('audit brief visualProxies must be an array');
    for (const item of brief.visualProxies) {
      if (!item || typeof item !== 'object') throw new Error('audit brief visual proxy must be an object');
      await verifyFile(root, item.source, `visual proxy source ${item.source?.id ?? ''}`);
      await verifyFile(root, item.proxy, `visual proxy ${item.proxy?.id ?? ''}`);
    }
  }
  if (brief.requiredInspector?.contextMode !== 'clean_zero_context' || brief.requiredInspector?.readOnly !== true) {
    throw new Error('audit brief must require clean_zero_context read-only inspection');
  }
  const expected = brief.generationEvidence;
  if (!expected || normalized(expected.prompt) !== normalized(approval.binding.prompt)
    || normalized(expected.package) !== normalized(approval.binding.package)
    || normalized(expected.inputMedia) !== normalized(approval.binding.inputMedia)) {
    throw new Error('approval binding does not exactly match the audit brief generation evidence');
  }
  if (!Array.isArray(brief.mandatoryCoverage) || brief.mandatoryCoverage.length === 0) throw new Error('audit brief must declare mandatory coverage');
  return brief;
}

async function assertMissing(path, label) {
  await access(path).then(() => { throw new Error(`${label} already exists; refusing to overwrite review evidence`); }, error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function attemptsForApproval(root, approvalId) {
  const entries = await readdir(join(root, 'runs'), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
    const record = await readJson(join(root, 'runs', entry.name));
    if (record?.kind === 'independent_external_model_audit' && record.approvalId === approvalId) records.push(record);
  }
  return records;
}

async function writeTextAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function markdownReport({ approval, runId, sessionId, result, reviewedAt }) {
  const coverage = result.report.coverage.map(item => `- ${item.category}: ${item.status} — ${item.evidence}`).join('\n');
  const findings = result.report.findings.length === 0 ? '- None' : result.report.findings.map(item => `- [${item.severity}] ${item.category}: ${item.evidence} Recommendation: ${item.recommendation}`).join('\n');
  const usageLine = approval.budget.unit === 'USD'
    ? `Actual cost: USD ${result.costUsd}`
    : `${result.costEvidence?.classification === 'usage_derived_consumed_credits' ? 'Usage-derived consumption' : 'Actual consumption'}: ${result.consumedCredits} Credits`;
  return `# Segment independent external audit\n\n- Decision: ${result.report.decision}\n- Provider: ${providerFor(approval.model)}\n- Model: ${approval.model}\n- Session/task ID: ${sessionId}\n- Context: clean_zero_context, read-only\n- ${usageLine}\n- Run ID: ${runId}\n- Reviewed at: ${reviewedAt}\n\n## Summary\n\n${result.report.summary}\n\n## Coverage\n\n${coverage}\n\n## Findings\n\n${findings}\n`;
}

export async function persistExternalAuditOnlyApproval(root, approval) {
  assertExternalAuditOnlyApproval(approval);
  const state = await readJson(join(root, 'project-state.json'));
  if (approval.projectId !== state.projectId) throw new Error('audit-only approval projectId does not match the project');
  await verifyBinding(root, approval);
  return withProjectLock(root, async () => {
    const path = join(root, 'reviews', `${encodeURIComponent(approval.id)}.json`);
    await readJson(path).then(() => { throw new Error(`audit-only approval already exists: ${approval.id}`); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await writeJsonAtomic(path, approval);
    return approval;
  });
}

export async function executeIndependentExternalAudit(root, input, options = {}) {
  const approval = assertExternalAuditOnlyApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(input.approvalId)}.json`)));
  const state = await readJson(join(root, 'project-state.json'));
  if (approval.projectId !== state.projectId) throw new Error('audit-only approval projectId does not match the project');
  const brief = await verifyBinding(root, approval);
  const runId = options.runId ?? `independent-external-audit-${randomUUID()}`;
  const sessionId = options.sessionId ?? randomUUID();
  const runPath = join(root, 'runs', `${encodeURIComponent(runId)}.json`);
  const now = new Date().toISOString();
  const bindingSha256 = createHash('sha256').update(normalized(approval.binding)).digest('hex');
  const reportRelative = brief.expectedOutputs?.reportMarkdown ?? `reviews/${approval.segmentId}-independent-audit-report.md`;
  const machineRelative = brief.expectedOutputs?.machineJson ?? `reviews/${approval.segmentId}-independent-audit.json`;
  const reportFile = safeRelative(root, reportRelative, 'audit report');
  const machineFile = safeRelative(root, machineRelative, 'audit machine output');
  const adapter = options.adapter ?? new OpenCodexAuditAdapter({
    cwd: root, model: approval.model, budget: approval.budget, executionPolicy: approval.executionPolicy
  });
  const executorPreflight = await adapter.preflight();

  const retryOfRunId = typeof options.retryOfRunId === 'string' && options.retryOfRunId.length > 0
    ? options.retryOfRunId
    : null;
  if (retryOfRunId && !/^[A-Za-z0-9._-]+$/.test(retryOfRunId)) {
    throw new Error('external audit retry run id is invalid');
  }
  if (retryOfRunId && options.explicitRetryAuthorization !== true) {
    throw new Error('external audit retry requires explicit human authorization');
  }

  await withProjectLock(root, async () => {
    const attempts = await attemptsForApproval(root, approval.id);
    if (attempts.length >= approval.maxCalls) throw new Error(`audit-only approval ${approval.id} has already been consumed; automatic retry is forbidden`);
    if (retryOfRunId) {
      const predecessor = await readJson(join(root, 'runs', `${encodeURIComponent(retryOfRunId)}.json`));
      if (predecessor.kind !== 'independent_external_model_audit' || predecessor.status !== 'UNCERTAIN'
        || predecessor.auditRequestFingerprint !== options.requestFingerprint) {
        throw new Error('external audit retry does not bind the exact prior uncertain run');
      }
    }
    if (options.requestFingerprint) {
      const entries = await readdir(join(root, 'runs'), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('._')) continue;
        const prior = await readJson(join(root, 'runs', entry.name));
        const isExplicitRetryOfThisRun = retryOfRunId === prior.id && prior.status === 'UNCERTAIN' && options.explicitRetryAuthorization === true;
        if (prior.id !== runId && prior.kind === 'independent_external_model_audit'
          && prior.auditRequestFingerprint === options.requestFingerprint
          && ['SUBMITTING', 'UNCERTAIN', 'SUCCESS'].includes(prior.status)
          && !isExplicitRetryOfThisRun) {
          throw new Error(`external audit input ${options.requestFingerprint} already has ${prior.status} run ${prior.id}; paid replay is forbidden`);
        }
      }
    }
    await assertMissing(reportFile.path, 'audit report');
    await assertMissing(machineFile.path, 'audit machine output');
    await writeJsonAtomic(runPath, {
      id: runId, kind: 'independent_external_model_audit', status: 'SUBMITTING', approvalId: approval.id,
      projectId: approval.projectId, segmentId: approval.segmentId, provider: providerFor(approval.model),
      model: approval.model, sessionId, auditBriefPath: approval.binding.auditBrief.path,
      auditBriefSha256: approval.binding.auditBrief.sha256, bindingSha256,
      budget: approval.budget,
      ...(approval.budget.unit === 'USD' ? { maxBudgetUsd: approval.budget.perCallLimit } : { maxBudgetCredits: approval.budget.perCallLimit }),
      permissions: approval.permissions,
      executionPolicy: approval.executionPolicy, executorPreflight,
      ...(options.requestFingerprint ? { auditRequestFingerprint: options.requestFingerprint } : {}),
      ...(options.auditPurpose ? { auditPurpose: options.auditPurpose } : {}),
      ...(options.targetBinding ? { targetBinding: structuredClone(options.targetBinding) } : {}),
      ...(retryOfRunId ? { retryOfRunId, explicitRetryAuthorizedAt: now } : {}),
      createdAt: now, updatedAt: now
    });
  });

  try {
    const prompt = await readFile(safeRelative(root, approval.binding.auditBrief.path, 'audit brief').path, 'utf8');
    const result = await adapter.audit({ prompt, sessionId, requiredCoverage: brief.mandatoryCoverage });
    if (result.sessionId !== sessionId || result.cleanZeroContext !== true || result.model !== approval.model) throw new Error('external audit identity does not match the approved isolated session');
    if (result.report.decision === 'PASS' && result.report.findings.some(item => item.severity === 'blocker')) {
      throw new Error('external audit cannot PASS while reporting a blocker finding');
    }
    if (approval.budget.unit === 'USD') {
      if (result.costEvidence?.classification !== 'actual_billed_usd' || result.costEvidence.actualBilledUsd !== result.costUsd) throw new Error('external audit did not return actual billed USD evidence');
      if (!Number.isFinite(result.costUsd) || result.costUsd < 0 || result.costUsd > approval.budget.perCallLimit || result.costUsd > approval.budget.totalLimit) throw new Error('external audit returned missing or over-budget USD usage');
    } else {
      const requiredCreditsEvidence = approval.executionPolicy.costEvidenceRequired;
      const validCreditsEvidence = requiredCreditsEvidence === 'actual_consumed_credits'
        ? result.costEvidence?.classification === 'actual_consumed_credits'
        : requiredCreditsEvidence === 'usage_derived_consumed_credits'
          && result.costEvidence?.classification === 'usage_derived_consumed_credits'
          && result.costEvidence.receiptAvailable === false;
      if (!validCreditsEvidence || result.costEvidence.consumedCredits !== result.consumedCredits) {
        const label = requiredCreditsEvidence === 'actual_consumed_credits' ? 'actual consumed Credits' : 'usage-derived consumed Credits';
        throw new Error(`external audit did not return ${label} evidence (${requiredCreditsEvidence})`);
      }
      if (!Number.isFinite(result.consumedCredits) || result.consumedCredits < 0 || result.consumedCredits > approval.budget.perCallLimit || result.consumedCredits > approval.budget.totalLimit) throw new Error('external audit returned missing or over-budget Credits usage');
    }
    const reviewedAt = new Date().toISOString();
    const reportText = markdownReport({ approval, runId, sessionId, result, reviewedAt });
    await writeTextAtomic(reportFile.path, reportText);
    const reportSha256 = await sha256File(reportFile.path);
    const audit = assertIndependentCreativeAudit({
      id: options.artifactId ?? `${approval.segmentId}-independent-audit-v1`, kind: 'independent_creative_audit', segmentId: approval.segmentId,
      revision: options.revision ?? 1, decision: result.report.decision, agentContextMode: 'clean_zero_context', agentTaskId: sessionId,
      evidenceRunId: runId,
      sourceRange: brief.sourceRange, reportPath: reportFile.relativePath, reportSha256,
      promptSha256: approval.binding.prompt.sha256, packageSha256: approval.binding.package.sha256,
      inputMedia: approval.binding.inputMedia,
      blockerCount: result.report.findings.filter(item => item.severity === 'blocker').length,
      importantCount: result.report.findings.filter(item => item.severity === 'important').length,
      reviewedAt
    });
    const providerReportPath = join(root, 'reviews', 'external-audits', `${encodeURIComponent(runId)}.json`);
    const providerReportSha256 = createHash('sha256').update(`${JSON.stringify(result.report, null, 2)}\n`).digest('hex');
    const machineOutputSha256 = createHash('sha256').update(`${JSON.stringify(audit, null, 2)}\n`).digest('hex');
    const completed = {
      ...(await readJson(runPath)), status: 'SUCCESS', decision: result.report.decision,
      ...(approval.budget.unit === 'USD' ? { costUsd: result.costUsd } : { consumedCredits: result.consumedCredits }),
      usage: result.usage ?? null, reportPath: reportFile.relativePath, reportSha256,
      costEvidence: result.costEvidence, executionEvidence: result.executionEvidence ?? null,
      providerReportPath: relative(root, providerReportPath).split(sep).join('/'), providerReportSha256,
      machineOutputPath: machineFile.relativePath, machineOutputSha256, artifactId: audit.id, updatedAt: reviewedAt
    };
    await withProjectLock(root, () => commitJsonTransaction(root, `independent-external-audit-complete-${runId}`, [
      { path: providerReportPath, value: result.report }, { path: machineFile.path, value: audit }, { path: runPath, value: completed }
    ]));
    await deriveExecutionObservationBestEffort(root, {
      schemaVersion: 1,
      kind: 'execution_observation_derivation',
      sourceType: 'external_audit_cost',
      runId
    }, {
      deriveExecutionObservation: options.deriveExecutionObservation,
      derivationOptions: options.observationDerivationOptions,
      onError: options.onObservationError
    });
    return {
      run: completed, audit,
      artifactDescriptor: { id: audit.id, type: 'independent_creative_audit', revision: audit.revision, status: 'draft', path: machineFile.relativePath, segmentId: audit.segmentId }
    };
  } catch (error) {
    await withProjectLock(root, async () => {
      const record = await readJson(runPath);
      await writeJsonAtomic(runPath, {
        ...record, status: 'UNCERTAIN', errorMessage: error.message,
        executionEvidence: error.executionEvidence ?? null, updatedAt: new Date().toISOString()
      });
    });
    throw error;
  }
}
