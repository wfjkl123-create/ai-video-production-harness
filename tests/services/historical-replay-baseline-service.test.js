import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import { executionLedgerHeadPath } from '../../src/services/execution-ledger-service.js';
import {
  readHistoricalReplayBaseline,
  renderHistoricalReplayMarkdown,
  writeHistoricalReplayBaselineReport
} from '../../src/services/historical-replay-baseline-service.js';

async function observedProject(projectsRoot) {
  const root = join(projectsRoot, 'observed-project');
  await initializeProject(root, { projectId: 'HISTORICAL-OBSERVED' });
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'outputs', 'final.mp4'), 'verified-video-bytes');
  const sha256 = await sha256File(join(root, 'outputs', 'final.mp4'));
  const state = await readJson(join(root, 'project-state.json'));
  state.phase = 'video_review';
  state.updatedAt = '2026-08-20T04:00:00.000Z';
  state.artifacts.push({
    id: 'final-edit-v1', type: 'final_edit', revision: 1, status: 'locked',
    path: 'outputs/final.mp4', sha256, lockedByReviewId: 'quality-final-v1'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await writeJsonAtomic(join(root, 'reviews', 'quality-final-v1.json'), {
    id: 'quality-final-v1', kind: 'quality_review', actor: 'human', decision: 'approved',
    artifactId: 'final-edit-v1', artifactSha256: sha256, createdAt: '2026-08-20T05:00:00.000Z'
  });
  await mkdir(join(root, 'reviews', 'video-audits', 'audit-v1'), { recursive: true });
  await writeJsonAtomic(join(root, 'reviews', 'video-audits', 'audit-v1', 'report.json'), {
    id: 'audit-v1', kind: 'video_audit_package', videoPath: 'outputs/final.mp4',
    videoSha256: sha256, machineDecision: 'PASS', createdAt: '2026-08-20T04:30:00.000Z'
  });
  return root;
}

test('historical replay separates registered, machine, final-edit, Gate 5 and delivery evidence', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'historical-replay-'));
  const observedRoot = await observedProject(projectsRoot);
  const oldRoot = join(projectsRoot, 'old-project');
  await initializeProject(oldRoot, { projectId: 'HISTORICAL-OLD' });
  const oldState = await readJson(join(oldRoot, 'project-state.json'));
  oldState.updatedAt = '2026-07-01T00:00:00.000Z';
  await writeJsonAtomic(join(oldRoot, 'project-state.json'), oldState);
  const brokenRoot = join(projectsRoot, 'broken-project');
  await mkdir(brokenRoot, { recursive: true });
  await writeFile(join(brokenRoot, 'project-state.json'), '{broken');

  const report = await readHistoricalReplayBaseline(projectsRoot, {
    from: '2026-08-10', through: '2026-08-24', timeZoneOffset: '+08:00'
  }, {
    now: '2026-08-25T02:00:00.000Z',
    readinessAuditor: async () => ({ status: 'PASS', findings: [] })
  });

  assert.equal(report.scope.includedProjects, 1);
  assert.equal(report.scope.excludedOutsideWindow, 1);
  assert.equal(report.scope.unreadableProjects, 1);
  assert.equal(report.scope.measurementScope, 'project_lifetime_evidence_for_window_activity_set');
  assert.equal(report.hardErrorRate.value, null);
  assert.equal(report.shadowFunnel.kind, 'shadow_funnel_projection');
  assert.equal(report.shadowFunnel.writebackEligible, false);
  assert.equal(report.aggregate.counts.observedPaidRetries, null, 'partial ledger coverage must not aggregate unknown retries as zero');
  assert.equal(report.aggregate.countCoverageProjects.observedPaidRetries, 0);
  const project = report.projects[0];
  assert.equal(project.evidenceLevels.artifactRegistered, true);
  assert.equal(project.evidenceLevels.machineVideoPassVerified, true);
  assert.equal(project.evidenceLevels.finalEditBytesVerified, true);
  assert.equal(project.evidenceLevels.gate5Status, 'final_edit_accepted');
  assert.equal(project.evidenceLevels.deliveryFinalized, false);
  assert.ok(project.funnel.findIndex(stage => stage.id === 'generation') < project.funnel.findIndex(stage => stage.id === 'editing'));
  assert.ok(project.funnel.findIndex(stage => stage.id === 'editing') < project.funnel.findIndex(stage => stage.id === 'technical_review'));
  await assert.rejects(access(executionLedgerHeadPath(observedRoot)), undefined, 'historical replay must not bootstrap a ledger');
  assert.match(renderHistoricalReplayMarkdown(report), /机器视频 PASS 不等于 Gate 5 用户接受/);
  assert.match(renderHistoricalReplayMarkdown(report), /影子漏斗/);
  const output = await writeHistoricalReplayBaselineReport(join(projectsRoot, 'reports'), report);
  assert.equal((await readJson(output.jsonPath)).kind, 'historical_replay_baseline');
  assert.match(await import('node:fs/promises').then(module => module.readFile(output.markdownPath, 'utf8')), /历史项目离线重放基线/);
});

test('a stale machine PASS is not counted as playable evidence', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'historical-replay-stale-'));
  const root = await observedProject(projectsRoot);
  await writeFile(join(root, 'outputs', 'final.mp4'), 'changed-video-bytes');
  const report = await readHistoricalReplayBaseline(projectsRoot, {
    from: '2026-08-10', through: '2026-08-24'
  }, { readinessAuditor: async () => ({ status: 'PASS', findings: [] }) });
  assert.equal(report.projects[0].counts.machineVideoPasses, 0);
  assert.equal(report.projects[0].counts.staleMachineVideoPasses, 1);
  assert.equal(report.projects[0].evidenceLevels.playableVideoVerified, false);
  assert.equal(report.projects[0].counts.verifiedFinalEdits, 0);
});

test('historical replay rejects impossible or reversed date windows', async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), 'historical-replay-window-'));
  await assert.rejects(readHistoricalReplayBaseline(projectsRoot, { from: '2026-02-30', through: '2026-03-01' }), /real calendar day/);
  await assert.rejects(readHistoricalReplayBaseline(projectsRoot, { from: '2026-08-24', through: '2026-08-10' }), /must not precede/);
});
