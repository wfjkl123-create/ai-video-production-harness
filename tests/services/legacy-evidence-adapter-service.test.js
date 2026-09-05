import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import { executionLedgerHeadPath } from '../../src/services/execution-ledger-service.js';
import {
  adaptLegacyProjectEvidence,
  readLegacyEvidencePortfolio,
  renderLegacyEvidencePortfolioMarkdown
} from '../../src/services/legacy-evidence-adapter-service.js';

async function legacyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'legacy-evidence-adapter-'));
  await initializeProject(root, { projectId: 'LEGACY-EVIDENCE' });
  const state = await readJson(join(root, 'project-state.json'));
  state.updatedAt = '2026-08-20T00:00:00.000Z';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await writeFile(join(root, 'outputs', 'video.mp4'), 'legacy-video-bytes');
  const videoSha256 = await sha256File(join(root, 'outputs', 'video.mp4'));
  const reportPath = 'reviews/video-audits/audit-001/report.json';
  await writeJsonAtomic(join(root, reportPath), {
    id: 'audit-001', kind: 'video_audit_package', segmentId: 'segment-001', videoRunId: 'run-001',
    videoPath: 'outputs/video.mp4', videoSha256, machineDecision: 'PASS', createdAt: '2026-08-20T01:00:00.000Z'
  });
  const reportSha256 = await sha256File(join(root, reportPath));
  const fingerprintSha256 = 'a'.repeat(64);
  await writeJsonAtomic(join(root, 'runs', 'preflight-001.json'), {
    id: 'preflight-001', kind: 'video_preflight', status: 'READY', segmentId: 'segment-001',
    fingerprint: { sha256: fingerprintSha256 }
  });
  await writeJsonAtomic(join(root, 'runs', 'run-001.json'), {
    id: 'run-001', kind: 'libtv_video', status: 'SUCCESS', segmentId: 'segment-001',
    taskId: 'provider-task-001', fingerprint: { sha256: fingerprintSha256 },
    outputs: [{ path: 'outputs/video.mp4', sha256: videoSha256 }],
    auditPackage: { id: 'audit-001', reportPath, reportSha256, machineDecision: 'PASS' }
  });
  await writeJsonAtomic(join(root, 'reviews', 'approval-001.json'), {
    id: 'approval-001', kind: 'paid_generation_approval', actor: 'human', decision: 'approved',
    segmentId: 'segment-001', preflightId: 'preflight-001', fingerprint: { sha256: fingerprintSha256 },
    consumedByRunId: 'run-001', consumedAt: '2026-08-20T00:30:00.000Z', createdAt: '2026-08-20T00:20:00.000Z'
  });
  return root;
}

test('legacy adapter verifies approval, provider task, output and machine audit through exact reverse bindings', async () => {
  const root = await legacyFixture();
  const report = await adaptLegacyProjectEvidence(root);
  assert.equal(report.writebackEligible, false);
  assert.equal(report.summary.byType.paid_approval.verified, 1);
  assert.equal(report.summary.byType.provider_task.verified, 1);
  assert.equal(report.summary.byType.generation_output.verified, 1);
  assert.equal(report.summary.byType.machine_video_audit.verified, 1);
  assert.equal(report.summary.byStatus.partial, 0);
  assert.equal(report.summary.byStatus.invalid, 0);
  await assert.rejects(access(executionLedgerHeadPath(root)), undefined, 'adapter must never bootstrap a ledger');
});

test('changed output bytes invalidate both generated output and the machine audit', async () => {
  const root = await legacyFixture();
  await writeFile(join(root, 'outputs', 'video.mp4'), 'changed-video-bytes');
  const report = await adaptLegacyProjectEvidence(root);
  assert.equal(report.summary.byType.generation_output.invalid, 1);
  assert.equal(report.summary.byType.machine_video_audit.invalid, 1);
  assert.ok(report.candidates.find(item => item.normalizationType === 'machine_video_audit').reasonCodes.includes('audited_video_sha_mismatch'));
});

test('a reconciled non-submission never counts as a provider task', async () => {
  const root = await legacyFixture();
  const runPath = join(root, 'runs', 'run-001.json');
  const run = await readJson(runPath);
  run.status = 'RECONCILED_NOT_SUBMITTED';
  run.taskId = null;
  run.outputs = [];
  run.auditPackage = null;
  await writeJsonAtomic(runPath, run);
  const report = await adaptLegacyProjectEvidence(root);
  assert.equal(report.summary.byType.provider_task.total, 0);
  assert.equal(report.summary.byType.generation_run_record.verified, 1);
  assert.equal(report.candidates.find(item => item.normalizationType === 'generation_run_record').facts.outcome, 'not_submitted');
});

test('a forged preflight binding invalidates the approval and downgrades the provider task', async () => {
  const root = await legacyFixture();
  const preflightPath = join(root, 'runs', 'preflight-001.json');
  const preflight = await readJson(preflightPath);
  preflight.fingerprint.sha256 = 'b'.repeat(64);
  await writeJsonAtomic(preflightPath, preflight);
  const report = await adaptLegacyProjectEvidence(root);
  assert.equal(report.summary.byType.paid_approval.invalid, 1);
  assert.equal(report.summary.byType.provider_task.partial, 1);
  assert.ok(report.candidates.find(item => item.normalizationType === 'paid_approval').reasonCodes.includes('approval_preflight_fingerprint_mismatch'));
});

test('portfolio preserves verified, partial and invalid states without writeback eligibility', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'legacy-evidence-portfolio-'));
  const project = await legacyFixture();
  const target = join(projectsRoot, 'project-one');
  await import('node:fs/promises').then(module => module.cp(project, target, { recursive: true }));
  const portfolio = await readLegacyEvidencePortfolio(projectsRoot, ['project-one']);
  assert.equal(portfolio.writebackEligible, false);
  assert.equal(portfolio.summary.byStatus.verified, 4);
  assert.match(renderLegacyEvidencePortfolioMarkdown(portfolio), /不自动写入执行账本/);
});
