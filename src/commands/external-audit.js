import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { OpenCodexAuditAdapter } from '../adapters/opencodex-audit-adapter.js';
import { sha256File } from '../storage/checksum.js';
import { executeExternalAudit } from '../services/external-audit-execution-service.js';
import { option } from './args.js';

function projectFile(root, value) {
  if (isAbsolute(value)) throw new Error('audit prompt must use a project-relative path');
  const path = resolve(root, value);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('audit prompt must stay inside the project');
  return { path, relativePath: rel.split(sep).join('/') };
}

export async function runExternalAudit(args, options = {}) {
  const dryRun = args.includes('--dry-run');
  const live = args.includes('--live');
  if (Number(dryRun) + Number(live) !== 1) throw new Error('external-audit requires exactly one of --dry-run or --live');
  const root = resolve(option(args, 'project'));
  if (live) return executeExternalAudit(root, {
    batchApprovalId: option(args, 'batch-approval'), segmentId: option(args, 'segment'),
    auditStage: option(args, 'stage'), preflightId: option(args, 'preflight', { required: false }),
    videoRunId: option(args, 'video-run', { required: false }), promptPath: option(args, 'prompt'),
    model: option(args, 'model'), maxBudgetUsd: Number(option(args, 'max-budget-usd'))
  }, options);
  const source = projectFile(root, option(args, 'prompt'));
  const prompt = await readFile(source.path, 'utf8');
  const maxBudgetUsd = Number(option(args, 'max-budget-usd'));
  const adapter = new OpenCodexAuditAdapter({ cwd: root, model: option(args, 'model'), maxBudgetUsd });
  const plan = adapter.plan({ prompt, sessionId: options.sessionId ?? randomUUID() });
  return {
    mode: 'dry-run', mutatesExternalModel: false, executable: plan.executable,
    model: plan.model, sessionId: plan.sessionId, cleanZeroContext: true,
    permissions: ['Read'], projectRoot: root, promptPath: source.relativePath,
    promptSha256: await sha256File(source.path), maxBudgetUsd
  };
}
