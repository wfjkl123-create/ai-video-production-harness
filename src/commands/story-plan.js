import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { createStoryPlan } from '../services/story-plan-service.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';

export async function runStoryPlan(args) {
  const root = resolve(option(args, 'project'));
  const inspected = await inspectArtifactFile(root, option(args, 'input'));
  const input = await readJson(inspected.path);
  return createStoryPlan(root, input);
}
