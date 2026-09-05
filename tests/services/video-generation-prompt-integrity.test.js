import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { inspectVideoPackage } from '../../src/services/video-generation-service.js';

async function writePackage({ promptBody, mediaBindings = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'video-prompt-integrity-'));
  await mkdir(join(root, 'prompts/segment-001'), { recursive: true });
  const prompt = `${promptBody}\n`;
  await writeFile(join(root, 'prompts/segment-001/execution-prompt.txt'), prompt);
  await writeJsonAtomic(join(root, 'prompts/segment-001/seedance-package.json'), {
    duration: 10,
    ratio: '9:16',
    resolution: '720p',
    videoModelProfileId: 'runninghub-seedance-v1',
    videoExecutor: 'runninghub',
    videoModel: 'RunningHub Seedance',
    promptPath: 'prompts/segment-001/execution-prompt.txt',
    imageInputs: [],
    videoInputs: [],
    audioInputs: [],
    responsibilityMap: {},
    mediaBindingContractVersion: 1,
    mediaBindings
  });
  return root;
}

test('paid preflight reruns zero-context lint against the persisted execution prompt', async () => {
  const root = await writePackage({ promptBody: '承接上一段的动作继续拍摄。' });
  await assert.rejects(
    inspectVideoPackage(root, 'segment-001'),
    /IMPLICIT_PRIOR_CONTEXT/
  );
});

test('paid preflight rejects a media binding contract that no longer matches selected inputs', async () => {
  const root = await writePackage({
    promptBody: '生成一段独立完整的真人短片。',
    mediaBindings: [{ tag: '@图1', id: 'not-selected' }]
  });
  await assert.rejects(
    inspectVideoPackage(root, 'segment-001'),
    /persisted media bindings do not match/
  );
});
