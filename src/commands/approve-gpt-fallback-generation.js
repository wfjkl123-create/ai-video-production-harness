import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { createGptFallbackPaidGenerationApproval } from '../services/gpt-fallback-generation-service.js';
export async function runApproveGptFallbackGeneration(args) {
  const root = resolve(option(args,'project'));
  return createGptFallbackPaidGenerationApproval(root,await readJson(resolve(option(args,'input'))));
}
