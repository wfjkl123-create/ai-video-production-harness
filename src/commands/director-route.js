import { resolve } from 'node:path';
import { option } from './args.js';
import { routeLockedStoryPlan } from '../services/director-route-service.js';

export function runDirectorRoute(args) {
  return routeLockedStoryPlan(resolve(option(args, 'project')), option(args, 'story-plan', { required: false }));
}
