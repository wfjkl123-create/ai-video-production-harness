import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertRule, createCandidateRule, recordRuleApplication, verifyRule, reviseRule, applicableRules
} from '../../src/domain/rules.js';

const feedback = {
  trigger: {
    product: ['shapewear'], assetType: ['storyboard'], shotType: ['close_up'],
    motionType: ['pull'], peopleCountRange: { min: 1, max: 2 }, spaceComplexity: ['simple']
  },
  symptom: 'waistband deforms',
  evidence: ['output-001@00:03'],
  reason: 'reference responsibility conflict',
  correction: 'bind product structure only to product reference',
  forbidden: ['storyboard controls product structure'],
  sourceProject: 'project-001',
  sourceSegment: 'segment-001'
};

function candidate() {
  return createCandidateRule(feedback, {
    id: 'rule-001', now: () => '2026-07-13T01:00:00.000Z'
  });
}

test('creates a candidate with the exact persistent contract', () => {
  const rule = candidate();
  assert.deepEqual(Object.keys(rule), [
    'id', 'status', 'trigger', 'symptom', 'evidence', 'reason', 'correction', 'forbidden',
    'sourceProject', 'sourceSegment', 'applications', 'verificationReviewId', 'revision',
    'createdAt', 'updatedAt'
  ]);
  assert.equal(rule.status, 'candidate');
  assert.equal(rule.revision, 1);
  assert.deepEqual(rule.applications, []);
  assert.equal(rule.verificationReviewId, null);
  assert.equal(assertRule(rule), rule);
});

test('runtime validation enforces schema date-time format and unique arrays', () => {
  assert.throws(() => assertRule({
    ...candidate(), createdAt: '2026-02-30T00:00:00.000Z'
  }), /createdAt.*date-time/);
  assert.throws(() => createCandidateRule({
    ...feedback, evidence: ['same-evidence', 'same-evidence']
  }), /evidence.*unique/);
  assert.throws(() => createCandidateRule({
    ...feedback,
    trigger: { ...feedback.trigger, product: ['shapewear', 'shapewear'] }
  }), /trigger.product.*unique/);
});

test('cannot promote without a later approved review tied to a recorded application', () => {
  const rule = candidate();
  const applied = recordRuleApplication(rule, 'run-001', { now: () => '2026-07-13T02:00:00.000Z' });
  assert.throws(() => verifyRule(rule, {
    id: 'review-001', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001', createdAt: '2026-07-13T03:00:00.000Z'
  }), /recorded application/);
  assert.throws(() => verifyRule(applied, {
    id: 'review-001', decision: 'rejected', actor: 'human', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001', createdAt: '2026-07-13T03:00:00.000Z'
  }), /approved/);
  assert.throws(() => verifyRule(applied, {
    id: 'review-001', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 1, runId: 'other-run', createdAt: '2026-07-13T03:00:00.000Z'
  }), /tied to.*application/);
  assert.throws(() => verifyRule(applied, {
    id: 'review-001', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001', createdAt: '2026-07-13T01:30:00.000Z'
  }), /later than application/);
  assert.throws(() => verifyRule(applied, {
    id: 'review-wrong-revision', decision: 'approved', actor: 'human', ruleId: 'rule-001',
    ruleRevision: 2, runId: 'run-001', createdAt: '2026-07-13T03:00:00.000Z'
  }), /current rule revision/);

  const hard = verifyRule(applied, {
    id: 'review-001', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 1,
    runId: 'run-001', createdAt: '2026-07-13T03:00:00.000Z'
  });
  assert.equal(hard.status, 'hard');
  assert.equal(hard.verificationReviewId, 'review-001');
});

test('rejects a fabricated hard rule without verification linked to an application', () => {
  assert.throws(() => assertRule({
    ...candidate(),
    status: 'hard',
    verificationReviewId: 'review-unlinked'
  }), /verificationReviewId.*recorded application/);
  assert.throws(() => assertRule({
    ...candidate(),
    applications: [{
      runId: 'run-001',
      revision: 1,
      appliedAt: '2026-07-13T02:00:00.000Z',
      reviewId: '   '
    }]
  }), /application.reviewId/);
  assert.throws(() => assertRule({
    ...candidate(),
    status: 'hard',
    revision: 2,
    applications: [{
      runId: 'run-revision-1',
      revision: 1,
      appliedAt: '2026-07-13T02:00:00.000Z',
      reviewId: 'review-revision-1'
    }],
    verificationReviewId: 'review-revision-1'
  }), /current rule revision/);
});

