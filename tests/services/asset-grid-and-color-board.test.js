import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../../src/adapters/process-runner.js';
import { sha256File } from '../../src/storage/checksum.js';
import { buildAssetGridFfmpegCommand, composeAssetGrid } from '../../src/services/asset-grid-compositor-service.js';
import { composeColorBoard, renderColorBoardSvg } from '../../src/services/color-board-service.js';

test('deterministic color board renders exactly seven program-owned HEX values and labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'color-board-'));
  await writeFile(join(root, 'project-state.json'), '{}');
  const colors = ['#111111', '#333333', '#555555', '#777777', '#996655', '#668899', '#CC9933'];
  const roles = ['primary', 'secondary', 'shadow', 'highlight', 'skin', 'reflection', 'accent'];
  const spec = { id: 'color-v1', title: '七色色板', colors: roles.map((role, index) => ({ role, hex: colors[index], usage: `usage ${index + 1}` })), outputPath: 'assets/color-v1.svg' };
  const svg = renderColorBoardSvg(spec);
  assert.equal((svg.match(/<rect x="70"/g) ?? []).length, 7);
  colors.forEach(hex => assert.match(svg, new RegExp(hex)));
  const result = await composeColorBoard(root, spec);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.match(await readFile(join(root, result.path), 'utf8'), /accent/);
});

test('generic grid compositor places audited prop atoms in fixed slots', async (context) => {
  try { if ((await runProcess('ffmpeg', ['-version'])).code !== 0) return context.skip('ffmpeg unavailable'); } catch { return context.skip('ffmpeg unavailable'); }
  const root = await mkdtemp(join(tmpdir(), 'asset-grid-')); await mkdir(join(root, 'atoms'));
  const panels = [], artifacts = []; const colors = ['red', 'green', 'blue', 'yellow'];
  for (let index = 0; index < 4; index += 1) {
    const path = `atoms/p${index + 1}.png`;
    assert.equal((await runProcess('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colors[index]}:s=320x240`, '-frames:v', '1', '-y', join(root, path)])).code, 0);
    const sha256 = await sha256File(join(root, path)); const assetId = `prop-view-${index + 1}`; const visualAuditId = `audit-${assetId}`;
    panels.push({ panelIndex: index + 1, assetId, assetType: 'story_prop_v1', revision: 1, path, sha256, visualAuditId });
    artifacts.push({ id: visualAuditId, type: 'asset_visual_audit', status: 'locked', decision: 'PASS', assetId, assetType: 'story_prop_v1', assetRevision: 1, assetSha256: sha256, inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context', blockerCount: 0 });
  }
  await writeFile(join(root, 'project-state.json'), JSON.stringify({ artifacts }));
  const plan = { id: 'prop-grid-v1', assetId: 'prop-board-v1', layoutProfile: 'story-prop-grid-v1', grid: { rows: 2, columns: 2, width: 800, height: 600 }, panels, outputPath: 'outputs/prop-board-v1.png', renderer: 'ffmpeg-deterministic-asset-grid-v1' };
  const command = await buildAssetGridFfmpegCommand(root, plan);
  assert.match(command.args[command.args.indexOf('-filter_complex') + 1], /layout=0_0\|400_0\|0_300\|400_300/);
  const result = await composeAssetGrid(root, plan);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});
