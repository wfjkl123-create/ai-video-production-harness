import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/services/project-service.js';
import { sha256File } from '../../src/storage/checksum.js';

const execFileAsync = promisify(execFile);

test('record-execution-observation CLI records one SHA-bound v2 measurement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-observation-cli-'));
  await initializeProject(root, { projectId: 'OBSERVATION-CLI' });
  await mkdir(join(root, 'traces'), { recursive: true });
  const evidencePath = join(root, 'traces', 'timing.json');
  await writeFile(evidencePath, '{"machineExecutionMs":2500}\n');
  const inputPath = join(root, 'reviews', 'execution-observation-input.json');
  await writeFile(inputPath, `${JSON.stringify({
    schemaVersion: 2, kind: 'execution_observation_evidence',
    id: 'observation-cli-1', evidencePath: 'reviews/execution-observation-input.json',
    observedAt: '2026-08-24T10:00:00.000Z',
    actor: { kind: 'human', id: null }, segmentId: null, correlationId: null, causationId: null,
    sourceReferences: [{
      kind: 'execution_trace', id: 'timing', path: 'traces/timing.json', sha256: await sha256File(evidencePath)
    }],
    observation: { subjectId: 'timing', scope: 'project', stage: 'generation', timing: { machineExecutionMs: 2500 } }
  }, null, 2)}\n`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    'src/cli.js', 'record-execution-observation', '--project', root, '--input', inputPath
  ]);
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.event.schemaVersion, 2);
  assert.equal(result.event.observation.timing.machineExecutionMs, 2500);
});
