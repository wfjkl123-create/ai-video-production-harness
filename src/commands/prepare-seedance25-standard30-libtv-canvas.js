import { resolve } from 'node:path';
import { option } from './args.js';
import { prepareLibTvVideoCanvas } from '../services/libtv-video-generation-service.js';
import { inspectSeedance25Standard30ExecutionPackage } from '../services/seedance25-standard30-execution-service.js';

/**
 * Creates the reviewed 30-second Seedance 2.5 node and uploads only its
 * already-locked 9-image, 1-depth-video, 1-music inputs. It intentionally has
 * no --live mode: paying to run the node stays a separate, user-canvas action.
 */
export async function runPrepareSeedance25Standard30LibTvCanvas(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const executionUnitId = option(args, 'execution-unit');
  const projectUuid = option(args, 'libtv-project');
  const nodeName = option(args, 'node-name');
  const model = option(args, 'model', { required: false }) ?? 'Seedance 2.5';
  if (model !== 'Seedance 2.5') throw new Error('prepare-seedance25-standard30-libtv-canvas only supports Seedance 2.5');
  return prepareLibTvVideoCanvas(root, {
    segmentId: executionUnitId,
    projectUuid,
    nodeName,
    model
  }, {
    ...options,
    inspect: (_root, requestedUnitId, inspectOptions) => inspectSeedance25Standard30ExecutionPackage(
      root,
      requestedUnitId,
      inspectOptions
    )
  });
}
