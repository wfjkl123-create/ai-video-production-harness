import { resolve } from 'node:path';
import { option } from './args.js';
import { prepareLibTvVideoCanvas } from '../services/libtv-video-generation-service.js';
import { inspectSeedance25StandardExecutionPackage } from '../services/seedance25-standard-execution-service.js';

/**
 * Creates the reviewed Seedance 2.5 standard-generation node and uploads only
 * its already-locked inputs (4-30 seconds, 9:16/16:9/1:1, 480p/720p, any
 * compiled image/video/audio mix). It intentionally has no --live mode:
 * paying to run the node stays a separate, user-canvas action.
 */
export async function runPrepareSeedance25StandardLibTvCanvas(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const executionUnitId = option(args, 'execution-unit');
  const projectUuid = option(args, 'libtv-project');
  const nodeName = option(args, 'node-name');
  const model = option(args, 'model', { required: false }) ?? 'Seedance 2.5';
  if (model !== 'Seedance 2.5') throw new Error('prepare-seedance25-standard-libtv-canvas only supports Seedance 2.5');
  return prepareLibTvVideoCanvas(root, {
    segmentId: executionUnitId,
    projectUuid,
    nodeName,
    model
  }, {
    ...options,
    inspect: (_root, requestedUnitId, inspectOptions) => inspectSeedance25StandardExecutionPackage(
      root,
      requestedUnitId,
      inspectOptions
    )
  });
}
