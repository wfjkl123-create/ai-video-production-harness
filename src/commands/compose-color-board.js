import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { composeColorBoard } from '../services/color-board-service.js';

export async function runComposeColorBoard(args) {
  const root = resolve(option(args, 'project'));
  const input = await inspectArtifactFile(root, option(args, 'input'));
  return composeColorBoard(root, await readJson(input.path));
}
