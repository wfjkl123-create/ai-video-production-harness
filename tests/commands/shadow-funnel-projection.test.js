import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';

const execFileAsync = promisify(execFile);

test('shadow-funnel-projection CLI is read-only and writes reports only outside the projects root', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'shadow-funnel-cli-'));
  const root = join(projectsRoot, 'project-one');
  await initializeProject(root, { projectId: 'SHADOW-FUNNEL-ONE' });
  const state = await readJson(join(root, 'project-state.json'));
  state.updatedAt = '2026-08-20T00:00:00.000Z';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    'src/cli.js', 'shadow-funnel-projection', '--projects-root', projectsRoot,
    '--from', '2026-08-10', '--through', '2026-08-24'
  ]);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.kind, 'shadow_funnel_projection');
  assert.equal(report.writebackEligible, false);
  assert.equal(report.scope.projectCount, 1);

  const reportDirectory = await mkdtemp(join(tmpdir(), 'shadow-funnel-reports-'));
  const persisted = await execFileAsync(process.execPath, [
    'src/cli.js', 'shadow-funnel-projection', '--projects-root', projectsRoot,
    '--from', '2026-08-10', '--through', '2026-08-24', '--report-dir', reportDirectory
  ]);
  const result = JSON.parse(persisted.stdout);
  assert.match(await readFile(result.outputs.markdownPath, 'utf8'), /历史证据影子漏斗/);
  await assert.rejects(execFileAsync(process.execPath, [
    'src/cli.js', 'shadow-funnel-projection', '--projects-root', projectsRoot,
    '--from', '2026-08-10', '--through', '2026-08-24', '--report-dir', join(projectsRoot, 'reports')
  ]), /report-dir must stay outside projects-root/);
});
