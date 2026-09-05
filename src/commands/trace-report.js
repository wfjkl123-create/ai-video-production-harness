import { resolve } from 'node:path';
import { reportExecutionTrace } from '../services/execution-trace-service.js';
import { option } from './args.js';

export async function runTraceReport(args, dependencies = {}) {
  const root = resolve(dependencies.cwd ?? process.cwd(), option(args, 'project'));
  const traceId = option(args, 'trace');
  return (dependencies.reportExecutionTrace ?? reportExecutionTrace)(root, traceId);
}
