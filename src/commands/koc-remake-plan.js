import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { option } from './args.js';
import { buildKocRemakePlan } from '../services/koc-remake-orchestrator-service.js';

export async function runKocRemakePlan(args) {
  const inputPath = resolve(option(args, 'input'));
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  return buildKocRemakePlan(input);
}
