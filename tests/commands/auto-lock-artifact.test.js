import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { runAutoLockArtifact } from '../../src/commands/auto-lock-artifact.js';
import { readJson } from '../../src/storage/json-store.js';

test('auto-lock command only locks an allowed auto-lock artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-lock-command-'));
  await initializeProject(root, { projectId: 'AUTOLOCK-1', workflowVersion: 2 });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'prompt.txt'), 'standalone prompt\n');
  await registerArtifact(root, {
    id: 'prompt-v1', type: 'seedance_prompt', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'prompts/prompt.txt'
  });

  const review = await runAutoLockArtifact([
    '--project', root, '--artifact', 'prompt-v1', '--note', 'machine checks passed'
  ]);
  assert.equal(review.actor, 'system');
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(item => item.id === 'prompt-v1').status, 'locked');
});
