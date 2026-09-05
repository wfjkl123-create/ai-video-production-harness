import { resolve } from 'node:path';
import { option } from './args.js';
import { resolveProjectInput } from './project-input.js';
import { registerSpatialControlModel } from '../services/spatial-control-model-service.js';

export function runSpatialControlModel(args) {
  const root = resolve(option(args, 'project'));
  const input = resolveProjectInput(root, option(args, 'input'));
  return registerSpatialControlModel(root, input);
}
