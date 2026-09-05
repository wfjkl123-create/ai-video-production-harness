import { resolve } from 'node:path';
import { createDerivedPaidGenerationApproval } from '../services/batch-generation-service.js';
import { option } from './args.js';

export function runDerivePaidGeneration(args, options = {}) {
  const root = resolve(option(args, 'project'));
  return createDerivedPaidGenerationApproval(root, {
    segmentId: option(args, 'segment'), preflightId: option(args, 'preflight'),
    batchApprovalId: option(args, 'batch-approval'),
    externalAuditAttestationId: option(args, 'external-audit')
  }, { id: options.id });
}
