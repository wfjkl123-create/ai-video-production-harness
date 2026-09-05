import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../../src/adapters/process-runner.js';
import { sha256File } from '../../src/storage/checksum.js';
import { assertStoryboardRepairPlan, buildStoryboardRepairFfmpegCommand, repairStoryboardPanels } from '../../src/services/storyboard-repair-service.js';

async function fixture(context) {
  try {
    if ((await runProcess('ffmpeg', ['-version'])).code !== 0 || (await runProcess('ffprobe', ['-version'])).code !== 0) {
      context.skip('ffmpeg/ffprobe unavailable');
      return null;
    }
  } catch {
    context.skip('ffmpeg/ffprobe unavailable');
    return null;
  }
  const root = await mkdtemp(join(tmpdir(), 'storyboard-repair-'));
  await mkdir(join(root, 'assets'));
  const sourcePath = 'assets/source.png';
  const replacementPath = 'assets/replacement.png';
  assert.equal((await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1200x600', '-frames:v', '1', '-y', join(root, sourcePath)])).code, 0);
  assert.equal((await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=400x300', '-frames:v', '1', '-y', join(root, replacementPath)])).code, 0);
  const sourceSha = await sha256File(join(root, sourcePath));
  const replacementSha = await sha256File(join(root, replacementPath));
  await writeFile(join(root, 'project-state.json'), JSON.stringify({
    artifacts: [{
      id: 'audit-replacement', type: 'asset_visual_audit', status: 'locked', decision: 'PASS',
      assetId: 'panel-02-repair-v2', assetType: 'storyboard_panel_repair_v1', assetRevision: 2,
      assetSha256: replacementSha, inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context', blockerCount: 0
    }]
  }));
  return {
    root,
    plan: {
      id: 'storyboard-repair-v2', kind: 'storyboard_panel_repair_plan',
      source: { artifactId: 'storyboard-v1', path: sourcePath, sha256: sourceSha, grid: { rows: 2, columns: 3, width: 1200, height: 600 } },
      replacements: [{ panelIndex: 2, assetId: 'panel-02-repair-v2', revision: 2, path: replacementPath, sha256: replacementSha, visualAuditId: 'audit-replacement' }],
      outputPath: 'outputs/storyboard-v2.png', renderer: 'ffmpeg-lossless-storyboard-panel-repair-v1'
    }
  };
}

test('builds a fixed-slot overlay and rejects local repair when half the board failed', async (context) => {
  const value = await fixture(context);
  if (!value) return;
  const command = await buildStoryboardRepairFfmpegCommand(value.root, value.plan);
  const filter = command.args[command.args.indexOf('-filter_complex') + 1];
  assert.match(filter, /scale=400:300/);
  assert.match(filter, /overlay=400:0/);
  assert.throws(() => assertStoryboardRepairPlan({
    ...value.plan,
    replacements: [1, 2, 3].map((panelIndex, index) => ({ ...value.plan.replacements[0], panelIndex, assetId: `panel-${index}` }))
  }), /regenerate the complete sheet/);
});

test('repairs only the failed slot and proves every correct panel pixel hash stayed identical', async (context) => {
  const value = await fixture(context);
  if (!value) return;
  const result = await repairStoryboardPanels(value.root, value.plan);
  assert.deepEqual(result.repairedPanelIndexes, [2]);
  assert.equal(Object.keys(result.preservedPanelHashes).length, 5);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.doesNotReject(access(join(value.root, result.path)));
  assert.notEqual(result.sha256, value.plan.source.sha256);
});

test('refuses a replacement whose bytes changed after visual audit', async (context) => {
  const value = await fixture(context);
  if (!value) return;
  await writeFile(join(value.root, value.plan.replacements[0].path), 'tampered');
  await assert.rejects(buildStoryboardRepairFfmpegCommand(value.root, value.plan), /checksum changed/);
});
