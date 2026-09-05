import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSecrets, redact, readRunningHubKeychain, RUNNINGHUB_KEYCHAIN_SERVICE } from '../../src/config/env.js';
import { RUNNINGHUB_DEFAULTS } from '../../src/config/defaults.js';
import * as runninghub from '../../src/adapters/runninghub-adapter.js';

const { RunningHubAdapter, RUNNINGHUB_NODES } = runninghub;

function response(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('loads the environment key before .env.local and never exposes it through redact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-env-'));
  await writeFile(join(root, '.env.local'), 'RUNNINGHUB_API_KEY=file-secret\n');
  const previous = process.env.RUNNINGHUB_API_KEY;
  process.env.RUNNINGHUB_API_KEY = 'environment-secret';
  try {
    assert.deepEqual(loadSecrets(root), { runningHubApiKey: 'environment-secret' });
    assert.equal(redact('environment-secret'), '[REDACTED]');
  } finally {
    if (previous === undefined) delete process.env.RUNNINGHUB_API_KEY;
    else process.env.RUNNINGHUB_API_KEY = previous;
  }
});

test('deeply redacts sensitive keys and known secret values without mutating evidence', () => {
  const source = {
    status: 'failed',
    nested: {
      Authorization: 'Bearer nested-secret',
      message: 'request contained nested-secret',
      items: [{ apiKey: 'nested-secret' }, 'prefix-nested-secret-suffix']
    }
  };
  const sanitized = redact(source, ['nested-secret']);
  assert.deepEqual(sanitized, {
    status: 'failed',
    nested: {
      Authorization: '[REDACTED]',
      message: 'request contained [REDACTED]',
      items: [{ apiKey: '[REDACTED]' }, 'prefix-[REDACTED]-suffix']
    }
  });
  assert.equal(source.nested.Authorization, 'Bearer nested-secret');
});

test('loads .env.local without logging and rejects a missing API key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-env-'));
  await writeFile(join(root, '.env.local'), '# local only\nRUNNINGHUB_API_KEY="file-secret"\n');
  const previous = process.env.RUNNINGHUB_API_KEY;
  delete process.env.RUNNINGHUB_API_KEY;
  try {
    assert.deepEqual(loadSecrets(root), { runningHubApiKey: 'file-secret' });
    await writeFile(join(root, '.env.local'), 'OTHER=value\n');
    assert.throws(() => loadSecrets(root, process.env, { keychainReader: () => undefined }), /RUNNINGHUB_API_KEY is not configured/);
  } finally {
    if (previous !== undefined) process.env.RUNNINGHUB_API_KEY = previous;
  }
});

test('loads the macOS Keychain only as the final fallback and redacts it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-keychain-'));
  await writeFile(join(root, '.env.local'), 'OTHER=value\n');
  const keychainCalls = [];
  assert.deepEqual(loadSecrets(root, {}, {
    keychainReader: () => {
      keychainCalls.push('read');
      return 'global-keychain-secret';
    }
  }), { runningHubApiKey: 'global-keychain-secret' });
  assert.deepEqual(keychainCalls, ['read']);
  assert.equal(redact('global-keychain-secret'), '[REDACTED]');

  await writeFile(join(root, '.env.local'), 'RUNNINGHUB_API_KEY=project-secret\n');
  assert.deepEqual(loadSecrets(root, {}, { keychainReader: () => { throw new Error('must not read'); } }), {
    runningHubApiKey: 'project-secret'
  });
});

test('reads the fixed Keychain service without exposing command failures', () => {
  const calls = [];
  const value = readRunningHubKeychain({
    account: 'test-user',
    execFile: (executable, args, options) => {
      calls.push({ executable, args, options });
      return 'keychain-secret\n';
    }
  });
  assert.equal(value, 'keychain-secret');
  assert.deepEqual(calls[0].args, [
    'find-generic-password', '-a', 'test-user', '-s', RUNNINGHUB_KEYCHAIN_SERVICE, '-w'
  ]);
  assert.equal(calls[0].options.stdio[2], 'ignore');
  assert.equal(readRunningHubKeychain({ execFile: () => { throw new Error('denied secret'); } }), undefined);
});

