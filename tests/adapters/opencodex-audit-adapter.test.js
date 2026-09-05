import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodexAuditAdapter, assertNonGptAuditModel } from '../../src/adapters/opencodex-audit-adapter.js';

const executionPolicy = {
  costEvidenceRequired: 'actual_billed_usd', maxTurns: 1, maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
  requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
  pricing: { unit: 'USD_per_million_tokens', inputUsdPerMillion: 5, outputUsdPerMillion: 25, source: 'verified-test-price', verifiedAt: '2026-07-28T00:00:00Z' },
  worstCaseUsd: 0.08
};

const capabilityRunner = async () => ({ code: 0, stderr: '', stdout: '--max-turns --max-output-tokens' });

test('builds a fresh read-only OpenCodex Claude audit with a hard budget', () => {
  const adapter = new OpenCodexAuditAdapter({ cwd: '/safe/project', model: 'claude-ocx-anthropic--claude-opus-4-8', maxBudgetUsd: 0.4, executionPolicy });
  const plan = adapter.plan({ prompt: 'review these locked files', sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(plan.executable, 'ocx');
  assert.equal(plan.cleanZeroContext, true);
  assert.deepEqual(plan.args.slice(0, 4), ['claude', '-p', '--model', 'claude-ocx-anthropic--claude-opus-4-8']);
  assert.ok(plan.args.includes('--no-session-persistence'));
  assert.ok(plan.args.includes('--safe-mode'));
  assert.ok(plan.args.includes('--json-schema'));
  assert.equal(plan.args[plan.args.indexOf('--tools') + 1], 'Read');
  assert.equal(plan.args[plan.args.indexOf('--max-budget-usd') + 1], '0.4');
  assert.equal(plan.args[plan.args.indexOf('--max-turns') + 1], '1');
  assert.equal(plan.args.includes('--max-output-tokens'), false);
  assert.equal(plan.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '3000');
});

test('rejects GPT, OpenAI, aliases, and unspecified providers', () => {
  for (const model of ['gpt-5', 'openai/gpt-5', 'opus', 'other/model']) {
    assert.throws(() => assertNonGptAuditModel(model), /explicit OpenCodex/);
  }
  assert.equal(assertNonGptAuditModel('kimi/kimi-k2.7-code'), 'kimi/kimi-k2.7-code');
  assert.equal(assertNonGptAuditModel('qwen/Qwen3.8-Max-Preview'), 'qwen/Qwen3.8-Max-Preview');
});

test('uses a prompt-embedded schema for Qwen because gateway discovery declares structured outputs unsupported', () => {
  const adapter = new OpenCodexAuditAdapter({ cwd: '/safe/project', model: 'claude-ocx-qwen--qwen3.8-max-preview', maxBudgetUsd: 0.4 });
  const plan = adapter.plan({ prompt: 'review', sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(plan.structuredOutputMode, 'prompt_contract_local_validation');
  assert.equal(plan.args.includes('--json-schema'), false);
  assert.match(plan.args.at(-1), /OUTPUT CONTRACT/);
  assert.match(plan.args.at(-1), /additionalProperties/);
});

test('accepts only a matching isolated session and structured result but labels gateway cost as an estimate', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const runner = async () => ({
    code: 0, stderr: '', stdout: JSON.stringify({
      session_id: sessionId,
      structured_output: { decision: 'PASS', summary: 'ok', coverage: [{ category: 'prompt', status: 'PASS', evidence: 'read' }], findings: [] },
      usage: { input_tokens: 10 }, total_cost_usd: 0.02
    })
  });
  const adapter = new OpenCodexAuditAdapter({ runner, capabilityRunner, cwd: '/safe/project', model: 'kimi/kimi-k2.7-code', maxBudgetUsd: 0.4, executionPolicy });
  const result = await adapter.audit({ prompt: 'review', sessionId, requiredCoverage: ['prompt'] });
  assert.equal(result.report.decision, 'PASS');
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.costEvidence.classification, 'api_list_price_equivalent');
  assert.equal(result.costEvidence.actualBilledUsd, null);
});

test('rejects a PASS that omits any required coverage category', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'kimi/kimi-k2.7-code', maxBudgetUsd: 0.4, executionPolicy, capabilityRunner,
    runner: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
      session_id: sessionId, total_cost_usd: 0.01,
      structured_output: { decision: 'PASS', summary: 'partial', coverage: [{ category: 'prompt', status: 'PASS', evidence: 'read' }], findings: [] }
    }) })
  });
  await assert.rejects(adapter.audit({ prompt: 'review', sessionId, requiredCoverage: ['prompt', 'assets'] }), /omitted required coverage/);
});

