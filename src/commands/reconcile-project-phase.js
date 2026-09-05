#!/usr/bin/env node
import { resolve } from 'node:path';
import { reconcileProjectPhase } from '../services/project-readiness-audit-service.js';

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: node src/commands/reconcile-project-phase.js <project-root>\n');
  process.exitCode = 2;
} else {
  try {
    const result = await reconcileProjectPhase(resolve(root));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