test('uses the locked endpoints and bearer auth without retaining the secret in evidence', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/media/upload/binary')) return response({ data: { download_url: 'https://temp/upload.png' } });
    if (url.includes('/seedance-2.0-global/multimodal-video')) return response({ data: { taskId: 'task-1' } });
    return response({ data: { taskId: 'task-1', status: 'RUNNING' } });
  };
  const root = await mkdtemp(join(tmpdir(), 'runninghub-http-'));
  const image = join(root, 'reference.png');
  await writeFile(image, 'image bytes');
  const adapter = new RunningHubAdapter({ apiKey: 'top-secret', fetch });

  assert.equal(await adapter.upload(image), 'https://temp/upload.png');
  assert.equal(await adapter.submitVideo({ prompt: 'move', imageInputs: ['https://temp/upload.png'] }), 'task-1');
  await adapter.query('task-1');

  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/openapi/v2/media/upload/binary',
    '/openapi/v2/bytedance/seedance-2.0-global/multimodal-video',
    '/openapi/v2/query'
  ]);
  assert.ok(calls.every(call => new URL(call.url).origin === 'https://www.runninghub.cn'));
  assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer top-secret'));
  const submitted = JSON.parse(calls[1].options.body);
  assert.equal(submitted.ratio, '9:16');
  assert.deepEqual(submitted.imageUrls, ['https://temp/upload.png']);
  assert.doesNotMatch(JSON.stringify(adapter.evidence), /top-secret|Authorization|Bearer/);
});

test('checks standard model entitlement without exposing the key or consuming a task', async () => {
  const calls = [];
  const adapter = new RunningHubAdapter({
    apiKey: 'entitlement-secret',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response({ data: { apiType: 'SHARED', remainMoney: '369.137', currency: 'CNY', currentTaskCounts: '0' } });
    }
  });
  assert.deepEqual(await adapter.assertStandardModelAccess(), {
    apiType: 'SHARED', remainMoney: '369.137', currency: 'CNY', currentTaskCounts: '0'
  });
  assert.equal(new URL(calls[0].url).pathname, '/uc/openapi/accountStatus');
  assert.equal(JSON.parse(calls[0].options.body).apikey, 'entitlement-secret');
  assert.doesNotMatch(JSON.stringify(adapter.evidence), /entitlement-secret|Authorization|Bearer/);

  const normal = new RunningHubAdapter({ apiKey: 'x', fetch: async () => response({ data: { apiType: 'NORMAL' } }) });
  await assert.rejects(normal.assertStandardModelAccess(), error => error.kind === 'entitlement' && /SHARED.*NORMAL/.test(error.message));
});

test('maps media to exact slots and rejects overflow', async () => {
  assert.deepEqual(RUNNINGHUB_NODES, {
    settings: null,
    images: Array.from({ length: 9 }, (_, index) => `imageUrls[${index}]`),
    videos: Array.from({ length: 3 }, (_, index) => `videoUrls[${index}]`),
    audio: Array.from({ length: 3 }, (_, index) => `audioUrls[${index}]`)
  });
  assert.equal(RUNNINGHUB_DEFAULTS.ratio, '9:16');
  const adapter = new RunningHubAdapter({ apiKey: 'x', fetch: async () => response({ data: { taskId: 't' } }) });
  await assert.rejects(adapter.submitVideo({ prompt: 'x', imageInputs: Array(10).fill('url') }), /image inputs exceed 9 slots/);
});

test('submission rejects unsafe task IDs at the RunningHub response boundary', async () => {
  for (const taskId of ['  ', '../escape', 'task id', 'task\nforged', { nested: true }]) {
    const adapter = new RunningHubAdapter({ apiKey: 'x', fetch: async () => response({ data: { taskId } }) });
    await assert.rejects(adapter.submitVideo({ prompt: 'x' }), /safe taskId/);
  }
  const adapter = new RunningHubAdapter({ apiKey: 'x', fetch: async () => response({ data: { taskId: '  safe-task:1  ' } }) });
  assert.equal(await adapter.submitVideo({ prompt: 'x' }), 'safe-task:1');
});

