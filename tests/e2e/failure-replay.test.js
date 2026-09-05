import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { compileAssetManifest, assertLockedAssetInputs } from '../../src/services/asset-service.js';
import { initializeProject, getProjectStatus } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { runPrepareHandoff } from '../../src/commands/prepare-handoff.js';
import { RunningHubAdapter } from '../../src/adapters/runninghub-adapter.js';
import { createCandidateRule, verifyRule } from '../../src/services/rule-service.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { runGenerateAssets } from '../../src/commands/generate-assets.js';
import { runReviewAssetManifest } from '../../src/commands/review-asset-manifest.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';
import { runCompileSeedance } from '../../src/commands/compile-seedance.js';
import { runGenerateVideoCommand } from '../../src/commands/generate-video-cli.js';
import { runApprovePaidGeneration } from '../../src/commands/approve-paid-generation.js';
import { runReconcileVideoSubmit } from '../../src/commands/reconcile-video-submit.js';
import { sha256File } from '../../src/storage/checksum.js';
import { claimPaidGeneration } from '../../src/services/video-generation-service.js';
import { runReconcileLibTvRun } from '../../src/commands/reconcile-libtv-run.js';
import { lockPassingIndependentAudit } from '../helpers/independent-creative-audit-fixture.js';
import { runGenerateLibTvVideo } from '../../src/commands/generate-libtv-video.js';
import { createDerivedPaidGenerationApproval } from '../../src/services/batch-generation-service.js';
import { createGptFallbackPaidGenerationApproval } from '../../src/services/gpt-fallback-generation-service.js';
import { readExecutionEvents } from '../../src/services/execution-ledger-service.js';

const sha = 'a'.repeat(64);
const locked = (id, type, extra = {}) => ({ id, type, revision: 1, status: 'locked', path: `${id}.json`, lockedByReviewId: `review-${id}`, ...extra });
const segment = {
  id: 'segment-001', duration: 12, status: 'locked', lockedByReviewId: 'review-segments',
  projectAssetIds: ['missing-product'], segmentAssetRequirements: ['camera_blocking'],
  previousSegmentId: null, nextSegmentId: null
};

test('failure replay: missing project asset stops manifest compilation', () => {
  assert.throws(() => compileAssetManifest({
    segments: [segment], artifacts: [locked('script', 'script'), locked('shotlist', 'shotlist')]
  }, segment), /missing-product.*not locked/);
});

test('failure replay: rejected segment asset never becomes a downstream input', () => {
  assert.throws(() => assertLockedAssetInputs({ items: [{
    id: 'camera', status: 'rejected', responsibility: 'camera only', mustNotControl: ['identity']
  }] }), /camera.*not locked/);
});

test('failure replay: RunningHub authentication failure is classified and preserved', async () => {
  const adapter = new RunningHubAdapter({ apiKey: 'fake', fetch: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(adapter.query('task'), error => error.kind === 'authentication');
  assert.equal(adapter.evidence.at(-1).outcome, 'authentication_error');
});

test('failure replay: bounded polling exhaustion stops instead of looping forever', async () => {
  let now = 0;
  const adapter = new RunningHubAdapter({
    apiKey: 'fake', now: () => now, sleep: async ms => { now += Math.max(ms, 1); },
    fetch: async () => new Response(JSON.stringify({ data: { status: 'RUNNING' } }), { status: 200 })
  });
  await assert.rejects(adapter.waitForCompletion('task', { pollIntervalMs: 1, maxWaitMs: 2 }), error => error.kind === 'timeout');
});

async function readyVideoProject(prefix, auditOptions = {}, videoExecutor = 'runninghub') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const directory of ['assets', 'outputs', 'reviews', 'rules', 'segments']) {
    await cp(`tests/fixtures/project-ready/${directory}`, join(root, directory), { recursive: true });
  }
  await mkdir(join(root, 'prompts'), { recursive: true });
  for (const name of ['character-001.txt', 'segment-001-camera-blocking.txt', 'segment-001-storyboard.txt', 'segment-001.txt', 'segment-001-narration.json']) {
    await cp(`tests/fixtures/project-ready/prompts/${name}`, join(root, 'prompts', name));
  }
  await cp('tests/fixtures/project-ready/project-state.json', join(root, 'project-state.json'));
  await runCompileSeedance(['--project', root, '--segment', 'segment-001', '--video-executor', videoExecutor]);
  await lockPassingIndependentAudit(root, 'segment-001', auditOptions);
  return root;
}

