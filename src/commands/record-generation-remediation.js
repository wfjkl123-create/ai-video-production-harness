import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { recordGenerationRemediation } from '../services/generation-failure-service.js';

export async function runRecordGenerationRemediation(args, options = {}) {
  return recordGenerationRemediation(
    resolve(option(args, 'project')),
    await readJson(resolve(option(args, 'input'))),
    options
  );
}
