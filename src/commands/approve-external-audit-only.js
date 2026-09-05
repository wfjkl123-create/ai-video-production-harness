import { resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { persistExternalAuditOnlyApproval } from '../services/external-audit-only-service.js';
import { option } from './args.js';

export async function runApproveExternalAuditOnly(args) {
  const root = resolve(option(args, 'project'));
  return persistExternalAuditOnlyApproval(root, await readJson(resolve(option(args, 'input'))));
}