test('failure replay: submitted taskId is durable and resume never submits a second task', async () => {
  const root = await readyVideoProject('resume-task-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-resume' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'approve exact fingerprint'
  ], { id: 'approval-resume' });
  let submits = 0;
  const interrupted = {
    upload: async path => `fake://${path}`,
    submitVideo: async () => { submits += 1; return 'task-durable-001'; },
    waitForCompletion: async () => { throw Object.assign(new Error('worker interrupted'), { kind: 'timeout' }); },
    downloadResults: async () => assert.fail('must not download before SUCCESS')
  };
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { adapter: interrupted, runId: 'live-resumable' }), /interrupted/);
  const partial = JSON.parse(await readFile(join(root, 'runs/live-resumable.json'), 'utf8'));
  assert.equal(partial.taskId, 'task-durable-001');
  assert.equal(partial.status, 'INTERRUPTED');
  assert.equal(partial.errorKind, 'timeout');
  assert.equal(partial.failurePhase, 'poll');

  const resumed = {
    upload: async () => assert.fail('resume must not upload'),
    submitVideo: async () => { submits += 1; assert.fail('resume must not submit'); },
    waitForCompletion: async taskId => {
      assert.equal(taskId, 'task-durable-001');
      return { status: 'SUCCESS', results: [{ url: 'fake://result' }] };
    },
    downloadResults: async (_result, destination) => {
      await mkdir(destination, { recursive: true });
      const path = join(destination, 'result-1.mp4');
      await writeFile(path, 'resumed video');
      return [path];
    }
  };
  const completed = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--resume', 'live-resumable'
  ], { adapter: resumed });
  assert.equal(completed.taskId, 'task-durable-001');
  assert.equal(submits, 1);
  assert.deepEqual((await readExecutionEvents(root)).map(event => event.type), [
    'ledger.bootstrap',
    'preflight.ready',
    'paid_approval.granted',
    'generation.claimed',
    'generation.submitted',
    'generation.interrupted',
    'generation.succeeded'
  ]);
});

test('failure replay: paid approval becomes invalid when an approved input changes', async () => {
  const root = await readyVideoProject('approval-binding-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-binding' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'approve exact fingerprint'
  ], { id: 'approval-binding' });
  const packageJson = JSON.parse(await readFile(join(root, 'prompts/segment-001/seedance-package.json'), 'utf8'));
  await writeFile(join(root, packageJson.imageInputs[0].path), 'tampered after approval');
  let submits = 0;
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { adapter: { submitVideo: async () => { submits += 1; } } }), /checksum|fingerprint|changed/);
  assert.equal(submits, 0);
});

test('failure replay: standard model entitlement is checked before consuming paid approval', async () => {
  const root = await readyVideoProject('approval-entitlement-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-entitlement' });
  assert.deepEqual(preflight.fingerprint.generationContract, {
    provider: 'runninghub',
    endpoint: '/openapi/v2/bytedance/seedance-2.0-global/multimodal-video',
    requiredApiType: 'SHARED',
    request: { duration: 12, ratio: '9:16', resolution: '480p', generateAudio: true, realPersonMode: true }
  });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'must remain unconsumed'
  ], { id: 'approval-entitlement' });
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { runId: 'live-entitlement', adapter: {
    assertStandardModelAccess: async () => { throw Object.assign(new Error('SHARED key required'), { kind: 'entitlement' }); },
    upload: async () => assert.fail('entitlement failure must not upload'),
    submitVideo: async () => assert.fail('entitlement failure must not submit')
  } }), /SHARED key required/);
  const unchanged = JSON.parse(await readFile(join(root, `reviews/${approval.id}.json`), 'utf8'));
  assert.equal(unchanged.consumedByRunId, null);
  await assert.rejects(readFile(join(root, 'runs/live-entitlement.json')), /ENOENT/);
});

test('failure replay: LibTV dry-run persists the exact official-CLI contract used by its plan', async () => {
  const root = await readyVideoProject('libtv-fingerprint-e2e-', {}, 'libtv');
  const projectUuid = 'b'.repeat(32);
  const nodeName = 'segment-001-seedance-video-v4';
  const plan = await runGenerateLibTvVideo([
    '--project', root, '--segment', 'segment-001', '--libtv-project', projectUuid,
    '--node-name', nodeName, '--dry-run'
  ], { runId: 'preflight-libtv-contract' });
  assert.equal(plan.mutatesLibTv, false);
  assert.equal(plan.preflightId, 'preflight-libtv-contract');
  assert.deepEqual(plan.fingerprint.generationContract, {
    provider: 'libtv', transport: 'official_cli', projectUuid, nodeName,
    model: 'Seedance 2.0 VIP', modeType: 'mixed2video',
    request: { duration: 12, ratio: '9:16', resolution: '480p', enableSound: true, count: 1, searchEnabled: 0, autoCompliance: true }
  });
  const persisted = JSON.parse(await readFile(join(root, 'runs/preflight-libtv-contract.json'), 'utf8'));
  assert.equal(persisted.fingerprint.sha256, plan.fingerprint.sha256);
  assert.deepEqual(persisted.fingerprint.generationContract, plan.fingerprint.generationContract);
  assert.equal(plan.createCommand.includes('--run'), false);
});

