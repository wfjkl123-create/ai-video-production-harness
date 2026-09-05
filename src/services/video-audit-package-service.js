import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runProcess } from '../adapters/process-runner.js';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { videoResolutionSpec } from '../domain/video-model-profile.js';
import { executionControlFingerprint } from '../domain/execution-control-contract.js';
import { recordGeneratedOutputFailure } from './generation-failure-service.js';
import { deriveExecutionObservationBestEffort } from './authoritative-trace-observation-service.js';

function safeProjectFile(root, recordedPath) {
  if (typeof recordedPath !== 'string' || isAbsolute(recordedPath)) throw new Error('video output must be project-relative');
  const path = resolve(root, recordedPath);
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('video output must stay inside the project');
  return path;
}

function seconds(matches, startName, endName) {
  let total = 0;
  for (const match of matches) total += Math.max(0, Number(match.groups[endName]) - Number(match.groups[startName]));
  return total;
}

function analyzeDiagnostics(stderr) {
  const black = [...stderr.matchAll(/black_start:(?<start>[\d.]+)\s+black_end:(?<end>[\d.]+)/g)];
  const freeze = [...stderr.matchAll(/freeze_start:\s*(?<start>[\d.]+).*?freeze_end:\s*(?<end>[\d.]+)/gs)];
  const silence = [...stderr.matchAll(/silence_start:\s*(?<start>[\d.]+).*?silence_end:\s*(?<end>[\d.]+)/gs)];
  const blur = [...stderr.matchAll(/blur mean:\s*(?<value>[\d.]+)/g)].map(match => Number(match.groups.value));
  return {
    blackSeconds: seconds(black, 'start', 'end'), freezeSeconds: seconds(freeze, 'start', 'end'),
    silenceSeconds: seconds(silence, 'start', 'end'), blurMean: blur.length ? blur.reduce((a, b) => a + b, 0) / blur.length : null
  };
}

async function invoke(runner, executable, args, root) {
  const result = await runner(executable, args, { cwd: root, shell: false });
  if (result.code !== 0) throw new Error(`${executable} audit command failed with exit code ${Number.isInteger(result.code) ? result.code : 'unknown'}`);
  return result;
}