test('rejects a PASS that simultaneously reports a blocker finding', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'kimi/kimi-k2.7-code', maxBudgetUsd: 0.4, executionPolicy, capabilityRunner,
    runner: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
      session_id: sessionId, total_cost_usd: 0.01,
      structured_output: {
        decision: 'PASS', summary: 'contradictory',
        coverage: [{ category: 'prompt', status: 'PASS', evidence: 'read' }],
        findings: [{ severity: 'blocker', category: 'prompt', evidence: 'fatal mismatch', recommendation: 'fix it' }]
      }
    }) })
  });
  await assert.rejects(adapter.audit({ prompt: 'review', sessionId, requiredCoverage: ['prompt'] }), /cannot PASS.*blocker/i);
});

test('locally rejects malformed prompt-contract JSON from a routed model', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'qwen/qwen3.8-max-preview', maxBudgetUsd: 0.4, executionPolicy, capabilityRunner,
    runner: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
      session_id: sessionId, total_cost_usd: 0.01,
      result: JSON.stringify({ decision: 'PASS', summary: 'invalid', coverage: [{ category: 'prompt', status: 'PASS' }], findings: [] })
    }) })
  });
  await assert.rejects(adapter.audit({ prompt: 'review', sessionId, requiredCoverage: ['prompt'] }), error => {
    assert.match(error.message, /required contract/);
    assert.equal(error.executionEvidence.exitCode, 0);
    assert.equal(error.executionEvidence.envelope.session_id, sessionId);
    assert.match(error.executionEvidence.stdoutSha256, /^[a-f0-9]{64}$/);
    return true;
  });
});

test('fails before a model call when the installed executor lacks hard-budget flags', async () => {
  let called = false;
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'kimi/kimi-k2.7-code', maxBudgetUsd: 0.4, executionPolicy,
    capabilityRunner: async (_executable, _args, options) => options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ? ({ code: 1, stderr: 'unsupported output cap environment', stdout: '' })
      : ({ code: 0, stderr: '', stdout: '--max-turns only' }),
    runner: async () => { called = true; return { code: 0, stdout: '{}', stderr: '' }; }
  });
  await assert.rejects(adapter.audit({ prompt: 'review' }), error => {
    assert.match(error.message, /max_output_tokens/);
    assert.equal(error.executionEvidence.checkedWithoutModelCall, true);
    return true;
  });
  assert.equal(called, false);
});

test('preserves a redacted non-zero JSON envelope and stdout checksum as failure evidence', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const envelope = { type: 'result', subtype: 'error_during_execution', session_id: sessionId, total_cost_usd: 0.39, result: 'partial audit' };
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'kimi/kimi-k2.7-code', maxBudgetUsd: 0.4, executionPolicy, capabilityRunner,
    runner: async () => ({ code: 1, stderr: 'execution stopped', stdout: JSON.stringify(envelope) })
  });
  await assert.rejects(adapter.audit({ prompt: 'review', sessionId }), error => {
    assert.equal(error.executionEvidence.exitCode, 1);
    assert.equal(error.executionEvidence.envelope.subtype, 'error_during_execution');
    assert.equal(error.executionEvidence.envelope.result, 'partial audit');
    assert.match(error.executionEvidence.stdoutSha256, /^[a-f0-9]{64}$/);
    return true;
  });
});

