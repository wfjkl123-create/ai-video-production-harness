import { resolve } from 'node:path';
import { readExecutionLedgerPortfolio } from '../services/execution-ledger-portfolio-service.js';
import { option } from './args.js';

export async function runLedgerPortfolio(args) {
  const projectsRoot = resolve(option(args, 'projects-root'));
  return readExecutionLedgerPortfolio(projectsRoot);
}
