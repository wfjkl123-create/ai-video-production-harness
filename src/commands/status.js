import { resolve } from 'node:path';
import { getProjectStatus, getCompactStatus } from '../services/project-service.js';
import { option } from './args.js';

export async function runStatus(args) {
  const root = resolve(option(args, 'project'));
  const segment = option(args, 'segment', { required: false });
  const full = args.includes('--full');
  if (full) return getProjectStatus(root);
  return getCompactStatus(root, segment);
}
