import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

export const RUNNINGHUB_KEYCHAIN_SERVICE = 'ai-video-harness.runninghub.api-key';

const knownSecrets = new Set();
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie)$/i;

function redactString(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function redact(value, additionalSecrets = []) {
  const secrets = new Set([...knownSecrets, ...additionalSecrets].filter(secret => typeof secret === 'string' && secret.length > 0));
  const visit = (current, key) => {
    if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (typeof current === 'string') return redactString(current, secrets);
    if (Array.isArray(current)) return current.map(item => visit(item));
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    return current;
  };
  return visit(value);
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[match[1]] = value;
  }
  return values;
}

export function readRunningHubKeychain({ execFile = execFileSync, account = userInfo().username } = {}) {
  try {
    const value = execFile('/usr/bin/security', [
      'find-generic-password', '-a', account, '-s', RUNNINGHUB_KEYCHAIN_SERVICE, '-w'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function loadSecrets(root = process.cwd(), env = process.env, options = {}) {
  let apiKey = env.RUNNINGHUB_API_KEY?.trim();
  if (!apiKey) {
    try {
      apiKey = parseEnv(readFileSync(join(root, '.env.local'), 'utf8')).RUNNINGHUB_API_KEY?.trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!apiKey) apiKey = (options.keychainReader ?? readRunningHubKeychain)()?.trim();
  if (!apiKey) throw new Error('RUNNINGHUB_API_KEY is not configured');
  knownSecrets.add(apiKey);
  return { runningHubApiKey: apiKey };
}
