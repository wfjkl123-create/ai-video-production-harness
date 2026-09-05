import { resolve } from 'node:path';
import { determineNextActions } from '../services/next-action-service.js';
import { option } from './args.js';

export async function runNext(args) {
  return determineNextActions(resolve(option(args, 'project')));
}
