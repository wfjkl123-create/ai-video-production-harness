import test from 'node:test';
import assert from 'node:assert/strict';
import { executeParallelImageTaskPlan, planParallelImageTasks } from '../../src/services/image-task-dispatcher-service.js';
import { visualStyleContract } from '../helpers/image-prompt-fixture.js';

const task = (id, category, subjectKey, dependencies = [], style = visualStyleContract()) => ({
  id, category, subjectKey, workerRole: `${category}_worker`, dependencies,
  request: { templateSource: `knowledge/${category}.md`, skillsApplied: [`${category}-skill`], visualStyleContract: style }
});

test('groups asset types and independent subjects into parallel lanes', () => {
  const plan = planParallelImageTasks([
    task('char-a-front', 'character', 'character-a'),
    task('char-a-back', 'character', 'character-a'),
    task('char-b-front', 'character', 'character-b'),
    task('scene-home', 'scene', 'scene-home'),
    task('prop-shirt', 'prop', 'prop-shirt')
  ]);
  assert.equal(plan.laneCount, 4);
  assert.equal(plan.waves.length, 1);
  assert.equal(plan.waves[0].lanes.find(lane => lane.id === 'character:character-a').tasks.length, 2);
});

test('isolates a failed lane and continues unrelated lanes', async () => {
  const plan = planParallelImageTasks([
    task('character-a', 'character', 'character-a'),
    task('scene-home', 'scene', 'scene-home'),
    task('prop-after-character', 'prop', 'prop-shirt', ['character-a'])
  ]);
  const result = await executeParallelImageTaskPlan(plan, { worker: async current => {
    if (current.id === 'character-a') throw new Error('identity generation failed');
    return `${current.id}-done`;
  } });
  assert.equal(result.outcomes.find(item => item.taskId === 'scene-home').status, 'fulfilled');
  assert.equal(result.outcomes.find(item => item.taskId === 'character-a').status, 'rejected');
  assert.equal(result.outcomes.find(item => item.taskId === 'prop-after-character').status, 'blocked');
});

test('keeps incompatible surface contracts in separate dispatch lanes', () => {
  const plan = planParallelImageTasks([
    task('character-a', 'character', 'character-a'),
    task('scene-home', 'scene', 'scene-home', [], visualStyleContract({ version: 2 }))
  ]);
  assert.equal(plan.visualStyleFingerprints.length, 2);
  assert.equal(plan.laneCount, 2);
  assert.notEqual(plan.waves[0].lanes[0].styleFingerprint, plan.waves[0].lanes[1].styleFingerprint);
});
