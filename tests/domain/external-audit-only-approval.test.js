import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExternalAuditOnlyApproval } from '../../src/domain/external-audit-only-approval.js';

const sha = 'a'.repeat(64);

function approval() {
  return {
    id: 'audit-only-1', kind: 'external_audit_only_approval', actor: 'human', decision: 'approved',
    projectId: 'p1', segmentId: 'segment-001', model: 'claude-ocx-anthropic--claude-opus-4-8', maxCalls: 1,
    budget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.4 },
    executionPolicy: {
      costEvidenceRequired: 'actual_billed_usd', maxTurns: 1, maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
      requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
      pricing: { unit: 'USD_per_million_tokens', inputUsdPerMillion: 5, outputUsdPerMillion: 25, source: 'verified-test-price', verifiedAt: '2026-07-28T00:00:00Z' },
      worstCaseUsd: 0.08
    },
    permissions: { readOnly: true, automaticRetries: false, imageGeneration: false, videoGeneration: false, externalMessages: false },
    binding: {
      auditBrief: { path: 'reviews/brief.json', sha256: sha }, prompt: { id: 'prompt-1', path: 'prompts/p.txt', sha256: sha },
      package: { path: 'prompts/package.json', sha256: sha }, inputMedia: { images: [], videos: [], audio: [] }
    }, approvedAt: '2026-07-28T00:00:00Z'
  };
}

test('accepts a one-call read-only non-GPT audit approval', () => {
  assert.equal(assertExternalAuditOnlyApproval(approval()).maxCalls, 1);
});

test('rejects generation permission, retry permission, GPT, or more than one call', () => {
  for (const mutate of [
    value => { value.permissions.videoGeneration = true; },
    value => { value.permissions.imageGeneration = true; },
    value => { value.permissions.automaticRetries = true; },
    value => { value.model = 'openai/gpt-5'; },
    value => { value.maxCalls = 2; }
  ]) {
    const value = approval(); mutate(value);
    assert.throws(() => assertExternalAuditOnlyApproval(value));
  }
});

test('rejects a forged or over-budget worst-case execution policy', () => {
  const forged = approval(); forged.executionPolicy.worstCaseUsd = 0.01;
  assert.throws(() => assertExternalAuditOnlyApproval(forged), /machine calculation/);
  const over = approval(); over.executionPolicy.maxOutputTokensPerTurn = 20_000; over.executionPolicy.worstCaseUsd = 0.505;
  assert.throws(() => assertExternalAuditOnlyApproval(over), /exceeds/);
});

test('accepts a bounded Token Plan credits approval with verified conversion evidence', () => {
  const value = approval();
  value.model = 'qwen/qwen3.8-max-preview';
  value.budget = { unit: 'CREDITS', perCallLimit: 120, totalLimit: 120 };
  value.executionPolicy = {
    costEvidenceRequired: 'actual_consumed_credits', maxTurns: 1,
    maxInputTokensPerTurn: 1000, maxOutputTokensPerTurn: 3000,
    requiredExecutorCapabilities: ['max_output_tokens', 'max_turns'],
    pricing: {
      unit: 'CREDITS_per_million_tokens', inputCreditsPerMillion: 20_000,
      outputCreditsPerMillion: 30_000, source: 'verified-token-plan-rate',
      verifiedAt: '2026-07-28T00:00:00Z'
    },
    worstCaseCredits: 110
  };
  assert.equal(assertExternalAuditOnlyApproval(value).budget.unit, 'CREDITS');
});

test('rejects mixed USD and credits policy fields', () => {
  const value = approval();
  value.model = 'qwen/qwen3.8-max-preview';
  value.budget = { unit: 'CREDITS', perCallLimit: 120, totalLimit: 120 };
  value.executionPolicy.costEvidenceRequired = 'actual_consumed_credits';
  assert.throws(() => assertExternalAuditOnlyApproval(value), /CREDITS|credits/i);
});