test('Token Plan credits mode omits the fake USD flag and requires actual consumed credits', async () => {
  const creditsPolicy = {
    costEvidenceRequired: 'actual_consumed_credits', maxTurns: 1,
    maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
    requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
    pricing: { unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion: 20_000, outputCreditsPerMillion: 30_000, source: 'verified', verifiedAt: '2026-07-28T00:00:00Z' },
    worstCaseCredits: 110
  };
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'qwen/qwen3.8-max-preview',
    budget: { unit: 'CREDITS', perCallLimit: 120, totalLimit: 120 }, executionPolicy: creditsPolicy,
    capabilityRunner,
    runner: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
      session_id: sessionId, consumed_credits: 42,
      result: JSON.stringify({ decision: 'PASS', summary: 'ok', coverage: [{ category: 'prompt', status: 'PASS', evidence: 'read' }], findings: [] })
    }) })
  });
  const plan = adapter.plan({ prompt: 'review', sessionId });
  assert.equal(plan.args.includes('--max-budget-usd'), false);
  const result = await adapter.audit({ prompt: 'review', sessionId, requiredCoverage: ['prompt'] });
  assert.equal(result.consumedCredits, 42);
  assert.equal(result.costEvidence.classification, 'actual_consumed_credits');
});

test('Token Plan credits mode fails closed with receipt evidence when the gateway returns only usage/USD', async () => {
  const creditsPolicy = {
    costEvidenceRequired: 'actual_consumed_credits', maxTurns: 1,
    maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
    requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
    pricing: { unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion: 20_000, outputCreditsPerMillion: 30_000, source: 'verified', verifiedAt: '2026-07-28T00:00:00Z' },
    worstCaseCredits: 110
  };
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'kimi/k3',
    budget: { unit: 'CREDITS', perCallLimit: 120, totalLimit: 120 }, executionPolicy: creditsPolicy,
    capabilityRunner,
    runner: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
      session_id: sessionId, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 },
      result: JSON.stringify({ decision: 'PASS', summary: 'ok', coverage: [{ category: 'prompt', status: 'PASS', evidence: 'read' }], findings: [] })
    }) })
  });
  await assert.rejects(adapter.audit({ prompt: 'review', sessionId, requiredCoverage: ['prompt'] }), error => {
    assert.match(error.message, /actual consumed Credits evidence/);
    assert.equal(error.executionEvidence.receiptRequirement, 'actual_consumed_credits');
    assert.deepEqual(error.executionEvidence.observedUsage, { input_tokens: 10, output_tokens: 5 });
    return true;
  });
});

test('Token Plan usage-derived mode computes Credits from reported token usage and marks the lack of a receipt', async () => {
  const usagePolicy = {
    costEvidenceRequired: 'usage_derived_consumed_credits', maxTurns: 1,
    maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
    requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
    pricing: { unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion: 1000, outputCreditsPerMillion: 1000, source: 'user-authorized usage-derived test rate', verifiedAt: '2026-07-28T00:00:00Z' },
    worstCaseCredits: 4
  };
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const adapter = new OpenCodexAuditAdapter({
    cwd: '/safe/project', model: 'kimi/k3',
    budget: { unit: 'CREDITS', perCallLimit: 5, totalLimit: 5 }, executionPolicy: usagePolicy,
    capabilityRunner,
    runner: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({
      session_id: sessionId, usage: { input_tokens: 100, output_tokens: 50 },
      result: JSON.stringify({ decision: 'PASS', summary: 'ok', coverage: [{ category: 'prompt', status: 'PASS', evidence: 'read' }], findings: [] })
    }) })
  });
  const result = await adapter.audit({ prompt: 'review', sessionId, requiredCoverage: ['prompt'] });
  assert.equal(result.consumedCredits, 0.15);
  assert.equal(result.costEvidence.classification, 'usage_derived_consumed_credits');
  assert.equal(result.costEvidence.receiptAvailable, false);
});
