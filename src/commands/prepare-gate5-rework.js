import { resolve } from 'node:path';
import { option } from './args.js';
import { prepareGate5ReworkWorkOrder } from '../services/gate5-rework-work-order-service.js';

export function runPrepareGate5Rework(args, options = {}) {
  return prepareGate5ReworkWorkOrder(resolve(option(args, 'project')), {
    failureReturnId: option(args, 'failure-return'),
    confirm: args.includes('--confirm')
  }, options);
}
