import { constants } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../adapters/process-runner.js';
import { loadSecrets } from '../config/env.js';
import { assertProjectState } from '../domain/project-state.js';
import { readJson } from '../storage/json-store.js';
import { verifyLockedArtifact } from './artifact-file-service.js';

function check(id, status, message) {
  return { id, status, message };
}

async function toolCheck(id, executable, args, runner) {
  try {
    const result = await runner(executable, args, { shell: false });
    return result?.code === 0
      ? check(id, 'PASS', `${executable} is available`)
      : check(id, 'FAIL', `${executable} check failed`);
  } catch {
    return check(id, 'FAIL', `${executable} is unavailable`);
  }
}

async function jsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('._'));
}

export async function inspectProjectHealth(root, options = {}) {
  const projectRoot = resolve(root);
  const runner = options.runner ?? runProcess;
  const env = options.env ?? process.env;
  const keychainReader = options.keychainReader;
  const nodeVersion = options.nodeVersion ?? process.version;
  const checks = [];

  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
  checks.push(major >= 22
    ? check('node', 'PASS', `Node ${major} satisfies the minimum`)
    : check('node', 'FAIL', 'Node 22 or newer is required'));

  let state;
  try {
    state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
    checks.push(check('project_state', 'PASS', `project ${state.projectId} state is valid`));
  } catch {
    checks.push(check('project_state', 'FAIL', 'project state is missing or invalid'));
  }

  try {
    await access(projectRoot, constants.R_OK | constants.W_OK);
    checks.push(check('project_write', 'PASS', 'project root is readable and writable'));
  } catch {
    checks.push(check('project_write', 'FAIL', 'project root is not readable and writable'));
  }

  checks.push(await toolCheck('ffmpeg', 'ffmpeg', ['-version'], runner));
  checks.push(await toolCheck('libtv_version', 'libtv', ['--version'], runner));
  checks.push(await toolCheck('libtv_account', 'libtv', ['account', 'info'], runner));
  try {
    loadSecrets(projectRoot, env, { keychainReader });
    checks.push(check('runninghub_key', 'PASS', 'RunningHub API key is present'));
  } catch {
    checks.push(check('runninghub_key', 'WARN', 'RunningHub API key is missing; default LibTV workflow remains available'));
  }

  try {
    const transactions = await jsonFiles(join(projectRoot, '.transactions'));
    const pending = [];
    for (const entry of transactions) {
      const value = await readJson(join(projectRoot, '.transactions', entry.name));
      if (value?.status === 'PENDING') pending.push(value.id ?? entry.name);
    }
    checks.push(pending.length === 0
      ? check('transactions', 'PASS', 'no pending transaction journals')
      : check('transactions', 'FAIL', `${pending.length} pending transaction journal(s) require recovery`));
  } catch {
    checks.push(check('transactions', 'FAIL', 'transaction journals cannot be inspected'));
  }

  try {
    await lstat(join(projectRoot, '.review-mutation.lock'));
    checks.push(check('project_lock', 'FAIL', 'project mutation lock exists; verify the owner before recovery'));
  } catch (error) {
    checks.push(error.code === 'ENOENT'
      ? check('project_lock', 'PASS', 'no project mutation lock')
      : check('project_lock', 'FAIL', 'project mutation lock cannot be inspected'));
  }

  try {
    const runs = await jsonFiles(join(projectRoot, 'runs'));
    let uncertain = 0;
    for (const entry of runs) {
      const value = await readJson(join(projectRoot, 'runs', entry.name));
      if (value?.kind === 'runninghub_video' && value.status === 'SUBMITTING' && value.taskId === null) uncertain += 1;
      if (value?.kind === 'libtv_video' && ['PREPARING', 'SUBMITTING', 'UNCERTAIN', 'INTERRUPTED_DOWNLOAD'].includes(value.status)) uncertain += 1;
      if (value?.kind === 'external_model_audit' && ['SUBMITTING', 'UNCERTAIN'].includes(value.status)) uncertain += 1;
    }
    checks.push(uncertain === 0
      ? check('uncertain_submissions', 'PASS', 'no unresolved external submissions')
      : check('uncertain_submissions', 'FAIL', `${uncertain} unresolved external submission(s) require reconciliation`));
  } catch {
    checks.push(check('uncertain_submissions', 'FAIL', 'generation runs cannot be inspected'));
  }

  if (!state) {
    checks.push(check('locked_artifacts', 'FAIL', 'locked artifacts cannot be inspected without valid project state'));
  } else {
    const failures = [];
    for (const artifact of state.artifacts.filter(item => item.status === 'locked' && item.type !== 'handoff')) {
      try {
        await verifyLockedArtifact(projectRoot, artifact);
      } catch {
        failures.push(artifact.id);
      }
    }
    checks.push(failures.length === 0
      ? check('locked_artifacts', 'PASS', 'locked artifact files and reviews are intact')
      : check('locked_artifacts', 'FAIL', `${failures.length} locked artifact(s) failed integrity checks`));
  }

  return {
    status: checks.some(item => item.status === 'FAIL') ? 'FAIL' : checks.some(item => item.status === 'WARN') ? 'WARN' : 'PASS',
    project: state?.projectId ?? null,
    checks
  };
}
