import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { createCreativeBrief } from '../services/creative-brief-service.js';

export async function runCreativeBrief(args) {
  const root = resolve(option(args, 'project'));
  const inspected = await inspectArtifactFile(root, option(args, 'input'));
  return createCreativeBrief(root, await readJson(inspected.path));
}
