import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { executeExternalAudit } from '../../src/services/external-audit-execution-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';

const sha = 'a'.repeat(64);
const model = 'claude-ocx-anthropic--claude-opus-4-8';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'audit-exec-'));
  await mkdir(join(root, 'reviews'), { recursive: true }); await mkdir(join(root, 'runs'), { recursive: true });
  await writeFile(join(root, 'reviews', 'brief.md'), JSON.stringify({ mandatoryCoverage: ['assets'] }));
  await writeJsonAtomic(join(root, 'reviews', 'batch-1.json'), {
    id: 'batch-1', kind: 'batch_generation_approval', actor: 'human', decision: 'approved', projectId: 'p1', executor: 'libtv', libtvProjectUuid: 'a'.repeat(32), externalAuditModel: model,
    segments: [{ segmentId: 'segment-001', strategy: 'editorial_cut', maxPaidAttempts: 1 }],
    budget: { unit: 'tasks', limit: 1 }, externalAuditBudget: { unit: 'USD', perCallLimit: 0.4, totalLimit: 0.8 }, maxPaidSubmissions: 1, stopVetoes: ['blur'], approvedAt: '2026-07-26T00:00:00Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'preflight-1.json'), {
    id: 'preflight-1', kind: 'video_preflight', status: 'READY', segmentId: 'segment-001', fingerprint: { sha256: sha }
  });
  return root;
}

test('claims a unique session before the model call and persists PASS attestation', async () => {
  const root = await fixture();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const adapter = { audit: async ({ sessionId: actual }) => {
    const claimed = await readJson(join(root, 'runs', 'audit-run-1.json'));
    assert.equal(claimed.status, 'SUBMITTING');
    assert.equal(actual, sessionId);
    return { sessionId, model, cleanZeroContext: true, report: { decision: 'PASS', summary: 'ok', coverage: [{ category: 'assets', status: 'PASS', evidence: 'checked' }], findings: [] }, usage: { input_tokens: 10 }, costUsd: 0.02 };
  } };
  const result = await executeExternalAudit(root, {
    batchApprovalId: 'batch-1', segmentId: 'segment-001', auditStage: 'pre_generation', preflightId: 'preflight-1',
    promptPath: 'reviews/brief.md', model, maxBudgetUsd: 0.4
  }, { adapter, runId: 'audit-run-1', sessionId });
  assert.equal(result.run.status, 'SUCCESS');
  assert.equal(result.attestation.decision, 'PASS');
  assert.equal(result.attestation.providerTaskId, sessionId);
});

test('an interrupted audit becomes uncertain and blocks another paid model call', async () => {
  const root = await fixture();
  const input = {
    batchApprovalId: 'batch-1', segmentId: 'segment-001', auditStage: 'pre_generation', preflightId: 'preflight-1',
    promptPath: 'reviews/brief.md', model, maxBudgetUsd: 0.4
  };
  await assert.rejects(executeExternalAudit(root, input, {
    adapter: { audit: async () => { throw new Error('connection lost'); } }, runId: 'audit-run-1', sessionId: '11111111-1111-4111-8111-111111111111'
  }), /connection lost/);
  assert.equal((await readJson(join(root, 'runs', 'audit-run-1.json'))).status, 'UNCERTAIN');
  await assert.rejects(executeExternalAudit(root, input, {
    adapter: { audit: async () => assert.fail('must not retry') }, runId: 'audit-run-2', sessionId: '22222222-2222-4222-8222-222222222222'
  }), /uncertain/);
});

test('a strict post-generation FAIL automatically records the latest output root cause', async () => {
  const root = await fixture();
  await writeFile(join(root, 'reviews', 'post-brief.json'), JSON.stringify({ manualExternalChecksRequired: ['weaving_causality'] }));
  await mkdir(join(root, 'outputs'));
  await writeFile(join(root, 'outputs', 'take.mp4'), 'generated-take');
  const outputSha256 = await sha256File(join(root, 'outputs', 'take.mp4'));
  const control = {
    version: 1, plannedShotCount: 1, generatedUnitShotCount: 1,
    executionUnitStrategy: 'single_take', requiresIndependentShotControl: false,
    platformCapability: {
      surface: 'LibTV node', profileId: 'seedance-2-libtv-v1', parameter: 'multi_shots',
      exposed: false, enabled: false, evidence: 'not required for single take'
    }
  };
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'p1', workflowVersion: 2, videoGovernanceVersion: 2,
    phase: 'gate5_review', activeSegmentId: 'segment-001', blockedReason: null,
    artifacts: [], updatedAt: '2026-08-24T00:00:00.000Z'
  });
  await writeJsonAtomic(join(root, 'reviews', 'remake-v2-generation-policy.json'), {
    kind: 'project_generation_policy', decision: 'approved', projectId: 'p1',
    qualityFailurePolicy: { maxFailedGeneratedOutputs: 4 }
  });
  await writeJsonAtomic(join(root, 'runs', 'video-run-post.json'), {
    id: 'video-run-post', kind: 'libtv_video', status: 'SUCCESS', segmentId: 'segment-001',
    fingerprint: { executionControlContract: control },
    outputs: [{ id: 'take-output', path: 'outputs/take.mp4', sha256: outputSha256 }]
  });
  const sessionId = '33333333-3333-4333-8333-333333333333';
  await executeExternalAudit(root, {
    batchApprovalId: 'batch-1', segmentId: 'segment-001', auditStage: 'post_generation', videoRunId: 'video-run-post',
    promptPath: 'reviews/post-brief.json', model, maxBudgetUsd: 0.4
  }, {
    runId: 'audit-run-post', sessionId,
    adapter: { audit: async () => ({
      sessionId, model, cleanZeroContext: true,
      report: {
        decision: 'FAIL', summary: '编织线与产品未完成边界无连续接触',
        coverage: [{ category: 'weaving_causality', status: 'FAIL', evidence: '00:04.2' }],
        findings: [{ id: 'weave-overlay', timestampsOrRegions: ['00:04.2'], evidence: ['线条只贴在完成品上'] }]
      },
      usage: { input_tokens: 10 }, costUsd: 0.02
    }) }
  });
  const ledger = await readJson(join(root, 'runs', 'generation-failure-ledger.json'));
  assert.equal(ledger.events[0].outputId, 'take-output');
  assert.equal(ledger.events[0].failureType, 'third_party_video_audit_fail');
  assert.equal(ledger.events[0].rootCauseKey, 'POST_GENERATION_EXTERNAL_AUDIT_FAIL');
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.observations.derivation.bySourceType.generation_failure, 1);
  assert.equal(status.observations.failures.byCategory.other, 1);
});
