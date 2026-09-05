import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File } from '../../src/storage/checksum.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { prepareVideoAuditPackage } from '../../src/services/video-audit-package-service.js';
import { initializeProject } from '../../src/services/project-service.js';
import { readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';

async function fixture({ initialized = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'video-audit-'));
  if (initialized) await initializeProject(root, { projectId: 'VIDEO-AUDIT-AUTO' });
  await mkdir(join(root, 'runs'), { recursive: true });
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'outputs', 'video.mp4'), 'video-bytes');
  await writeJsonAtomic(join(root, 'runs', 'video-run.json'), {
    id: 'video-run', kind: 'libtv_video', status: 'SUCCESS', segmentId: 'segment-001',
    fingerprint: { generationContract: { request: { duration: 10 } } },
    outputs: [{ path: 'outputs/video.mp4', sha256: await sha256File(join(root, 'outputs', 'video.mp4')) }]
  });
  return root;
}

function runnerFor({ width = 720, height = 1280, audio = true, diagnostics = 'blur mean: 2.1' } = {}) {
  return async (executable, args) => {
    if (executable === 'ffprobe') return {
      code: 0, stderr: '', stdout: JSON.stringify({
        streams: [
          { codec_type: 'video', width, height, codec_name: 'h264', duration: '10' },
          ...(audio ? [{ codec_type: 'audio', codec_name: 'aac' }] : [])
        ], format: { duration: '10' }
      })
    };
    if (args.includes('-frames:v')) {
      const count = Number(args[args.indexOf('-frames:v') + 1]);
      const pattern = args.at(-1);
      for (let index = 1; index <= count; index += 1) await writeFile(pattern.replace('%03d', String(index).padStart(3, '0')), 'png');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: diagnostics };
  };
}

test('builds a checksum-bound full-span frame package with machine PASS', async () => {
  const root = await fixture();
  const observationRequests = [];
  const report = await prepareVideoAuditPackage(root, 'video-run', {
    runner: runnerFor(),
    packageId: 'audit-package-1',
    deriveExecutionObservation: async (projectRoot, request) => {
      const publishedRun = await readJson(join(projectRoot, 'runs', 'video-run.json'));
      assert.equal(publishedRun.auditPackage.reportPath, request.reportPath);
      assert.match(publishedRun.auditPackage.reportSha256, /^[a-f0-9]{64}$/);
      observationRequests.push(request);
      return { reused: false };
    }
  });
  assert.equal(report.machineDecision, 'PASS');
  assert.equal(report.metadata.hasAudio, true);
  assert.equal(report.frames.length, 10);
  assert.equal(report.reportSha256.length, 64);
  assert.ok(report.manualExternalChecksRequired.includes('audio_visual_sync'));
  assert.ok(report.manualExternalChecksRequired.includes('visible_text_subtitles_logo_watermark'));
  assert.ok(report.manualExternalChecksRequired.includes('camera_gaze_and_sales_gesture'));
  assert.ok(report.manualExternalChecksRequired.includes('opening_pose_release'));
  assert.ok(report.manualExternalChecksRequired.includes('product_feature_readability'));
  assert.ok(report.manualExternalChecksRequired.includes('before_after_effect_comparability'));
  assert.match(report.externalAuditInstructions, /visible subtitle\/text\/logo\/watermark/);
  assert.match(report.externalAuditInstructions, /before\/after result that is not visually comparable/);
  assert.deepEqual(observationRequests, [{
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'video_audit_media',
    reportPath: report.reportPath
  }]);
});

test('media observation failure never changes a published video audit result', async () => {
  const root = await fixture();
  const errors = [];
  const report = await prepareVideoAuditPackage(root, 'video-run', {
    runner: runnerFor(),
    packageId: 'audit-package-observation-failure',
    deriveExecutionObservation: async () => { throw new Error('observation unavailable'); },
    onObservationError: error => errors.push(error.message)
  });
  assert.equal(report.machineDecision, 'PASS');
  assert.equal((await readJson(join(root, 'runs', 'video-run.json'))).auditPackage.id, report.id);
  assert.deepEqual(errors, ['observation unavailable']);
});

test('published video audit automatically records the generated output duration', async () => {
  const root = await fixture({ initialized: true });
  const report = await prepareVideoAuditPackage(root, 'video-run', {
    runner: runnerFor(), packageId: 'audit-package-auto-duration'
  });
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.consistency, 'consistent');
  assert.equal(status.observations.derivation.bySourceType.video_audit_media, 1);
  assert.equal(status.observations.media.byKind.generated_output.totalDurationMs, report.metadata.duration * 1000);
});

