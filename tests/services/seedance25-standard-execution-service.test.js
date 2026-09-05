import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileSeedance25StandardExecution } from '../../src/services/seedance25-standard-execution-service.js';
import { runCompileSeedance25Standard } from '../../src/commands/compile-seedance25-standard.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'seedance25-standard-'));
  for (const directory of ['assets', 'outputs', 'prompts/unit-20', 'reviews']) await mkdir(join(root, directory), { recursive: true });
  const media = [
    { id: 'character-v1', type: 'project_asset', path: 'assets/character.png', bytes: 'character-bytes' },
    { id: 'depth-v1', type: 'segment_asset', path: 'outputs/depth.mp4', bytes: 'depth-bytes' },
    { id: 'audio-v1', type: 'segment_asset', path: 'assets/audio.wav', bytes: 'audio-bytes' }
  ];
  const artifacts = [];
  for (const item of media) {
    const sha256 = hash(item.bytes);
    const reviewId = `review-${item.id}`;
    await writeFile(join(root, item.path), item.bytes);
    await writeFile(join(root, 'reviews', `${reviewId}.json`), jsonText({
      id: reviewId, artifactId: item.id, decision: 'approved', actor: 'human', artifactSha256: sha256
    }));
    artifacts.push({
      id: item.id, type: item.type, segmentId: item.type === 'segment_asset' ? 'segment-001' : undefined,
      revision: 1, status: 'locked', path: item.path, sha256, lockedByReviewId: reviewId
    });
    item.sha256 = sha256;
  }
  const promptPath = 'prompts/unit-20/source-prompt.txt';
  const prompt = '@素材[character-v1]只控制人物身份。@素材[depth-v1]只控制固定机位与动作时序。@素材[audio-v1]只控制对白时钟。0-5秒：人物看到产品，视线移向手指，身体略微靠近。5-15秒：她说到舒服后才靠近镜头，开口说：“真的很舒服。”听者从镜头看见她的呼吸变化，肩膀放松，没有立刻移开视线。15-20秒：她选择继续看向镜头，手指松开布料，最后保持原位，留下呼吸余波。\n';
  await writeFile(join(root, promptPath), prompt);
  const promptSha256 = hash(prompt);
  const reportPath = 'prompts/unit-20/performance-report.json';
  await writeFile(join(root, reportPath), jsonText({
    status: 'PASS', profile: 'dialogue', duration: 20,
    promptPath: join(root, promptPath), promptSha256, findings: []
  }));
  const binding = {
    images: [{ assetId: media[0].id, path: media[0].path, sha256: media[0].sha256, status: 'locked' }],
    videos: [{ assetId: media[1].id, path: media[1].path, sha256: media[1].sha256, status: 'locked', durationSec: 20 }],
    audios: [{ assetId: media[2].id, path: media[2].path, sha256: media[2].sha256, status: 'locked', durationSec: 20 }]
  };
  const bindingPath = 'prompts/unit-20/media-binding.json';
  const bindingText = jsonText(binding);
  await writeFile(join(root, bindingPath), bindingText);
  await writeFile(join(root, 'project-state.json'), jsonText({
    projectId: 'fixture-project', phase: 'gate3_locked', activeSegmentId: 'segment-001', blockedReason: null,
    artifacts, updatedAt: '2026-08-27T00:00:00.000Z'
  }));
  const unit = {
    schemaVersion: 1, id: 'unit-20', projectId: 'fixture-project', segmentId: 'segment-001', status: 'draft',
    model: 'Seedance 2.5', operation: 'standard',
    generationContract: {
      durationSec: 20, aspectRatio: '9:16', resolution: '720p', generateAudio: true,
      enableSound: true, paidGenerationSubmitted: false
    },
    prompt: { path: promptPath, sha256: promptSha256, narrativePerformanceReport: reportPath },
    mediaBinding: { path: bindingPath, sha256: hash(bindingText) },
    mediaResponsibilities: {
      'character-v1': { controls: ['identity'], mustNotControl: ['scene'] },
      'depth-v1': { controls: ['motion_timing'], mustNotControl: ['identity'] },
      'audio-v1': { controls: ['dialogue_timing'], mustNotControl: ['visual_identity'] }
    },
    executionControlContract: {
      version: 1, plannedShotCount: 1, generatedUnitShotCount: 1,
      executionUnitStrategy: 'single_take', requiresIndependentShotControl: false,
      platformCapability: {
        surface: 'Doubao Seedance 2.5 standard', profileId: 'seedance-2.5-standard',
        parameter: 'single_continuous_take', exposed: false, enabled: false,
        evidence: 'planning-only; live readback intentionally pending'
      }
    }
  };
  return { root, unit };
}

