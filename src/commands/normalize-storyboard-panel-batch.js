import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { normalizeStoryboardPanelBatch } from '../services/storyboard-panel-normalization-plan-service.js';
import { runProcess } from '../adapters/process-runner.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runNormalizeStoryboardPanelBatch(args, options) {
  const root = resolve(option(args, 'project'));
  const requested = option(args, 'input');
  const out = option(args, 'out');
  const plansDir = option(args, 'plans-dir');
  if (outside(root, resolve(root, requested)) || outside(root, resolve(root, out)) || outside(root, resolve(root, plansDir))) {
    throw new Error('normalization batch input, output and plans directory must stay inside project root');
  }
  const value = await readJson((await inspectArtifactFile(root, requested)).path);
  return normalizeStoryboardPanelBatch(root, value, out, plansDir, {
    ...options,
    runner: options?.runner ?? runProcess
  });
}
