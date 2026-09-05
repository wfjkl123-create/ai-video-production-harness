import { resolve } from 'node:path';
import { option } from './args.js';
import { lintNarration } from '../services/narration-lint-service.js';

export async function runNarrationLint(args) {
  const root = resolve(option(args, 'project'));
  return lintNarration(root, option(args, 'artifact'));
}
