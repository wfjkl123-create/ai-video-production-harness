import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File } from '../../src/storage/checksum.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { executeIndependentExternalAudit, persistExternalAuditOnlyApproval } from '../../src/services/external-audit-only-service.js';
import { readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';

const model = 'claude-ocx-anthropic--claude-opus-4-8';
const sessionId = '11111111-1111-4111-8111-111111111111';
const executionPolicy = {
  costEvidenceRequired: 'actual_billed_usd', maxTurns: 1, maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
  requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
  pricing: { unit: 'USD_per_million_tokens', inputUsdPerMillion: 5, outputUsdPerMillion: 25, source: 'verified-test-price', verifiedAt: '2026-07-28T00:00:00Z' },
  worstCaseUsd: 0.08
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'audit-only-'));
  for (const dir of ['reviews', 'runs', 'prompts', 'assets']) await mkdir(join(root, dir), { recursive: true });
  await writeJsonAtomic(join(root, 'project-state.json'), { projectId: 'p1', phase: 'production', activeSegmentId: 'segment-001', blockedReason: null, artifacts: [], updatedAt: '2026-07-28T00:00:00Z' });
  await writeFile(join(root, 'prompts', 'p.txt'), 'locked prompt');
  await writeJsonAtomic(join(root, 'prompts', 'package.json'), { imageInputs: [], videoInputs: [], audioInputs: [] });
  await writeFile(join(root, 'assets', 'image.png'), 'image');
  await writeFile(join(root, 'assets', 'source.mp4'), 'source');
  const prompt = { id: 'prompt-1', path: 'prompts/p.txt', sha256: await sha256File(join(root, 'prompts', 'p.txt')) };
  const pkg = { path: 'prompts/package.json', sha256: await sha256File(join(root, 'prompts', 'package.json')) };
  const image = { id: 'image-1', path: 'assets/image.png', sha256: await sha256File(join(root, 'assets', 'image.png')) };
  const brief = {
    kind: 'independent_creative_audit_brief', segmentId: 'segment-001', sourceRange: '00:00.000-00:15.000',
    requiredInspector: { contextMode: 'clean_zero_context', readOnly: true },
    sourceEvidence: [{ id: 'source-1', path: 'assets/source.mp4', sha256: await sha256File(join(root, 'assets', 'source.mp4')) }],
    generationEvidence: { prompt, package: pkg, inputMedia: { images: [image], videos: [], audio: [] } },
    mandatoryCoverage: ['prompt_and_reference_pollution'],
    expectedOutputs: { reportMarkdown: 'reviews/audit-report.md', machineJson: 'reviews/audit.json' }
  };
  await writeJsonAtomic(join(root, 'reviews', 'brief.json'), brief);
  const approval = {
    id: 'audit-only-1', kind: 'external_audit_only_approval', actor: 'human', decision: 'approved', projectId: 'p1', segmentId: 'segment-001',
    model, maxCalls: 1, budget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.4 },
    executionPolicy,
    permissions: { readOnly: true, automaticRetries: false, imageGeneration: false, videoGeneration: false, externalMessages: false },
    binding: { auditBrief: { path: 'reviews/brief.json', sha256: await sha256File(join(root, 'reviews', 'brief.json')) }, prompt, package: pkg, inputMedia: { images: [image], videos: [], audio: [] } },
    approvedAt: '2026-07-28T00:00:00Z'
  };
  await persistExternalAuditOnlyApproval(root, approval);
  return { root, approval };
}

function fakeAdapter(audit) {
  return { preflight: async () => ({ checkedWithoutModelCall: true, capabilities: { max_turns: true, max_output_tokens: true }, worstCaseUsd: 0.08 }), audit };
}

function passingAdapter(root) {
  return fakeAdapter(async ({ sessionId: actual, requiredCoverage }) => {
    const claimed = await readJson(join(root, 'runs', 'run-1.json'));
    assert.equal(claimed.status, 'SUBMITTING');
    assert.equal(claimed.permissions.videoGeneration, false);
    assert.equal(actual, sessionId);
    return {
      sessionId, model, cleanZeroContext: true, costUsd: 0.03,
      costEvidence: { classification: 'actual_billed_usd', actualBilledUsd: 0.03, amountUsd: 0.03, source: 'test-provider-receipt' },
      usage: { input_tokens: 10 },
      report: { decision: 'PASS', summary: 'all bound evidence checked', coverage: requiredCoverage.map(category => ({ category, status: 'PASS', evidence: 'checked exact file' })), findings: [] }
    };
  });
}

