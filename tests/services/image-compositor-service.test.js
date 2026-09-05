import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../../src/storage/checksum.js';
import { buildCharacterBoardCompositePlan, buildCharacterBoardFfmpegCommand, composeCharacterBoard } from '../../src/services/image-compositor-service.js';
import { runProcess } from '../../src/adapters/process-runner.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'character-composite-'));
  await mkdir(join(root, 'atoms'));
  const slots = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
  const profiles = [
    'character_front_face_closeup_v1',
    'character_profile_face_closeup_v1',
    'character_front_wardrobe_no_head_v1',
    'character_full_body_back_v1'
  ];
  const panels = [];
  const artifacts = [];
  for (const [index, slot] of slots.entries()) {
    const path = `atoms/panel-${index}.png`;
    await writeFile(join(root, path), Buffer.from(`panel-${index}`));
    const sha256 = await sha256File(join(root, path));
    const visualAuditId = `visual-audit-atomic-${index}`;
    panels.push({ slot, atomicAssetId: `atomic-${index}`, profileId: profiles[index], revision: 1, path, sha256, visualAuditId });
    artifacts.push({
      id: visualAuditId, type: 'asset_visual_audit', status: 'locked', decision: 'PASS',
      assetId: `atomic-${index}`, assetType: profiles[index], assetRevision: 1, assetSha256: sha256,
      inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
      observedIdentityCount: 1, blockerCount: 0
    });
  }
  await writeFile(join(root, 'project-state.json'), JSON.stringify({ artifacts }));
  return { root, plan: buildCharacterBoardCompositePlan({ id: 'composite-a-v1', assetId: 'character-a-board-v1', panels, outputPath: 'outputs/character-a-board-v1.png' }) };
}

test('builds an exact four-slot ffmpeg composition with one-third face row', async () => {
  const { root, plan } = await fixture();
  const command = await buildCharacterBoardFfmpegCommand(root, plan);
  const filter = command.args[command.args.indexOf('-filter_complex') + 1];
  assert.match(filter, /1024:512/);
  assert.match(filter, /1024:1024/);
  assert.match(filter, /layout=0_0\|1024_0\|0_512\|1024_512/);
});

test('verifies panel checksums and refuses to overwrite an existing composite', async () => {
  const { root, plan } = await fixture();
  await writeFile(join(root, plan.panels[0].path), 'tampered');
  await assert.rejects(buildCharacterBoardFfmpegCommand(root, plan), /checksum changed/);

  const fresh = await fixture();
  await mkdir(join(fresh.root, 'outputs'));
  await writeFile(join(fresh.root, fresh.plan.outputPath), 'existing');
  await assert.rejects(composeCharacterBoard(fresh.root, fresh.plan), /already exists/);
});

test('refuses to compose a panel without exact locked machine-audit evidence', async () => {
  const { root, plan } = await fixture();
  const state = JSON.parse(await readFile(join(root, 'project-state.json'), 'utf8'));
  state.artifacts[0].assetSha256 = 'f'.repeat(64);
  await writeFile(join(root, 'project-state.json'), JSON.stringify(state));
  await assert.rejects(buildCharacterBoardFfmpegCommand(root, plan), /stale or does not match/);
});

test('refuses an output-directory symlink without invoking ffmpeg or writing outside', async () => {
  const { root, plan } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'character-composite-outside-'));
  await symlink(outside, join(root, 'outputs'));
  let calls = 0;
  await assert.rejects(composeCharacterBoard(root, plan, { runner: async () => {
    calls += 1;
    return { code: 0, stdout: '', stderr: '' };
  } }), /must not contain symlinks/);
  assert.equal(calls, 0);
  await assert.rejects(access(join(outside, 'character-a-board-v1.png')));
});

test('publishes a compositor result only after the runner produces the output', async () => {
  const { root, plan } = await fixture();
  const result = await composeCharacterBoard(root, plan, { runner: async (_executable, args) => {
    await writeFile(args.at(-1), Buffer.from('composite-output'));
    return { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal(result.path, plan.outputPath);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('real ffmpeg smoke test produces an exact 2048x1536 PNG board', async (context) => {
  try {
    const probe = await runProcess('ffmpeg', ['-version']);
    if (probe.code !== 0) {
      context.skip('ffmpeg is unavailable');
      return;
    }
  } catch {
    context.skip('ffmpeg is unavailable');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'character-composite-real-'));
  await mkdir(join(root, 'atoms'));
  const slots = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
  const profiles = [
    'character_front_face_closeup_v1', 'character_profile_face_closeup_v1',
    'character_front_wardrobe_no_head_v1', 'character_full_body_back_v1'
  ];
  const colors = ['red', 'green', 'blue', 'yellow'];
  const panels = [];
  const artifacts = [];
  for (const [index, slot] of slots.entries()) {
    const path = `atoms/real-${index}.png`;
    const generated = await runProcess('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colors[index]}:s=320x240`,
      '-frames:v', '1', '-y', join(root, path)
    ]);
    assert.equal(generated.code, 0);
    const sha256 = await sha256File(join(root, path));
    const visualAuditId = `visual-audit-real-${index}`;
    panels.push({ slot, atomicAssetId: `real-${index}`, profileId: profiles[index], revision: 1, path, sha256, visualAuditId });
    artifacts.push({
      id: visualAuditId, type: 'asset_visual_audit', status: 'locked', decision: 'PASS',
      assetId: `real-${index}`, assetType: profiles[index], assetRevision: 1, assetSha256: sha256,
      inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
      observedIdentityCount: 1, blockerCount: 0
    });
  }
  await writeFile(join(root, 'project-state.json'), JSON.stringify({ artifacts }));
  const plan = buildCharacterBoardCompositePlan({
    id: 'real-composite-v1', assetId: 'real-character-board-v1', panels,
    outputPath: 'outputs/real-character-board-v1.png'
  });
  await composeCharacterBoard(root, plan);
  const inspected = await runProcess('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name',
    '-of', 'json', join(root, plan.outputPath)
  ]);
  assert.equal(inspected.code, 0);
  const stream = JSON.parse(inspected.stdout).streams[0];
  assert.deepEqual(stream, { codec_name: 'png', width: 2048, height: 1536 });
});
