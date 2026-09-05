import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendExecutionSpan,
  completeExecutionTrace,
  createExecutionTrace
} from '../../src/domain/execution-trace.js';
import {
  deriveExecutionObservation,
  planExecutionObservationDerivation
} from '../../src/services/execution-observation-derivation-service.js';
import { readExecutionEvents, readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';
import { initializeProject } from '../../src/services/project-service.js';
import { recordExecutionTrace } from '../../src/services/execution-trace-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';

async function fixture(projectId = 'DERIVATION-TEST') {
  const root = await mkdtemp(join(tmpdir(), 'execution-observation-derivation-'));
  await initializeProject(root, { projectId });
  return root;
}

function authoritativeTrace(projectId, authority = {
  schemaVersion: 1,
  basis: 'leaf_spans',
  scope: 'generation_attempt',
  stage: 'generation',
  segmentId: 'segment-001',
  fields: ['machineExecutionMs', 'externalQueueMs', 'humanWaitMs']
}) {
  let trace = createExecutionTrace({
    id: 'trace-authoritative-001',
    projectId,
    startedAt: '2026-08-24T10:00:00.000Z',
    metadata: { authoritativeObservation: authority }
  });
  trace = appendExecutionSpan(trace, {
    id: 'project-root', kind: 'project', name: 'Project', parentSpanId: null,
    startedAt: '2026-08-24T10:00:00.000Z', endedAt: '2026-08-24T10:00:03.000Z'
  });
  trace = appendExecutionSpan(trace, {
    id: 'machine-task', kind: 'task', name: 'Compile', parentSpanId: 'project-root',
    startedAt: '2026-08-24T10:00:00.000Z', endedAt: '2026-08-24T10:00:01.000Z',
    activeComputeMs: 650, humanWaitMs: 100
  });
  trace = appendExecutionSpan(trace, {
    id: 'external-call', kind: 'external_call', name: 'Queue', parentSpanId: 'project-root',
    startedAt: '2026-08-24T10:00:01.000Z', endedAt: '2026-08-24T10:00:03.000Z',
    queueMs: 1400, activeComputeMs: 500, humanWaitMs: 50
  });
  return completeExecutionTrace(trace, {
    endedAt: '2026-08-24T10:00:03.000Z', status: 'succeeded'
  });
}

test('authoritative trace derivation is dry-run safe, leaf-based, atomic and idempotent', async () => {
  const root = await fixture();
  const trace = authoritativeTrace('DERIVATION-TEST');
  assert.equal((await recordExecutionTrace(root, trace)).recorded, true);
  const request = {
    schemaVersion: 1, kind: 'execution_observation_derivation',
    sourceType: 'execution_trace_timing', traceId: trace.id
  };

  const preview = await planExecutionObservationDerivation(root, request);
  assert.equal(preview.status, 'READY');
  assert.deepEqual(preview.observation.timing, {
    machineExecutionMs: 650,
    externalQueueMs: 1400,
    humanWaitMs: 150
  });
  await assert.rejects(access(join(root, 'ledger', 'head.json')), /ENOENT/);
  await assert.rejects(access(join(root, preview.evidencePath)), /ENOENT/);

  const first = await deriveExecutionObservation(root, request);
  assert.equal(first.reused, false);
  assert.equal(first.event.schemaVersion, 2);
  assert.equal((await readJson(join(root, first.evidencePath))).observation.subjectId, trace.id);
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.consistency, 'consistent');
  assert.equal(status.observations.derivation.automaticEventCount, 1);
  assert.equal(status.observations.derivation.bySourceType.execution_trace_timing, 1);
  assert.equal(status.observations.timing.machineExecutionMs.totalMs, 650);
  assert.equal(status.observations.timing.externalQueueMs.totalMs, 1400);
  assert.equal(status.observations.timing.humanWaitMs.totalMs, 150);

  const eventCount = (await readExecutionEvents(root)).length;
  const second = await deriveExecutionObservation(root, request);
  assert.equal(second.reused, true);
  assert.equal((await readExecutionEvents(root)).length, eventCount);
});

test('trace derivation rejects uninstrumented zeros and a changed source before writing', async () => {
  const root = await fixture('DERIVATION-TRACE-REJECT');
  const withoutCoverage = authoritativeTrace('DERIVATION-TRACE-REJECT', undefined);
  withoutCoverage.metadata = {};
  assert.equal((await recordExecutionTrace(root, withoutCoverage)).recorded, true);
  const request = {
    schemaVersion: 1, kind: 'execution_observation_derivation',
    sourceType: 'execution_trace_timing', traceId: withoutCoverage.id
  };
  await assert.rejects(planExecutionObservationDerivation(root, request), /authoritativeObservation/);
  await assert.rejects(access(join(root, 'ledger', 'head.json')), /ENOENT/);
});