test('failure replay: LibTV batch approval and external audit derive only the same canvas-bound fingerprint', async () => {
  const root = await readyVideoProject('libtv-derived-fingerprint-e2e-', {}, 'libtv');
  const projectUuid = 'c'.repeat(32);
  const nodeName = 'segment-001-seedance-video-v5';
  const plan = await runGenerateLibTvVideo([
    '--project', root, '--segment', 'segment-001', '--libtv-project', projectUuid,
    '--node-name', nodeName, '--dry-run'
  ], { runId: 'preflight-libtv-derived' });
  const state = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  const model = 'claude-ocx-anthropic--claude-opus-4-8';
  await writeJsonAtomic(join(root, 'reviews/batch-libtv-derived.json'), {
    id: 'batch-libtv-derived', kind: 'batch_generation_approval', actor: 'human', decision: 'approved',
    projectId: state.projectId, executor: 'libtv', libtvProjectUuid: projectUuid, externalAuditModel: model,
    segments: [{ segmentId: 'segment-001', strategy: 'editorial_cut', maxPaidAttempts: 1 }],
    budget: { unit: 'tasks', limit: 1 }, externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.8 },
    maxPaidSubmissions: 1, stopVetoes: ['blur'], approvedAt: '2026-07-28T00:00:00Z'
  });
  await writeJsonAtomic(join(root, 'runs/audit-run-libtv-derived.json'), {
    id: 'audit-run-libtv-derived', kind: 'external_model_audit', status: 'SUCCESS',
    attestationId: 'audit-libtv-derived', sessionId: 'session-libtv-derived', model,
    segmentId: 'segment-001', auditStage: 'pre_generation', fingerprintSha256: plan.fingerprint.sha256
  });
  await writeJsonAtomic(join(root, 'reviews/audit-libtv-derived.json'), {
    id: 'audit-libtv-derived', kind: 'external_audit_attestation', segmentId: 'segment-001',
    auditStage: 'pre_generation', provider: 'anthropic', model, providerTaskId: 'session-libtv-derived',
    auditRunId: 'audit-run-libtv-derived', cleanZeroContext: true, decision: 'PASS',
    fingerprintSha256: plan.fingerprint.sha256, reportSha256: 'd'.repeat(64), reviewedAt: '2026-07-28T00:01:00Z'
  });
  const approval = await createDerivedPaidGenerationApproval(root, {
    batchApprovalId: 'batch-libtv-derived', segmentId: 'segment-001',
    preflightId: plan.preflightId, externalAuditAttestationId: 'audit-libtv-derived'
  }, { id: 'paid-libtv-derived' });
  assert.equal(approval.executor, 'libtv');
  assert.equal(approval.libtvProjectUuid, projectUuid);
  assert.equal(approval.nodeName, nodeName);
  assert.equal(approval.fingerprint.sha256, plan.fingerprint.sha256);
  assert.equal(approval.fingerprint.generationContract.provider, 'libtv');
  assert.deepEqual((await readExecutionEvents(root)).map(event => event.type), [
    'ledger.bootstrap', 'preflight.ready', 'paid_approval.granted'
  ]);
});

