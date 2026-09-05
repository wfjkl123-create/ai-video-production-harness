import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join } from 'node:path';
import { RUNNINGHUB_DEFAULTS, RUNNINGHUB_VIDEO_ENDPOINT } from '../config/defaults.js';
import { redact } from '../config/env.js';

const BASE_URL = 'https://www.runninghub.cn';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 5;
const SAFE_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.wav', '.m4a', '.aac']);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export const RUNNINGHUB_CONTRACT = Object.freeze({
  endpoint: RUNNINGHUB_VIDEO_ENDPOINT,
  requiredApiType: 'SHARED',
  settings: Object.freeze(['prompt', 'resolution', 'duration', 'ratio', 'generateAudio', 'realPersonMode']),
  images: Object.freeze({ maxCount: 9, fieldName: 'imageUrls' }),
  videos: Object.freeze({ maxCount: 3, fieldName: 'videoUrls' }),
  audio: Object.freeze({ maxCount: 3, fieldName: 'audioUrls' })
});

export const RUNNINGHUB_NODES = Object.freeze({
  settings: null,
  images: Object.freeze(Array.from({ length: RUNNINGHUB_CONTRACT.images.maxCount }, (_, index) => `imageUrls[${index}]`)),
  videos: Object.freeze(Array.from({ length: RUNNINGHUB_CONTRACT.videos.maxCount }, (_, index) => `videoUrls[${index}]`)),
  audio: Object.freeze(Array.from({ length: RUNNINGHUB_CONTRACT.audio.maxCount }, (_, index) => `audioUrls[${index}]`))
});

export class RunningHubError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'RunningHubError';
    this.kind = kind;
    this.details = details;
  }
}

function dataOf(body) {
  return body?.data ?? body;
}

function outputUrl(output) {
  return typeof output === 'string' ? output : output?.url ?? output?.download_url ?? output?.fileUrl;
}

function businessFailure(body) {
  const code = body?.code;
  const successfulCode = code === undefined || [0, 200, '0', '200', 'SUCCESS'].includes(code);
  if (body?.success !== false && successfulCode) return null;
  const message = String(body?.message ?? body?.msg ?? body?.error ?? '');
  const authentication = code === 401 || code === 403 || code === '401' || code === '403'
    || /auth|unauthori[sz]ed|api\s*key|token/i.test(message);
  return { kind: authentication ? 'authentication' : 'http', code };
}

function safeDownloadTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RunningHubError('security', 'RunningHub output URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const allowedHost = host === 'runninghub.cn' || host.endsWith('.runninghub.cn')
    || host === 'myqcloud.com' || host.endsWith('.myqcloud.com');
  if (url.protocol !== 'https:' || !allowedHost || url.username || url.password) {
    throw new RunningHubError('security', 'RunningHub output URL is not an approved HTTPS host');
  }
  const extension = extname(url.pathname).toLowerCase();
  if (!SAFE_EXTENSIONS.has(extension)) throw new RunningHubError('security', 'RunningHub output has an unsafe file extension');
  return { url: url.href, extension };
}

function timeoutError(message, details = {}) {
  return new RunningHubError('timeout', message, details);
}

