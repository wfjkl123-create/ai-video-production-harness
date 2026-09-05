import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../../src/adapters/process-runner.js';
import { sha256File } from '../../src/storage/checksum.js';
import { assertStoryboardPanelNormalizationPlan, buildStoryboardPanelNormalizationCommand, normalizeStoryboardPanel } from '../../src/services/storyboard-panel-normalization-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'storyboard-panel-normalize-'));
  await mkdir(join(root, 'atoms'));
  const sourcePath = 'atoms/raw.png';
  const outputPath = 'atoms/final.png';
  const built = await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=720x1280', '-frames:v', '1', '-y', join(root, sourcePath)]);
  assert.equal(built.code, 0);
  const sha256 = await sha256File(join(root, sourcePath));
  const sourceId = 'panel-01-candidate';
  const auditId = 'audit-panel-01-candidate';
  await mkdir(join(root, 'plans'));
  await writeFile(join(root, 'plans/atomic.json'), JSON.stringify({ projectId: 'project-001', requests: [] }));
  const planSha256 = await sha256File(join(root, 'plans/atomic.json'));
  await writeFile(join(root, 'project-state.json'), JSON.stringify({ artifacts: [
    {
      id: sourceId, type: 'storyboard_panel', assetType: 'storyboard_execution_panel_candidate', segmentId: 'segment-001', storyboardSequenceId: 's01-v1', panelIndex: 1, shotId: 'segment-001-shot-a', revision: 1, status: 'locked', path: sourcePath, sha256, visualAuditId: auditId, lockedByReviewId: 'review-source',
      sourcePromptPlanPath: 'plans/atomic.json', sourcePromptPlanSha256: planSha256, sourceRequestId: 'request-panel-01', sourceRequestFingerprint: 'b'.repeat(64),
      expectedFinalAssetId: 'panel-01-final', expectedFinalVisualAuditId: 'audit-panel-01-final', expectedFinalRevision: 2
    },
    { id: auditId, type: 'asset_visual_audit', status: 'locked', decision: 'PASS', assetId: sourceId, assetType: 'storyboard_execution_panel_candidate', assetRevision: 1, assetSha256: sha256, inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context', blockerCount: 0 }
  ] }));
  return {
    root,
    plan: {
      id: 'normalize-panel-01-v1', kind: 'storyboard_panel_normalization_plan', projectId: 'project-001', segmentId: 'segment-001', storyboardSequenceId: 's01-v1',
      source: {
        assetId: sourceId, visualAuditId: auditId, path: sourcePath, sha256, revision: 1, panelIndex: 1, shotId: 'segment-001-shot-a', segmentId: 'segment-001', storyboardSequenceId: 's01-v1',
        sourcePromptPlanPath: 'plans/atomic.json', sourcePromptPlanSha256: planSha256, sourceRequestId: 'request-panel-01', sourceRequestFingerprint: 'b'.repeat(64),
        expectedFinalAssetId: 'panel-01-final', expectedFinalVisualAuditId: 'audit-panel-01-final', expectedFinalRevision: 2
      },
      output: { assetId: 'panel-01-final', assetType: 'storyboard_execution_panel', path: outputPath, revision: 2, panelIndex: 1, shotId: 'segment-001-shot-a', segmentId: 'segment-001', storyboardSequenceId: 's01-v1' },
      crop: { left: 0, top: 0, width: 720, height: 1280 }, renderer: 'ffmpeg-lossless-native-storyboard-panel-crop-v1'
    }
  };
}

test('normalizes only a locked clean-reviewed raw panel with a no-scale 9:16 crop', async () => {
  const { root, plan } = await fixture();
  assert.equal(assertStoryboardPanelNormalizationPlan(plan).id, plan.id);
  const command = await buildStoryboardPanelNormalizationCommand(root, plan);
  assert.doesNotMatch(command.args.join(' '), /scale=|pad=/);
  const result = await normalizeStoryboardPanel(root, plan);
  assert.match(result.output.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.output.path, 'atoms/final.png');
});

test('refuses a source candidate without a locked matching audit', async () => {
  const { root, plan } = await fixture();
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'project-state.json'), 'utf8'));
  state.artifacts[1].decision = 'FAIL';
  await writeFile(join(root, 'project-state.json'), JSON.stringify(state));
  await assert.rejects(buildStoryboardPanelNormalizationCommand(root, plan), /locked clean-zero-context visual PASS/);
});
