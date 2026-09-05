import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { answerDirectorInterview, prepareDirectorInterview } from '../services/director-interview-service.js';

export async function runDirectorInterview(args) {
  const root = resolve(option(args, 'project'));
  const state = await readJson(resolve(root, 'project-state.json'));
  if (!state.routeDecision?.harnessRequired) throw new Error('director-interview requires a persisted Harness video route');
  const answersPath = option(args, 'answers', { required: false });
  if (answersPath) {
    return answerDirectorInterview(root, {
      answers: await readJson(resolve(answersPath)),
      routeDecision: state.routeDecision
    });
  }
  return prepareDirectorInterview(root, {
    projectId: state.projectId,
    requestText: option(args, 'request'),
    routeDecision: state.routeDecision
  });
}