test('failure replay: explicit human GPT fallback binds the exact LibTV fingerprint and never grants retries', async () => {
  const root = await readyVideoProject('gpt-fallback-e2e-', { agentTaskId: 'gpt-clean-fixture' }, 'libtv');
  const projectUuid = 'e'.repeat(32);
  const nodeName = 'segment-001-gpt-fallback';
  const plan = await runGenerateLibTvVideo([
    '--project', root, '--segment', 'segment-001', '--libtv-project', projectUuid,
    '--node-name', nodeName, '--dry-run'
  ], { runId: 'preflight-gpt-fallback' });
  const state = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  const exceptionId = 'gpt-exception-current';
  await writeJsonAtomic(join(root, `reviews/${exceptionId}.json`), {
    id: exceptionId, projectId: state.projectId, segmentId: 'segment-001',
    decision: 'GPT_ALLOWED_TO_SUBSTITUTE_NON_GPT_AUDIT_FOR_THIS_PROJECT_SEGMENT',
    binding: {
      prompt: { path: plan.fingerprint.promptPath, sha256: plan.fingerprint.promptSha256 },
      package: { path: plan.fingerprint.packagePath, sha256: plan.fingerprint.packageSha256 },
      inputMediaSha256: [...plan.fingerprint.inputMedia.images, ...plan.fingerprint.inputMedia.videos, ...plan.fingerprint.inputMedia.audio].map(item => item.sha256),
      generationContract: plan.fingerprint.generationContract
    },
    limitations: { doesNotAuthorizePaidGeneration: true, doesNotAuthorizeNodeCreation: true, doesNotAuthorizeNodeRun: true, doesNotAuthorizeAutomaticRetry: true, mustIdentifyReviewerAsGpt: true }
  });
  await writeFile(join(root, 'reviews/gpt-brief.json'), '{}');
  await writeFile(join(root, 'reviews/gpt-report.md'), '# GPT PASS');
  const gptAuditId = 'gpt-fingerprint-pass';
  await writeJsonAtomic(join(root, `reviews/${gptAuditId}.json`), {
    id: gptAuditId, kind: 'gpt_external_audit_attestation', projectId: state.projectId,
    segmentId: 'segment-001', auditStage: 'pre_generation', model: 'gpt-fixture', cleanZeroContext: true,
    thirdParty: false, decision: 'PASS', preflightId: plan.preflightId, fingerprintSha256: plan.fingerprint.sha256,
    userExceptionId: exceptionId, auditBriefPath: 'reviews/gpt-brief.json',
    auditBriefSha256: await sha256File(join(root, 'reviews/gpt-brief.json')),
    reportPath: 'reviews/gpt-report.md', reportSha256: await sha256File(join(root, 'reviews/gpt-report.md'))
  });
  const authorization = {
    id: 'human-gpt-fallback-auth', kind: 'human_gpt_fallback_generation_authorization', actor: 'human', decision: 'approved',
    projectId: state.projectId, segmentId: 'segment-001', preflightId: plan.preflightId,
    fingerprintSha256: plan.fingerprint.sha256, independentAuditArtifactId: 'independent-audit-segment-001-v1',
    gptAuditExceptionId: exceptionId, gptFingerprintAuditId: gptAuditId,
    libtvProjectUuid: projectUuid, nodeName, maxPaidAttempts: 1, automaticPaidRetries: false,
    approvedAt: '2026-07-28T00:00:00Z'
  };
  await assert.rejects(createGptFallbackPaidGenerationApproval(root, {
    ...authorization, id: 'bad-auth', gptFingerprintAuditId: 'missing-audit'
  }), /ENOENT|GPT fingerprint audit/);
  const approval = await createGptFallbackPaidGenerationApproval(root, authorization, { id: 'paid-gpt-fallback' });
  assert.equal(approval.auditAuthorizationKind, 'human_gpt_fallback');
  assert.equal(approval.fingerprint.sha256, plan.fingerprint.sha256);
  assert.equal(approval.maxPaidAttempts, 1);
  assert.equal(approval.consumedByRunId, null);
  assert.equal((await readExecutionEvents(root)).at(-1).type, 'paid_approval.granted');
});

test('failure replay: paid approval ignores exFAT AppleDouble run metadata', async () => {
  const root = await readyVideoProject('approval-appledouble-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-appledouble' });
  await writeFile(join(root, 'runs', '._preflight-appledouble.json'), Buffer.from([0, 0, 0, 0]));
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'ignore AppleDouble metadata'
  ], { id: 'approval-appledouble' });
  assert.equal(approval.decision, 'approved');
});

test('failure replay: concurrent live calls share one submit owner and submit exactly once', async () => {
  const root = await readyVideoProject('approval-concurrent-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-concurrent' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'one submit only'
  ], { id: 'approval-concurrent' });
  let releaseFirst;
  let signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const barrier = new Promise(resolve => { releaseFirst = resolve; });
  let submits = 0;
  const successfulAdapter = label => ({
    upload: async path => `fake://${path}`,
    submitVideo: async () => {
      submits += 1;
      if (label === 'first') {
        const durable = JSON.parse(await readFile(join(root, 'runs/live-owner.json'), 'utf8'));
        assert.equal(durable.status, 'SUBMITTING');
        assert.equal(durable.taskId, null);
        signalEntered();
        await barrier;
      }
      return `task-${label}`;
    },
    waitForCompletion: async () => ({ status: 'SUCCESS', results: [{ url: 'fake://result' }] }),
    downloadResults: async (_result, destination) => {
      await mkdir(destination, { recursive: true });
      const path = join(destination, `${label}.mp4`);
      await writeFile(path, label);
      return [path];
    }
  });
  const first = runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { adapter: successfulAdapter('first'), runId: 'live-owner' });
  await entered;
  try {
    await assert.rejects(runGenerateVideoCommand([
      '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
    ], { adapter: successfulAdapter('second'), runId: 'live-contender' }), /submit.*owner|already.*claimed|SUBMITTING/i);
  } finally {
    releaseFirst();
  }
  await first;
  assert.equal(submits, 1);
});

