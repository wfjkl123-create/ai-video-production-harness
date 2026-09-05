import { resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { registerArtifact } from '../services/intake-service.js';
import { option } from './args.js';

export async function runRegisterArtifact(args) {
  const root = resolve(option(args, 'project'));
  return registerArtifact(root, await readJson(resolve(option(args, 'input'))));
}
