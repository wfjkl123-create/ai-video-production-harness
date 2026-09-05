import { resolve } from 'node:path';
import { option } from './args.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { persistSourceFactAnalysis } from '../services/source-fact-analysis-service.js';
import { readJson } from '../storage/json-store.js';

export async function runSourceFactAnalysis(args, dependencies = {}) {
  const root = resolve(option(args, 'project'));
  const inspected = await (dependencies.inspectArtifactFile ?? inspectArtifactFile)(root, option(args, 'input'));
  const input = await (dependencies.readJson ?? readJson)(inspected.path);
  return (dependencies.persistSourceFactAnalysis ?? persistSourceFactAnalysis)(root, input);
}
