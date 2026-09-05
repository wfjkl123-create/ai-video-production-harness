import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { composeAndRegisterStoryboardContactSheet } from '../services/storyboard-contact-sheet-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runComposeStoryboardContactSheet(args, options) {
  const root = resolve(option(args, 'project'));
  const recordedInput = option(args, 'input');
  const input = resolve(root, recordedInput);
  if (outside(root, input)) throw new Error('storyboard contact-sheet input must stay inside project root');
  const inspected = await inspectArtifactFile(root, recordedInput);
  return composeAndRegisterStoryboardContactSheet(root, await readJson(inspected.path), { ...options, planSha256: inspected.sha256 });
}
