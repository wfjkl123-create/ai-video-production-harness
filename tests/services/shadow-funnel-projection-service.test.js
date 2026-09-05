import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildShadowFunnelProjection,
  renderShadowFunnelMarkdown
} from '../../src/services/shadow-funnel-projection-service.js';

let sequence = 0;
function evidence(normalizationType, facts, status = 'verified', reasonCodes = []) {
  sequence += 1;
  return {
    id: `legacy-${normalizationType}-${sequence}`,
    normalizationType, status, reasonCodes,
    sourcePath: `evidence/${sequence}.json`, evidencePaths: [`evidence/${sequence}.json`], facts
  };
}

function portfolio(candidates) {
  return {
    kind: 'legacy_evidence_adapter_portfolio',
    projects: [{ slug: 'project-one', report: { projectId: 'PROJECT-ONE', candidates } }]
  };
}

test('shadow funnel counts only a fully reverse-bound verified chain and suppresses duplicate tasks', () => {
  const sha = 'a'.repeat(64);
  const candidates = [
    evidence('paid_approval', {
      approvalId: 'approval-1', consumption: 'consumed', consumedByRunId: 'run-1'
    }),
    evidence('provider_task', {
      runId: 'run-1', providerTaskId: 'task-1', exactApprovalId: 'approval-1'
    }),
    evidence('provider_task', {
      runId: 'run-1', providerTaskId: 'task-1', exactApprovalId: 'approval-1'
    }),
    evidence('generation_output', {
      runId: 'run-1', providerTaskId: 'task-1', sha256: sha, bytesVerified: true
    }),
    evidence('machine_video_audit', {
      auditId: 'audit-1', runId: 'run-1', videoSha256: sha, decision: 'PASS'
    }),
    evidence('gate5_review', {
      reviewId: 'review-1', artifactId: 'final-edit-1', artifactType: 'final_edit',
      artifactSha256: sha, decision: 'approved', currentAuthority: true
    }),
    evidence('final_edit', {
      artifactId: 'final-edit-1', sha256: sha, currentAuthority: true, gate5Decision: 'approved'
    }),
    evidence('final_delivery', {
      receiptId: 'delivery-1', deliverables: [{ path: 'outputs/final.mp4', sha256: sha }]
    }),
    evidence('generation_run_record', { runId: 'uncertain-run' }, 'partial', ['provider_task_id_missing'])
  ];
  const report = buildShadowFunnelProjection(portfolio(candidates), {
    from: '2026-08-10', through: '2026-08-24', generatedAt: '2026-08-25T02:00:00.000Z'
  });
  assert.deepEqual(report.stages.map(stage => stage.count), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(report.stages.find(stage => stage.id === 'provider_tasks').conversionRate, 1);
  assert.equal(report.exclusions.filter(item => item.reasonCodes.includes('duplicate_semantic_identity_suppressed')).length, 1);
  assert.equal(report.exclusions.filter(item => item.status === 'partial').length, 1);
  assert.equal(report.writebackEligible, false);
  assert.match(renderShadowFunnelMarkdown(report), /审批包存在、审批已消费和真实 Provider taskId 是三个不同层级/);
});

test('consumed but not submitted approval remains in its own denominator and never becomes a provider task', () => {
  const report = buildShadowFunnelProjection(portfolio([
    evidence('paid_approval', {
      approvalId: 'approval-unused-task', consumption: 'consumed', consumedByRunId: 'run-not-submitted'
    }),
    evidence('generation_run_record', {
      runId: 'run-not-submitted', providerTaskId: null, outcome: 'not_submitted'
    })
  ]));
  assert.equal(report.stages.find(stage => stage.id === 'approved_packages').count, 1);
  assert.equal(report.stages.find(stage => stage.id === 'consumed_approvals').count, 1);
  assert.equal(report.stages.find(stage => stage.id === 'provider_tasks').count, 0);
  assert.equal(report.stages.find(stage => stage.id === 'provider_tasks').conversionRate, 0);
  assert.equal(report.stages.find(stage => stage.id === 'verified_outputs').conversionRate, null);
});

test('verified candidates with a broken predecessor chain are excluded rather than promoted', () => {
  const report = buildShadowFunnelProjection(portfolio([
    evidence('generation_output', {
      runId: 'forged-run', providerTaskId: 'forged-task', sha256: 'b'.repeat(64), bytesVerified: true
    }),
    evidence('machine_video_audit', {
      runId: 'forged-run', videoSha256: 'b'.repeat(64), decision: 'PASS'
    })
  ]));
  assert.equal(report.stages.find(stage => stage.id === 'verified_outputs').count, 0);
  assert.equal(report.stages.find(stage => stage.id === 'machine_passes').count, 0);
  assert.ok(report.exclusions.some(item => item.reasonCodes.includes('verified_provider_task_chain_missing')));
  assert.ok(report.exclusions.some(item => item.reasonCodes.includes('machine_pass_output_chain_missing')));
});
