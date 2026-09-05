import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { buildAndWriteStoryboardPanelNormalizationPlans } from '../services/storyboard-panel-normalization-plan-service.js';
import { runProcess } from '../adapters/process-runner.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runBuildStoryboardPanelNormalizationPlans(args, options) {
  const root = resolve(option(args, 'project'));
  const requested = option(args, 'input');
  const output = option(args, 'out');
  const input = resolve(root, requested);
  if (outside(root, input) || isAbsolute(requested) || outside(root, resolve(root, output))) {
    throw new Error('normalization-plan inputs and output must stay inside project root');
  }
  const value = await readJson((await inspectArtifactFile(root, requested)).path);
  return buildAndWriteStoryboardPanelNormalizationPlans(root, value, output, {
    ...options,
    runner: options?.runner ?? runProcess
  });
}