test('declared trace spans provide complete coverage without counting diagnostic children twice', async () => {
  const root = await fixture('DERIVATION-DECLARED-SPANS');
  const authority = {
    schemaVersion: 1,
    basis: 'declared_spans',
    spanIds: ['machine-task'],
    scope: 'project',
    stage: 'intake',
    segmentId: null,
    fields: ['machineExecutionMs', 'humanWaitMs']
  };
  const trace = authoritativeTrace('DERIVATION-DECLARED-SPANS', authority);
  assert.equal((await recordExecutionTrace(root, trace)).recorded, true);
  const preview = await planExecutionObservationDerivation(root, {
    schemaVersion: 1, kind: 'execution_observation_derivation',
    sourceType: 'execution_trace_timing', traceId: trace.id
  });
  assert.deepEqual(preview.observation.timing, { machineExecutionMs: 650, humanWaitMs: 100 });

  const overlapRoot = await fixture('DERIVATION-DECLARED-OVERLAP');
  const overlap = authoritativeTrace('DERIVATION-DECLARED-OVERLAP', {
    ...authority,
    spanIds: ['project-root', 'machine-task']
  });
  assert.equal((await recordExecutionTrace(overlapRoot, overlap)).recorded, true);
  await assert.rejects(planExecutionObservationDerivation(overlapRoot, {
    schemaVersion: 1, kind: 'execution_observation_derivation',
    sourceType: 'execution_trace_timing', traceId: overlap.id
  }), /ancestor overlaps/);
});

test('video audit package derives generated output duration only when both report and video SHA match', async () => {
  const root = await fixture('DERIVATION-VIDEO-AUDIT');
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'outputs', 'segment.mp4'), 'video-content');
  const videoSha256 = await sha256File(join(root, 'outputs', 'segment.mp4'));
  const reportPath = 'reviews/video-audits/audit-001/report.json';
  await writeJsonAtomic(join(root, reportPath), {
    id: 'audit-001', kind: 'video_audit_package', segmentId: 'segment-001', videoRunId: 'run-001',
    videoPath: 'outputs/segment.mp4', videoSha256,
    metadata: { duration: 12.345 }, machineDecision: 'PASS',
    createdAt: '2026-08-24T11:00:00.000Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'run-001.json'), {
    id: 'run-001', status: 'SUCCESS', segmentId: 'segment-001',
    outputs: [{ path: 'outputs/segment.mp4', sha256: videoSha256 }],
    auditPackage: {
      id: 'audit-001', reportPath, reportSha256: await sha256File(join(root, reportPath))
    }
  });
  const request = {
    schemaVersion: 1, kind: 'execution_observation_derivation',
    sourceType: 'video_audit_media', reportPath
  };
  const result = await deriveExecutionObservation(root, request);
  assert.deepEqual(result.observation.media, { kind: 'generated_output', durationMs: 12345 });
  assert.equal((await readExecutionLedgerStatus(root)).observations.media.byKind.generated_output.totalDurationMs, 12345);

  const changedReport = { ...(await readJson(join(root, reportPath))), metadata: { duration: 13 } };
  await writeJsonAtomic(join(root, reportPath), changedReport);
  await assert.rejects(planExecutionObservationDerivation(root, request), /does not bind the exact video audit report SHA/);
  const run = await readJson(join(root, 'runs', 'run-001.json'));
  await writeJsonAtomic(join(root, 'runs', 'run-001.json'), {
    ...run,
    auditPackage: { ...run.auditPackage, reportSha256: await sha256File(join(root, reportPath)) }
  });
  await writeFile(join(root, 'outputs', 'segment.mp4'), 'changed-video');
  await assert.rejects(planExecutionObservationDerivation(root, request), /checksum changed/);
});

test('final delivery derivation probes locally, writes probe and ledger together, and remains idempotent', async () => {
  const root = await fixture('DERIVATION-FINAL');
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'outputs', 'final.mp4'), 'final-video');
  const sha256 = await sha256File(join(root, 'outputs', 'final.mp4'));
  await writeJsonAtomic(join(root, 'deliveries', 'final-delivery-receipt.json'), {
    schemaVersion: 1, id: 'final-delivery-001', kind: 'final_delivery_receipt', status: 'COMPLETE',
    projectId: 'DERIVATION-FINAL', deliveryFingerprint: 'fingerprint',
    deliverable: [{ segmentId: 'segment-001', videoArtifactId: 'video-final-001', path: 'outputs/final.mp4', sha256 }],
    finalEdit: null, retrospectiveId: 'retro-001', retrospectivePath: 'reviews/retro-001.json',
    completedAt: '2026-08-24T12:00:00.000Z'
  });
  const runner = async () => ({
    code: 0,
    stdout: JSON.stringify({ streams: [{ codec_type: 'video', duration: '30.250' }], format: {} }),
    stderr: ''
  });
  const request = {
    schemaVersion: 1, kind: 'execution_observation_derivation', sourceType: 'final_delivery_media'
  };
  const preview = await planExecutionObservationDerivation(root, request, { runner });
  assert.deepEqual(preview.observation.media, { kind: 'final_delivery', durationMs: 30250 });
  await assert.rejects(access(join(root, preview.sourceReferences[0].path)), /ENOENT/);

  const first = await deriveExecutionObservation(root, request, { runner });
  assert.equal(first.reused, false);
  const probe = await readJson(join(root, first.sourceReferences[0].path));
  assert.equal(probe.media.durationMs, 30250);
  assert.equal((await readExecutionLedgerStatus(root)).observations.media.byKind.final_delivery.totalDurationMs, 30250);
  assert.equal((await deriveExecutionObservation(root, request, { runner })).reused, true);
});

