import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { composeAssetGrid } from '../services/asset-grid-compositor-service.js';

export async function runComposeAssetGrid(args, options) {
  const root = resolve(option(args, 'project'));
  const input = await inspectArtifactFile(root, option(args, 'input'));
  return composeAssetGrid(root, await readJson(input.path), options);
}
