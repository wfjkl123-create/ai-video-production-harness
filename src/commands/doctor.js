import { resolve } from 'node:path';
import { inspectProjectHealth } from '../services/doctor-service.js';
import { option } from './args.js';

export async function runDoctor(args, options = {}) {
  return inspectProjectHealth(resolve(option(args, 'project')), options);
}
