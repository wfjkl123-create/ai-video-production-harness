import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runExternalAudit } from '../../src/commands/external-audit.js';

test('external audit dry-run binds a project prompt without calling a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-audit-'));
  await mkdir(join(root, 'reviews'));
  await writeFile(join(root, 'reviews', 'audit.md'), 'review locked evidence');
  const result = await runExternalAudit([
    '--project', root, '--prompt', 'reviews/audit.md', '--model', 'claude-ocx-anthropic--claude-opus-4-8',
    '--max-budget-usd', '0.4', '--dry-run'
  ], { sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(result.mutatesExternalModel, false);
  assert.equal(result.cleanZeroContext, true);
  assert.equal(result.promptSha256.length, 64);
  assert.deepEqual(result.permissions, ['Read']);
});

test('external audit requires one mode and rejects project path escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-audit-'));
  await assert.rejects(runExternalAudit(['--project', root]), /exactly one/);
  await assert.rejects(runExternalAudit([
    '--project', root, '--prompt', '../secret', '--model', 'kimi/kimi-k2.7-code', '--max-budget-usd', '0.2', '--dry-run'
  ]), /stay inside/);
});
