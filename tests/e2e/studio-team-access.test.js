import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeProject } from '../../src/services/project-service.js';
import {
  assignStudioProjectOwner,
  createStudioInvite,
  issueOwnerSession
} from '../../src/services/studio-team-access-service.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function waitForServer(child, port) {
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10_000;
  while (!output.includes(`127.0.0.1:${port}`)) {
    if (child.exitCode !== null) throw new Error(`Studio exited early: ${output}`);
    if (Date.now() > deadline) throw new Error(`Studio did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function rawStatus(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

test('Studio team links isolate projects, bind CSRF to sessions, and preserve owner visibility', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-team-e2e-'));
  const projectsRoot = join(root, 'projects');
  const stateRoot = join(root, 'state');
  const inviteA = await createStudioInvite(stateRoot, '同事 A');
  const inviteB = await createStudioInvite(stateRoot, '同事 B');
  const owner = await issueOwnerSession(stateRoot);
  await initializeProject(join(projectsRoot, 'project-a'), { projectId: 'project-a', workflowVersion: 2 });
  await initializeProject(join(projectsRoot, 'project-b'), { projectId: 'project-b', workflowVersion: 2 });
  await assignStudioProjectOwner(stateRoot, 'project-a', inviteA.principal.id);
  await assignStudioProjectOwner(stateRoot, 'project-b', inviteB.principal.id);

  const port = await freePort();
  const child = spawn(process.execPath, ['apps/harness-studio/server.js'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      HARNESS_PROJECTS_ROOT: projectsRoot,
      HARNESS_STUDIO_STATE_ROOT: stateRoot,
      HARNESS_STUDIO_PORT: String(port),
      HARNESS_STUDIO_HOST: '127.0.0.1',
      HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(child, port);
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  const joinA = await fetch(`${base}/join/${inviteA.token}`, { redirect: 'manual' });
  const joinB = await fetch(`${base}/join/${inviteB.token}`, { redirect: 'manual' });
  assert.equal(joinA.status, 303);
  assert.equal(joinB.status, 303);
  assert.equal((await fetch(`${base}/join/${inviteA.token}`, { redirect: 'manual' })).status, 410);
  const cookieA = cookieFrom(joinA);
  const cookieB = cookieFrom(joinB);
  const cookieOwner = `${'harness_studio_session'}=${owner.token}`;

  const projectsA = await (await fetch(`${base}/api/projects`, { headers: { cookie: cookieA } })).json();
  const projectsOwner = await (await fetch(`${base}/api/projects`, { headers: { cookie: cookieOwner } })).json();
  assert.deepEqual(projectsA.projects.map(item => item.slug), ['project-a']);
  assert.deepEqual(new Set(projectsOwner.projects.map(item => item.slug)), new Set(['project-a', 'project-b']));
  assert.equal(projectsA.executionPortfolio.scope.totalProjects, 1);
  assert.deepEqual(projectsA.executionPortfolio.projects.map(item => item.slug), ['project-a']);
  assert.equal(projectsOwner.executionPortfolio.scope.totalProjects, 2);
  const portfolioA = await (await fetch(`${base}/api/execution-ledger/portfolio`, { headers: { cookie: cookieA } })).json();
  assert.equal(portfolioA.scope.totalProjects, 1);
  assert.deepEqual(portfolioA.projects.map(item => item.slug), ['project-a']);
  assert.equal((await fetch(`${base}/api/projects/project-a`, { headers: { cookie: cookieB } })).status, 404);
  assert.equal((await fetch(`${base}/api/projects/project-a/media/guessed-asset`, { headers: { cookie: cookieB, range: 'bytes=0-10' } })).status, 404);

  const sessionA = await (await fetch(`${base}/api/session`, { headers: { cookie: cookieA } })).json();
  const sessionB = await (await fetch(`${base}/api/session`, { headers: { cookie: cookieB } })).json();
  const mismatch = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { cookie: cookieA, origin: base, 'content-type': 'application/json', 'x-harness-csrf': sessionB.csrfToken },
    body: JSON.stringify({ projectId: 'forbidden', confirm: true })
  });
  assert.equal(mismatch.status, 403);
  const valid = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { cookie: cookieA, origin: base, 'content-type': 'application/json', 'x-harness-csrf': sessionA.csrfToken },
    body: JSON.stringify({ projectId: 'created-by-a', confirm: true })
  });
  assert.equal(valid.status, 201);
  const created = await valid.json();
  assert.match(created.slug, /^[a-f0-9]{8}-created-by-a$/);
  assert.equal((await fetch(`${base}/api/projects/${created.slug}`, { headers: { cookie: cookieB } })).status, 404);
  const chineseProject = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { cookie: cookieA, origin: base, 'content-type': 'application/json', 'x-harness-csrf': sessionA.csrfToken },
    body: JSON.stringify({ projectId: '夏日收腹裤-001', confirm: true })
  });
  assert.equal(chineseProject.status, 201);
  const chineseCreated = await chineseProject.json();
  assert.match(chineseCreated.slug, /^[a-f0-9]{8}-夏日收腹裤-001$/);
  assert.equal((await fetch(`${base}/api/projects/${encodeURIComponent(chineseCreated.slug)}`, { headers: { cookie: cookieA } })).status, 200);
  assert.equal(await rawStatus(port, '/api/projects', { cookie: cookieA, host: `example.com:${port}` }), 403);
  const missingOrigin = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', 'x-harness-csrf': sessionA.csrfToken },
    body: JSON.stringify({ projectId: 'missing-origin', confirm: true })
  });
  assert.equal(missingOrigin.status, 403);
});