export async function prepareVideoAuditPackage(root, runId, options = {}) {
  const run = await readJson(join(root, 'runs', `${encodeURIComponent(runId)}.json`));
  if (run.kind !== 'libtv_video' || run.status !== 'SUCCESS' || !Array.isArray(run.outputs) || run.outputs.length !== 1) {
    throw new Error('video audit package requires one successful LibTV video output');
  }
  const videoPath = safeProjectFile(root, run.outputs[0].path);
  if (await sha256File(videoPath) !== run.outputs[0].sha256) throw new Error('video output checksum changed before audit packaging');
  const runner = options.runner ?? runProcess;
  const probe = await invoke(runner, 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath], root);
  let metadata;
  try { metadata = JSON.parse(probe.stdout); } catch { throw new Error('ffprobe returned invalid JSON'); }
  const videoStream = metadata.streams?.find(stream => stream.codec_type === 'video');
  const audioStream = metadata.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(metadata.format?.duration ?? videoStream?.duration);
  if (!videoStream || !Number.isFinite(duration) || duration <= 0) throw new Error('video metadata lacks a valid video stream or duration');
  const expectedDuration = Number(run.fingerprint?.generationContract?.request?.duration ?? duration);
  const expectedResolution = run.fingerprint?.generationContract?.request?.resolution ?? '480p';
  const expectedDimensions = videoResolutionSpec(expectedResolution);
  const frameCount = Math.max(6, Math.min(15, Math.ceil(duration)));
  const packageId = options.packageId ?? `video-audit-${run.segmentId}-${randomUUID()}`;
  const packageRoot = join(root, 'reviews', 'video-audits', packageId);
  const framesRoot = join(packageRoot, 'frames');
  await mkdir(framesRoot, { recursive: true });
  const fps = frameCount / duration;
  await invoke(runner, 'ffmpeg', ['-hide_banner', '-nostdin', '-n', '-i', videoPath, '-vf', `fps=${fps}`, '-frames:v', String(frameCount), join(framesRoot, 'frame-%03d.png')], root);
  const diagnostics = await invoke(runner, 'ffmpeg', [
    '-hide_banner', '-nostdin', '-i', videoPath,
    '-vf', 'blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-50dB:d=1,blurdetect',
    ...(audioStream ? ['-af', 'silencedetect=n=-50dB:d=1'] : []), '-f', 'null', '-'
  ], root);
  const signals = analyzeDiagnostics(diagnostics.stderr);
  const frames = (await readdir(framesRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.startsWith('._') && entry.name.endsWith('.png'))
    .sort().map(entry => relative(root, join(framesRoot, entry.name)).split(sep).join('/'));
  const vetoes = [];
  const actualRatio = videoStream.width / videoStream.height;
  const expectedRatio = expectedDimensions.width / expectedDimensions.height;
  const compatiblePortrait = videoStream.width >= expectedDimensions.width
    && videoStream.height >= expectedDimensions.height
    && Math.abs(actualRatio - expectedRatio) <= 0.03;
  if (!compatiblePortrait) vetoes.push('wrong_dimensions');
  if (duration > expectedDuration + 0.2 || Math.abs(duration - expectedDuration) > 1.25) vetoes.push('duration_mismatch');
  if (!audioStream) vetoes.push('missing_generated_audio');
  if (frames.length < Math.min(6, frameCount)) vetoes.push('insufficient_visual_samples');
  if (signals.blackSeconds > 0.5) vetoes.push('extended_black_frames');
  if (signals.freezeSeconds > 2) vetoes.push('extended_frozen_video');
  const report = {
    id: packageId, kind: 'video_audit_package', segmentId: run.segmentId, videoRunId: run.id,
    videoPath: run.outputs[0].path, videoSha256: run.outputs[0].sha256,
    metadata: { width: videoStream.width, height: videoStream.height, duration, videoCodec: videoStream.codec_name, hasAudio: Boolean(audioStream), audioCodec: audioStream?.codec_name ?? null, fileSize: (await stat(videoPath)).size },
    expected: { ...expectedDimensions, resolution: expectedResolution, maxDuration: expectedDuration + 0.2, duration: expectedDuration, generatedAudio: true },
    signals: {
      ...signals,
      resolutionUpgrade: compatiblePortrait
        && (videoStream.width > expectedDimensions.width || videoStream.height > expectedDimensions.height)
    },
    frames, machineDecision: vetoes.length ? 'FAIL' : 'PASS', triggeredVetoes: vetoes,
    manualExternalChecksRequired: [
      'identity_and_limb_artifacts',
      'garment_intersection_and_dressing_physics',
      'speaker_mouth_binding',
      'audio_visual_sync',
      'product_scale_and_structure',
      'blocking_and_plot_fidelity',
      'visible_text_subtitles_logo_watermark',
      'camera_gaze_and_sales_gesture',
      'opening_pose_release',
      'product_feature_readability',
      'before_after_effect_comparability'
    ],
    externalAuditInstructions: 'Use only this clean audit package and its listed project files. Inspect every sampled frame and the exact locked plot/prompt evidence. FAIL on any identity drift, extra limbs or footwear, garment/body intersection, dressing teleportation, wrong speaking character, visible audio/lip mismatch, product scale/structure error, blocking drift, plot deviation, visible subtitle/text/logo/watermark, camera-facing sales delivery or pointing gesture, sustained opening-reference pose lock, unreadable required product feature, or a before/after result that is not visually comparable. Cite concrete frame filenames and observable evidence.',
    createdAt: new Date().toISOString()
  };
  const reportPath = join(packageRoot, 'report.json');
  await writeJsonAtomic(reportPath, report);
  const reportRecord = { ...report, reportPath: relative(root, reportPath).split(sep).join('/'), reportSha256: await sha256File(reportPath) };
  await withProjectLock(root, async () => {
    const current = await readJson(join(root, 'runs', `${encodeURIComponent(runId)}.json`));
    if (current.status !== 'SUCCESS' || current.outputs?.[0]?.sha256 !== run.outputs[0].sha256) throw new Error('video run changed before audit package publication');
    await writeJsonAtomic(join(root, 'runs', `${encodeURIComponent(runId)}.json`), {
      ...current,
      auditPackage: { id: packageId, machineDecision: report.machineDecision, triggeredVetoes: vetoes, reportPath: reportRecord.reportPath, reportSha256: reportRecord.reportSha256 },
      updatedAt: new Date().toISOString()
    });
  });
  if (report.machineDecision === 'FAIL') {
    const state = await readJson(join(root, 'project-state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (state?.videoGovernanceVersion === 2) {
      const rootCauseKey = 'MACHINE_TECHNICAL_OUTPUT_VETO';
      await recordGeneratedOutputFailure(root, {
        outputId: run.outputs[0].id ?? `${run.id}-output-1`,
        outputSha256: run.outputs[0].sha256,
        failureType: 'machine_video_veto',
        rootCauseKey,
        causalAttribution: {
          kind: 'generation_failure_causal_attribution_v1', version: 1, rootCauseKey,
          primary: {
            key: rootCauseKey, stage: 'technical_review',
            hypothesis: 'the generated output violated a deterministic delivery or playback contract',
            confidence: 'high', evidence: vetoes.map(item => `${item}: ${JSON.stringify(report.signals)}`),
            falsifier: 'a checksum-identical output passes the same deterministic audit with the same expected contract'
          },
          contributors: [], counterEvidence: [],
          unknowns: ['the upstream internal mechanism that produced the invalid output is not directly observable'],
          nextMinimalCheck: {
            variable: 'failed deterministic contract dimension',
            action: 'inspect the exact failed metadata or decoded stream before changing any prompt language',
            expectedObservation: 'the failed contract dimension identifies the smallest control-route correction',
            changesOnePrimaryVariable: true, costClass: 'free'
          },
          promptOnlyRetryAllowed: false, controlRouteChangeRequired: true
        },
        segmentId: run.segmentId,
        failureObservation: {
          category: 'technical_output_failure',
          responsibilityStage: 'generation',
          returnStage: 'generation',
          retryKind: 'none'
        },
        controlRouteFingerprint: executionControlFingerprint(run.fingerprint.executionControlContract),
        observableProblem: `Machine audit vetoes: ${vetoes.join(', ')}`,
        exactTimestampsOrRegions: ['full_output_machine_scan'],
        observedEvidence: vetoes.map(item => `${item}: ${JSON.stringify(report.signals)}`),
        expectedLockedRequirement: JSON.stringify(report.expected),
        mostLikelyCause: 'Generated output violated a deterministic delivery or playback contract',
        freeRevisionCompleted: 'not_applicable_machine_terminal_output'
      }, { id: `generation-failure-${run.id}` }).catch(error => {
        if (!/already counted/.test(error.message)) throw error;
      });
    }
  }
  await deriveExecutionObservationBestEffort(root, {
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'video_audit_media',
    reportPath: reportRecord.reportPath
  }, {
    deriveExecutionObservation: options.deriveExecutionObservation,
    derivationOptions: options.observationDerivationOptions,
    onError: options.onObservationError
  });
  return reportRecord;
}
