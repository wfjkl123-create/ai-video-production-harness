import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodexDirectorAdapter } from '../../src/adapters/opencodex-director-adapter.js';

const help = '--max-budget-usd --no-session-persistence --safe-mode --permission-mode --tools --allowedTools';
const capabilityRunner = async executable => executable === 'ocx'
  ? ({ code: 0, stdout: 'Usage: ocx claude [claude args...] Launch Claude Code wired to the proxy and execs `claude`.', stderr: '' })
  : ({ code: 0, stdout: help, stderr: '' });

test('director adapter plans one isolated budget-bounded no-tool request', () => {
  const adapter = new OpenCodexDirectorAdapter({ cwd: '/project', model: 'gpt-5.6-sol', maxBudgetUsd: 0.25 });
  const plan = adapter.plan({ prompt: 'make one draft', sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(plan.executable, 'ocx');
  assert.deepEqual(plan.args.slice(0, 5), ['claude', '-p', '--model', 'gpt-5.6-sol', '--output-format']);
  assert.ok(plan.args.includes('--no-session-persistence'));
  assert.ok(plan.args.includes('--safe-mode'));
  assert.equal(plan.args[plan.args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(plan.args[plan.args.indexOf('--tools') + 1], '');
  assert.equal(plan.args[plan.args.indexOf('--max-budget-usd') + 1], '0.25');
  assert.equal(plan.args.includes('make one draft'), false);
  assert.equal(plan.stdin, 'make one draft');
});

test('director adapter preflight rejects an executor without a hard budget flag and makes no model call', async () => {
  let modelCalls = 0;
  const preflightCommands = [];
  const adapter = new OpenCodexDirectorAdapter({
    cwd: '/project', model: 'gpt-5.6-sol', maxBudgetUsd: 0.25,
    capabilityRunner: async (executable, args) => {
      preflightCommands.push({ executable, args });
      return executable === 'ocx'
        ? { code: 0, stdout: 'Usage: ocx claude [claude args...] Launch Claude Code wired to the proxy and execs `claude`.', stderr: '' }
        : { code: 0, stdout: '--safe-mode --permission-mode --tools --allowedTools --no-session-persistence', stderr: '' };
    },
    runner: async () => { modelCalls += 1; return { code: 0, stdout: '{}', stderr: '' }; }
  });
  await assert.rejects(adapter.generate({ prompt: 'draft' }), /lacks required safety flags: --max-budget-usd/);
  assert.deepEqual(preflightCommands, [
    { executable: 'ocx', args: ['claude', '--help'] },
    { executable: 'claude', args: ['--help'] }
  ]);
  assert.equal(modelCalls, 0);
});

test('director adapter accepts only an isolated JSON result with usage inside the approved budget', async () => {
  const draft = { targetDurationSec: 15, creativeDecision: {}, lockedConstraints: ['one'] };
  const adapter = new OpenCodexDirectorAdapter({
    cwd: '/project', model: 'gpt-5.6-sol', maxBudgetUsd: 0.25, capabilityRunner,
    runner: async (_executable, args, options) => {
      assert.equal(options.stdin, 'draft');
      return ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        session_id: args[args.indexOf('--session-id') + 1],
        result: JSON.stringify(draft),
        total_cost_usd: 0.08,
        usage: { input_tokens: 100, output_tokens: 200 }
      })
    });
    }
  });
  const result = await adapter.generate({ prompt: 'draft' });
  assert.deepEqual(result.draft, draft);
  assert.equal(result.costUsd, 0.08);
  assert.equal(result.costEvidence.approvedMaximumUsd, 0.25);

  const overBudget = new OpenCodexDirectorAdapter({
    cwd: '/project', model: 'gpt-5.6-sol', maxBudgetUsd: 0.25, capabilityRunner,
    runner: async (_executable, args) => ({
      code: 0, stderr: '',
      stdout: JSON.stringify({ session_id: args[args.indexOf('--session-id') + 1], result: JSON.stringify(draft), total_cost_usd: 0.3 })
    })
  });
  await assert.rejects(overBudget.generate({ prompt: 'draft' }), /within the approved budget/);
});

test('director adapter rejects unsafe model identifiers before creating a process plan', () => {
  assert.throws(() => new OpenCodexDirectorAdapter({ cwd: '/project', model: 'gpt; rm', maxBudgetUsd: 0.25 }), /safe OpenCodex model ID/);
});