test('freezes the complete RunningHub field contract and submits the exact full payload', async () => {
  const { RUNNINGHUB_CONTRACT } = runninghub;
  assert.deepEqual(RUNNINGHUB_CONTRACT, {
    endpoint: '/openapi/v2/bytedance/seedance-2.0-global/multimodal-video',
    requiredApiType: 'SHARED',
    settings: ['prompt', 'resolution', 'duration', 'ratio', 'generateAudio', 'realPersonMode'],
    images: { maxCount: 9, fieldName: 'imageUrls' },
    videos: { maxCount: 3, fieldName: 'videoUrls' },
    audio: { maxCount: 3, fieldName: 'audioUrls' }
  });
  assert.equal(Object.isFrozen(RUNNINGHUB_CONTRACT), true);
  assert.equal(Object.isFrozen(RUNNINGHUB_CONTRACT.settings), true);
  assert.equal(Object.isFrozen(RUNNINGHUB_CONTRACT.images), true);

  let payload;
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    fetch: async (_url, options) => {
      payload = JSON.parse(options.body);
      return response({ data: { taskId: 'task-full' } });
    }
  });
  await adapter.submitVideo({
    prompt: 'full prompt',
    duration: 12,
    ratio: '9:16',
    resolution: '720p',
    realPersonMode: false,
    imageInputs: Array.from({ length: 9 }, (_, index) => `image-${index + 1}`),
    videoInputs: ['video-1', 'video-2', 'video-3'],
    audioInputs: ['audio-1', 'audio-2', 'audio-3']
  });
  assert.deepEqual(payload, {
    prompt: 'full prompt',
    resolution: '720p',
    duration: '12',
    ratio: '9:16',
    generateAudio: true,
    realPersonMode: false,
    imageUrls: Array.from({ length: 9 }, (_, index) => `image-${index + 1}`),
    videoUrls: ['video-1', 'video-2', 'video-3'],
    audioUrls: ['audio-1', 'audio-2', 'audio-3']
  });
});

test('bounded polling distinguishes FAILED and timeout outcomes', async () => {
  const failed = new RunningHubAdapter({ apiKey: 'x', fetch: async () => response({ data: {
    status: 'FAILED', errorCode: '805', errorMessage: 'workflow failed',
    failedReason: { exception_type: 'prompt_outputs_failed_validation', traceback: 'upstream balance insufficient' }
  } }) });
  await assert.rejects(
    failed.waitForCompletion('t', { pollIntervalMs: 0, maxWaitMs: 10 }),
    error => error.kind === 'failed'
      && /workflow failed.*upstream balance insufficient/.test(error.message)
      && error.details.failedReason.exception_type === 'prompt_outputs_failed_validation'
  );

  let now = 0;
  const timed = new RunningHubAdapter({
    apiKey: 'x',
    fetch: async () => response({ data: { status: 'RUNNING' } }),
    now: () => now,
    sleep: async ms => { now += Math.max(ms, 1); }
  });
  await assert.rejects(timed.waitForCompletion('t', { pollIntervalMs: 1, maxWaitMs: 2 }), error => error.kind === 'timeout');
});

test('aborts a hung request at its per-request timeout', async () => {
  let observedSignal;
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    requestTimeoutMs: 10,
    fetch: async (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
  });
  await assert.rejects(adapter.query('hung'), error => error.kind === 'timeout');
  assert.equal(observedSignal.aborted, true);
});

test('keeps the request timeout active while a JSON response body hangs', { timeout: 200 }, async () => {
  let observedSignal;
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    requestTimeoutMs: 10,
    fetch: async (_url, options) => {
      observedSignal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
          options.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }
      }), { headers: { 'content-type': 'application/json' } });
    }
  });
  await assert.rejects(adapter.query('hung-json'), error => error.kind === 'timeout');
  assert.equal(observedSignal.aborted, true);
});

test('poll deadline caps sleep to remaining time before another query', async () => {
  let now = 0;
  const sleeps = [];
  let calls = 0;
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    requestTimeoutMs: 1_000,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; },
    fetch: async (_url, options) => {
      calls += 1;
      if (calls === 1) return response({ data: { status: 'RUNNING' } });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
  });
  const promise = adapter.waitForCompletion('deadline', { pollIntervalMs: 100, maxWaitMs: 5 });
  await assert.rejects(promise, error => error.kind === 'timeout');
  assert.deepEqual(sleeps, [5]);
  assert.equal(calls, 1);
});

test('overall poll deadline aborts an in-flight query before its request timeout', async () => {
  let observedSignal;
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    requestTimeoutMs: 1_000,
    fetch: async (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
  });
  await assert.rejects(
    adapter.waitForCompletion('deadline', { pollIntervalMs: 100, maxWaitMs: 10 }),
    error => error.kind === 'timeout'
  );
  assert.equal(observedSignal.aborted, true);
});

