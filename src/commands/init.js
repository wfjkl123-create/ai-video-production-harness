import { resolve } from 'node:path';
import { initializeProject } from '../services/project-service.js';
import { option } from './args.js';

export async function runInit(args) {
  const root = resolve(option(args, 'project'));
  const requestedWorkflowVersion = option(args, 'workflow-version', { required: false });
  const workflowVersion = Number(requestedWorkflowVersion ?? 2);
  return initializeProject(root, {
    projectId: option(args, 'project-id'),
    workflowVersion,
    realismContractsVersion: Number(option(args, 'realism-contracts-version', { required: false }) ?? workflowVersion),
    realismContractsWriteMode: option(args, 'realism-contracts-write-mode', { required: false }) ?? 'enabled',
    ingressPolicyVersion: option(args, 'ingress-policy-version', { required: false })
      ?? (requestedWorkflowVersion === undefined ? 'ingress-route-v1' : undefined)
  });
}
