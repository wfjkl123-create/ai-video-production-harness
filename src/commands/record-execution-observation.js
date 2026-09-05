import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { recordExecutionObservation } from '../services/execution-observation-service.js';

export async function runRecordExecutionObservation(args, options = {}) {
  return recordExecutionObservation(
    resolve(option(args, 'project')),
    await readJson(resolve(option(args, 'input'))),
    options
  );
}