test('consumes one audit-only approval and produces a draft independent audit without generation authorization', async () => {
  const { root } = await fixture();
  const result = await executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, { adapter: passingAdapter(root), runId: 'run-1', sessionId });
  assert.equal(result.run.status, 'SUCCESS');
  assert.equal(result.run.costUsd, 0.03);
  assert.equal(result.audit.decision, 'PASS');
  assert.equal(result.audit.agentContextMode, 'clean_zero_context');
  assert.equal(result.audit.evidenceRunId, 'run-1');
  assert.equal(result.run.artifactId, result.audit.id);
  assert.match(result.run.machineOutputSha256, /^[a-f0-9]{64}$/);
  assert.match(result.run.providerReportSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.artifactDescriptor.status, 'draft');
  assert.equal(result.artifactDescriptor.type, 'independent_creative_audit');
  const reviewFiles = await Promise.all(['audit-only-1.json', 'audit.json'].map(name => readJson(join(root, 'reviews', name))));
  assert.equal(reviewFiles.some(value => value.kind === 'paid_generation_approval'), false);
  const ledger = await readExecutionLedgerStatus(root);
  assert.equal(ledger.observations.derivation.bySourceType.external_audit_cost, 1);
  assert.equal(ledger.observations.cost.byUnit.USD.actual.amount, 0.03);
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: fakeAdapter(async () => assert.fail('must not call twice')), runId: 'run-2', sessionId: '22222222-2222-4222-8222-222222222222'
  }), /already been consumed/);
});

test('the same exact audit fingerprint cannot be paid again through a fresh approval', async () => {
  const { root, approval } = await fixture();
  const fingerprint = 'f'.repeat(64);
  await executeIndependentExternalAudit(root, { approvalId: approval.id }, {
    adapter: passingAdapter(root), runId: 'run-1', sessionId, requestFingerprint: fingerprint,
    auditPurpose: 'creative_package'
  });
  const second = { ...approval, id: 'audit-only-2', approvedAt: '2026-07-28T00:01:00Z' };
  await persistExternalAuditOnlyApproval(root, second);
  let called = false;
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: second.id }, {
    adapter: fakeAdapter(async () => { called = true; }), runId: 'run-2',
    sessionId: '22222222-2222-4222-8222-222222222222', requestFingerprint: fingerprint,
    auditPurpose: 'creative_package'
  }), /paid replay is forbidden/);
  assert.equal(called, false);
});

test('cost observation failure never turns a completed external audit into UNCERTAIN', async () => {
  const { root } = await fixture();
  const errors = [];
  const result = await executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: passingAdapter(root), runId: 'run-1', sessionId,
    deriveExecutionObservation: async () => { throw new Error('cost ledger unavailable'); },
    onObservationError: error => errors.push(error.message)
  });
  assert.equal(result.run.status, 'SUCCESS');
  assert.equal((await readJson(join(root, 'runs', 'run-1.json'))).status, 'SUCCESS');
  assert.deepEqual(errors, ['cost ledger unavailable']);
});

test('an interrupted call becomes UNCERTAIN and cannot be retried', async () => {
  const { root } = await fixture();
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: fakeAdapter(async () => { throw new Error('connection lost'); }), runId: 'run-1', sessionId
  }), /connection lost/);
  assert.equal((await readJson(join(root, 'runs', 'run-1.json'))).status, 'UNCERTAIN');
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: fakeAdapter(async () => assert.fail('must not retry')), runId: 'run-2', sessionId: '22222222-2222-4222-8222-222222222222'
  }), /already been consumed/);
});

