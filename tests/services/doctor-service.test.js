import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { inspectProjectHealth } from '../../src/services/doctor-service.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';

async function healthyProject() {
  const root = await mkdtemp(join(tmpdir(), 'doctor-'));
  await initializeProject(root, { projectId: 'DOCTOR-1' });
  return root;
}

const healthyRunner = async (executable, args) => {
  if (executable === 'ffmpeg' && args[0] === '-version') return { code: 0, stdout: 'ffmpeg version 7', stderr: '' };
  if (executable === 'libtv' && args[0] === '--version') return { code: 0, stdout: '1.1.1', stderr: '' };
  if (executable === 'libtv' && args[0] === 'account' && args[1] === 'info') return { code: 0, stdout: '{"loggedIn":true}', stderr: '' };
  throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
};

test('healthy doctor report is read-only and never exposes the RunningHub secret', async () => {
  const root = await healthyProject();
  const secret = 'secret-that-must-not-appear';
  const report = await inspectProjectHealth(root, {
    runner: healthyRunner,
    env: { RUNNINGHUB_API_KEY: secret },
    nodeVersion: 'v22.15.0'
  });
  assert.equal(report.status, 'PASS');
  assert.ok(report.checks.every(check => check.status === 'PASS'));
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(report.checks.map(({ id }) => id), [
    'node', 'project_state', 'project_write', 'ffmpeg', 'libtv_version', 'libtv_account',
    'runninghub_key', 'transactions', 'project_lock', 'uncertain_submissions', 'locked_artifacts'
  ]);
});

test('doctor recognizes a project-local env file without exposing its value', async () => {
  const root = await healthyProject();
  const secret = 'local-file-secret';
  await writeFile(join(root, '.env.local'), `RUNNINGHUB_API_KEY=${secret}\n`);
  const report = await inspectProjectHealth(root, {
    runner: healthyRunner, env: {}, nodeVersion: 'v22.15.0'
  });
  assert.equal(report.checks.find(check => check.id === 'runninghub_key').status, 'PASS');
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('doctor recognizes a global Keychain fallback without exposing its value', async () => {
  const root = await healthyProject();
  const secret = 'global-keychain-secret';
  const report = await inspectProjectHealth(root, {
    runner: healthyRunner, env: {}, nodeVersion: 'v22.15.0', keychainReader: () => secret
  });
  assert.equal(report.checks.find(check => check.id === 'runninghub_key').status, 'PASS');
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('doctor fails on pending transactions, project lock, and uncertain submit while a missing optional RunningHub key only warns', async () => {
  const root = await healthyProject();
  await mkdir(join(root, '.transactions'), { recursive: true });
  await writeJsonAtomic(join(root, '.transactions', 'pending.json'), { id: 'pending', status: 'PENDING', writes: [] });
  await writeFile(join(root, '.review-mutation.lock'), '{"pid":123}\n');
  await writeJsonAtomic(join(root, 'runs', 'uncertain.json'), {
    id: 'uncertain', kind: 'runninghub_video', status: 'SUBMITTING', taskId: null, submissionUncertain: true
  });
  const report = await inspectProjectHealth(root, {
    runner: healthyRunner, env: {}, nodeVersion: 'v22.15.0', keychainReader: () => undefined
  });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.checks.find(check => check.id === 'runninghub_key').status, 'WARN');
  for (const id of ['transactions', 'project_lock', 'uncertain_submissions']) {
    assert.equal(report.checks.find(check => check.id === id).status, 'FAIL');
  }
});

test('doctor reports tool failures without leaking stderr or authentication output', async () => {
  const root = await healthyProject();
  const secret = 'stderr-secret';
  const report = await inspectProjectHealth(root, {
    env: { RUNNINGHUB_API_KEY: 'present' }, nodeVersion: 'v20.0.0',
    runner: async executable => ({ code: 1, stdout: `token=${secret}`, stderr: `token=${secret} ${executable}` })
  });
  assert.equal(report.status, 'FAIL');
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.checks.find(check => check.id === 'node').status, 'FAIL');
  assert.equal(report.checks.find(check => check.id === 'ffmpeg').status, 'FAIL');
  assert.equal(report.checks.find(check => check.id === 'libtv_account').status, 'FAIL');
});
