#!/usr/bin/env node
import { resolve } from 'node:path';
import { auditProjectReadiness } from '../services/project-readiness-audit-service.js';

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: node src/commands/audit-project-readiness.js <project-root>\n');
  process.exitCode = 2;
} else {
  try {
    const report = await auditProjectReadiness(resolve(root));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === 'BLOCKED') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