test('a new approval can retry exactly one matching UNCERTAIN run only with explicit human authorization', async () => {
  const { root, approval } = await fixture();
  const fingerprint = 'a'.repeat(64);
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: approval.id }, {
    adapter: fakeAdapter(async () => { throw new Error('first isolated session ended before a conclusion'); }),
    runId: 'run-1', sessionId, requestFingerprint: fingerprint, auditPurpose: 'creative_package'
  }), /ended before a conclusion/);
  const retryApproval = { ...approval, id: 'audit-only-2', approvedAt: '2026-07-28T00:01:00Z' };
  await persistExternalAuditOnlyApproval(root, retryApproval);
  const retrySessionId = '22222222-2222-4222-8222-222222222222';
  const result = await executeIndependentExternalAudit(root, { approvalId: retryApproval.id }, {
    adapter: fakeAdapter(async ({ sessionId: actual, requiredCoverage }) => ({
      sessionId: actual, model, cleanZeroContext: true, costUsd: 0.03,
      costEvidence: { classification: 'actual_billed_usd', actualBilledUsd: 0.03, amountUsd: 0.03, source: 'test-provider-receipt' },
      usage: { input_tokens: 10 },
      report: { decision: 'PASS', summary: 'checked after explicit retry', coverage: requiredCoverage.map(category => ({ category, status: 'PASS', evidence: 'checked exact file' })), findings: [] }
    })), runId: 'run-2', sessionId: retrySessionId, requestFingerprint: fingerprint, auditPurpose: 'creative_package',
    retryOfRunId: 'run-1', explicitRetryAuthorization: true
  });
  assert.equal(result.run.status, 'SUCCESS');
  assert.equal(result.run.retryOfRunId, 'run-1');
  assert.equal((await readJson(join(root, 'runs', 'run-1.json'))).status, 'UNCERTAIN');
});

test('a custom adapter cannot smuggle a blocker finding through a PASS decision', async () => {
  const { root } = await fixture();
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: fakeAdapter(async ({ requiredCoverage }) => ({
      sessionId, model, cleanZeroContext: true, costUsd: 0.03,
      costEvidence: { classification: 'actual_billed_usd', actualBilledUsd: 0.03, amountUsd: 0.03, source: 'test' },
      report: {
        decision: 'PASS', summary: 'contradictory',
        coverage: requiredCoverage.map(category => ({ category, status: 'PASS', evidence: 'checked' })),
        findings: [{ severity: 'blocker', category: 'prompt', evidence: 'fatal mismatch', recommendation: 'fix it' }]
      }
    })), runId: 'run-1', sessionId
  }), /cannot PASS.*blocker/i);
  assert.equal((await readJson(join(root, 'runs', 'run-1.json'))).status, 'UNCERTAIN');
});

test('stale bound media blocks before an external call is claimed', async () => {
  const { root } = await fixture();
  await writeFile(join(root, 'assets', 'image.png'), 'changed');
  let called = false;
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: fakeAdapter(async () => { called = true; }), runId: 'run-1', sessionId
  }), /checksum changed/);
  assert.equal(called, false);
  await assert.rejects(readJson(join(root, 'runs', 'run-1.json')), error => error.code === 'ENOENT');
});

test('stale source evidence or an existing output blocks before the external call', async () => {
  for (const prepare of [
    root => writeFile(join(root, 'assets', 'source.mp4'), 'changed source'),
    root => writeFile(join(root, 'reviews', 'audit-report.md'), 'existing evidence')
  ]) {
    const { root } = await fixture();
    await prepare(root);
    let called = false;
    await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
      adapter: fakeAdapter(async () => { called = true; }), runId: 'run-1', sessionId
    }), /checksum changed|refusing to overwrite/);
    assert.equal(called, false);
  }
});

test('visual proxy evidence binds both the original video and its sampled-frame image', async () => {
  const { root, approval } = await fixture();
  await writeFile(join(root, 'assets', 'source-samples.png'), 'sampled frames');
  const briefPath = join(root, 'reviews', 'proxy-brief.json');
  const brief = await readJson(join(root, 'reviews', 'brief.json'));
  brief.visualProxies = [{
    source: brief.sourceEvidence[0],
    proxy: { id: 'source-samples', path: 'assets/source-samples.png', sha256: await sha256File(join(root, 'assets', 'source-samples.png')) }
  }];
  await writeJsonAtomic(briefPath, brief);
  const proxyApproval = {
    ...approval,
    id: 'audit-only-with-proxy',
    binding: { ...approval.binding, auditBrief: { path: 'reviews/proxy-brief.json', sha256: await sha256File(briefPath) } }
  };
  await persistExternalAuditOnlyApproval(root, proxyApproval);
  await writeFile(join(root, 'assets', 'source-samples.png'), 'changed samples');
  let called = false;
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: proxyApproval.id }, {
    adapter: fakeAdapter(async () => { called = true; }), runId: 'run-proxy', sessionId
  }), /visual proxy .*checksum changed/);
  assert.equal(called, false);
});

