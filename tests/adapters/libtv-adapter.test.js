import test from 'node:test';
import assert from 'node:assert/strict';
import { LibTvAdapter } from '../../src/adapters/libtv-adapter.js';

function fakeRunner(calls) {
  return async (executable, args, options) => {
    calls.push({ executable, args, options });
    return { code: 0, stdout: '{"ok":true}', stderr: '' };
  };
}

test('LibTV adapter invokes only the executable with argument arrays', async () => {
  const calls = [];
  const adapter = new LibTvAdapter({ runner: fakeRunner(calls), cwd: '/safe/project' });

  await adapter.check();
  await adapter.ensureWorkspace(42);
  await adapter.ensureProject('canvas-uuid');
  await adapter.upload({ name: 'reference', file: 'assets/reference.png' });
  await adapter.createImageNode({
    name: 'board', model: 'Image Model', prompt: 'make a board', left: ['reference']
  });
  await adapter.runNode('board');
  await adapter.download({ node: 'board', out: 'outputs/board' });

  assert.deepEqual(calls.map(({ args }) => args), [
    ['--version'],
    ['workspace', 'use', '42'],
    ['project', 'use', 'canvas-uuid'],
    ['upload', 'reference', '-t', 'image', '--resource', 'assets/reference.png'],
    ['node', 'create', 'board', '-t', 'image', '-s', 'model=Image Model', '--prompt', 'make a board', '--left', 'reference', '--run'],
    ['node', 'board', '--run'],
    ['download', '--node', 'board', '--out', 'outputs/board']
  ]);
  for (const call of calls) {
    assert.equal(call.executable, 'libtv');
    assert.ok(Array.isArray(call.args));
    assert.deepEqual(call.options, { cwd: '/safe/project' });
    assert.doesNotMatch(call.args.join(' '), /curl|https?:\/\/|token|secret/i);
  }
});

test('LibTV download rejects a file-valued output path before invoking the runner', async () => {
  const calls = [];
  const adapter = new LibTvAdapter({ runner: fakeRunner(calls) });

  await assert.rejects(
    adapter.download({ node: 'board', out: 'outputs/board.png' }),
    /output directory.*file path/i
  );
  assert.equal(calls.length, 0);
});

test('JSON parsing happens only after a successful LibTV exit', async () => {
  const successful = new LibTvAdapter({ runner: async () => ({ code: 0, stdout: '{"nodeKey":"n1"}', stderr: '' }) });
  assert.deepEqual(await successful.upload({ name: 'x', file: 'x.png' }), { nodeKey: 'n1' });

  const failed = new LibTvAdapter({ runner: async () => ({ code: 7, stdout: '{not json', stderr: 'denied' }) });
  await assert.rejects(failed.upload({ name: 'x', file: 'x.png' }), /exit code 7/);
});
