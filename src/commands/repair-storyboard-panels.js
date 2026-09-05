import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { repairStoryboardPanels } from '../services/storyboard-repair-service.js';

export async function runRepairStoryboardPanels(args, options) {
  const root = resolve(option(args, 'project'));
  const inspected = await inspectArtifactFile(root, option(args, 'input'));
  return repairStoryboardPanels(root, await readJson(inspected.path), options);
}