export class RunningHubAdapter {
  constructor({
    apiKey,
    fetch: fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    sleep,
    now,
    evidencePath,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxDownloadBytes = DEFAULT_MAX_DOWNLOAD_BYTES
  } = {}) {
    if (!apiKey) throw new Error('RUNNINGHUB_API_KEY is not configured');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new RangeError('requestTimeoutMs must be positive');
    if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes <= 0) throw new RangeError('maxDownloadBytes must be a positive safe integer');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sleep = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = now ?? Date.now;
    this.evidencePath = evidencePath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxDownloadBytes = maxDownloadBytes;
    this.evidence = [];
  }

  async record(entry) {
    const sanitized = redact({ at: new Date(this.now()).toISOString(), ...entry }, [this.apiKey]);
    this.evidence.push(sanitized);
    if (this.evidencePath) {
      await mkdir(join(this.evidencePath, '..'), { recursive: true });
      await writeFile(this.evidencePath, `${JSON.stringify(this.evidence, null, 2)}\n`);
    }
  }

  async withTimeout(timeoutMs, operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw timeoutError(`RunningHub request exceeded ${timeoutMs}ms`, { timeoutMs });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(path, options = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    let response;
    let body;
    try {
      ({ response, body } = await this.withTimeout(timeoutMs, async signal => {
        const fetched = await this.fetch(`${this.baseUrl}${path}`, {
          ...options,
          redirect: 'manual',
          signal,
          headers: { ...options.headers, Authorization: `Bearer ${this.apiKey}` }
        });
        if (!fetched.ok) return { response: fetched, body: undefined };
        return { response: fetched, body: await fetched.json() };
      }));
    } catch (error) {
      if (error instanceof RunningHubError && error.kind === 'timeout') {
        await this.record({ operation: path, outcome: 'timeout', timeoutMs });
        throw error;
      }
      if (error instanceof SyntaxError) {
        await this.record({ operation: path, outcome: 'invalid_response', status: response?.status });
        throw new RunningHubError('http', 'RunningHub returned invalid JSON', { status: response?.status });
      }
      await this.record({ operation: path, outcome: 'network_error', error: error?.name });
      throw new RunningHubError('network', 'RunningHub network request failed');
    }
    if (!response.ok) {
      const kind = response.status === 401 || response.status === 403 ? 'authentication' : 'http';
      await this.record({ operation: path, outcome: `${kind}_error`, status: response.status });
      throw new RunningHubError(kind, kind === 'authentication' ? 'RunningHub authentication failed' : `RunningHub HTTP request failed (${response.status})`, { status: response.status });
    }
    const failure = businessFailure(body);
    if (failure) {
      await this.record({ operation: path, outcome: `${failure.kind}_business_error`, status: response.status, code: failure.code });
      throw new RunningHubError(failure.kind, failure.kind === 'authentication' ? 'RunningHub authentication failed' : 'RunningHub business request failed', { status: response.status, code: failure.code });
    }
    await this.record({ operation: path, outcome: 'success', status: response.status });
    return body;
  }

  async upload(path) {
    const form = new FormData();
    form.append('file', new Blob([await readFile(path)]), basename(path));
    const body = dataOf(await this.request('/openapi/v2/media/upload/binary', { method: 'POST', body: form }));
    const url = body?.download_url ?? body?.downloadUrl ?? body?.url;
    if (!url) throw new RunningHubError('http', 'RunningHub upload response has no download URL');
    return url;
  }

  async getAccountStatus() {
    const body = await this.request('/uc/openapi/accountStatus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apikey: this.apiKey })
    });
    return dataOf(body);
  }

  async assertStandardModelAccess() {
    const account = await this.getAccountStatus();
    const apiType = String(account?.apiType ?? '').trim().toUpperCase();
    if (apiType !== RUNNINGHUB_CONTRACT.requiredApiType) {
      throw new RunningHubError(
        'entitlement',
        `RunningHub standard model API requires a ${RUNNINGHUB_CONTRACT.requiredApiType} key; current key type is ${apiType || 'UNKNOWN'}`,
        { apiType: apiType || 'UNKNOWN', requiredApiType: RUNNINGHUB_CONTRACT.requiredApiType }
      );
    }
    return {
      apiType,
      remainMoney: account?.remainMoney,
      currency: account?.currency,
      currentTaskCounts: account?.currentTaskCounts
    };
  }

  async submitVideo(input) {
    const imageInputs = input.imageInputs ?? [];
    const videoInputs = input.videoInputs ?? [];
    const audioInputs = input.audioInputs ?? [];
    for (const [label, values, contract] of [
      ['image', imageInputs, RUNNINGHUB_CONTRACT.images],
      ['video', videoInputs, RUNNINGHUB_CONTRACT.videos],
      ['audio', audioInputs, RUNNINGHUB_CONTRACT.audio]
    ]) {
      if (values.length > contract.maxCount) throw new RangeError(`${label} inputs exceed ${contract.maxCount} slots`);
    }
    const settings = { ...RUNNINGHUB_DEFAULTS, ...input };
    const payload = {
      prompt: settings.prompt,
      resolution: settings.resolution,
      duration: String(settings.duration),
      ratio: settings.ratio,
      generateAudio: settings.generateAudio,
      realPersonMode: settings.realPersonMode,
      imageUrls: imageInputs,
      videoUrls: videoInputs,
      audioUrls: audioInputs
    };
    const body = dataOf(await this.request(RUNNINGHUB_CONTRACT.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }));
    const taskId = body?.taskId ?? body?.task_id;
    const normalizedTaskId = typeof taskId === 'string' ? taskId.trim() : '';
    if (!SAFE_TASK_ID.test(normalizedTaskId)) throw new RunningHubError('http', 'RunningHub submission response has no safe taskId');
    return normalizedTaskId;
  }

  async query(taskId, options = {}) {
    return dataOf(await this.request('/openapi/v2/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId })
    }, options));
  }

  async pollTimeout(taskId, maxWaitMs) {
    await this.record({ operation: 'poll', taskId, outcome: 'timeout', maxWaitMs });
    throw timeoutError(`RunningHub polling exceeded ${maxWaitMs}ms`, { taskId, maxWaitMs });
  }

  async sleepWithinDeadline(delayMs, remainingMs) {
    let timer;
    const deadlineReached = Symbol('deadlineReached');
    const result = await Promise.race([
      this.sleep(delayMs),
      new Promise(resolve => { timer = setTimeout(() => resolve(deadlineReached), remainingMs); })
    ]);
    clearTimeout(timer);
    return result !== deadlineReached;
  }

  async waitForCompletion(taskId, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? RUNNINGHUB_DEFAULTS.pollIntervalMs;
    const maxWaitMs = options.maxWaitMs ?? RUNNINGHUB_DEFAULTS.maxWaitMs;
    const deadline = this.now() + maxWaitMs;
    while (true) {
      const remainingBeforeQuery = deadline - this.now();
      if (remainingBeforeQuery <= 0) return this.pollTimeout(taskId, maxWaitMs);
      let result;
      try {
        result = await this.query(taskId, { timeoutMs: Math.min(this.requestTimeoutMs, remainingBeforeQuery) });
      } catch (error) {
        if (error instanceof RunningHubError && error.kind === 'timeout' && this.now() >= deadline) {
          return this.pollTimeout(taskId, maxWaitMs);
        }
        if (error instanceof RunningHubError && error.kind === 'timeout' && remainingBeforeQuery < this.requestTimeoutMs) {
          return this.pollTimeout(taskId, maxWaitMs);
        }
        throw error;
      }
      const status = String(result?.status ?? result?.taskStatus ?? '').toUpperCase();
      if (status === 'SUCCESS') return result;
      if (status === 'FAILED') {
        const failedReason = result?.failedReason;
        const nestedMessage = typeof failedReason === 'string'
          ? failedReason
          : failedReason?.exception_message ?? failedReason?.traceback;
        const reason = [result?.errorMessage, nestedMessage]
          .filter(value => typeof value === 'string' && value.trim() !== '')
          .map(value => value.trim())
          .join('; ');
        const safeReason = redact(reason, [this.apiKey]);
        const details = redact({
          taskId,
          errorCode: result?.errorCode,
          errorMessage: result?.errorMessage,
          failedReason
        }, [this.apiKey]);
        await this.record({ operation: 'poll', taskId, outcome: 'failed', errorCode: result?.errorCode, failedReason: details.failedReason });
        throw new RunningHubError('failed', `RunningHub task FAILED${safeReason ? `: ${safeReason}` : ''}`, details);
      }
      const remainingBeforeSleep = deadline - this.now();
      if (remainingBeforeSleep <= 0) return this.pollTimeout(taskId, maxWaitMs);
      const slept = await this.sleepWithinDeadline(Math.min(pollIntervalMs, remainingBeforeSleep), remainingBeforeSleep);
      if (!slept) return this.pollTimeout(taskId, maxWaitMs);
    }
  }

  async downloadResults(result, destination) {
    const outputs = result?.taskOutputs ?? result?.outputs ?? result?.results ?? result?.data ?? [];
    const list = Array.isArray(outputs) ? outputs : [outputs];
    const targets = list.map(outputUrl).filter(Boolean).map(safeDownloadTarget);
    if (targets.length === 0) throw new RunningHubError('http', 'RunningHub SUCCESS response has no downloadable outputs');
    await mkdir(destination, { recursive: true });
    const localPaths = [];
    for (const [index, target] of targets.entries()) {
      const temporaryPath = join(destination, `.result-${index + 1}-${randomUUID()}.part`);
      try {
        const finalPath = await this.withTimeout(this.requestTimeoutMs, async signal => {
          let effectiveTarget = target;
          let response;
          for (let redirects = 0; ; redirects += 1) {
            response = await this.fetch(effectiveTarget.url, { redirect: 'manual', signal });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            if (redirects >= MAX_DOWNLOAD_REDIRECTS) throw new RunningHubError('security', `RunningHub download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`);
            const location = response.headers.get('location');
            if (!location) throw new RunningHubError('security', 'RunningHub redirect has no Location header');
            effectiveTarget = safeDownloadTarget(new URL(location, effectiveTarget.url).href);
          }
          if (!response.ok) throw new RunningHubError('http', `RunningHub result download failed (${response.status})`, { status: response.status });
          if (response.url) effectiveTarget = safeDownloadTarget(response.url);
          const declaredLength = Number(response.headers.get('content-length'));
          if (Number.isFinite(declaredLength) && declaredLength > this.maxDownloadBytes) {
            throw new RunningHubError('size', `RunningHub result exceeds ${this.maxDownloadBytes} bytes`);
          }
          if (!response.body) throw new RunningHubError('http', 'RunningHub result download has no response body');
          let received = 0;
          const limiter = new Transform({
            transform: (chunk, _encoding, callback) => {
              received += chunk.length;
              if (received > this.maxDownloadBytes) callback(new RunningHubError('size', `RunningHub result exceeds ${this.maxDownloadBytes} bytes`));
              else callback(null, chunk);
            }
          });
          await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
          for (let suffix = 0; ; suffix += 1) {
            const name = suffix === 0 ? `result-${index + 1}${effectiveTarget.extension}` : `result-${index + 1}-${suffix}${effectiveTarget.extension}`;
            const candidate = join(destination, name);
            try {
              await copyFile(temporaryPath, candidate, constants.COPYFILE_EXCL);
              return candidate;
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
            }
          }
        });
        localPaths.push(finalPath);
      } catch (error) {
        if (error instanceof RunningHubError) throw error;
        throw new RunningHubError('network', 'RunningHub result download failed');
      } finally {
        await rm(temporaryPath, { force: true });
      }
    }
    await this.record({ operation: 'download', outcome: 'success', localOutputs: localPaths });
    return localPaths;
  }
}
