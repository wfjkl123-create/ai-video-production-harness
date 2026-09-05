import { resolve } from 'node:path';
import { getSegmentContext } from '../services/segment-context-service.js';
import { option } from './args.js';

export async function runSegmentContext(args) {
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  return getSegmentContext(root, segmentId);
}
