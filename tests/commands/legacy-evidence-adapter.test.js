import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';

const execFileAsync = promisify(execFile);

test('legacy-evidence-adapter CLI scans only the historical window project set', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'legacy-evidence-cli-'));
  const root = join(projectsRoot, 'project-one');
  await initializeProject(root, { projectId: 'LEGACY-CLI-ONE' });
  const state = await readJson(join(root, 'project-state.json'));
  state.updatedAt = '2026-08-20T00:00:00.000Z';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    'src/cli.js', 'legacy-evidence-adapter', '--projects-root', projectsRoot,
    '--from', '2026-08-10', '--through', '2026-08-24'
  ]);
  assert.equal(stderr, '');
  const portfolio = JSON.parse(stdout);
  assert.equal(portfolio.kind, 'legacy_evidence_adapter_portfolio');
  assert.equal(portfolio.scope.readableProjects, 1);
  assert.equal(portfolio.writebackEligible, false);
});
