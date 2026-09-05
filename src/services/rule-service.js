import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import {
  createCandidateRule as createRule,
  recordRuleApplication as applyRule,
  createRuleReviewEvidence,
  verifyRule as promoteRule,
  reviseRule as reviseCandidate,
  applicableRules as filterRules
} from '../domain/rules.js';

const rulePath = (root, id) => join(root, 'rules', `${encodeURIComponent(id)}.json`);
const reviewPath = (root, id) => join(root, 'reviews', `${encodeURIComponent(id)}.json`);

async function readRules(root) {
  let entries;
  try {
    entries = await readdir(join(root, 'rules'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(entries
    .filter(name => name.endsWith('.json') && !name.startsWith('._'))
    .map(name => readJson(join(root, 'rules', name))));
}

export function createCandidateRule(root, feedback) {
  return withProjectLock(root, async () => {
    const rule = createRule(feedback);
    try {
      await readJson(rulePath(root, rule.id));
      throw new Error(`rule already exists: ${rule.id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeJsonAtomic(rulePath(root, rule.id), rule);
    return rule;
  });
}

export function recordRuleApplication(root, ruleId, runId) {
  return withProjectLock(root, async () => {
    const rule = applyRule(await readJson(rulePath(root, ruleId)), runId);
    await writeJsonAtomic(rulePath(root, ruleId), rule);
    return rule;
  });
}

export function recordRuleReview(root, ruleId, input, options = {}) {
  return withProjectLock(root, async () => {
    const review = createRuleReviewEvidence(await readJson(rulePath(root, ruleId)), input, options);
    try {
      await readJson(reviewPath(root, review.id));
      throw new Error(`rule review already exists: ${review.id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeJsonAtomic(reviewPath(root, review.id), review);
    return review;
  });
}

export function verifyRule(root, ruleId, reviewId) {
  return withProjectLock(root, async () => {
    const [rule, review] = await Promise.all([
      readJson(rulePath(root, ruleId)),
      readJson(reviewPath(root, reviewId))
    ]);
    const hard = promoteRule(rule, review);
    await writeJsonAtomic(rulePath(root, ruleId), hard);
    return hard;
  });
}

export function reviseRule(root, ruleId, revision) {
  return withProjectLock(root, async () => {
    if (typeof revision?.reviewId !== 'string' || revision.reviewId.trim() === '') {
      throw new Error('rule revision requires reviewId');
    }
    const [rule, review] = await Promise.all([
      readJson(rulePath(root, ruleId)),
      readJson(reviewPath(root, revision.reviewId))
    ]);
    const revised = reviseCandidate(rule, { ...revision, review });
    await writeJsonAtomic(rulePath(root, ruleId), revised);
    return revised;
  });
}

export async function applicableRules(root, context) {
  return filterRules(await readRules(root), context);
}
