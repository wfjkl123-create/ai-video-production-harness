import { resolve } from 'node:path';
import { createSegmentContract } from '../services/segment-contract-service.js';
import { readJson } from '../storage/json-store.js';
import { option } from './args.js';
import { resolveProjectInput } from './project-input.js';

export async function runSegmentContract(args) {
  const root = resolve(option(args, 'project'));
  const input = await readJson(resolveProjectInput(root, option(args, 'input')));
  return createSegmentContract(root, input);
}