test('failure replay: paid claim journal recovers a crash between run and approval writes without a second owner', async () => {
  const root = await readyVideoProject('paid-claim-journal-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-claim-journal' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'journal crash replay'
  ], { id: 'approval-claim-journal' });
  await assert.rejects(claimPaidGeneration(root, {
    segmentId: 'segment-001', approvalId: approval.id, runId: 'live-claim-journal',
    transactionOptions: { afterWrite: index => { if (index === 0) throw new Error('injected claim crash'); } }
  }), /injected claim crash/);
  await assert.rejects(claimPaidGeneration(root, {
    segmentId: 'segment-001', approvalId: approval.id, runId: 'live-second-owner'
  }), /submit owner|already.*claim/i);
  const recoveredApproval = JSON.parse(await readFile(join(root, `reviews/${approval.id}.json`), 'utf8'));
  assert.equal(recoveredApproval.consumedByRunId, 'live-claim-journal');
  assert.equal((await readExecutionEvents(root)).filter(event => event.type === 'generation.claimed').length, 1);
  await assert.rejects(readFile(join(root, 'runs/live-second-owner.json')), /ENOENT/);
});

test('failure replay: uncertain submit is never retried and human reconcile attaches the verified taskId', async () => {
  const root = await readyVideoProject('submit-uncertain-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-uncertain' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'uncertainty gate'
  ], { id: 'approval-uncertain' });
  let submits = 0;
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { runId: 'live-uncertain', adapter: {
    upload: async path => `fake://${path}`,
    submitVideo: async () => { submits += 1; throw new Error('connection lost after send'); }
  } }), /connection lost/);
  const uncertain = JSON.parse(await readFile(join(root, 'runs/live-uncertain.json'), 'utf8'));
  assert.equal(uncertain.status, 'SUBMITTING');
  assert.equal(uncertain.taskId, null);
  assert.equal(uncertain.submissionUncertain, true);
  assert.doesNotMatch(JSON.stringify(await readExecutionEvents(root)), /connection lost after send/);
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { adapter: { submitVideo: async () => { submits += 1; } } }), /reconcile|SUBMITTING/i);
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--resume', 'live-uncertain'
  ], { adapter: { waitForCompletion: async () => assert.fail('must not poll an unknown task') } }), /reconcile|submitted.*taskId/i);
  for (const invalidTaskId of ['   ', 'task/unsafe']) {
    await assert.rejects(runReconcileVideoSubmit([
      '--project', root, '--run', 'live-uncertain', '--task-id', invalidTaskId, '--note', 'must reject invalid token'
    ]), /taskId|task-id|safe.*token|non-empty/i);
    const unchanged = JSON.parse(await readFile(join(root, 'runs/live-uncertain.json'), 'utf8'));
    assert.equal(unchanged.status, 'SUBMITTING');
    assert.equal(unchanged.taskId, null);
  }
  await runReconcileVideoSubmit([
    '--project', root, '--run', 'live-uncertain', '--task-id', '  task-human-verified  ', '--note', 'verified in RunningHub console'
  ]);
  const resumed = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--resume', 'live-uncertain'
  ], { adapter: {
    waitForCompletion: async taskId => {
      assert.equal(taskId, 'task-human-verified');
      return { status: 'SUCCESS', results: [{ url: 'fake://result' }] };
    },
    downloadResults: async (_result, destination) => {
      await mkdir(destination, { recursive: true });
      const path = join(destination, 'reconciled.mp4');
      await writeFile(path, 'reconciled');
      return [path];
    }
  } });
  assert.equal(resumed.taskId, 'task-human-verified');
  assert.equal(submits, 1);
});

test('failure replay: explicit RunningHub FAILED is terminal while timeout remains resumable', async () => {
  const root = await readyVideoProject('platform-failed-terminal-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-platform-failed' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'platform failure classification'
  ], { id: 'approval-platform-failed' });
  const platformFailure = Object.assign(new Error('RunningHub task FAILED'), { kind: 'failed' });
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { runId: 'live-platform-failed', adapter: {
    upload: async path => `fake://${path}`,
    submitVideo: async () => 'task-platform-failed',
    waitForCompletion: async () => { throw platformFailure; }
  } }), error => error === platformFailure);
  const failed = JSON.parse(await readFile(join(root, 'runs/live-platform-failed.json'), 'utf8'));
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorKind, 'failed');
  assert.equal(failed.failurePhase, 'poll');
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--resume', 'live-platform-failed'
  ], { adapter: { waitForCompletion: async () => assert.fail('terminal FAILED must not poll') } }), /SUBMITTED|INTERRUPTED|terminal/i);
});

