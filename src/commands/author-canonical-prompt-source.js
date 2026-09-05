import { resolve } from 'node:path';
import { option } from './args.js';
import { resolveProjectInput } from './project-input.js';
import { readJson } from '../storage/json-store.js';
import { authorCanonicalPromptSource } from '../services/canonical-prompt-source-service.js';

export async function runAuthorCanonicalPromptSource(args) {
  const root = resolve(option(args, 'project'));
  const input = await readJson(resolveProjectInput(root, option(args, 'input')));
  return authorCanonicalPromptSource(root, input);
}