test('overall poll deadline also bounds a sleep that never settles', { timeout: 200 }, async () => {
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    sleep: async () => new Promise(() => {}),
    fetch: async () => response({ data: { status: 'RUNNING' } })
  });
  await assert.rejects(
    adapter.waitForCompletion('sleep-hung', { pollIntervalMs: 100, maxWaitMs: 10 }),
    error => error.kind === 'timeout'
  );
});

test('classifies authentication, HTTP, and network failures separately', async () => {
  for (const [fetch, kind] of [
    [async () => response({ message: 'denied' }, { status: 401 }), 'authentication'],
    [async () => response({ message: 'broken' }, { status: 503 }), 'http'],
    [async () => { throw new TypeError('offline'); }, 'network']
  ]) {
    const adapter = new RunningHubAdapter({ apiKey: 'x', fetch });
    await assert.rejects(adapter.query('t'), error => error.kind === kind);
  }
});

test('rejects HTTP-200 business error envelopes', async () => {
  for (const [body, kind] of [
    [{ code: 401, message: 'invalid api key' }, 'authentication'],
    [{ code: 5001, message: 'workflow unavailable' }, 'http'],
    [{ success: false, message: 'quota exhausted' }, 'http']
  ]) {
    const adapter = new RunningHubAdapter({ apiKey: 'x', fetch: async () => response(body) });
    await assert.rejects(adapter.query('t'), error => error.kind === kind);
  }
});

test('adapter methods upload, submit, wait, and download SUCCESS outputs in order', async () => {
  const events = [];
  const adapter = {
    upload: async path => { events.push(`upload:${path}`); return `https://temp/${path}`; },
    submitVideo: async input => { events.push(`submit:${input.imageInputs[0]}`); return 'task-1'; },
    waitForCompletion: async id => { events.push(`wait:${id}`); return { status: 'SUCCESS', outputs: [{ url: 'https://temp/result.mp4' }] }; },
    downloadResults: async (result, destination) => { events.push(`download:${destination}`); return [join(destination, 'result.mp4')]; }
  };
  const input = { prompt: 'move', imageInputs: ['ref.png'] };
  const submittedInput = {
    ...input,
    imageInputs: await Promise.all(input.imageInputs.map(path => adapter.upload(path)))
  };
  const taskId = await adapter.submitVideo(submittedInput);
  const result = await adapter.waitForCompletion(taskId);
  const localOutputs = await adapter.downloadResults(result, '/outputs');
  assert.deepEqual(events, ['upload:ref.png', 'submit:https://temp/ref.png', 'wait:task-1', 'download:/outputs']);
  assert.deepEqual(localOutputs, ['/outputs/result.mp4']);
});

test('downloads the taskOutputs shape through a streamed temporary file and atomic rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-download-'));
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    fetch: async url => {
      assert.equal(url, 'https://outputs.runninghub.cn/result.mp4');
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('video '));
          controller.enqueue(new TextEncoder().encode('bytes'));
          controller.close();
        }
      }), { headers: { 'content-length': '11' } });
    }
  });
  const paths = await adapter.downloadResults({
    taskStatus: 'SUCCESS',
    taskOutputs: [{ fileUrl: 'https://outputs.runninghub.cn/result.mp4' }]
  }, root);
  assert.equal((await readFile(paths[0], 'utf8')), 'video bytes');
  assert.deepEqual(await readdir(root), ['result-1.mp4']);
  assert.equal((await stat(paths[0])).size, 11);
});

