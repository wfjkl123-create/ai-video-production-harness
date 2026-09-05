import { resolve } from 'node:path';
import { option } from './args.js';
import { persistSourceComparatorAudit } from '../services/source-comparator-audit-service.js';

export async function runSourceComparatorAudit(args, dependencies = {}) {
  const root = resolve(option(args, 'project'));
  const request = {
    sourceAnalysisId: option(args, 'source-analysis'),
    storyPlanId: option(args, 'story-plan')
  };
  return (dependencies.persistSourceComparatorAudit ?? persistSourceComparatorAudit)(root, request);
}
