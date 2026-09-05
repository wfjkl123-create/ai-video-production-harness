import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { runDepthPlan } from '../../src/commands/depth-plan.js';

async function project(name) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  await mkdir(join(root, 'inputs'));
  await writeJsonAtomic(join(root, 'project-state.json'), { projectId: name });
  return root;
}

test('directory discovery lists multiple video candidates and performs no probe or write', async () => {
  const root = await project('DEPTH-AMBIGUOUS');
  await writeFile(join(root, 'inputs/a.mp4'), 'a');
  await writeFile(join(root, 'inputs/b.mov'), 'b');
  let probes = 0;
  await assert.rejects(
    runDepthPlan(['--project', root, '--kind', 'video', '--input-dir', 'inputs'], {
      runner: async () => { probes += 1; return { code: 0, stdout: '{}', stderr: '' }; }
    }),
    error => error.code === 'DEPTH_INPUT_AMBIGUOUS'
      && error.message.includes('inputs/a.mp4')
      && error.message.includes('inputs/b.mov')
  );
  assert.equal(probes, 0);
  await assert.rejects(access(join(root, 'runs/depth-conversion-plans')));
});

test('unique video input produces an idempotent free plan without changing the source or creating media output', async () => {
  const root = await project('DEPTH-UNIQUE');
  const source = 'immutable source bytes';
  const sourcePath = join(root, 'inputs/source.mp4');
  await writeFile(sourcePath, source);
  const actualSourcePath = await realpath(sourcePath);
  const sourceSha = createHash('sha256').update(source).digest('hex');
  const runner = async (executable, args, options) => {
    assert.equal(executable, 'ffprobe');
    assert.equal(args.at(-1), actualSourcePath);
    assert.equal(options.shell, false);
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        streams: [{ codec_type: 'video', width: 720, height: 1280, avg_frame_rate: '30/1' }],
        format: { duration: '16.25' }
      })
    };
  };
  const first = await runDepthPlan(['--project', root, '--kind', 'video', '--input', 'inputs/source.mp4'], { runner });
  const second = await runDepthPlan(['--project', root, '--kind', 'video', '--input', 'inputs/source.mp4'], { runner });
  assert.equal(first.planFingerprint, second.planFingerprint);
  assert.equal(first.input.sha256, sourceSha);
  assert.equal(first.output.segments.length, 2);
  assert.deepEqual(first.output.segments.map(item => item.durationSec), [15, 1.25]);
  assert.equal(await readFile(sourcePath, 'utf8'), source);
  assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha);
  assert.match(await readFile(join(root, first.instructionPath), 'utf8'), /近处(?:为)?白色?，远处(?:为)?黑色?/);
  assert.equal((await readFile(join(root, first.path), 'utf8')).includes(first.planFingerprint), true);
  for (const output of first.output.segments) await assert.rejects(access(join(root, output.outputPath)));
});

test('planning refuses an existing depth output instead of overwriting it', async () => {
  const root = await project('DEPTH-NO-OVERWRITE');
  await writeFile(join(root, 'inputs/frame.png'), 'fake image');
  const runner = async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 960 }] })
  });
  const first = await runDepthPlan(['--project', root, '--kind', 'image', '--input', 'inputs/frame.png'], { runner });
  await mkdir(join(root, 'outputs/depth'), { recursive: true });
  await writeFile(join(root, first.output.outputPath), 'existing result');
  await assert.rejects(
    runDepthPlan(['--project', root, '--kind', 'image', '--input', 'inputs/frame.png'], { runner }),
    error => error.code === 'DEPTH_OUTPUT_EXISTS'
  );
  assert.equal(await readFile(join(root, first.output.outputPath), 'utf8'), 'existing result');
});