test('failure replay: a new paid approval is blocked until human confirms the uncertain run was not submitted', async () => {
  const root = await readyVideoProject('submit-not-submitted-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-not-submitted' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'first approval'
  ], { id: 'approval-not-submitted-first' });
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { runId: 'live-not-submitted', adapter: {
    upload: async path => `fake://${path}`,
    submitVideo: async () => { throw new Error('unknown submit outcome'); }
  } }), /unknown submit outcome/);
  await assert.rejects(runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'unsafe retry'
  ], { id: 'approval-not-submitted-blocked' }), /reconcile|uncertain|SUBMITTING/i);
  await runReconcileVideoSubmit([
    '--project', root, '--run', 'live-not-submitted', '--confirmed-not-submitted', '--note', 'verified no task exists in RunningHub'
  ]);
  const replacement = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'safe retry after verification'
  ], { id: 'approval-not-submitted-replacement' });
  assert.equal(replacement.decision, 'approved');
});

test('failure replay: resume refuses terminal generation runs', async () => {
  const root = await readyVideoProject('resume-terminal-e2e-');
  const preflight = await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ], { runId: 'preflight-terminal' });
  const approval = await runApprovePaidGeneration([
    '--project', root, '--segment', 'segment-001', '--preflight', preflight.preflightId, '--note', 'terminal resume gate'
  ], { id: 'approval-terminal' });
  await runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--live', '--paid-approval', approval.id
  ], { runId: 'live-terminal', adapter: {
    upload: async path => `fake://${path}`,
    submitVideo: async () => 'task-terminal',
    waitForCompletion: async () => ({ status: 'SUCCESS', results: [{ url: 'fake://result' }] }),
    downloadResults: async (_result, destination) => {
      await mkdir(destination, { recursive: true });
      const path = join(destination, 'terminal.mp4');
      await writeFile(path, 'terminal');
      return [path];
    }
  } });
  await assert.rejects(runGenerateVideoCommand([
    '--project', root, '--segment', 'segment-001', '--resume', 'live-terminal'
  ], { adapter: { waitForCompletion: async () => assert.fail('terminal run must not poll') } }), /SUBMITTED|INTERRUPTED|terminal/i);
});

test('failure replay: an unapproved video cannot produce handoff evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unapproved-handoff-'));
  await initializeProject(root, { projectId: 'HANDOFF-FAIL' });
  await mkdir(join(root, 'outputs/segment-001'), { recursive: true });
  await writeFile(join(root, 'outputs/segment-001/video.mp4'), 'video');
  const state = await getProjectStatus(root);
  state.artifacts.push({
    id: 'video', type: 'video_segment', revision: 1, segmentId: 'segment-001', status: 'awaiting_review',
    path: 'outputs/segment-001/video.mp4', sha256: sha
  });
  delete state.pendingHumanGate;
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await assert.rejects(runPrepareHandoff(['--project', root, '--artifact', 'video'], { runner: async () => assert.fail('must not run') }), /locked by human review/);
});

test('failure replay: candidate rule cannot become hard without verified repair review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-rule-e2e-'));
  await createCandidateRule(root, {
    id: 'rule-candidate', trigger: {
      product: ['shapewear'], assetType: ['storyboard'], shotType: ['close_up'], motionType: ['pull'],
      peopleCountRange: { min: 1, max: 1 }, spaceComplexity: ['simple']
    }, symptom: 'product deformed', evidence: ['run-001@3s'], reason: 'reference conflict',
    correction: 'separate product responsibility', forbidden: ['storyboard controls product'],
    sourceProject: 'PILOT', sourceSegment: 'segment-001'
  });
  await assert.rejects(verifyRule(root, 'rule-candidate', 'missing-review'), /ENOENT/);
});