test('missing or over-budget cost evidence makes the consumed call UNCERTAIN', async () => {
  for (const costUsd of [undefined, 0.41]) {
    const { root } = await fixture();
    await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
      adapter: fakeAdapter(async () => ({
        sessionId, model, cleanZeroContext: true, costUsd,
        costEvidence: costUsd === undefined ? undefined : { classification: 'actual_billed_usd', actualBilledUsd: costUsd, amountUsd: costUsd, source: 'test' }, usage: null,
        report: { decision: 'FAIL', summary: 'x', coverage: [{ category: 'prompt_and_reference_pollution', status: 'FAIL', evidence: 'x' }], findings: [] }
      })), runId: 'run-1', sessionId
    }), /actual billed USD|missing or over-budget/);
    assert.equal((await readJson(join(root, 'runs', 'run-1.json'))).status, 'UNCERTAIN');
  }
});

test('executor capability failure blocks before consuming the approval or calling a model', async () => {
  const { root } = await fixture();
  let called = false;
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: { preflight: async () => { throw new Error('missing max_output_tokens'); }, audit: async () => { called = true; } },
    runId: 'run-1', sessionId
  }), /missing max_output_tokens/);
  assert.equal(called, false);
  await assert.rejects(readJson(join(root, 'runs', 'run-1.json')), error => error.code === 'ENOENT');
});

test('non-zero adapter evidence is persisted on the UNCERTAIN run', async () => {
  const { root } = await fixture();
  const error = new Error('exit 1');
  error.executionEvidence = { exitCode: 1, stdoutSha256: 'b'.repeat(64), envelope: { subtype: 'error_during_execution', total_cost_usd: 0.39 } };
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: fakeAdapter(async () => { throw error; }), runId: 'run-1', sessionId
  }), /exit 1/);
  const run = await readJson(join(root, 'runs', 'run-1.json'));
  assert.equal(run.status, 'UNCERTAIN');
  assert.equal(run.executionEvidence.envelope.subtype, 'error_during_execution');
});

test('API list-price estimate is not accepted as actual billed USD evidence', async () => {
  const { root } = await fixture();
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: 'audit-only-1' }, {
    adapter: fakeAdapter(async () => ({
      sessionId, model, cleanZeroContext: true, costUsd: 0.03,
      costEvidence: { classification: 'api_list_price_equivalent', actualBilledUsd: null, amountUsd: 0.03, source: 'gateway-estimate' },
      report: { decision: 'PASS', summary: 'x', coverage: [{ category: 'prompt_and_reference_pollution', status: 'PASS', evidence: 'x' }], findings: [] }
    })), runId: 'run-1', sessionId
  }), /actual billed USD/);
  assert.equal((await readJson(join(root, 'runs', 'run-1.json'))).status, 'UNCERTAIN');
});

test('credits approval requires an actual consumed credits receipt', async () => {
  const { root } = await fixture();
  const path = join(root, 'reviews', 'audit-only-1.json');
  const approval = await readJson(path);
  approval.model = 'qwen/qwen3.8-max-preview';
  approval.budget = { unit: 'CREDITS', perCallLimit: 120, totalLimit: 120 };
  approval.executionPolicy = {
    costEvidenceRequired: 'actual_consumed_credits', maxTurns: 1,
    maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
    requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
    pricing: { unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion: 20_000, outputCreditsPerMillion: 30_000, source: 'verified', verifiedAt: '2026-07-28T00:00:00Z' },
    worstCaseCredits: 110
  };
  await writeJsonAtomic(path, approval);
  await assert.rejects(executeIndependentExternalAudit(root, { approvalId: approval.id }, {
    adapter: fakeAdapter(async () => ({
      sessionId, model: approval.model, cleanZeroContext: true,
      costEvidence: { classification: 'token_counts_only', consumedCredits: null, source: 'executor' },
      usage: { input_tokens: 10 },
      report: { decision: 'PASS', summary: 'x', coverage: [{ category: 'prompt_and_reference_pollution', status: 'PASS', evidence: 'x' }], findings: [] }
    })), runId: 'run-credits-missing', sessionId
  }), /actual consumed Credits/i);
});

