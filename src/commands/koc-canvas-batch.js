import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { option } from './args.js';
import { buildKocCanvasBatchPlan, executeKocCanvasBatch } from '../services/koc-canvas-batch-service.js';

export async function runKocCanvasBatch(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const input = JSON.parse(await readFile(resolve(option(args, 'input')), 'utf8'));
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');
  if (Number(dryRun) + Number(execute) !== 1) throw new Error('koc-canvas-batch requires exactly one of --dry-run or --execute');
  return dryRun ? buildKocCanvasBatchPlan(root, input) : executeKocCanvasBatch(root, input, options);
}
