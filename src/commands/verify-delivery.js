import { resolve } from 'node:path';
import { option } from './args.js';
import { verifyDelivery } from '../services/delivery-service.js';

export function runVerifyDelivery(args) {
  return verifyDelivery(resolve(option(args, 'project')));
}
