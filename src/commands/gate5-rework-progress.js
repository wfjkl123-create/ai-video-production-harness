import { resolve } from 'node:path';

import { option } from './args.js';
import { updateGate5ReworkWorkOrderProgress } from '../services/gate5-rework-work-order-service.js';

export function runGate5ReworkProgress(args, options = {}) {
  const action = option(args, 'action');
  const evidenceKind = option(args, 'evidence-kind', { required: false });
  const evidence = evidenceKind ? [{
    kind: evidenceKind,
    id: option(args, 'evidence-id'),
    sha256: option(args, 'evidence-sha256'),
    path: option(args, 'evidence-path', { required: false }) ?? null
  }] : [];
  return updateGate5ReworkWorkOrderProgress(resolve(option(args, 'project')), {
    workOrderId: option(args, 'work-order'),
    action,
    stage: option(args, 'stage', { required: false }) ?? null,
    reason: option(args, 'reason', { required: false }) ?? null,
    note: option(args, 'note', { required: false }) ?? null,
    evidence,
    confirm: args.includes('--confirm')
  }, options);
}
