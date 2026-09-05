import { resolve } from 'node:path';
import { option } from './args.js';
import { preparePreGenerationAuditBrief } from '../services/external-audit-brief-service.js';

export function runPrepareExternalAuditBrief(args) {
  return preparePreGenerationAuditBrief(resolve(option(args, 'project')), option(args, 'preflight'));
}
