import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/services/project-service.js';

const execFileAsync = promisify(execFile);

test('ledger-portfolio CLI returns the cross-project read-only baseline', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'ledger-portfolio-cli-'));
  await initializeProject(join(projectsRoot, 'project-one'), { projectId: 'PORTFOLIO-CLI-ONE' });
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    'src/cli.js', 'ledger-portfolio', '--projects-root', projectsRoot
  ]);
  assert.equal(stderr, '');
  const portfolio = JSON.parse(stdout);
  assert.equal(portfolio.kind, 'execution_ledger_portfolio');
  assert.equal(portfolio.scope.totalProjects, 1);
  assert.equal(portfolio.scope.initializedProjects, 0);
  assert.equal(portfolio.observation, 'unavailable');
});
