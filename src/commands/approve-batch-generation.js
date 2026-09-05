import { resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { persistBatchGenerationApproval } from '../services/batch-generation-service.js';
import { option } from './args.js';

export async function runApproveBatchGeneration(args) {
  const root = resolve(option(args, 'project'));
  return persistBatchGenerationApproval(root, await readJson(resolve(option(args, 'input'))));
}
