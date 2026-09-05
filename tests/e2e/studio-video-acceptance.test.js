import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { issueOwnerSession } from '../../src/services/studio-team-access-service.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';

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

test('Studio serves layered video acceptance evidence for a video segment artifact', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-video-acceptance-'));
  const projectsRoot = join(root, 'projects');
  const stateRoot = join(root, 'state');
  const projectRoot = join(projectsRoot, 'vid-acceptance');
  await initializeProject(projectRoot, { projectId: 'vid-acceptance', workflowVersion: 2 });
  await mkdir(join(projectRoot, 'outputs'), { recursive: true });
  await mkdir(join(projectRoot, 'runs'), { recursive: true });

  const ffmpeg = process.env.HARNESS_FFMPEG_EXECUTABLE ?? 'ffmpeg';
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    join(projectRoot, 'outputs', 'vid.mp4')
  ]);

  await writeJsonAtomic(join(projectRoot, 'runs', 'vid-run-1.json'), {
    id: 'vid-run-1', kind: 'libtv_video', tool: 'libtv', status: 'SUCCESS', segmentId: 'segment-001',
    taskId: 'task-1',
    bindingSnapshot: {
      capturedAt: '2026-08-24T00:00:00Z', model: 'Seedance 2.0 VIP', modeType: 'mixed2video',
      settings: { ratio: '9:16', resolution: '720p', duration: 12, enableSound: 'on' },
      mixedList: [{ label: 'i1-test', mediaType: 'image', nodeId: 'node-1', durationSec: null, width: 941, height: 1672 }]
    },
    outputs: [{ path: 'outputs/vid.mp4', sha256: 'pending' }],
    createdAt: '2026-08-24T00:00:00Z', updatedAt: '2026-08-24T00:00:00Z'
  });
  const artifact = await registerArtifact(projectRoot, {
    id: 'vid-art-1', type: 'video_segment', revision: 1, status: 'draft',
    path: 'outputs/vid.mp4', mediaKind: 'video', segmentId: 'segment-001', videoRunId: 'vid-run-1'
  });

  const owner = await issueOwnerSession(stateRoot);
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

  const response = await fetch(`http://127.0.0.1:${port}/api/projects/vid-acceptance/artifacts/vid-art-1`, {
    headers: { cookie: `harness_studio_session=${owner.token}` }
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.artifact.id, artifact.id);
  const acceptance = detail.videoAcceptance;
  assert.ok(acceptance, 'video_segment artifact must include layered acceptance evidence');
  assert.equal(acceptance.spec.width, 320);
  assert.equal(acceptance.spec.height, 568);
  assert.equal(acceptance.spec.hasAudio, true);
  assert.ok(acceptance.spec.durationSec > 1.5 && acceptance.spec.durationSec < 2.5);
  assert.equal(acceptance.binding.model, 'Seedance 2.0 VIP');
  assert.equal(acceptance.binding.mixedList[0].label, 'i1-test');
  assert.ok(acceptance.contentFrameStrip.startsWith('data:image/jpeg;base64,'), 'content layer must ship a frame strip');
});
