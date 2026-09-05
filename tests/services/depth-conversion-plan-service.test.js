import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildDepthConversionPlan, detectDepthIntents, resolveUniqueDepthInput } from '../../src/services/depth-conversion-plan-service.js';

const videoSha = 'a'.repeat(64);
const imageSha = 'b'.repeat(64);

async function template() {
  return JSON.parse(await readFile(new URL('../../knowledge/capabilities/monocular-depth-templates.json', import.meta.url), 'utf8'));
}

test('requires one unique media candidate and exposes every ambiguous filename without guessing', () => {
  assert.equal(resolveUniqueDepthInput(['inputs/readme.txt', 'inputs/source.MP4'], 'video'), 'inputs/source.MP4');
  assert.throws(
    () => resolveUniqueDepthInput(['inputs/b.mov', 'inputs/a.mp4', 'inputs/readme.txt'], 'video'),
    error => error.code === 'DEPTH_INPUT_AMBIGUOUS'
      && JSON.stringify(error.candidates) === JSON.stringify(['inputs/a.mp4', 'inputs/b.mov'])
  );
  assert.throws(
    () => resolveUniqueDepthInput(['inputs/source.mp4'], 'image'),
    error => error.code === 'DEPTH_INPUT_NOT_FOUND'
  );
  assert.throws(() => resolveUniqueDepthInput(['C:\\outside\\source.mp4'], 'video'), /project root/);
  assert.throws(() => resolveUniqueDepthInput(['../outside/source.mp4'], 'video'), /project root/);
});

test('routes gray-white wording to depth by default without stealing mannequin or ordinary desaturation tasks', async () => {
  const value = await template();
  assert.deepEqual(detectDepthIntents('把灰白图作为空间控制图', value), ['image']);
  assert.deepEqual(detectDepthIntents('把灰度视频分段输出', value), ['video']);
  assert.deepEqual(detectDepthIntents('同时需要深度图和深度视频', value), ['image', 'video']);
  assert.deepEqual(detectDepthIntents('制作灰白假模分镜图', value), []);
  assert.deepEqual(detectDepthIntents('只做普通黑白滤镜去色', value), []);
});

test('video plan freezes one depth direction and global range, preserves timing, and splits at 15 seconds', async () => {
  const result = buildDepthConversionPlan({
    projectId: 'DEPTH-VIDEO-1',
    mediaKind: 'video',
    input: { path: 'inputs/source.mp4', sha256: videoSha },
    metadata: { width: 1080, height: 1920, durationSec: 31.2, frameRate: '30000/1001' },
    template: await template(),
    instructionPath: 'prompts/depth/depth-video.txt',
    createdAt: '2026-07-31T00:00:00.000Z'
  });
  assert.equal(result.plan.input.readOnly, true);
  assert.equal(result.plan.depthContract.near, 'white');
  assert.equal(result.plan.depthContract.far, 'black');
  assert.equal(result.plan.depthContract.normalizationScope, 'entire_source_video');
  assert.equal(result.plan.depthContract.perFrameContrastStretch, false);
  assert.equal(result.plan.depthContract.temporalStabilization, 'moderate_edge_preserving');
  assert.equal(result.plan.output.videoCodec, 'h264');
  assert.equal(result.plan.output.audio, false);
  assert.deepEqual(result.plan.output.segments.map(({ startSec, endSec }) => [startSec, endSec]), [
    [0, 15], [15, 30], [30, 31.2]
  ]);
  assert.ok(result.plan.output.segments.every(segment => segment.durationSec <= 15));
  assert.match(result.instructionText, /先确认唯一的输入视频/);
  assert.match(result.instructionText, /不要逐帧自动拉伸对比度/);
});

test('image plan keeps the source dimensions and produces only a non-overwriting grayscale depth PNG', async () => {
  const result = buildDepthConversionPlan({
    projectId: 'DEPTH-IMAGE-1',
    mediaKind: 'image',
    input: { path: 'inputs/frame.png', sha256: imageSha },
    metadata: { width: 1536, height: 2048 },
    template: await template(),
    instructionPath: 'prompts/depth/depth-image.txt',
    createdAt: '2026-07-31T00:00:00.000Z'
  });
  assert.equal(result.plan.output.width, 1536);
  assert.equal(result.plan.output.height, 2048);
  assert.equal(result.plan.output.colorMode, 'pure_grayscale_depth_only');
  assert.equal(result.plan.output.overwrite, false);
  assert.notEqual(result.plan.output.outputPath, result.plan.input.path);
  assert.match(result.instructionText, /禁止：重新设计构图/);
  assert.match(result.instructionText, /不添加边框、说明文字、色彩图例或装饰/);
});

test('publishes the depth plan JSON schema with the locked direction and no-overwrite contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/depth-conversion-plan.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.required.includes('planFingerprint'));
  assert.equal(schema.properties.depthContract.properties.near.const, 'white');
  assert.equal(schema.properties.depthContract.properties.far.const, 'black');
  assert.equal(schema.$defs.videoOutput.properties.audio.const, false);
  assert.equal(schema.$defs.videoOutput.properties.overwrite.const, false);
  assert.equal(schema.$defs.imageOutput.properties.overwrite.const, false);
});
