import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { recordGeneratedOutputFailure } from '../services/generation-failure-service.js';

export async function runRecordGenerationFailure(args, options = {}) {
  return recordGeneratedOutputFailure(resolve(option(args, 'project')), await readJson(resolve(option(args, 'input'))), options);
}
