import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/services/project-service.js';

const execFileAsync = promisify(execFile);

test('historical-replay-baseline CLI returns a read-only time-window report', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'historical-replay-cli-'));
  await initializeProject(join(projectsRoot, 'project-one'), { projectId: 'HISTORICAL-CLI-ONE' });
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    'src/cli.js', 'historical-replay-baseline', '--projects-root', projectsRoot,
    '--from', '2026-08-10', '--through', '2026-08-24'
  ]);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.kind, 'historical_replay_baseline');
  assert.equal(report.window.timeZoneOffset, '+08:00');

  const reportDirectory = await mkdtemp(join(tmpdir(), 'historical-replay-cli-reports-'));
  const persisted = await execFileAsync(process.execPath, [
    'src/cli.js', 'historical-replay-baseline', '--projects-root', projectsRoot,
    '--from', '2026-08-10', '--through', '2026-08-24', '--report-dir', reportDirectory
  ]);
  const result = JSON.parse(persisted.stdout);
  assert.equal(result.report.kind, 'historical_replay_baseline');
  assert.match(await readFile(result.outputs.markdownPath, 'utf8'), /历史项目离线重放基线/);

  await assert.rejects(execFileAsync(process.execPath, [
    'src/cli.js', 'historical-replay-baseline', '--projects-root', projectsRoot,
    '--from', '2026-08-10', '--through', '2026-08-24', '--report-dir', join(projectsRoot, 'reports')
  ]), /report-dir must stay outside projects-root/);
});
