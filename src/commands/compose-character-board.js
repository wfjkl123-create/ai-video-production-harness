import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { composeCharacterBoard } from '../services/image-compositor-service.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runComposeCharacterBoard(args, options) {
  const root = resolve(option(args, 'project'));
  const recordedInput = option(args, 'input');
  const input = resolve(root, recordedInput);
  if (outside(root, input)) throw new Error('character board composite input must stay inside project root');
  const inspected = await inspectArtifactFile(root, recordedInput);
  return composeCharacterBoard(root, await readJson(inspected.path), options);
}