test('failed fix returns the rule to candidate with a higher revision', () => {
  const applied = recordRuleApplication(candidate(), 'run-001', { now: () => '2026-07-13T02:00:00.000Z' });
  const revised = reviseRule(applied, {
    correction: 'use a tighter product crop',
    evidence: ['review-rejected-001'],
    failedRunId: 'run-001',
    review: {
      id: 'review-rejected-001', decision: 'rejected', actor: 'human', ruleId: 'rule-001', ruleRevision: 1,
      runId: 'run-001', createdAt: '2026-07-13T03:00:00.000Z'
    }
  }, { now: () => '2026-07-13T04:00:00.000Z' });
  assert.equal(revised.status, 'candidate');
  assert.equal(revised.revision, 2);
  assert.equal(revised.correction, 'use a tighter product crop');
  assert.equal(revised.verificationReviewId, null);
  assert.deepEqual(revised.evidence, ['output-001@00:03', 'review-rejected-001']);
});

test('a revised rule can be verified only by an application of its current revision', () => {
  const firstApplication = recordRuleApplication(candidate(), 'run-revision-1', {
    now: () => '2026-07-13T02:00:00.000Z'
  });
  const revised = reviseRule(firstApplication, {
    correction: 'revision two correction',
    evidence: ['review-rejected-001'],
    failedRunId: 'run-revision-1',
    review: {
      id: 'review-rejected-001', decision: 'rejected', actor: 'human', ruleId: 'rule-001', ruleRevision: 1,
      runId: 'run-revision-1', createdAt: '2026-07-13T03:00:00.000Z'
    }
  });
  assert.throws(() => reviseRule(revised, {
    correction: 'must not reuse revision one failure',
    evidence: ['review-stale-rejection'],
    failedRunId: 'run-revision-1',
    review: {
      id: 'review-stale-rejection', decision: 'rejected', actor: 'human', ruleId: 'rule-001', ruleRevision: 2,
      runId: 'run-revision-1', createdAt: '2026-07-13T04:00:00.000Z'
    }
  }), /current rule revision/);
  assert.throws(() => verifyRule(revised, {
    id: 'review-stale-approval', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 2,
    runId: 'run-revision-1', createdAt: '2026-07-13T04:00:00.000Z'
  }), /current rule revision/);

  const secondApplication = recordRuleApplication(revised, 'run-revision-2', {
    now: () => '2026-07-13T04:00:00.000Z'
  });
  const hard = verifyRule(secondApplication, {
    id: 'review-current-approval', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 2,
    runId: 'run-revision-2', createdAt: '2026-07-13T05:00:00.000Z'
  });
  assert.equal(hard.status, 'hard');
  assert.equal(hard.verificationReviewId, 'review-current-approval');
});

test('matches all explicit context dimensions and returns only hard plus linked candidate rules', () => {
  const applied = recordRuleApplication(candidate(), 'run-001', { now: () => '2026-07-13T02:00:00.000Z' });
  const hard = verifyRule(applied, {
    id: 'review-001', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001', createdAt: '2026-07-13T03:00:00.000Z'
  });
  const linked = { ...candidate(), id: 'rule-linked' };
  const unrelated = {
    ...candidate(), id: 'rule-unrelated',
    trigger: { ...candidate().trigger, product: ['other-product'] }
  };
  const context = {
    product: 'shapewear', assetType: 'storyboard', shotType: 'close_up', motionType: 'pull',
    peopleCount: 2, spaceComplexity: 'simple', reworkRuleIds: ['rule-linked']
  };
  assert.deepEqual(applicableRules([unrelated, linked, hard], context).map(({ id }) => id), ['rule-001', 'rule-linked']);
  assert.deepEqual(applicableRules([hard], { ...context, peopleCount: 3 }), []);
  assert.deepEqual(applicableRules([hard], { ...context, motionType: 'walk' }), []);
});

test('publishes the exact rule schema contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/rule.schema.json', import.meta.url)));
  assert.deepEqual(schema.required, [
    'id', 'status', 'trigger', 'symptom', 'evidence', 'reason', 'correction', 'forbidden',
    'sourceProject', 'sourceSegment', 'applications', 'verificationReviewId', 'revision',
    'createdAt', 'updatedAt'
  ]);
  assert.deepEqual(schema.properties.status.enum, ['candidate', 'hard']);
  assert.deepEqual(schema.properties.trigger.required, [
    'product', 'assetType', 'shotType', 'motionType', 'peopleCountRange', 'spaceComplexity'
  ]);
  assert.deepEqual(schema.properties.applications.items.required, ['runId', 'revision', 'appliedAt']);
});
