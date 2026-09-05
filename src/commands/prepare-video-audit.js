import { resolve } from 'node:path';
import { option } from './args.js';
import { prepareVideoAuditPackage } from '../services/video-audit-package-service.js';

export function runPrepareVideoAudit(args, options = {}) {
  return prepareVideoAuditPackage(resolve(option(args, 'project')), option(args, 'run'), options);
}
