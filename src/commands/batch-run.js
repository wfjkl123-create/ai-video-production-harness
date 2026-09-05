import { resolve } from 'node:path';
import { option } from './args.js';
import { runBatchAutonomously } from '../services/batch-autonomous-runner-service.js';
import { planBatchNext } from '../services/batch-orchestrator-service.js';
import { planFastDagNext } from '../services/fast-dag-planner-service.js';
import { runFastDagFreePreparation } from '../services/fast-dag-preparation-service.js';

export function runBatchRun(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const batchApprovalId = option(args, 'batch-approval');
  if (args.includes('--fast-dag-v1')) {
    if (args.includes('--live')) throw new Error('fast_dag_v1 is shadow-only; live execution remains disabled until replay acceptance');
    if (args.includes('--execute-free-prep')) return runFastDagFreePreparation(root, batchApprovalId, options);
    if (!args.includes('--dry-run')) throw new Error('fast_dag_v1 requires --dry-run or --execute-free-prep');
    return planFastDagNext(root, batchApprovalId);
  }
  if (args.includes('--dry-run') && !args.includes('--live')) return planBatchNext(root, batchApprovalId);
  if (!args.includes('--live') || args.includes('--dry-run')) throw new Error('batch-run requires exactly one of --dry-run or --live');
  return runBatchAutonomously(root, batchApprovalId, {
    ...options, maxSteps: Number(option(args, 'max-steps', { required: false }) ?? options.maxSteps ?? 100)
  });
}
