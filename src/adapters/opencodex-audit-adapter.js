import { createHash, randomUUID } from 'node:crypto';
import { runProcess } from './process-runner.js';
import { redact } from '../config/env.js';
import { assertExternalAuditCreditsExecutionPolicy, assertExternalAuditExecutionPolicy, computeUsageDerivedAuditCredits, computeWorstCaseAuditCredits, computeWorstCaseAuditUsd } from '../domain/external-audit-execution-policy.js';

const ALLOWED_MODEL = /^(?:claude-ocx-(?:anthropic|kimi|qwen)--|(?:anthropic|kimi|qwen)\/)[A-Za-z0-9._-]+$/;
const PROMPT_SCHEMA_MODEL = /^(?:claude-ocx-(?:kimi|qwen)--|(?:kimi|qwen)\/)/;

export const AUDIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'summary', 'coverage', 'findings'],
  properties: {
    decision: { enum: ['PASS', 'FAIL'] },
    summary: { type: 'string' },
    coverage: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['category', 'status', 'evidence'],
        properties: { category: { type: 'string' }, status: { enum: ['PASS', 'FAIL', 'NOT_VERIFIABLE'] }, evidence: { type: 'string' } }
      }
    },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'category', 'evidence', 'recommendation'],
        properties: {
          severity: { enum: ['blocker', 'important', 'note'] },
          category: { type: 'string' }, evidence: { type: 'string' }, recommendation: { type: 'string' }
        }
      }
    }
  }
};

export function assertNonGptAuditModel(model) {
  if (typeof model !== 'string' || !ALLOWED_MODEL.test(model) || /gpt|openai/i.test(model)) {
    throw new Error('audit model must be an explicit OpenCodex Claude, Kimi, or Qwen model');
  }
  return model;
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseEnvelope(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

function parseStructuredResult(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next bounded candidate */ }
  }
  return null;
}

function safeExecutionEvidence(result, envelope) {
  return redact({
    exitCode: Number.isInteger(result.code) ? result.code : null,
    stderrSummary: String(result.stderr ?? '').trim().split('\n').slice(0, 8).join(' ').slice(0, 1000),
    stdoutBytes: Buffer.byteLength(String(result.stdout ?? '')),
    stdoutSha256: sha256Text(String(result.stdout ?? '')),
    envelope: envelope ?? null
  });
}

export class OpenCodexAuditExecutionError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'OpenCodexAuditExecutionError';
    this.executionEvidence = evidence;
  }
}

