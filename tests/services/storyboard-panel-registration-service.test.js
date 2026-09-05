import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../../src/adapters/process-runner.js';
import { sha256File } from '../../src/storage/checksum.js';
import { canonicalJson } from '../../src/domain/image-prompt-ir.js';
import { createHash } from 'node:crypto';
import { registerStoryboardPanel } from '../../src/services/storyboard-panel-registration-service.js';

function shaJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'storyboard-panel-register-'));
  await mkdir(join(root, 'atoms'));
  await mkdir(join(root, 'plans'));
  const candidatePath = 'atoms/raw.png';
  const created = await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=720x1280', '-frames:v', '1', '-y', join(root, candidatePath)]);
  assert.equal(created.code, 0);
  const candidateSha = await sha256File(join(root, candidatePath));
  const request = {
    id: 'request-panel-01', assetType: 'storyboard_execution_panel', profileId: 'storyboard_execution_panel_v1', status: 'PREPARED', lint: { decision: 'PASS' },
    storyboardPanel: { storyboardSequenceId: 's01-v1', panelIndex: 1, shotId: 'segment-001-shot-a', beatStartSec: 0, beatEndSec: 1, representativeFrameSec: 0.999, revision: 1, rawCandidateAssetId: 'panel-01-raw', rawCandidateVisualAuditId: 'audit-panel-01-raw', finalAssetId: 'panel-01-final', finalVisualAuditId: 'audit-panel-01-final' }
  };
  request.requestFingerprint = shaJson({ ...request });
  const promptPlan = { projectId: 'project-001', requests: [request] };
  const promptPlanPath = 'plans/atomic-plan.json';
  await writeFile(join(root, promptPlanPath), JSON.stringify(promptPlan));
  const promptPlanSha256 = await sha256File(join(root, promptPlanPath));
  await writeFile(join(root, 'project-state.json'), JSON.stringify({ projectId: 'project-001', phase: 'asset_review', activeSegmentId: null, blockedReason: null, artifacts: [], updatedAt: '2026-08-13T00:00:00.000Z' }));
  return { root, candidatePath, candidateSha, promptPlanPath, promptPlanSha256, request };
}

test('registers a raw atomic candidate only from one exact PREPARED lint-passing request', async () => {
  const fixtureData = await fixture();
  const artifact = await registerStoryboardPanel(fixtureData.root, {
    id: 'registration-panel-01-raw', kind: 'storyboard_panel_registration', projectId: 'project-001', stage: 'raw_candidate', visualAuditId: 'audit-panel-01-raw',
    promptPlanPath: fixtureData.promptPlanPath, promptPlanSha256: fixtureData.promptPlanSha256,
    requestId: fixtureData.request.id, requestFingerprint: fixtureData.request.requestFingerprint, candidatePath: fixtureData.candidatePath
  });
  assert.equal(artifact.type, 'storyboard_panel');
  assert.equal(artifact.assetType, 'storyboard_execution_panel_candidate');
  assert.equal(artifact.panelIndex, 1);
  assert.equal(artifact.sha256, fixtureData.candidateSha);
  assert.equal(artifact.expectedFinalAssetId, 'panel-01-final');
  assert.equal(artifact.expectedFinalVisualAuditId, 'audit-panel-01-final');
});

test('rejects a raw registration whose exact request fingerprint is not bound', async () => {
  const fixtureData = await fixture();
  await assert.rejects(registerStoryboardPanel(fixtureData.root, {
    id: 'registration-panel-01-raw', kind: 'storyboard_panel_registration', projectId: 'project-001', stage: 'raw_candidate', visualAuditId: 'audit-panel-01-raw',
    promptPlanPath: fixtureData.promptPlanPath, promptPlanSha256: fixtureData.promptPlanSha256,
    requestId: fixtureData.request.id, requestFingerprint: 'a'.repeat(64), candidatePath: fixtureData.candidatePath
  }), /request fingerprint/);
});

test('rejects a raw registration whose visual-audit identity was not frozen by the atomic request', async () => {
  const fixtureData = await fixture();
  await assert.rejects(registerStoryboardPanel(fixtureData.root, {
    id: 'registration-panel-01-raw', kind: 'storyboard_panel_registration', projectId: 'project-001', stage: 'raw_candidate', visualAuditId: 'wrong-audit-id',
    promptPlanPath: fixtureData.promptPlanPath, promptPlanSha256: fixtureData.promptPlanSha256,
    requestId: fixtureData.request.id, requestFingerprint: fixtureData.request.requestFingerprint, candidatePath: fixtureData.candidatePath
  }), /exact visual-audit identity/);
});
