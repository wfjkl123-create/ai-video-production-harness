import { randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { RunningHubAdapter } from '../adapters/runninghub-adapter.js';
import { loadSecrets, redact } from '../config/env.js';
import { sha256File } from '../storage/checksum.js';
import {
  claimPaidGeneration, createVideoPreflight, loadResumableGeneration, markSubmissionUncertain,
  recordSubmittedTask, updateGenerationRun
} from '../services/video-generation-service.js';
import { option } from './args.js';

async function completeSubmitted(root, claimed, adapter) {
  const { run, inspected } = claimed;
  let phase = 'poll';
  try {
    const result = await adapter.waitForCompletion(run.taskId);
    phase = 'download';
    const destination = join(root, 'outputs', run.segmentId);
    const localOutputs = await adapter.downloadResults(result, destination);
    const outputs = await Promise.all(localOutputs.map(async path => ({
      path: relative(root, path).split(sep).join('/'), sha256: await sha256File(path)
    })));
    await updateGenerationRun(root, run.id, { status: 'SUCCESS', outputs });
    return { ...inspected.plan, mutatesRunningHub: true, runId: run.id, taskId: run.taskId, outputs };
  } catch (error) {
    const errorKind = error.kind ?? 'unknown';
    const resumableInterruption = ['network', 'timeout'].includes(errorKind) || phase === 'download';
    const status = errorKind === 'failed' ? 'FAILED' : resumableInterruption ? 'INTERRUPTED' : 'FAILED_TECHNICAL';
    await updateGenerationRun(root, run.id, {
      status, failurePhase: phase, errorKind, errorMessage: redact(error.message)
    });
    throw error;
  }
}

export async function runGenerateVideoCommand(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  const dryRun = args.includes('--dry-run');
  const live = args.includes('--live');
  const resumeId = option(args, 'resume', { required: false });
  const executor = option(args, 'executor', { required: false }) ?? 'runninghub';
  if (Number(dryRun) + Number(live) + Number(Boolean(resumeId)) !== 1) {
    throw new Error('choose exactly one of --dry-run, --live, or --resume');
  }
  if (dryRun) return createVideoPreflight(root, segmentId, {
    id: options.runId,
    executor,
    libtvProjectUuid: option(args, 'libtv-project', { required: false }),
    nodeName: option(args, 'node-name', { required: false })
  });
  if (executor !== 'runninghub') throw new Error('generate-video --live/--resume only supports RunningHub; use generate-libtv-video for LibTV');
  const adapterFor = runId => options.adapter ?? new RunningHubAdapter({
    apiKey: loadSecrets(root).runningHubApiKey,
    evidencePath: join(root, 'runs', `${runId}-adapter.json`)
  });
  if (resumeId) {
    const resumable = await loadResumableGeneration(root, resumeId, segmentId);
    return completeSubmitted(root, resumable, adapterFor(resumable.run.id));
  }

  const approvalId = option(args, 'paid-approval');
  const runId = options.runId ?? `runninghub-${randomUUID()}`;
  const adapter = adapterFor(runId);
  if (typeof adapter.assertStandardModelAccess === 'function') await adapter.assertStandardModelAccess();
  const claimed = await claimPaidGeneration(root, { segmentId, approvalId, runId });
  try {
    const uploadAll = values => Promise.all(values.map(path => adapter.upload(path)));
    const submittedInput = {
      ...claimed.inspected.input,
      imageInputs: await uploadAll(claimed.inspected.input.imageInputs),
      videoInputs: await uploadAll(claimed.inspected.input.videoInputs),
      audioInputs: await uploadAll(claimed.inspected.input.audioInputs)
    };
    const taskId = await adapter.submitVideo(submittedInput);
    const run = await recordSubmittedTask(root, claimed.run.id, claimed.run.submitOwnerToken, taskId);
    return completeSubmitted(root, { ...claimed, run }, adapter);
  } catch (error) {
    await markSubmissionUncertain(root, claimed.run.id, claimed.run.submitOwnerToken, {
      kind: error.kind, message: redact(error.message)
    });
    throw error;
  }
}
