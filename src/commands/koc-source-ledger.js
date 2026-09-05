import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { option } from './args.js';
import { compileKocSourceLedger } from '../services/koc-source-ledger-service.js';

export async function runKocSourceLedger(args) {
  const input = JSON.parse(await readFile(resolve(option(args, 'input')), 'utf8'));
  return compileKocSourceLedger(input);
}