test('rejects unsafe download URLs and extensions before fetching', async () => {
  let calls = 0;
  const adapter = new RunningHubAdapter({ apiKey: 'x', fetch: async () => { calls += 1; return new Response('x'); } });
  const root = await mkdtemp(join(tmpdir(), 'runninghub-download-'));
  for (const url of [
    'http://outputs.runninghub.cn/result.mp4',
    'https://evil.example/result.mp4',
    'https://outputs.runninghub.cn/result.exe'
  ]) {
    await assert.rejects(adapter.downloadResults({ taskOutputs: [{ fileUrl: url }] }, root), error => error.kind === 'security');
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test('rejects a download redirected from an approved host to an unapproved host', async () => {
  const redirected = new Response('video');
  Object.defineProperty(redirected, 'url', { value: 'https://evil.example/result.mp4' });
  const adapter = new RunningHubAdapter({ apiKey: 'x', fetch: async () => redirected });
  const root = await mkdtemp(join(tmpdir(), 'runninghub-download-'));
  await assert.rejects(
    adapter.downloadResults({ taskOutputs: [{ fileUrl: 'https://outputs.runninghub.cn/result.mp4' }] }, root),
    error => error.kind === 'security'
  );
  assert.deepEqual(await readdir(root), []);
});

test('follows only validated manual redirect chains and bounds them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-download-'));
  const calls = [];
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    fetch: async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      if (url.endsWith('/start.mp4')) return new Response(null, { status: 302, headers: { location: 'https://cos.myqcloud.com/middle.mp4' } });
      if (url.endsWith('/middle.mp4')) return new Response(null, { status: 307, headers: { location: '/final.mp4' } });
      return new Response('video');
    }
  });
  const paths = await adapter.downloadResults({ taskOutputs: [{ fileUrl: 'https://outputs.runninghub.cn/start.mp4' }] }, root);
  assert.equal(await readFile(paths[0], 'utf8'), 'video');
  assert.deepEqual(calls, [
    { url: 'https://outputs.runninghub.cn/start.mp4', redirect: 'manual' },
    { url: 'https://cos.myqcloud.com/middle.mp4', redirect: 'manual' },
    { url: 'https://cos.myqcloud.com/final.mp4', redirect: 'manual' }
  ]);

  let unsafeCalls = 0;
  const unsafe = new RunningHubAdapter({
    apiKey: 'x',
    fetch: async () => {
      unsafeCalls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/result.mp4' } });
    }
  });
  await assert.rejects(unsafe.downloadResults({ taskOutputs: [{ fileUrl: 'https://outputs.runninghub.cn/start.mp4' }] }, root), error => error.kind === 'security');
  assert.equal(unsafeCalls, 1);

  let loopCalls = 0;
  const loop = new RunningHubAdapter({
    apiKey: 'x',
    fetch: async () => {
      loopCalls += 1;
      return new Response(null, { status: 302, headers: { location: `https://outputs.runninghub.cn/loop-${loopCalls}.mp4` } });
    }
  });
  await assert.rejects(loop.downloadResults({ taskOutputs: [{ fileUrl: 'https://outputs.runninghub.cn/loop.mp4' }] }, root), error => error.kind === 'security');
  assert.equal(loopCalls, 6);
});

test('keeps the request timeout active through a hanging download body and removes partial files', { timeout: 200 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-download-'));
  const adapter = new RunningHubAdapter({
    apiKey: 'x',
    requestTimeoutMs: 10,
    fetch: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        options.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }
    }))
  });
  await assert.rejects(
    adapter.downloadResults({ taskOutputs: [{ fileUrl: 'https://outputs.runninghub.cn/result.mp4' }] }, root),
    error => error.kind === 'timeout'
  );
  assert.deepEqual(await readdir(root), []);
});

test('never overwrites an existing published result path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-download-'));
  await writeFile(join(root, 'result-1.mp4'), 'preserved failed output');
  const adapter = new RunningHubAdapter({ apiKey: 'x', fetch: async () => new Response('new output') });
  const [published] = await adapter.downloadResults({ taskOutputs: [{ fileUrl: 'https://outputs.runninghub.cn/result.mp4' }] }, root);
  assert.equal(await readFile(join(root, 'result-1.mp4'), 'utf8'), 'preserved failed output');
  assert.equal(published, join(root, 'result-1-1.mp4'));
  assert.equal(await readFile(published, 'utf8'), 'new output');
});

test('rejects declared and streamed oversized downloads and cleans partial files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runninghub-download-'));
  const responses = [
    new Response('ignored', { headers: { 'content-length': '11' } }),
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      }
    }))
  ];
  const adapter = new RunningHubAdapter({ apiKey: 'x', maxDownloadBytes: 10, fetch: async () => responses.shift() });
  for (const name of ['declared.mp4', 'streamed.mp4']) {
    await assert.rejects(
      adapter.downloadResults({ taskOutputs: [{ fileUrl: `https://cos.myqcloud.com/${name}` }] }, root),
      error => error.kind === 'size'
    );
    assert.deepEqual(await readdir(root), []);
  }
});