test('final delivery source mutation after ffprobe is rejected before any ledger write', async () => {
  const root = await fixture('DERIVATION-FINAL-RACE');
  await mkdir(join(root, 'outputs'), { recursive: true });
  const videoPath = join(root, 'outputs', 'final.mp4');
  await writeFile(videoPath, 'final-video');
  const sha256 = await sha256File(videoPath);
  await writeJsonAtomic(join(root, 'deliveries', 'final-delivery-receipt.json'), {
    schemaVersion: 1, id: 'final-delivery-race', kind: 'final_delivery_receipt', status: 'COMPLETE',
    projectId: 'DERIVATION-FINAL-RACE', deliveryFingerprint: 'fingerprint',
    deliverable: [{ segmentId: 'segment-001', videoArtifactId: 'video-final-race', path: 'outputs/final.mp4', sha256 }],
    finalEdit: null, retrospectiveId: 'retro-001', retrospectivePath: 'reviews/retro-001.json',
    completedAt: '2026-08-24T12:30:00.000Z'
  });
  const runner = async () => {
    await writeFile(videoPath, 'mutated-after-probe');
    return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: '30' } }), stderr: '' };
  };
  await assert.rejects(deriveExecutionObservation(root, {
    schemaVersion: 1, kind: 'execution_observation_derivation', sourceType: 'final_delivery_media'
  }, { runner }), /derivation source changed before commit/);
  await assert.rejects(access(join(root, 'ledger', 'head.json')), /ENOENT/);
});

test('external audit cost derives only from the exact approved receipt classification', async () => {
  const root = await fixture('DERIVATION-AUDIT-COST');
  const approvalPath = join(root, 'reviews', 'audit-approval-001.json');
  await writeJsonAtomic(approvalPath, {
    id: 'audit-approval-001', kind: 'external_audit_only_approval', decision: 'approved',
    projectId: 'DERIVATION-AUDIT-COST', segmentId: 'segment-001',
    budget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.4 },
    executionPolicy: { costEvidenceRequired: 'actual_billed_usd' }
  });
  const providerReportPath = join(root, 'reviews', 'external-audits', 'audit-cost-run.json');
  await writeJsonAtomic(providerReportPath, { decision: 'PASS' });
  const runPath = join(root, 'runs', 'audit-cost-run.json');
  const baseRun = {
    id: 'audit-cost-run', kind: 'independent_external_model_audit', status: 'SUCCESS',
    projectId: 'DERIVATION-AUDIT-COST', segmentId: 'segment-001', approvalId: 'audit-approval-001',
    budget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.4 }, costUsd: 0.03,
    providerReportPath: 'reviews/external-audits/audit-cost-run.json',
    providerReportSha256: await sha256File(providerReportPath),
    updatedAt: '2026-08-24T13:00:00.000Z'
  };
  await writeJsonAtomic(runPath, {
    ...baseRun,
    costEvidence: {
      classification: 'api_list_price_equivalent', actualBilledUsd: null,
      amountUsd: 0.03, source: 'estimate'
    }
  });
  const request = {
    schemaVersion: 1, kind: 'execution_observation_derivation',
    sourceType: 'external_audit_cost', runId: baseRun.id
  };
  await assert.rejects(planExecutionObservationDerivation(root, request), /actual billed USD evidence/);
  await assert.rejects(access(join(root, 'ledger', 'head.json')), /ENOENT/);

  await writeJsonAtomic(runPath, {
    ...baseRun,
    costEvidence: {
      classification: 'actual_billed_usd', actualBilledUsd: 0.03,
      amountUsd: 0.03, source: 'provider-receipt'
    }
  });
  const result = await deriveExecutionObservation(root, request);
  assert.deepEqual(result.observation.cost, {
    amount: 0.03, unit: 'USD', evidenceLevel: 'actual_billed', purpose: 'external_audit'
  });
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.observations.derivation.bySourceType.external_audit_cost, 1);
  assert.equal(status.observations.cost.byUnit.USD.actual.amount, 0.03);
});
