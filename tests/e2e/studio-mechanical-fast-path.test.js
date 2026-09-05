import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { autoLockArtifact } from '../../src/services/review-service.js';
import { issueOwnerSession } from '../../src/services/studio-team-access-service.js';

const execFileAsync = promisify(execFile);

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

test('Studio mechanical endpoint cuts, compiles, and stops before paid LibTV generation', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-mechanical-e2e-'));
  const projectsRoot = join(root, 'projects');
  const stateRoot = join(root, 'state');
  const projectRoot = join(projectsRoot, 'mechanical-001');
  const routeDecision = {
    policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input_and_creation_intent',
    inputTypes: ['video', 'image'], sourceVideoIds: ['source-video-001'], assetInputIds: ['product-001'],
    referenceRoleStatus: 'authority', executionClass: 'mechanical_asset_prompt'
  };
  await initializeProject(projectRoot, { projectId: 'mechanical-001', routeDecision });
  await mkdir(join(projectRoot, 'assets', 'project'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=1',
    '-t', '30', '-pix_fmt', 'yuv420p', join(projectRoot, 'brief', 'source.mp4')
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:size=64x64',
    '-frames:v', '1', join(projectRoot, 'assets', 'project', 'product.png')
  ]);
  await registerArtifact(projectRoot, {
    id: 'source-video-001', type: 'reference_video', revision: 1, status: 'draft', path: 'brief/source.mp4'
  });
  await autoLockArtifact(projectRoot, 'source-video-001', 'test source lock');
  await registerArtifact(projectRoot, {
    id: 'product-001', type: 'project_asset', assetType: 'product_reference', mediaKind: 'image',
    revision: 1, status: 'draft', path: 'assets/project/product.png'
  });
  await autoLockArtifact(projectRoot, 'product-001', 'test mechanical product lock', {
    delegatedByExecutionClass: 'mechanical_asset_prompt'
  });

  const owner = await issueOwnerSession(stateRoot);
  const port = await freePort();
  const child = spawn(process.execPath, ['apps/harness-studio/server.js'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env, HARNESS_PROJECTS_ROOT: projectsRoot, HARNESS_STUDIO_STATE_ROOT: stateRoot,
      HARNESS_STUDIO_PORT: String(port), HARNESS_STUDIO_HOST: '127.0.0.1', HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(child, port);
  const base = `http://127.0.0.1:${port}`;
  const cookie = `harness_studio_session=${owner.token}`;
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-harness-csrf': session.csrfToken };

  const before = await (await fetch(`${base}/api/projects/mechanical-001`, { headers: { cookie } })).json();
  assert.equal(before.next.actions[0].id, 'prepare_mechanical_asset_prompt_package');
  assert.deepEqual(before.visibleSteps.map(step => step.gate), [4]);

  const response = await fetch(`${base}/api/projects/mechanical-001/mechanical-package`, {
    method: 'POST', headers, body: JSON.stringify({ confirm: true, segmentDurationSec: 15 })
  });
  assert.equal(response.status, 201);
  const prepared = await response.json();
  assert.equal(prepared.package.segmentCount, 2);
  assert.deepEqual(prepared.package.segments.map(segment => segment.durationSec), [15, 15]);
  assert.equal(prepared.package.assistantMaySubmitPaidGeneration, false);
  assert.equal(prepared.canvas, null);

  const after = await (await fetch(`${base}/api/projects/mechanical-001`, { headers: { cookie } })).json();
  assert.equal(after.next.actions[0].id, 'prepare_mechanical_libtv_canvas');
  assert.equal(after.mechanicalCanvas, null);

  const reconfiguredResponse = await fetch(`${base}/api/projects/mechanical-001/mechanical-package`, {
    method: 'POST', headers, body: JSON.stringify({ confirm: true, segmentDurationSec: 10, maxDurationSec: 20 })
  });
  assert.equal(reconfiguredResponse.status, 201);
  const reconfigured = await reconfiguredResponse.json();
  assert.equal(reconfigured.reused, false);
  assert.equal(reconfigured.package.segmentCount, 2);
  assert.deepEqual(reconfigured.package.segments.map(segment => segment.durationSec), [10, 10]);
});