test('operator contract exposes exact e2e verification scripts and runnable gates', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(packageJson.scripts['test:e2e'], 'node --test tests/e2e/*.test.js');
  assert.equal(packageJson.scripts.verify, 'node --check src/cli.js && node --env-file=.env.test --test');
  const runbook = await readFile('docs/operator-runbook.md', 'utf8');
  for (const required of [
    'register-artifact', 'segments', 'generate-assets', '--dry-run', '--live',
    'compile-seedance', 'generate-video', 'approve-paid-generation', '--paid-approval', '--resume',
    'reconcile-video-submit', '--confirmed-not-submitted', 'SUBMITTING', 'approve', 'prepare-handoff',
    'review-handoff', 'record-handoff', 'reconcile-libtv-run', 'verify-delivery',
    'rules list', 'status', '9:16', 'LibTV', 'RunningHub'
  ]) assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('failure replay: LibTV live refuses to regenerate a manifest with no pending targets', async () => {
  let calls = 0;
  await assert.rejects(runGenerateAssets([
    '--project', 'tests/fixtures/project-ready', '--segment', 'segment-001', '--live'
  ], { runner: async () => { calls += 1; return { code: 0, stdout: '{}', stderr: '' }; } }), /no pending segment assets/);
  assert.equal(calls, 0);
});

async function libtvReadyProject() {
  const root = await mkdtemp(join(tmpdir(), 'libtv-validate-e2e-'));
  await initializeProject(root, { projectId: 'LIBTV-VALIDATE' });
  await mkdir(join(root, 'assets/project'), { recursive: true });
  await writeFile(join(root, 'assets/project/source.png'), 'approved source');
  await writeFile(join(root, 'prompts/target.txt'), 'target responsibility only');
  await registerArtifact(root, {
    id: 'source', type: 'project_asset', assetType: 'character_board', characterId: 'character-a', visualContractVersion: 1, visualAuditId: 'visual-audit-source', revision: 1,
    status: 'draft', path: 'assets/project/source.png'
  });
  await submitForReview(root, 'source');
  await approveArtifact(root, 'source', 'source approved');
  const state = await getProjectStatus(root);
  const source = state.artifacts.find(({ id }) => id === 'source');
  await writeJsonAtomic(join(root, 'assets/segment-001-asset-manifest.json'), {
    id: 'manifest-validate', segmentId: 'segment-001', status: 'awaiting_review',
    items: [
      { id: 'source', type: 'character_board', scope: 'project', status: 'locked', revision: 1,
        path: source.path, sha256: source.sha256, lockedByReviewId: source.lockedByReviewId,
        responsibility: 'identity only', mustNotControl: ['camera'] },
      { id: 'target', type: 'camera_blocking', scope: 'segment', status: 'awaiting_review',
        responsibility: 'camera paths only', mustNotControl: ['identity'] }
    ]
  });
  return root;
}

test('failure replay: LibTV live rejects a forged manifest review binding', async () => {
  const root = await libtvReadyProject();
  const path = join(root, 'assets/segment-001-asset-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeJsonAtomic(path, { ...manifest, status: 'locked', lockedByReviewId: 'missing-review' });
  let calls = 0;
  await assert.rejects(runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], { runner: async () => { calls += 1; } }), /manifest review evidence|review.*match/);
  assert.equal(calls, 0);
});

test('failure replay: asset manifest review journal rolls forward after each cross-file crash', async () => {
  for (const crashIndex of [0, 1]) {
    const root = await libtvReadyProject();
    await assert.rejects(runReviewAssetManifest([
      '--project', root, '--segment', 'segment-001', '--note', 'review with injected crash'
    ], { transactionOptions: { afterWrite: index => { if (index === crashIndex) throw new Error(`manifest-crash-${crashIndex}`); } } }),
    new RegExp(`manifest-crash-${crashIndex}`));
    const review = await runReviewAssetManifest([
      '--project', root, '--segment', 'segment-001', '--note', 'recover prior decision'
    ]);
    const manifest = JSON.parse(await readFile(join(root, 'assets/segment-001-asset-manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'locked');
    assert.equal(manifest.lockedByReviewId, review.id);
    assert.equal(await sha256File(join(root, 'assets/segment-001-asset-manifest.json')), review.manifestSha256);
  }
});

test('failure replay: LibTV live rejects a source changed after manifest approval', async () => {
  const root = await libtvReadyProject();
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'requirements approved'
  ]);
  await writeFile(join(root, 'assets/project/source.png'), 'tampered source');
  let calls = 0;
  await assert.rejects(runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], { runner: async () => { calls += 1; } }), /checksum/);
  assert.equal(calls, 0);
});

test('failure replay: LibTV live rejects a prompt changed after manifest approval', async () => {
  const root = await libtvReadyProject();
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'requirements approved'
  ]);
  await writeFile(join(root, 'prompts/target.txt'), 'tampered prompt');
  let calls = 0;
  await assert.rejects(runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], { runner: async () => { calls += 1; } }), /prompt checksum/);
  assert.equal(calls, 0);
});