test('accepts LibTV native 480p portrait dimensions and encoder duration tolerance', async () => {
  const root = await fixture();
  const runPath = join(root, 'runs', 'video-run.json');
  const run = JSON.parse(await (await import('node:fs/promises')).readFile(runPath, 'utf8'));
  run.fingerprint.generationContract.request = { duration: 15, resolution: '480p' };
  await writeJsonAtomic(runPath, run);
  const runner = runnerFor({ width: 496, height: 864 });
  const wrapped = async (executable, args) => {
    const result = await runner(executable, args);
    if (executable === 'ffprobe') {
      const value = JSON.parse(result.stdout);
      value.streams[0].duration = '15.093';
      value.format.duration = '15.093';
      result.stdout = JSON.stringify(value);
    }
    return result;
  };
  const report = await prepareVideoAuditPackage(root, 'video-run', { runner: wrapped, packageId: 'audit-package-480p' });
  assert.equal(report.machineDecision, 'PASS');
  assert.equal(report.expected.resolution, '480p');
});

test('machine gate fails wrong dimensions, missing audio, black, and frozen intervals', async () => {
  const root = await fixture();
  const diagnostics = 'black_start:0 black_end:1 black_duration:1\nfreeze_start: 2\nfreeze_end: 5\nblur mean: 9.2';
  const report = await prepareVideoAuditPackage(root, 'video-run', {
    runner: runnerFor({ width: 1280, height: 720, audio: false, diagnostics }), packageId: 'audit-package-2'
  });
  assert.equal(report.machineDecision, 'FAIL');
  assert.ok(report.triggeredVetoes.includes('wrong_dimensions'));
  assert.ok(report.triggeredVetoes.includes('missing_generated_audio'));
  assert.ok(report.triggeredVetoes.includes('extended_black_frames'));
  assert.ok(report.triggeredVetoes.includes('extended_frozen_video'));
});

test('a strict-project machine veto automatically records the structured generation failure', async () => {
  const root = await fixture();
  await mkdir(join(root, 'reviews'));
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'video-audit-strict', workflowVersion: 2, videoGovernanceVersion: 2,
    phase: 'gate5_review', activeSegmentId: 'segment-001', blockedReason: null,
    artifacts: [], updatedAt: '2026-08-24T00:00:00.000Z'
  });
  await writeJsonAtomic(join(root, 'reviews', 'remake-v2-generation-policy.json'), {
    kind: 'project_generation_policy', decision: 'approved', projectId: 'video-audit-strict',
    qualityFailurePolicy: { maxFailedGeneratedOutputs: 4 }
  });
  const runPath = join(root, 'runs', 'video-run.json');
  const run = await readJson(runPath);
  run.outputs[0].id = 'generated-output-1';
  run.fingerprint.executionControlContract = {
    version: 1, plannedShotCount: 1, generatedUnitShotCount: 1,
    executionUnitStrategy: 'single_take', requiresIndependentShotControl: false,
    platformCapability: {
      surface: 'LibTV node', profileId: 'seedance-2-libtv-v1', parameter: 'multi_shots',
      exposed: false, enabled: false, evidence: 'not required for single take'
    }
  };
  await writeJsonAtomic(runPath, run);
  await prepareVideoAuditPackage(root, 'video-run', {
    runner: runnerFor({ width: 1280, height: 720, audio: false }), packageId: 'audit-package-auto-ledger'
  });
  const ledger = await readJson(join(root, 'runs', 'generation-failure-ledger.json'));
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].failureType, 'machine_video_veto');
  assert.equal(ledger.events[0].outputId, 'generated-output-1');
  assert.match(ledger.events[0].controlRouteFingerprint, /^[a-f0-9]{64}$/);
  const executionLedger = await readExecutionLedgerStatus(root);
  assert.equal(executionLedger.observations.derivation.bySourceType.generation_failure, 1);
  assert.equal(executionLedger.observations.failures.byCategory.technical_output_failure, 1);
});

test('accepts a compatible higher-resolution output but rejects a downgrade below the approved contract', async () => {
  const upgradedRoot = await fixture();
  const upgraded = await prepareVideoAuditPackage(upgradedRoot, 'video-run', {
    runner: runnerFor({ width: 1080, height: 1920 }), packageId: 'audit-package-upgraded'
  });
  assert.equal(upgraded.machineDecision, 'PASS');
  assert.equal(upgraded.signals.resolutionUpgrade, true);

  const downgradedRoot = await fixture();
  const runPath = join(downgradedRoot, 'runs', 'video-run.json');
  const run = JSON.parse(await (await import('node:fs/promises')).readFile(runPath, 'utf8'));
  run.fingerprint.generationContract.request.resolution = '1080p';
  await writeJsonAtomic(runPath, run);
  const downgraded = await prepareVideoAuditPackage(downgradedRoot, 'video-run', {
    runner: runnerFor({ width: 720, height: 1280 }), packageId: 'audit-package-downgraded'
  });
  assert.equal(downgraded.machineDecision, 'FAIL');
  assert.ok(downgraded.triggeredVetoes.includes('wrong_dimensions'));
});

test('refuses a changed video before invoking ffmpeg', async () => {
  const root = await fixture();
  await writeFile(join(root, 'outputs', 'video.mp4'), 'tampered');
  let calls = 0;
  await assert.rejects(prepareVideoAuditPackage(root, 'video-run', { runner: async () => { calls += 1; } }), /checksum changed/);
  assert.equal(calls, 0);
});
