import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { initializeProject } from '../../src/services/project-service.js';
import { isPathInside, persistSegmentation } from '../../src/services/segmentation-workflow-service.js';
import { runSegments } from '../../src/commands/segments.js';
import { writeJsonAtomic, readJson } from '../../src/storage/json-store.js';

const segment = { id: 'segment-001', duration: 10, status: 'awaiting_review' };

test('path containment uses path semantics compatible with Windows separators', () => {
  assert.equal(isPathInside('C:\\project\\segments', 'C:\\project\\segments\\approved.json', win32), true);
  assert.equal(isPathInside('C:\\project\\segments', 'C:\\project\\segments-escape\\bad.json', win32), false);
  assert.equal(isPathInside('C:\\project\\segments', 'D:\\other\\bad.json', win32), false);
});

test('segmentation persistence rejects a segments-directory symlink escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'segmentation-symlink-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'segmentation-symlink-outside-'));
  await initializeProject(root, { projectId: 'SEGMENT-SYMLINK' });
  await rename(join(root, 'segments'), join(root, 'segments-real'));
  await symlink(outside, join(root, 'segments'));
  await assert.rejects(persistSegmentation(root, {
    id: 'segmentation-escape', path: 'segments/escape.json', segments: [segment]
  }), /segments directory|stay.*segments|symlink/i);
});

test('segments CLI preserves a story-plan semantic binding from the input document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'segmentation-story-binding-'));
  await mkdir(join(root, 'segments'), { recursive: true });
  const input = {
    storyPlanBinding: { storyPlanId: 'story-plan-v1', storyPlanSemanticSha256: 'a'.repeat(64) },
    segments: [{
      id: 'segment-001', duration: 15, timeRange: [0, 15], narrativeTask: '完整承接一个清楚的动作因果',
      startState: { storyState: '开始' }, actionNodes: ['trigger'], endState: { storyState: '结束' },
      projectAssetIds: [], segmentAssetRequirements: [], previousSegmentId: null, nextSegmentId: null, status: 'awaiting_review'
    }]
  };
  await writeJsonAtomic(join(root, 'inputs.json'), input);
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'SEGMENT-BINDING', phase: 'story_plan_review', activeSegmentId: null, blockedReason: null,
    artifacts: [], updatedAt: '2026-08-14T00:00:00Z'
  });
  await runSegments(['--project', root, '--input', 'inputs.json', '--artifact', 'segmentation-v1', '--output', 'segments/segmentation-v1.json', '--revision', '1']);
  const persisted = await readJson(join(root, 'segments/segmentation-v1.json'));
  assert.deepEqual(persisted.storyPlanBinding, input.storyPlanBinding);
});
