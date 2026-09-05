import { resolve } from 'node:path';
import { recordQualityReview } from '../services/quality-review-service.js';
import { readJson } from '../storage/json-store.js';
import { option } from './args.js';
import { resolveProjectInput } from './project-input.js';

export async function runQualityReview(args) {
  const root = resolve(option(args, 'project'));
  const input = await readJson(resolveProjectInput(root, option(args, 'input')));
  return recordQualityReview(root, input);
}
