import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import {
  blockTaskCheckpoint,
  claimTaskCheckpoint,
  failTaskCheckpoint,
  getTaskCheckpoint,
  queueTaskCheckpoint,
  succeedTaskCheckpoint
} from '../services/task-checkpoint-service.js';

export async function runTaskCheckpoint(args, dependencies = {}) {
  const root = resolve(dependencies.cwd ?? process.cwd(), option(args, 'project'));
  const action = option(args, 'action');
  if (action === 'status') return (dependencies.getTaskCheckpoint ?? getTaskCheckpoint)(root, option(args, 'task-key'));
  const input = await (dependencies.readJson ?? readJson)(resolve(root, option(args, 'input')));
  if (action === 'queue') return (dependencies.queueTaskCheckpoint ?? queueTaskCheckpoint)(root, input.identity ?? input, input.options ?? {});
  if (action === 'claim') return (dependencies.claimTaskCheckpoint ?? claimTaskCheckpoint)(root, input.identity ?? input, input.options ?? {});
  const taskKey = option(args, 'task-key');
  const operations = {
    succeed: dependencies.succeedTaskCheckpoint ?? succeedTaskCheckpoint,
    fail: dependencies.failTaskCheckpoint ?? failTaskCheckpoint,
    block: dependencies.blockTaskCheckpoint ?? blockTaskCheckpoint
  };
  const operation = operations[action];
  if (!operation) throw new Error(`unknown task-checkpoint action: ${action}`);
  return operation(root, taskKey, input, input.options ?? {});
}
