import { resolve } from 'node:path';
import { executeIndependentExternalAudit } from '../services/external-audit-only-service.js';
import { option } from './args.js';

export async function runIndependentExternalAudit(args, options = {}) {
  if (!args.includes('--live')) throw new Error('independent-external-audit requires --live');
  const revisionText = option(args, 'revision', { required: false });
  const revision = revisionText === undefined ? undefined : Number(revisionText);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new Error('--revision must be a positive integer');
  return executeIndependentExternalAudit(resolve(option(args, 'project')), { approvalId: option(args, 'approval') }, {
    ...options,
    ...(option(args, 'artifact-id', { required: false }) ? { artifactId: option(args, 'artifact-id') } : {}),
    ...(revision === undefined ? {} : { revision })
  });
}
