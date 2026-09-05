import { proposeSegments, validateSegmentPlan } from '../services/segment-service.js';
import { persistSegmentation } from '../services/segmentation-workflow-service.js';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { resolveProjectInput } from './project-input.js';

function parseBeats(value) {
  if (value.trim().startsWith('[')) return JSON.parse(value);
  return value.split(',').map(Number);
}

export async function runSegments(args) {
  const project = option(args, 'project', { required: false });
  const input = option(args, 'input', { required: false });
  if (input && !project) throw new Error('--input requires --project');
  if (input && (option(args, 'duration', { required: false }) || option(args, 'beats', { required: false }))) {
    throw new Error('--input cannot be combined with --duration or --beats');
  }
  const requestedInput = input
    ? await readJson(resolveProjectInput(project, input))
    : null;
  const segments = requestedInput
    ? validateSegmentPlan(requestedInput)
    : proposeSegments({
        totalDuration: Number(option(args, 'duration')),
        beats: parseBeats(option(args, 'beats'))
      });
  if (!project) return segments;
  return persistSegmentation(project, {
    id: option(args, 'artifact'), path: option(args, 'output'), segments: Array.isArray(segments) ? segments : segments.segments,
    revision: Number(option(args, 'revision', { required: false }) ?? 1),
    ...(requestedInput?.storyPlanBinding ? { storyPlanBinding: requestedInput.storyPlanBinding } : {})
  });
}
