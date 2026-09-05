import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { normalizeStoryboardPanel } from '../services/storyboard-panel-normalization-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runNormalizeStoryboardPanel(args, options) {
  const root = resolve(option(args, 'project'));
  const requested = option(args, 'input');
  const input = resolve(root, requested);
  if (outside(root, input)) throw new Error('storyboard panel normalization input must stay inside project root');
  return normalizeStoryboardPanel(root, await readJson((await inspectArtifactFile(root, requested)).path), options);
}
