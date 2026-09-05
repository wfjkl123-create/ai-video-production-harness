import { resolve } from 'node:path';
import { option } from './args.js';
import { resolveProjectInput } from './project-input.js';
import { readJson } from '../storage/json-store.js';
import { registerRealismAuthority } from '../services/realism-authority-service.js';

export async function runRealismAuthority(args) {
  const root = resolve(option(args, 'project'));
  const input = await readJson(resolveProjectInput(root, option(args, 'input')));
  return registerRealismAuthority(root, input);
}
