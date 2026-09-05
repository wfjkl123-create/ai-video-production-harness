import { resolve } from 'node:path';
import { option } from './args.js';
import { verifyLibTvVideoCanvas } from '../services/libtv-video-generation-service.js';
import { inspectSeedance25VideoEditExecutionPackage } from '../services/seedance25-video-edit-execution-service.js';

export async function runVerifyLibTvVideoCanvas(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const executionUnitId = option(args, 'execution-unit');
  const projectUuid = option(args, 'libtv-project');
  const nodeName = option(args, 'node-name');
  const nodeKey = option(args, 'node-key');
  const model = option(args, 'model', { required: false }) ?? 'Seedance 2.5';
  if (model !== 'Seedance 2.5') throw new Error('verify-libtv-video-canvas supports the current Seedance 2.5 direct-edit package only');
  return verifyLibTvVideoCanvas(root, {
    segmentId: executionUnitId,
    projectUuid,
    nodeName,
    nodeKey,
    model
  }, {
    ...options,
    inspect: (_root, requestedUnitId, inspectOptions) => inspectSeedance25VideoEditExecutionPackage(root, requestedUnitId, inspectOptions)
  });
}
