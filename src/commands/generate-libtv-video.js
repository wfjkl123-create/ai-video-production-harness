import { resolve } from 'node:path';
import { buildLibTvVideoPlan, executeLibTvVideo, prepareLibTvVideoCanvas, resumeLibTvVideoDownload } from '../services/libtv-video-generation-service.js';
import { createVideoPreflight } from '../services/video-generation-service.js';
import { inspectSeedance20Standard15ExecutionPackage } from '../services/seedance20-standard15-execution-service.js';
import { option } from './args.js';

function packageInspector(root, segmentId) {
  if (!segmentId.startsWith('seedance20-standard15-')) return undefined;
  return (_root, requestedUnitId, inspectOptions) => inspectSeedance20Standard15ExecutionPackage(root, requestedUnitId, inspectOptions);
}

export async function runGenerateLibTvVideo(args, options = {}) {
  const dryRun = args.includes('--dry-run');
  const live = args.includes('--live');
  const prepareCanvas = args.includes('--prepare-canvas');
  const resumeId = option(args, 'resume-download', { required: false });
  if (Number(dryRun) + Number(live) + Number(prepareCanvas) + Number(Boolean(resumeId)) !== 1) throw new Error('generate-libtv-video requires exactly one of --dry-run, --prepare-canvas, --live, or --resume-download');
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  const inspect = packageInspector(root, segmentId);
  if (resumeId) return resumeLibTvVideoDownload(root, resumeId, options);
  if (prepareCanvas) return prepareLibTvVideoCanvas(root, {
    segmentId,
    projectUuid: option(args, 'libtv-project'),
    nodeName: option(args, 'node-name', { required: false }),
    model: option(args, 'model', { required: false }) ?? 'Seedance 2.0 VIP'
  }, { ...options, ...(inspect ? { inspect } : {}) });
  if (live) return executeLibTvVideo(root, {
    segmentId, projectUuid: option(args, 'libtv-project', { required: false }),
    nodeName: option(args, 'node-name', { required: false }), paidApprovalId: option(args, 'paid-approval')
  }, { ...options, ...(inspect ? { inspect } : {}) });
  const projectUuid = option(args, 'libtv-project');
  const nodeName = option(args, 'node-name', { required: false }) ?? `${segmentId}-seedance-video`;
  const model = option(args, 'model', { required: false }) ?? 'Seedance 2.0 VIP';
  const preflight = await createVideoPreflight(root, segmentId, {
    id: options.runId, executor: 'libtv', libtvProjectUuid: projectUuid, nodeName, model
    , ...(inspect ? { inspect } : {})
  });
  const plan = await buildLibTvVideoPlan(root, segmentId, {
    projectUuid, nodeName, model, ...(inspect ? { inspect } : {})
  });
  if (plan.fingerprint.sha256 !== preflight.fingerprint.sha256) throw new Error('LibTV plan and persisted preflight fingerprints differ');
  return { ...plan, preflightId: preflight.preflightId };
}