test('failure replay: concurrent LibTV live calls have one owner and one remote create', async () => {
  const root = await libtvReadyProject();
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'requirements approved for one owner'
  ]);
  let creates = 0;
  const runner = async (_executable, args) => {
    if (args[0] === 'upload') await new Promise(resolve => setTimeout(resolve, 20));
    if (args[0] === 'node' && args.includes('create')) creates += 1;
    if (args[0] === 'download') {
      const directory = args[args.indexOf('--out') + 1];
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'result.png'), 'single owner result');
    }
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const outcomes = await Promise.allSettled([
    runGenerateAssets(['--project', root, '--segment', 'segment-001', '--live'], { runner, runId: 'libtv-owner-a' }),
    runGenerateAssets(['--project', root, '--segment', 'segment-001', '--live'], { runner, runId: 'libtv-owner-b' })
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
  const rejection = outcomes.find(({ status }) => status === 'rejected');
  assert.match(rejection.reason.message, /LibTV.*owner|already.*active|fingerprint/i);
  const completed = outcomes.find(({ status }) => status === 'fulfilled').value;
  assert.equal(creates, 1);
  assert.equal(completed.outputs.length, 1);
  assert.match(completed.outputs[0].path, /^outputs\/target\.png$/);
});

test('failure replay: LibTV failure evidence and thrown errors never retain stderr secrets or URLs', async () => {
  const root = await libtvReadyProject();
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'requirements approved for redaction replay'
  ]);
  const secret = 'super-secret-token';
  await assert.rejects(runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], {
    runId: 'libtv-secret-failure',
    runner: async () => ({ code: 9, stdout: '', stderr: `Bearer ${secret} https://private.example/path` })
  }), error => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(error.message, /https?:\/\//);
    return true;
  });
  const run = JSON.parse(await readFile(join(root, 'runs/libtv-secret-failure.json'), 'utf8'));
  assert.equal(run.status, 'UNCERTAIN');
  assert.doesNotMatch(JSON.stringify(run), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(run), /https?:\/\//);
  const reconciled = await runReconcileLibTvRun([
    '--project', root, '--run', run.id, '--confirmed-no-side-effects',
    '--note', 'human verified the CLI failed before any remote side effect'
  ]);
  assert.equal(reconciled.status, 'RECONCILED_NOT_RUN');
  const retried = await runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], {
    runId: 'libtv-after-reconcile',
    runner: async (_executable, args) => {
      if (args[0] === 'download') {
        const directory = args[args.indexOf('--out') + 1];
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'result.png'), 'verified retry result');
      }
      return { code: 0, stdout: '{}', stderr: '' };
    }
  });
  assert.equal(retried.outputs.length, 1);
});

test('failure replay: a crash after LibTV ownership claim blocks replay until human reconciliation', async () => {
  const root = await libtvReadyProject();
  await runReviewAssetManifest([
    '--project', root, '--segment', 'segment-001', '--note', 'requirements approved for crash replay'
  ]);
  let calls = 0;
  await assert.rejects(runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], {
    runId: 'libtv-claimed-crash',
    runner: async () => { calls += 1; return { code: 0, stdout: '{}', stderr: '' }; },
    afterClaim: () => { throw new Error('injected process crash'); }
  }), /injected process crash/);
  assert.equal(calls, 0);
  await assert.rejects(runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--live'
  ], { runId: 'libtv-forbidden-replay', runner: async () => { calls += 1; } }), /active or uncertain owner/);
  assert.equal(calls, 0);
  const reconciled = await runReconcileLibTvRun([
    '--project', root, '--run', 'libtv-claimed-crash', '--confirmed-no-side-effects',
    '--note', 'human confirmed no LibTV command started before the crash'
  ]);
  assert.equal(reconciled.status, 'RECONCILED_NOT_RUN');
});

test('failure replay: LibTV dry-run rejects an escaping prompt id before reading outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libtv-dryrun-containment-'));
  await initializeProject(root, { projectId: 'LIBTV-DRYRUN-CONTAINMENT' });
  const outside = join(root, '..', 'outside-secret.txt');
  await writeFile(outside, 'must never be read');
  const manifestPath = join(root, 'assets/segment-001-asset-manifest.json');
  const manifest = {
    id: 'manifest-dryrun-containment', segmentId: 'segment-001', status: 'locked',
    lockedByReviewId: 'review-dryrun-containment',
    items: [{ id: '../../outside-secret', type: 'storyboard', scope: 'segment', status: 'awaiting_review',
      responsibility: 'framing only', mustNotControl: ['identity'] }]
  };
  await writeJsonAtomic(manifestPath, manifest);
  await writeJsonAtomic(join(root, 'reviews/review-dryrun-containment.json'), {
    id: 'review-dryrun-containment', artifactId: manifest.id, artifactKind: 'asset_manifest',
    segmentId: 'segment-001', actor: 'human', decision: 'approved',
    manifestSha256: await sha256File(manifestPath), promptSha256: {}
  });
  await assert.rejects(runGenerateAssets([
    '--project', root, '--segment', 'segment-001', '--dry-run'
  ]), /unsafe.*asset id|safe CLI identifier/i);
});
