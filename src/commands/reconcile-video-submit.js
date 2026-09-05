import { resolve } from 'node:path';
import { option } from './args.js';
import { reconcileVideoSubmission } from '../services/video-generation-service.js';

export function runReconcileVideoSubmit(args) {
  const root = resolve(option(args, 'project'));
  return reconcileVideoSubmission(root, {
    runId: option(args, 'run'),
    taskId: option(args, 'task-id', { required: false }),
    confirmedNotSubmitted: args.includes('--confirmed-not-submitted'),
    note: option(args, 'note')
  });
}
