import { resolve } from 'node:path';
import { option } from './args.js';
import { prepareLibTvVideoCanvas } from '../services/libtv-video-generation-service.js';
import { inspectSeedance25VideoEditExecutionPackage } from '../services/seedance25-video-edit-execution-service.js';

/**
 * Canvas preparation only: this command uploads the reviewed direct-edit
 * inputs and creates a node, but never passes --run or submits paid work.
 */
export async function runPrepareSeedance25VideoEditLibTvCanvas(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const executionUnitId = option(args, 'execution-unit');
  const projectUuid = option(args, 'libtv-project');
  const nodeName = option(args, 'node-name');
  const model = option(args, 'model', { required: false }) ?? 'Seedance 2.5';
  if (model !== 'Seedance 2.5') throw new Error('prepare-seedance25-video-edit-libtv-canvas supports Seedance 2.5 only');
  return prepareLibTvVideoCanvas(root, {
    segmentId: executionUnitId,
    projectUuid,
    nodeName,
    model
  }, {
    ...options,
    inspect: (_root, requestedUnitId, inspectOptions) => inspectSeedance25VideoEditExecutionPackage(
      root,
      requestedUnitId,
      inspectOptions
    )
  });
}
