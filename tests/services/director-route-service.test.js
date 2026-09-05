import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadVerifiedCapabilityManifest, routeLockedStoryPlan } from '../../src/services/director-route-service.js';
import { initializeProject } from '../../src/services/project-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';

test('rejects an invalidated verified capability manifest before reading its file', async () => {
  const state = {
    verifiedCapabilityManifestId: 'capability-old',
    artifacts: [{
      id: 'capability-old', type: 'capability_manifest', revision: 1, status: 'locked',
      path: 'planning/capability-old.json', sha256: 'a'.repeat(64),
      invalidatedByScopeRevisionId: 'direction-revision-3'
    }]
  };
  await assert.rejects(
    loadVerifiedCapabilityManifest('/path-that-must-not-be-read', state),
    /was invalidated by direction-revision-3/
  );
});

test('does not route an invalidated locked story plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'director-route-invalidated-'));
  await initializeProject(root, { projectId: 'DIRECTOR-ROUTE-INVALIDATED', workflowVersion: 2 });
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts = [{
      id: 'story-old', type: 'story_plan', revision: 1, status: 'locked', path: 'planning/story-old.json',
      sha256: 'b'.repeat(64), lockedByReviewId: 'review-story-old',
      invalidatedByScopeRevisionId: 'direction-revision-2', invalidationReason: 'scope changed'
    }];
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await assert.rejects(routeLockedStoryPlan(root), /a locked story_plan is required/);
});
