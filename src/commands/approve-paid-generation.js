import { resolve } from 'node:path';
import { createPaidGenerationApproval } from '../services/video-generation-service.js';
import { inspectSeedance20Standard15ExecutionPackage } from '../services/seedance20-standard15-execution-service.js';
import { option } from './args.js';

export function runApprovePaidGeneration(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  const inspect = segmentId.startsWith('seedance20-standard15-')
    ? (_root, requestedUnitId, inspectOptions) => inspectSeedance20Standard15ExecutionPackage(root, requestedUnitId, inspectOptions)
    : undefined;
  return createPaidGenerationApproval(root, {
    segmentId,
    preflightId: option(args, 'preflight'),
    note: option(args, 'note')
  }, { id: options.id, ...(inspect ? { inspect } : {}) });
}
