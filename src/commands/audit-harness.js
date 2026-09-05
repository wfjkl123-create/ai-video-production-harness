import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { option } from './args.js';
import { auditHarnessSurface } from '../services/harness-surface-audit-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runAuditHarness(args, dependencies = {}) {
  const configuredRoot = dependencies.repoRoot
    ?? fileURLToPath(new URL('../..', import.meta.url));
  const repoRoot = await realpath(resolve(configuredRoot));
  const projectOption = option(args, 'project', { required: false });
  let projectRoot;
  if (projectOption) {
    const candidate = isAbsolute(projectOption)
      ? resolve(projectOption)
      : resolve(dependencies.cwd ?? process.cwd(), projectOption);
    projectRoot = await realpath(candidate);
    if (outside(repoRoot, projectRoot)) {
      throw new Error('--project must stay inside the harness repository');
    }
  }
  return auditHarnessSurface(repoRoot, { projectRoot, now: dependencies.now });
}
