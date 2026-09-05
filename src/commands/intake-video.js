import { isAbsolute, resolve } from 'node:path';
import { option } from './args.js';
import { intakeVideoRequest, persistVideoIntake } from '../services/video-intake-service.js';

function optional(args, name) {
  return option(args, name, { required: false });
}

function parseInputs(value, cwd) {
  if (value === undefined) return [];
  let inputs;
  try {
    inputs = JSON.parse(value);
  } catch {
    throw new Error('--inputs-json must be valid JSON');
  }
  if (!Array.isArray(inputs)) throw new Error('--inputs-json must contain an array of input descriptors');
  return inputs.map(input => ({
    ...input,
    path: typeof input?.path === 'string' && !isAbsolute(input.path) ? resolve(cwd, input.path) : input?.path
  }));
}

function parseOptOut(args) {
  const index = args.indexOf('--opt-out');
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('--opt-out must be a flag or true/false');
}

export async function runIntakeVideo(args, dependencies = {}) {
  const cwd = dependencies.cwd ?? process.cwd();
  const input = {
    requestText: option(args, 'request'),
    inputs: parseInputs(optional(args, 'inputs-json'), cwd),
    explicitOptOut: parseOptOut(args),
    requestKind: optional(args, 'request-kind'),
    explicitReferenceIntent: optional(args, 'reference-intent'),
    explicitExecutionClass: optional(args, 'task-class'),
    confirmScopeRevision: args.includes('--confirm-scope-revision'),
    scopeRevisionReason: optional(args, 'scope-revision-reason')
  };
  const project = optional(args, 'project');
  if (project === undefined) return intakeVideoRequest(input);
  return (dependencies.persistVideoIntake ?? persistVideoIntake)(resolve(cwd, project), input);
}
