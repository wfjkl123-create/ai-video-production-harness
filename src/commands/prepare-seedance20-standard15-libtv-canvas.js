import { resolve } from 'node:path';
import { option } from './args.js';
import { prepareLibTvVideoCanvas } from '../services/libtv-video-generation-service.js';
import { inspectSeedance20Standard15ExecutionPackage } from '../services/seedance20-standard15-execution-service.js';

/** Uploads and prepares, but never submits, the reviewed 15-second Seedance 2.0 node. */
export async function runPrepareSeedance20Standard15LibTvCanvas(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const executionUnitId = option(args, 'execution-unit');
  const projectUuid = option(args, 'libtv-project');
  const nodeName = option(args, 'node-name');
  const model = option(args, 'model', { required: false }) ?? 'Seedance 2.0 VIP';
  if (model !== 'Seedance 2.0 VIP') throw new Error('prepare-seedance20-standard15-libtv-canvas only supports the current LibTV Seedance 2.0 VIP model');
  return prepareLibTvVideoCanvas(root, { segmentId: executionUnitId, projectUuid, nodeName, model }, {
    ...options,
    inspect: (_root, requestedUnitId, inspectOptions) => inspectSeedance20Standard15ExecutionPackage(root, requestedUnitId, inspectOptions)
  });
}
