import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { runNext } from '../../src/commands/next.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { runQualityReview } from '../../src/commands/quality-review.js';
import { runSegmentContract } from '../../src/commands/segment-contract.js';

test('next and doctor commands expose service results without mutating the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governance-command-'));
  await initializeProject(root, { projectId: 'COMMAND-1', workflowVersion: 1 });
  const next = await runNext(['--project', root]);
  assert.deepEqual(next.actions.map(({ id }) => id), ['register_required_inputs']);
  const doctor = await runDoctor(['--project', root], {
    nodeVersion: 'v22.0.0', env: { RUNNINGHUB_API_KEY: 'hidden' },
    runner: async () => ({ code: 0, stdout: '', stderr: '' })
  });
  assert.equal(doctor.status, 'PASS');
  assert.equal(JSON.stringify(doctor).includes('hidden'), false);
});

test('quality-review and segment-contract commands require project-local JSON input files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governance-input-command-'));
  await initializeProject(root, { projectId: 'COMMAND-2', workflowVersion: 1 });
  await writeFile(join(root, 'reviews', 'quality-input.json'), '{}\n');
  await writeFile(join(root, 'segments', 'contract-input.json'), '{}\n');
  await assert.rejects(runQualityReview(['--project', root, '--input', 'reviews/quality-input.json']), /artifactId/);
  await assert.rejects(runSegmentContract(['--project', root, '--input', 'segments/contract-input.json']), /id/);
  await assert.rejects(runQualityReview(['--project', root, '--input', '../outside.json']), /inside project root/);
});