test('credits approval accepts bounded actual consumed credits evidence', async () => {
  const { root } = await fixture();
  const path = join(root, 'reviews', 'audit-only-1.json');
  const approval = await readJson(path);
  approval.model = 'qwen/qwen3.8-max-preview';
  approval.budget = { unit: 'CREDITS', perCallLimit: 120, totalLimit: 120 };
  approval.executionPolicy = {
    costEvidenceRequired: 'actual_consumed_credits', maxTurns: 1,
    maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
    requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
    pricing: { unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion: 20_000, outputCreditsPerMillion: 30_000, source: 'verified', verifiedAt: '2026-07-28T00:00:00Z' },
    worstCaseCredits: 110
  };
  await writeJsonAtomic(path, approval);
  const result = await executeIndependentExternalAudit(root, { approvalId: approval.id }, {
    adapter: fakeAdapter(async ({ requiredCoverage }) => ({
      sessionId, model: approval.model, cleanZeroContext: true, consumedCredits: 42,
      costEvidence: { classification: 'actual_consumed_credits', consumedCredits: 42, amountCredits: 42, source: 'token-plan-receipt' },
      usage: { input_tokens: 10 },
      report: { decision: 'PASS', summary: 'x', coverage: requiredCoverage.map(category => ({ category, status: 'PASS', evidence: 'x' })), findings: [] }
    })), runId: 'run-credits-pass', sessionId
  });
  assert.equal(result.run.consumedCredits, 42);
  assert.equal(result.run.costUsd, undefined);
  const ledger = await readExecutionLedgerStatus(root);
  assert.equal(ledger.observations.cost.byUnit.credits.actual.amount, 42);
});

test('credits approval accepts explicitly authorized usage-derived evidence', async () => {
  const { root } = await fixture();
  const path = join(root, 'reviews', 'audit-only-1.json');
  const approval = await readJson(path);
  approval.model = 'kimi/k3';
  approval.budget = { unit: 'CREDITS', perCallLimit: 120, totalLimit: 120 };
  approval.executionPolicy = {
    costEvidenceRequired: 'usage_derived_consumed_credits', maxTurns: 1,
    maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
    requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
    pricing: { unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion: 1000, outputCreditsPerMillion: 1000, source: 'user-authorized usage-derived test rate', verifiedAt: '2026-07-28T00:00:00Z' },
    worstCaseCredits: 4
  };
  await writeJsonAtomic(path, approval);
  const result = await executeIndependentExternalAudit(root, { approvalId: approval.id }, {
    adapter: fakeAdapter(async ({ requiredCoverage }) => ({
      sessionId, model: approval.model, cleanZeroContext: true, consumedCredits: 0.15,
      costEvidence: { classification: 'usage_derived_consumed_credits', consumedCredits: 0.15, amountCredits: 0.15, receiptAvailable: false, source: 'claude_cli_usage_and_approved_token_plan_rates' },
      usage: { input_tokens: 100, output_tokens: 50 },
      report: { decision: 'PASS', summary: 'x', coverage: requiredCoverage.map(category => ({ category, status: 'PASS', evidence: 'x' })), findings: [] }
    })), runId: 'run-credits-derived', sessionId
  });
  assert.equal(result.run.consumedCredits, 0.15);
  assert.equal(result.run.costEvidence.receiptAvailable, false);
  const ledger = await readExecutionLedgerStatus(root);
  assert.equal(ledger.observations.cost.byUnit.credits.derived.amount, 0.15);
  assert.equal(ledger.observations.cost.byUnit.credits.actual.amount, 0);
});
