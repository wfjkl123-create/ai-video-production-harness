import { resolve } from 'node:path';
import { option } from './args.js';
import { autoLockArtifact } from '../services/review-service.js';

export async function runAutoLockArtifact(args) {
  return autoLockArtifact(resolve(option(args, 'project')), option(args, 'artifact'), option(args, 'note'));
}
