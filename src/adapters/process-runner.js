import { spawn } from 'node:child_process';
import { constants, existsSync, accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// launchd starts desktop services with a minimal PATH.  LibTV is installed in
// the owner's home directory, so resolving it here keeps every server route
// (canvas preparation, result sync, readiness) working after a restart.
// The environment override is retained for non-default installations.
function resolvedExecutable(executable) {
  if (executable !== 'libtv') return executable;
  const candidates = [
    process.env.HARNESS_LIBTV_EXECUTABLE,
    join(homedir(), '.libtv', 'libtv'),
    '/opt/homebrew/bin/libtv',
    '/usr/local/bin/libtv'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue to the next explicit installation location, then preserve
      // the original command so callers receive the normal spawn error.
    }
  }
  return executable;
}

export function runProcess(executable, args, { cwd, env, stdin } = {}) {
  if (typeof executable !== 'string' || !Array.isArray(args)) {
    throw new TypeError('executable must be a string and args must be an array');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(resolvedExecutable(executable), args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
