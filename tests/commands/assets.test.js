import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileProjectAssetManifest } from '../../src/commands/assets.js';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';

test('project asset compilation refuses an invalidated locked story plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assets-invalidated-story-'));
  await initializeProject(root, { projectId: 'ASSETS-INVALIDATED-STORY', workflowVersion: 2 });
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.push({
    id: 'story-old', type: 'story_plan', revision: 1, status: 'locked', path: 'planning/story-old.json',
    sha256: 'a'.repeat(64), lockedByReviewId: 'review-story-old',
    invalidatedByScopeRevisionId: 'direction-revision-2', invalidationReason: 'scope changed'
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await assert.rejects(
    compileProjectAssetManifest(root, 'segment-001'),
    /requires a locked human-reviewed story_plan/
  );
});
