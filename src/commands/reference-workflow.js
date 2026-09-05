import { option } from './args.js';
import { detectReferenceWorkflow } from '../services/reference-workflow-service.js';

function csv(value) {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function runReferenceWorkflow(args) {
  return detectReferenceWorkflow({
    requestText: option(args, 'request'),
    sourceVideoIds: csv(option(args, 'source-videos', { required: false })),
    explicitIntent: option(args, 'intent', { required: false })
  });
}
