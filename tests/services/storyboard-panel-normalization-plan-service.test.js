import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../../src/adapters/process-runner.js';
import { sha256File } from '../../src/storage/checksum.js';
import { buildStoryboardPanelNormalizationPlans } from '../../src/services/storyboard-panel-normalization-plan-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'storyboard-normalization-plans-'));
  await mkdir(join(root, 'atoms'));
  await mkdir(join(root, 'plans'));
  const requests = [];
  const artifacts = [];
  const panels = [];
  for (let index = 1; index <= 11; index += 1) {
    const rawPath = `atoms/raw-${String(index).padStart(2, '0')}.png`;
    const made = await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=${720 + index}x${1280 + index}`, '-frames:v', '1', '-y', join(root, rawPath)]);
    assert.equal(made.code, 0);
    const sha256 = await sha256File(join(root, rawPath));
    const rawId = `panel-${String(index).padStart(2, '0')}-raw`;
    const finalId = `panel-${String(index).padStart(2, '0')}-final`;
    const rawAuditId = `audit-${rawId}`;
    const finalAuditId = `audit-${finalId}`;
    const requestId = `request-panel-${String(index).padStart(2, '0')}`;
    requests.push({
      id: requestId, assetType: 'storyboard_execution_panel', profileId: 'storyboard_execution_panel_v1', status: 'PREPARED', lint: { decision: 'PASS' }, requestFingerprint: `${String(index % 10).repeat(64)}`,
      storyboardPanel: { storyboardSequenceId: 's01-atomic-v1', panelIndex: index, shotId: `segment-001-shot-${index}`, revision: 2, finalAssetId: finalId }
    });
    artifacts.push(
      {
        id: rawId, type: 'storyboard_panel', assetType: 'storyboard_execution_panel_candidate', segmentId: 'segment-001', storyboardSequenceId: 's01-atomic-v1', panelIndex: index, shotId: `segment-001-shot-${index}`, revision: 1, status: 'locked', path: rawPath, sha256, visualAuditId: rawAuditId,
        sourcePromptPlanPath: 'plans/atomic.json', sourceRequestId: requestId, sourceRequestFingerprint: `${String(index % 10).repeat(64)}`,
        expectedFinalAssetId: finalId, expectedFinalVisualAuditId: finalAuditId, expectedFinalRevision: 2, lockedByReviewId: `review-${rawId}`
      },
      { id: rawAuditId, type: 'asset_visual_audit', status: 'locked', decision: 'PASS', assetId: rawId, assetType: 'storyboard_execution_panel_candidate', assetRevision: 1, assetSha256: sha256, inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context', blockerCount: 0, lockedByReviewId: `review-${rawAuditId}` }
    );
    panels.push({ panelIndex: index, assetId: rawId });
  }
  const promptPlanPath = 'plans/atomic.json';
  await writeFile(join(root, promptPlanPath), JSON.stringify({ projectId: 'project-001', requests }));
  const promptPlanSha256 = await sha256File(join(root, promptPlanPath));
  for (const artifact of artifacts.filter(item => item.type === 'storyboard_panel')) artifact.sourcePromptPlanSha256 = promptPlanSha256;
  await writeFile(join(root, 'project-state.json'), JSON.stringify({ projectId: 'project-001', phase: 'asset_review', activeSegmentId: null, blockedReason: null, artifacts, updatedAt: '2026-08-13T00:00:00.000Z' }));
  return {
    root,
    input: {
      id: 'normalization-batch-v1', projectId: 'project-001', segmentId: 'segment-001', storyboardSequenceId: 's01-atomic-v1',
      promptPlanPath, promptPlanSha256, outputDirectory: 'assets/segment-001/panels-v1', revision: 2, panels
    }
  };
}

test('builds eleven common-native no-scale 9:16 crop plans from exact locked raw atomic panels', async () => {
  const { root, input } = await fixture();
  const result = await buildStoryboardPanelNormalizationPlans(root, input, { runner: runProcess });
  assert.equal(result.plans.length, 11);
  assert.equal(result.nativeCell.width * 16, result.nativeCell.height * 9);
  assert.equal(new Set(result.plans.map(plan => `${plan.crop.width}x${plan.crop.height}`)).size, 1);
  assert.deepEqual(result.plans.map(plan => plan.output.assetId), input.panels.map(panel => panel.assetId.replace('-raw', '-final')));
  assert.ok(result.plans.every(plan => plan.output.path.startsWith('assets/segment-001/panels-v1/')));
});

test('uses the production process runner by default', async () => {
  const { root, input } = await fixture();
  const result = await buildStoryboardPanelNormalizationPlans(root, input);
  assert.equal(result.plans.length, 11);
  assert.equal(result.nativeCell.width * 16, result.nativeCell.height * 9);
});

test('permits a panel-specific frozen prompt plan only when its raw provenance matches exactly', async () => {
  const { root, input } = await fixture();
  const alternatePath = 'plans/atomic-panel-01-rework.json';
  const original = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'plans/atomic.json'), 'utf8'));
  await writeFile(join(root, alternatePath), JSON.stringify(original));
  const alternateSha256 = await sha256File(join(root, alternatePath));
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf8'));
  const raw = state.artifacts.find(item => item.id === input.panels[0].assetId);
  raw.sourcePromptPlanPath = alternatePath;
  raw.sourcePromptPlanSha256 = alternateSha256;
  await writeFile(statePath, JSON.stringify(state));
  input.panels[0].promptPlanPath = alternatePath;
  input.panels[0].promptPlanSha256 = alternateSha256;
  const result = await buildStoryboardPanelNormalizationPlans(root, input);
  assert.equal(result.plans[0].source.sourcePromptPlanPath, alternatePath);
  assert.equal(result.plans[0].source.sourcePromptPlanSha256, alternateSha256);
});

test('refuses a raw atomic panel whose frozen request provenance has changed', async () => {
  const { root, input } = await fixture();
  const statePath = join(root, 'project-state.json');
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf8'));
  state.artifacts.find(item => item.id === input.panels[0].assetId).sourceRequestFingerprint = 'f'.repeat(64);
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(buildStoryboardPanelNormalizationPlans(root, input, { runner: runProcess }), /frozen request sequence/);
});
