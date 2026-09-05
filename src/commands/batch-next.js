import { resolve } from 'node:path';
import { planBatchNext } from '../services/batch-orchestrator-service.js';
import { planFastDagNext } from '../services/fast-dag-planner-service.js';
import { option } from './args.js';

export function runBatchNext(args) {
  const root = resolve(option(args, 'project'));
  const batchApprovalId = option(args, 'batch-approval');
  return args.includes('--fast-dag-v1')
    ? planFastDagNext(root, batchApprovalId)
    : planBatchNext(root, batchApprovalId);
}
