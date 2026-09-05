import { canonicalJson } from '../domain/image-prompt-ir.js';
import { createHash } from 'node:crypto';

const CATEGORIES = new Set(['character', 'scene', 'prop', 'product', 'blocking', 'storyboard', 'color', 'other']);

function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function assertTask(task, index) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new TypeError(`tasks[${index}] must be an object`);
  nonEmpty(task.id, `tasks[${index}].id`);
  if (!CATEGORIES.has(task.category)) throw new TypeError(`tasks[${index}].category is unknown`);
  nonEmpty(task.subjectKey, `tasks[${index}].subjectKey`);
  nonEmpty(task.workerRole, `tasks[${index}].workerRole`);
  if (!Array.isArray(task.dependencies)) throw new TypeError(`tasks[${index}].dependencies must be an array`);
  if (!task.request || typeof task.request !== 'object') throw new TypeError(`tasks[${index}].request is required`);
  if (!Array.isArray(task.request.skillsApplied) || task.request.skillsApplied.length === 0) throw new TypeError(`tasks[${index}] requires skillsApplied`);
  nonEmpty(task.request.templateSource, `tasks[${index}].request.templateSource`);
  return task;
}

function styleFingerprint(task) {
  return createHash('sha256').update(canonicalJson(task.request.visualStyleContract)).digest('hex');
}

export function planParallelImageTasks(tasks, { executionMode = 'parallel', maxConcurrency = 8 } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError('tasks must be a non-empty array');
  if (!['parallel', 'sequential'].includes(executionMode)) throw new TypeError('executionMode must be parallel or sequential');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) throw new TypeError('maxConcurrency must be between 1 and 32');
  tasks.forEach(assertTask);
  const ids = tasks.map(task => task.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('task IDs must be unique');
  const idSet = new Set(ids);
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!idSet.has(dependency)) throw new TypeError(`task ${task.id} has unknown dependency ${dependency}`);
      if (dependency === task.id) throw new TypeError(`task ${task.id} cannot depend on itself`);
    }
  }
  // Textless story frames and text-light diagrams have intentionally different
  // surface contracts.  Keep their lanes isolated instead of weakening either
  // contract into a generic shared style.
  const stylesByTask = new Map(tasks.map(task => [task.id, styleFingerprint(task)]));

  const remaining = new Map(tasks.map(task => [task.id, structuredClone(task)]));
  const completed = new Set();
  const waves = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(task => task.dependencies.every(id => completed.has(id)));
    if (ready.length === 0) throw new Error('image task dependencies contain a cycle');
    const lanes = new Map();
    for (const task of ready) {
      const laneId = executionMode === 'sequential' ? 'sequential:all' : `${task.category}:${task.subjectKey}`;
      const style = stylesByTask.get(task.id);
      // Keep legacy-facing lane IDs readable, but key the internal grouping by
      // both style and lane so conflicting contracts can never share a worker.
      const laneKey = `${style}:${laneId}`;
      if (!lanes.has(laneKey)) lanes.set(laneKey, { id: laneId, styleFingerprint: style, workerRole: task.workerRole, tasks: [] });
      lanes.get(laneKey).tasks.push(task);
    }
    const laneList = [...lanes.values()].sort((left, right) => left.id.localeCompare(right.id));
    for (let offset = 0; offset < laneList.length; offset += executionMode === 'sequential' ? 1 : maxConcurrency) {
      const chunk = laneList.slice(offset, offset + (executionMode === 'sequential' ? 1 : maxConcurrency));
      waves.push({ index: waves.length, lanes: chunk });
    }
    for (const task of ready) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
  }

  return {
    kind: 'parallel_image_task_plan',
    executionMode,
    maxConcurrency,
    visualStyleFingerprints: [...new Set(tasks.map(task => stylesByTask.get(task.id)))].sort(),
    taskCount: tasks.length,
    laneCount: new Set(tasks.map(task => executionMode === 'sequential' ? 'sequential:all' : `${stylesByTask.get(task.id)}:${task.category}:${task.subjectKey}`)).size,
    waves
  };
}

export async function executeParallelImageTaskPlan(plan, { worker } = {}) {
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');
  const outcomes = new Map();
  for (const wave of plan.waves) {
    const laneResults = await Promise.all(wave.lanes.map(async lane => {
      const results = [];
      for (const task of lane.tasks) {
        const failedDependency = task.dependencies.find(id => outcomes.get(id)?.status !== 'fulfilled');
        if (failedDependency) {
          const outcome = { taskId: task.id, laneId: lane.id, status: 'blocked', blockedBy: failedDependency };
          outcomes.set(task.id, outcome);
          results.push(outcome);
          continue;
        }
        try {
          const value = await worker(task, { laneId: lane.id, workerRole: lane.workerRole });
          const outcome = { taskId: task.id, laneId: lane.id, status: 'fulfilled', value };
          outcomes.set(task.id, outcome);
          results.push(outcome);
        } catch (error) {
          const outcome = { taskId: task.id, laneId: lane.id, status: 'rejected', error: error.message };
          outcomes.set(task.id, outcome);
          results.push(outcome);
        }
      }
      return results;
    }));
    laneResults.flat().forEach(outcome => outcomes.set(outcome.taskId, outcome));
  }
  return { outcomes: [...outcomes.values()], failed: [...outcomes.values()].filter(item => item.status !== 'fulfilled') };
}
