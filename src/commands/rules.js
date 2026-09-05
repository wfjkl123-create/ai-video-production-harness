import { dirname, resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import {
  createCandidateRule, recordRuleApplication, recordRuleReview, verifyRule, reviseRule, applicableRules
} from '../services/rule-service.js';

export async function runRules(args) {
  const [action, ...rest] = args;
  if (action === 'list') {
    const contextPath = resolve(option(rest, 'context'));
    const context = await readJson(contextPath);
    const projectOption = option(rest, 'project', { required: false });
    if (!projectOption && (typeof context.projectRoot !== 'string' || context.projectRoot.trim() === '')) {
      throw new Error('--project is required unless context.projectRoot is a non-empty string');
    }
    const root = projectOption ? resolve(projectOption) : resolve(dirname(contextPath), context.projectRoot);
    const status = option(rest, 'status', { required: false });
    const rules = await applicableRules(root, context);
    return status ? rules.filter(rule => rule.status === status) : rules;
  }
  const root = resolve(option(rest, 'project'));
  if (action === 'create') return createCandidateRule(root, await readJson(resolve(option(rest, 'feedback'))));
  if (action === 'apply') return recordRuleApplication(root, option(rest, 'rule'), option(rest, 'run'));
  if (action === 'review') {
    return recordRuleReview(root, option(rest, 'rule'), await readJson(resolve(option(rest, 'input'))));
  }
  if (action === 'verify') return verifyRule(root, option(rest, 'rule'), option(rest, 'review'));
  if (action === 'revise') return reviseRule(root, option(rest, 'rule'), await readJson(resolve(option(rest, 'revision'))));
  throw new Error(`unknown rules action: ${action ?? ''}`);
}
