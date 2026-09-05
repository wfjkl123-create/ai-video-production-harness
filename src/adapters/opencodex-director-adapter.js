import { randomUUID } from 'node:crypto';
import { runProcess } from './process-runner.js';
import { redact } from '../config/env.js';
import { sha256Text } from '../storage/checksum.js';

function modelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/.test(value)) {
    throw new TypeError('director model must be an explicit safe OpenCodex model ID');
  }
  return value;
}

function positiveBudget(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 5) {
    throw new TypeError('director maxBudgetUsd must be greater than 0 and no more than 5');
  }
  return value;
}

function parseEnvelope(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

function parseDraft(envelope) {
  if (envelope?.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
  if (typeof envelope?.result !== 'string') throw new Error('Director Engine returned no JSON draft');
  try { return JSON.parse(envelope.result); } catch { throw new Error('Director Engine result is not valid JSON'); }
}

function executionEvidence(result, envelope) {
  return redact({
    exitCode: Number.isInteger(result.code) ? result.code : null,
    stderrSummary: String(result.stderr ?? '').trim().split('\n').slice(0, 6).join(' ').slice(0, 800),
    stdoutBytes: Buffer.byteLength(String(result.stdout ?? '')),
    stdoutSha256: sha256Text(String(result.stdout ?? '')),
    sessionId: envelope?.session_id ?? null
  });
}

export class OpenCodexDirectorExecutionError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'OpenCodexDirectorExecutionError';
    this.executionEvidence = evidence;
  }
}

export class OpenCodexDirectorAdapter {
  constructor({ runner = runProcess, capabilityRunner = runProcess, cwd, model, maxBudgetUsd } = {}) {
    this.runner = runner;
    this.capabilityRunner = capabilityRunner;
    this.cwd = cwd;
    this.model = modelId(model);
    this.maxBudgetUsd = positiveBudget(maxBudgetUsd);
    this.preflightEvidence = null;
  }

  plan({ prompt, sessionId = randomUUID() }) {
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('director prompt is required');
    return {
      executable: 'ocx',
      args: [
        'claude', '-p', '--model', this.model, '--output-format', 'json',
        '--session-id', sessionId, '--no-session-persistence', '--safe-mode',
        '--permission-mode', 'plan', '--tools', '', '--allowedTools', '',
        '--max-budget-usd', String(this.maxBudgetUsd)
      ],
      stdin: prompt,
      cwd: this.cwd,
      sessionId,
      model: this.model,
      maxBudgetUsd: this.maxBudgetUsd,
      cleanZeroContext: true
    };
  }

  async preflight() {
    const wrapperResult = await this.capabilityRunner('ocx', ['claude', '--help'], { cwd: this.cwd });
    const wrapperHelp = String(wrapperResult.stdout ?? '');
    const wrapperReady = wrapperResult.code === 0 && /(?:claude args|execs [`']?claude|Launch Claude Code wired)/i.test(wrapperHelp);
    const result = await this.capabilityRunner('claude', ['--help'], { cwd: this.cwd });
    const help = String(result.stdout ?? '');
    const requiredFlags = ['--max-budget-usd', '--no-session-persistence', '--safe-mode', '--permission-mode', '--tools', '--allowedTools'];
    const missing = requiredFlags.filter(flag => result.code !== 0 || !help.includes(flag));
    const evidence = {
      checkedWithoutModelCall: true,
      wrapperReady,
      requiredFlags,
      missingFlags: missing,
      wrapperHelpSha256: sha256Text(wrapperHelp),
      helpSha256: sha256Text(help),
      maxBudgetUsd: this.maxBudgetUsd
    };
    if (!wrapperReady) throw new OpenCodexDirectorExecutionError('Director Engine executor cannot verify the ocx claude passthrough', evidence);
    if (missing.length) throw new OpenCodexDirectorExecutionError(`Director Engine executor lacks required safety flags: ${missing.join(', ')}`, evidence);
    this.preflightEvidence = evidence;
    return evidence;
  }

  async generate({ prompt }) {
    if (!this.preflightEvidence) await this.preflight();
    const plan = this.plan({ prompt });
    const result = await this.runner(plan.executable, plan.args, { cwd: this.cwd, stdin: plan.stdin });
    const envelope = parseEnvelope(String(result.stdout ?? ''));
    if (result.code !== 0) {
      const reason = redact(String(result.stderr ?? '')).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
      throw new OpenCodexDirectorExecutionError(
        `Director Engine failed with exit code ${Number.isInteger(result.code) ? result.code : 'unknown'}${reason ? `: ${reason}` : ''}`,
        executionEvidence(result, envelope)
      );
    }
    if (!envelope) throw new OpenCodexDirectorExecutionError('Director Engine returned an invalid execution envelope', executionEvidence(result, null));
    if (envelope.session_id !== plan.sessionId) throw new Error('Director Engine session ID does not match the isolated request');
    if (!Number.isFinite(envelope.total_cost_usd) || envelope.total_cost_usd < 0 || envelope.total_cost_usd > this.maxBudgetUsd) {
      throw new Error('Director Engine did not return valid usage within the approved budget');
    }
    return {
      draft: parseDraft(envelope),
      model: plan.model,
      sessionId: plan.sessionId,
      costUsd: envelope.total_cost_usd,
      costEvidence: {
        amountUsd: envelope.total_cost_usd,
        approvedMaximumUsd: this.maxBudgetUsd,
        classification: 'api_list_price_equivalent',
        actualBilledUsd: null,
        source: 'claude_cli_envelope'
      },
      usage: envelope.usage ?? null,
      executionEvidence: executionEvidence(result, envelope)
    };
  }
}