test('compiles a dynamic 20-second 9:16 720p standard package with exact locked inputs', async () => {
  const { root, unit } = await fixture();
  const result = await compileSeedance25StandardExecution(root, unit);
  assert.equal(result.kind, 'seedance25_standard_execution_package');
  assert.equal(result.duration, 20);
  assert.equal(result.ratio, '9:16');
  assert.equal(result.resolution, '720p');
  assert.equal(result.generateAudio, true);
  assert.equal(result.enableSound, true);
  assert.equal(result.imageInputs.length, 1);
  assert.equal(result.videoInputs.length, 1);
  assert.equal(result.audioInputs.length, 1);
  assert.equal(result.mediaBindings.length, 3);
  assert.equal(result.status, 'draft_pending_dual_source_verification');
  assert.equal(result.canvasPreparationAllowed, false);
  assert.match(result.executionPrompt, /@图1/u);
  assert.match(result.executionPrompt, /@视频1/u);
  assert.match(result.executionPrompt, /@音频1/u);
});

test('rejects unsupported duration and stale performance-report duration', async () => {
  const { root, unit } = await fixture();
  await assert.rejects(
    () => compileSeedance25StandardExecution(root, {
      ...unit, generationContract: { ...unit.generationContract, durationSec: 31 }
    }),
    /between 4 and 30/
  );
  const reportPath = join(root, unit.prompt.narrativePerformanceReport);
  const stale = { status: 'PASS', duration: 15, promptPath: join(root, unit.prompt.path), promptSha256: unit.prompt.sha256 };
  await writeFile(reportPath, jsonText(stale));
  await assert.rejects(() => compileSeedance25StandardExecution(root, unit), /duration must match/);
});

test('rejects unsafe unit ids before deriving any output path', async () => {
  const { root, unit } = await fixture();
  await assert.rejects(
    () => compileSeedance25StandardExecution(root, { ...unit, id: '../../outside' }),
    /safe characters/
  );
});

test('CLI rejects an execution-unit symlink that escapes the project', async () => {
  const { root, unit } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'seedance25-outside-'));
  const outsideInput = join(outside, 'unit.json');
  await writeFile(outsideInput, jsonText(unit));
  const linkedInput = join(root, 'unit-link.json');
  await symlink(outsideInput, linkedInput);
  await assert.rejects(
    () => runCompileSeedance25Standard(['--project', root, '--input', linkedInput]),
    /must stay inside the project root/
  );
});

test('accepts the documented 4 and 30 second boundaries and rejects 3 seconds', async () => {
  for (const durationSec of [4, 30]) {
    const { root, unit } = await fixture();
    const reportPath = join(root, unit.prompt.narrativePerformanceReport);
    await writeFile(reportPath, jsonText({
      status: 'PASS', profile: 'dialogue', duration: durationSec,
      promptPath: join(root, unit.prompt.path), promptSha256: unit.prompt.sha256, findings: []
    }));
    const result = await compileSeedance25StandardExecution(root, {
      ...unit, generationContract: { ...unit.generationContract, durationSec }
    });
    assert.equal(result.duration, durationSec);
  }
  const { root, unit } = await fixture();
  await assert.rejects(
    () => compileSeedance25StandardExecution(root, {
      ...unit, generationContract: { ...unit.generationContract, durationSec: 3 }
    }),
    /between 4 and 30/
  );
});

test('fails closed on a stale locked-media review or a non-passing dual-source report', async () => {
  const stale = await fixture();
  await writeFile(join(stale.root, 'reviews', 'review-character-v1.json'), jsonText({
    id: 'review-character-v1', artifactId: 'character-v1', decision: 'approved', actor: 'human', artifactSha256: '0'.repeat(64)
  }));
  await assert.rejects(
    () => compileSeedance25StandardExecution(stale.root, stale.unit),
    /review checksum binding does not match/
  );

  const dual = await fixture();
  const dualPath = 'prompts/unit-20/dual-source.json';
  await writeFile(join(dual.root, dualPath), jsonText({
    finalStatus: 'VERIFIED_FAIL', prompt: { path: dual.unit.prompt.path, sha256: dual.unit.prompt.sha256 }
  }));
  await assert.rejects(
    () => compileSeedance25StandardExecution(dual.root, {
      ...dual.unit, prompt: { ...dual.unit.prompt, dualSourceVerification: dualPath }
    }),
    /must verify and bind the exact current prompt SHA/
  );
});

test('CLI rejects an existing output-directory symlink that escapes the project', async () => {
  const { root, unit } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'seedance25-output-'));
  const escapedOutput = join(outside, 'output-unit');
  await mkdir(escapedOutput);
  await symlink(escapedOutput, join(root, 'prompts', 'output-unit'));
  const safeUnit = { ...unit, id: 'output-unit' };
  const inputPath = join(root, 'output-unit.json');
  await writeFile(inputPath, jsonText(safeUnit));
  await assert.rejects(
    () => runCompileSeedance25Standard(['--project', root, '--input', inputPath]),
    /output directory must be a real project directory/
  );
});
