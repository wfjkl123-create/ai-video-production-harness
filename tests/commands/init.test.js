import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../../src/commands/init.js';

test('explicit workflow v1 defaults to realism v1 while workflow v2 defaults to realism v2', async t => {
  const v1 = await mkdtemp(join(tmpdir(), 'init-v1-'));
  const v2 = await mkdtemp(join(tmpdir(), 'init-v2-'));
  t.after(() => Promise.all([rm(v1, { recursive: true, force: true }), rm(v2, { recursive: true, force: true })]));
  assert.equal((await runInit(['--project', v1, '--project-id', 'legacy', '--workflow-version', '1'])).realismContractsVersion, 1);
  assert.equal((await runInit(['--project', v2, '--project-id', 'current'])).realismContractsVersion, 2);
});

test('explicit realism version remains an intentional override', async t => {
  const root = await mkdtemp(join(tmpdir(), 'init-override-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await runInit([
    '--project', root, '--project-id', 'override', '--workflow-version', '1', '--realism-contracts-version', '2'
  ]);
  assert.equal(state.workflowVersion, 1);
  assert.equal(state.realismContractsVersion, 2);
});