function promptWithOutputContract(prompt) {
  return [
    'You are the independent auditor, not a planner. Execute the audit now from the preloaded brief; do not describe a plan, ask to inspect files, or explain how the harness works.',
    prompt,
    '',
    'OUTPUT CONTRACT: Return only one valid JSON object. Do not wrap it in Markdown or add commentary.',
    `The JSON object must satisfy this exact JSON Schema: ${JSON.stringify(AUDIT_OUTPUT_SCHEMA)}`
  ].join('\n');
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function assertAuditReport(report) {
  if (!hasExactKeys(report, ['decision', 'summary', 'coverage', 'findings'])
    || !['PASS', 'FAIL'].includes(report.decision)
    || typeof report.summary !== 'string' || report.summary.trim() === ''
    || !Array.isArray(report.coverage) || report.coverage.length === 0
    || !Array.isArray(report.findings)) {
    throw new Error('OpenCodex audit result does not satisfy the required contract');
  }
  for (const item of report.coverage) {
    if (!hasExactKeys(item, ['category', 'status', 'evidence'])
      || typeof item.category !== 'string' || item.category.trim() === ''
      || !['PASS', 'FAIL', 'NOT_VERIFIABLE'].includes(item.status)
      || typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      throw new Error('OpenCodex audit result does not satisfy the required contract');
    }
  }
  for (const item of report.findings) {
    if (!hasExactKeys(item, ['severity', 'category', 'evidence', 'recommendation'])
      || !['blocker', 'important', 'note'].includes(item.severity)
      || typeof item.category !== 'string' || item.category.trim() === ''
      || typeof item.evidence !== 'string' || item.evidence.trim() === ''
      || typeof item.recommendation !== 'string' || item.recommendation.trim() === '') {
      throw new Error('OpenCodex audit result does not satisfy the required contract');
    }
  }
  return report;
}

export class OpenCodexAuditAdapter {
  constructor({ runner = runProcess, capabilityRunner = runProcess, cwd, model, budget = null, maxBudgetUsd = 0.5, executionPolicy } = {}) {
    this.runner = runner;
    this.cwd = cwd;
    this.model = assertNonGptAuditModel(model);
    this.budget = budget ?? { unit: 'USD', perCallLimit: maxBudgetUsd, totalLimit: maxBudgetUsd };
    if (!['USD', 'CREDITS'].includes(this.budget.unit) || !Number.isFinite(this.budget.perCallLimit) || this.budget.perCallLimit <= 0) {
      throw new TypeError('audit budget must have unit USD or CREDITS and a positive perCallLimit');
    }
    this.maxBudgetUsd = this.budget.unit === 'USD' ? this.budget.perCallLimit : null;
    this.executionPolicy = executionPolicy;
    this.capabilityRunner = capabilityRunner;
    this.preflightEvidence = null;
  }

  plan({ prompt, sessionId = randomUUID() }) {
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('audit prompt is required');
    const usesPromptSchema = PROMPT_SCHEMA_MODEL.test(this.model);
    const args = ['claude', '-p', '--model', this.model, '--output-format', 'json'];
    if (!usesPromptSchema) args.push('--json-schema', JSON.stringify(AUDIT_OUTPUT_SCHEMA));
    const readOnlyTools = this.executionPolicy?.allowReadTools !== false;
    args.push(
      '--session-id', sessionId,
      '--no-session-persistence', '--safe-mode', '--permission-mode', 'plan',
      '--tools', readOnlyTools ? 'Read' : '', '--allowedTools', readOnlyTools ? 'Read' : '', '--add-dir', this.cwd
    );
    if (this.budget.unit === 'USD') args.push('--max-budget-usd', String(this.budget.perCallLimit));
    args.push(usesPromptSchema ? promptWithOutputContract(prompt) : prompt);
    const env = {};
    if (this.executionPolicy) {
      const promptIndex = args.length - 1;
      args.splice(promptIndex, 0,
        '--max-turns', String(this.executionPolicy.maxTurns));
      // Claude Code 2.1.x exposes the per-turn output cap as an environment
      // setting rather than a public CLI option. Passing the old
      // --max-output-tokens flag makes the live executor reject the request.
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(this.executionPolicy.maxOutputTokensPerTurn);
    }
    return {
      executable: 'ocx', args, env, sessionId, model: this.model, cleanZeroContext: true, cwd: this.cwd,
      structuredOutputMode: usesPromptSchema ? 'prompt_contract_local_validation' : 'native_json_schema',
      liveEligible: Boolean(this.executionPolicy)
    };
  }

  async preflight() {
    const policy = this.budget.unit === 'USD'
      ? assertExternalAuditExecutionPolicy(this.executionPolicy, this.budget.perCallLimit)
      : assertExternalAuditCreditsExecutionPolicy(this.executionPolicy, this.budget.perCallLimit);
    // Claude Code keeps these two safety options hidden from the public help
    // text. Probe the parser with --help instead of grepping visible help;
    // --help exits before startup/model execution, so this remains a
    // no-model-call capability check while accepting hidden-but-supported
    // flags on current Claude builds.
    const probes = Object.fromEntries(await Promise.all([
      ['max_turns', ['--max-turns', '1', '--version'], {}],
      ['max_output_tokens', ['--version'], { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1' } }]
    ].map(async ([name, args, options]) => [name, {
      args,
      options,
      result: await this.capabilityRunner('claude', args, { cwd: this.cwd, ...options })
    }])));
    const help = String(probes.max_turns.result.stdout ?? '') + String(probes.max_output_tokens.result.stdout ?? '');
    const capabilities = Object.fromEntries(Object.entries(probes).map(([name, probe]) => [
      name, probe.result.code === 0
    ]));
    const missing = policy.requiredExecutorCapabilities.filter(name => capabilities[name] !== true);
    const evidence = {
      checkedWithoutModelCall: true, capabilities, helpSha256: sha256Text(help),
      capabilityProbes: Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, {
        args: probe.args,
        ...(probe.options.env ? { env: Object.keys(probe.options.env) } : {}),
        exitCode: Number.isInteger(probe.result.code) ? probe.result.code : null,
        stderrSummary: String(probe.result.stderr ?? '').trim().split('\n').slice(0, 4).join(' ').slice(0, 600),
        stdoutSha256: sha256Text(String(probe.result.stdout ?? ''))
      }])),
      budgetUnit: this.budget.unit,
      ...(this.budget.unit === 'USD'
        ? { worstCaseUsd: computeWorstCaseAuditUsd(policy), approvedLimitUsd: this.budget.perCallLimit }
        : { worstCaseCredits: computeWorstCaseAuditCredits(policy), approvedLimitCredits: this.budget.perCallLimit })
    };
    if (missing.length > 0) throw new OpenCodexAuditExecutionError(`audit executor lacks required hard-budget capabilities: ${missing.join(', ')}`, evidence);
    this.preflightEvidence = evidence;
    return evidence;
  }

  async audit(input) {
    if (!this.preflightEvidence) await this.preflight();
    const plan = this.plan(input);
    const result = await this.runner(plan.executable, plan.args, { cwd: this.cwd, env: plan.env });
    const envelope = parseEnvelope(String(result.stdout ?? ''));
    if (result.code !== 0) {
      const code = Number.isInteger(result.code) ? result.code : 'unknown';
      const reason = redact(String(result.stderr ?? '')).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
      throw new OpenCodexAuditExecutionError(
        `OpenCodex audit failed with exit code ${code}${reason ? `: ${reason}` : ''}`,
        safeExecutionEvidence(result, envelope)
      );
    }
    if (!envelope) throw new OpenCodexAuditExecutionError('OpenCodex audit returned invalid JSON', safeExecutionEvidence(result, null));
    if (envelope.session_id !== plan.sessionId) throw new Error('OpenCodex audit session ID does not match the isolated session');
    let report = envelope.structured_output;
    if (!report) report = parseStructuredResult(envelope.result);
    if (!report) throw new OpenCodexAuditExecutionError('OpenCodex audit result is not structured JSON', safeExecutionEvidence(result, envelope));
    try {
      assertAuditReport(report);
    } catch (error) {
      // Prompt-contract models may complete the read-only review but return a
      // shape that cannot be accepted as a decision. Preserve redacted
      // executor evidence so the UI can distinguish a contract failure from
      // a creative FAIL, without treating malformed output as a pass.
      throw new OpenCodexAuditExecutionError(error.message, safeExecutionEvidence(result, envelope));
    }
    if (report.decision === 'PASS' && report.coverage.some(item => item.status !== 'PASS')) {
      throw new Error('OpenCodex audit cannot PASS with failed or unverifiable coverage');
    }
    if (report.decision === 'PASS' && report.findings.some(item => item.severity === 'blocker')) {
      throw new Error('OpenCodex audit cannot PASS while reporting a blocker finding');
    }
    if (Array.isArray(input.requiredCoverage)) {
      const actual = new Set(report.coverage.map(item => item.category));
      const missing = input.requiredCoverage.filter(category => !actual.has(category));
      if (missing.length > 0) throw new Error(`OpenCodex audit omitted required coverage: ${missing.join(', ')}`);
      if (actual.size !== report.coverage.length) throw new Error('OpenCodex audit coverage categories must be unique');
    }
    const common = {
      report, sessionId: plan.sessionId, model: plan.model, cleanZeroContext: true, usage: envelope.usage ?? null,
      executionEvidence: safeExecutionEvidence(result, envelope)
    };
    if (this.budget.unit === 'CREDITS') {
      const consumedCredits = envelope.consumed_credits ?? envelope.usage?.consumed_credits;
      if (this.executionPolicy.costEvidenceRequired === 'usage_derived_consumed_credits') {
        const usageDerivedCredits = computeUsageDerivedAuditCredits(envelope.usage, this.executionPolicy);
        if (!Number.isFinite(usageDerivedCredits) || usageDerivedCredits < 0) throw new Error('OpenCodex audit usage-derived Credits are invalid');
        return {
          ...common,
          consumedCredits: usageDerivedCredits,
          costEvidence: {
            amountCredits: usageDerivedCredits,
            consumedCredits: usageDerivedCredits,
            classification: 'usage_derived_consumed_credits',
            source: 'claude_cli_usage_and_approved_token_plan_rates',
            inputTokens: envelope.usage.input_tokens,
            outputTokens: envelope.usage.output_tokens,
            receiptAvailable: false
          }
        };
      }
      if (!Number.isFinite(consumedCredits) || consumedCredits < 0) {
        throw new OpenCodexAuditExecutionError(
          'OpenCodex audit did not return actual consumed Credits evidence; token counts and USD estimates are not accepted as a receipt',
          {
            ...safeExecutionEvidence(result, envelope),
            receiptRequirement: 'actual_consumed_credits',
            observedUsage: envelope.usage ?? null,
            observedCostUsd: Number.isFinite(envelope.total_cost_usd) ? envelope.total_cost_usd : null
          }
        );
      }
      return { ...common, consumedCredits, costEvidence: { amountCredits: consumedCredits, consumedCredits, classification: 'actual_consumed_credits', source: 'opencodex_token_plan_receipt' } };
    }
    if (!Number.isFinite(envelope.total_cost_usd) || envelope.total_cost_usd < 0) throw new Error('OpenCodex audit did not return verifiable USD usage');
    return { ...common, costUsd: envelope.total_cost_usd, costEvidence: { amountUsd: envelope.total_cost_usd, classification: 'api_list_price_equivalent', actualBilledUsd: null, source: 'claude_cli_envelope' } };
  }
}
