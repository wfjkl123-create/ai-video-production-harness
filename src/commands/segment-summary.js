import { resolve } from 'node:path';
import { generateSegmentSummary } from '../services/segment-summary-service.js';
import { option } from './args.js';

export async function runSegmentSummary(args) {
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  return generateSegmentSummary(root, segmentId);
}
