import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import {
  deriveExecutionObservation,
  planExecutionObservationDerivation
} from '../services/execution-observation-derivation-service.js';

export async function runDeriveExecutionObservation(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const input = await readJson(resolve(option(args, 'input')));
  if (args.includes('--dry-run')) return planExecutionObservationDerivation(root, input, options);
  return deriveExecutionObservation(root, input, options);
}
