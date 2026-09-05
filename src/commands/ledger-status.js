import { resolve } from 'node:path';
import { readExecutionLedgerStatus } from '../services/execution-ledger-service.js';
import { option } from './args.js';

export async function runLedgerStatus(args) {
  const root = resolve(option(args, 'project'));
  return readExecutionLedgerStatus(root);
}
