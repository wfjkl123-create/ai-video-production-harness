import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/adapters/process-runner.js';
import { sha256File } from '../../src/storage/checksum.js';
import { assertStoryboardContactSheetPlan, buildStoryboardContactSheetFfmpegCommand, composeStoryboardContactSheet, composeAndRegisterStoryboardContactSheet } from '../../src/services/storyboard-contact-sheet-service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'storyboard-contact-sheet-'));
  await mkdir(join(root, 'atoms'));
  const panels = [];
  const artifacts = [];
  await mkdir(join(root, 'reviews'));
  for (let index = 0; index < 11; index += 1) {
    const path = `atoms/panel-${String(index + 1).padStart(2, '0')}.png`;
    const generated = await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=360x640`, '-frames:v', '1', '-y', join(root, path)]);
    assert.equal(generated.code, 0);
    const sha256 = await sha256File(join(root, path));
    const assetId = `segment-001-panel-${String(index + 1).padStart(2, '0')}-v1`;
    const auditId = `audit-${assetId}`;
    const panel = {
      panelIndex: index + 1, assetId, visualAuditId: auditId, shotId: `segment-001-shot-${String(index + 1).padStart(2, '0')}`,
      segmentId: 'segment-001', storyboardSequenceId: 's01-v1', revision: 1, path, sha256,
      destinationRect: { left: (index % 4) * 360, top: Math.floor(index / 4) * 640, width: 360, height: 640 }
    };
    panels.push(panel);
    const rawId = `${assetId}-raw`;
    const rawAuditId = `${auditId}-raw`;
    artifacts.push(
      {
        id: rawId, type: 'storyboard_panel', assetType: 'storyboard_execution_panel_candidate', segmentId: 'segment-001', storyboardSequenceId: 's01-v1', panelIndex: index + 1, shotId: `segment-001-shot-${String(index + 1).padStart(2, '0')}`, revision: 1, status: 'locked', path, sha256, lockedByReviewId: `review-raw-${index + 1}`, visualAuditId: rawAuditId,
        sourceRequestId: `request-${index + 1}`, sourceRequestFingerprint: 'c'.repeat(64), sourcePromptPlanPath: 'plans/atomic.json', sourcePromptPlanSha256: 'd'.repeat(64),
        expectedFinalAssetId: assetId, expectedFinalVisualAuditId: auditId, expectedFinalRevision: 1
      },
      { id: rawAuditId, type: 'asset_visual_audit', revision: 1, status: 'locked', path: `reviews/${rawAuditId}.json`, decision: 'PASS', assetId: rawId, assetType: 'storyboard_execution_panel_candidate', assetRevision: 1, assetSha256: sha256, inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context', blockerCount: 0, lockedByReviewId: `review-raw-audit-${index + 1}` },
      { id: assetId, type: 'storyboard_panel', assetType: 'storyboard_execution_panel', segmentId: 'segment-001', storyboardSequenceId: 's01-v1', panelIndex: index + 1, revision: 1, status: 'locked', path, sha256, lockedByReviewId: `review-${index + 1}`, visualAuditId: auditId, sourceCandidateArtifactId: rawId, sourceRequestId: `request-${index + 1}`, sourceRequestFingerprint: 'c'.repeat(64), sourcePromptPlanPath: 'plans/atomic.json', sourcePromptPlanSha256: 'd'.repeat(64) },
      { id: auditId, type: 'asset_visual_audit', revision: 1, status: 'locked', path: `reviews/${auditId}.json`, decision: 'PASS', assetId, assetType: 'storyboard_execution_panel', assetRevision: 1, assetSha256: sha256, inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context', blockerCount: 0, lockedByReviewId: `review-audit-${index + 1}` }
    );
  }
  const segmentationPath = 'segments/segmentation-v1.json';
  await mkdir(join(root, 'segments'));
  await writeFile(join(root, segmentationPath), JSON.stringify({ segments: [{ id: 'segment-001', duration: 15 }] }));
  const segmentationSha256 = await sha256File(join(root, segmentationPath));
  artifacts.push({ id: 'segmentation-v1', type: 'segmentation', revision: 1, status: 'locked', path: segmentationPath, sha256: segmentationSha256, lockedByReviewId: 'review-segmentation-v1' });
  await writeFile(join(root, 'reviews/review-segmentation-v1.json'), JSON.stringify({ id: 'review-segmentation-v1', actor: 'human', decision: 'approved', artifactId: 'segmentation-v1', artifactSha256: segmentationSha256 }));
  await writeFile(join(root, 'project-state.json'), JSON.stringify({ projectId: 'project-001', phase: 'asset_review', activeSegmentId: null, blockedReason: null, artifacts, updatedAt: '2026-08-13T00:00:00.000Z' }));
  return {
    root,
    plan: {
      id: 's01-contact-sheet-v1', kind: 'storyboard_contact_sheet_plan', assetId: 'segment-001-storyboard-v1', revision: 1, visualAuditId: 'audit-segment-001-storyboard-v1', projectId: 'project-001', segmentId: 'segment-001', storyboardSequenceId: 's01-v1', segmentationId: 'segmentation-v1', segmentationSha256,
      layoutProfile: 'storyboard-contact-sheet-v1', canvas: { width: 1440, height: 1920, aspectRatio: '3:4' },
      grid: { rows: 3, columns: 4, cellWidth: 360, cellHeight: 640, terminalBlankCell: { row: 3, column: 4 } },
      panels, outputPath: 'outputs/s01-storyboard.png', renderer: 'ffmpeg-lossless-native-storyboard-contact-sheet-v1'
    }
  };
}

test('requires eleven consecutive native 9:16 atomic panels', async () => {
  const { root, plan } = await fixture();
  assert.equal(assertStoryboardContactSheetPlan(plan).assetId, 'segment-001-storyboard-v1');
  const command = await buildStoryboardContactSheetFfmpegCommand(root, plan);
  const filter = command.args[command.args.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(filter, /scale=|pad=/);
  assert.match(filter, /layout=0_0\|360_0\|720_0\|1080_0\|0_640/);
});

test('rejects an atomic panel whose exact locked sequence record is missing', async () => {
  const { root, plan } = await fixture();
  plan.panels[3].storyboardSequenceId = 'wrong-sequence';
  assert.throws(() => assertStoryboardContactSheetPlan(plan), /storyboardSequenceId/);
  plan.panels[3].storyboardSequenceId = 's01-v1';
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'project-state.json'), 'utf8'));
  state.artifacts.find(item => item.id === plan.panels[3].assetId).status = 'draft';
  await writeFile(join(root, 'project-state.json'), JSON.stringify(state));
  await assert.rejects(buildStoryboardContactSheetFfmpegCommand(root, plan), /exact locked atomic storyboard asset/);
});

test('composes only native pixels and proves each output cell hash equals its source', async () => {
  const { root, plan } = await fixture();
  const result = await composeStoryboardContactSheet(root, plan);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(result.panelPixelHashes).length, 11);
  assert.ok(result.terminalBlankCell.meanLuma >= 254);
  assert.ok(result.terminalBlankCell.minLuma >= 250);
  const probe = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', join(root, result.path)]);
  assert.deepEqual(JSON.parse(probe.stdout).streams[0], { width: 1440, height: 1920 });
});

test('rejects a source panel that is not already the exact native cell dimensions', async () => {
  const { root, plan } = await fixture();
  const first = plan.panels[0];
  const replaced = await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=400x700', '-frames:v', '1', '-y', join(root, first.path)]);
  assert.equal(replaced.code, 0);
  const sha256 = await sha256File(join(root, first.path));
  first.sha256 = sha256;
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'project-state.json'), 'utf8'));
  const asset = state.artifacts.find(item => item.id === first.assetId);
  const audit = state.artifacts.find(item => item.id === first.visualAuditId);
  asset.sha256 = sha256;
  audit.assetSha256 = sha256;
  await writeFile(join(root, 'project-state.json'), JSON.stringify(state));
  await assert.rejects(buildStoryboardContactSheetFfmpegCommand(root, plan), /exact native 360x640 execution frame/);
});

test('registers a draft canonical storyboard sheet after native composition, never as an atomic panel', async () => {
  const { root, plan } = await fixture();
  const result = await composeAndRegisterStoryboardContactSheet(root, plan, { planSha256: 'b'.repeat(64) });
  assert.equal(result.artifact.type, 'segment_asset');
  assert.equal(result.artifact.assetType, 'storyboard');
  assert.equal(result.artifact.status, 'draft');
  assert.equal(result.artifact.visualAuditId, plan.visualAuditId);
  assert.equal(result.artifact.segmentationSha256, plan.segmentationSha256);
  const state = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  assert.equal(state.artifacts.find(item => item.id === plan.assetId).type, 'segment_asset');
});
