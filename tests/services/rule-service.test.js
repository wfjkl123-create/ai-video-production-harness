import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createCandidateRule, recordRuleApplication, verifyRule, reviseRule, applicableRules
} from '../../src/services/rule-service.js';
import * as ruleService from '../../src/services/rule-service.js';
import { runRules } from '../../src/commands/rules.js';

const execFile = promisify(execFileCallback);

const feedback = {
  id: 'rule-001',
  trigger: {
    product: ['shapewear'], assetType: ['storyboard'], shotType: ['close_up'],
    motionType: ['pull'], peopleCountRange: { min: 1, max: 2 }, spaceComplexity: ['simple']
  },
  symptom: 'waistband deforms', evidence: ['output-001@00:03'], reason: 'reference conflict',
  correction: 'isolate product structure', forbidden: ['storyboard controls product'],
  sourceProject: 'project-001', sourceSegment: 'segment-001'
};

test('records human rule-review evidence through the service entrypoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rule-review-entrypoint-'));
  await createCandidateRule(root, feedback);
  await recordRuleApplication(root, 'rule-001', 'run-001');
  const review = await ruleService.recordRuleReview(root, 'rule-001', {
    decision: 'approved', runId: 'run-001', note: 'the correction now holds'
  }, {
    id: '../review-safe', now: () => '2999-01-01T00:00:00.000Z'
  });
  assert.equal(review.actor, 'human');
  assert.equal(review.ruleRevision, 1);
  assert.equal(JSON.parse(await readFile(join(root, 'reviews', '..%2Freview-safe.json'), 'utf8')).id, '../review-safe');
  await assert.rejects(readFile(join(root, 'review-safe.json'), 'utf8'), /ENOENT/);
  assert.equal((await verifyRule(root, 'rule-001', '../review-safe')).status, 'hard');
});

test('records and applies human rule-review evidence through the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rule-review-cli-'));
  await createCandidateRule(root, feedback);
  await recordRuleApplication(root, 'rule-001', 'run-001');
  await new Promise(resolve => setTimeout(resolve, 2));
  const inputPath = join(root, 'review-input.json');
  await writeFile(inputPath, JSON.stringify({
    decision: 'approved', runId: 'run-001', note: 'human confirmed the repaired output'
  }));
  const review = await runRules([
    'review', '--project', root, '--rule', 'rule-001', '--input', inputPath
  ]);
  assert.equal(review.actor, 'human');
  const hard = await runRules([
    'verify', '--project', root, '--rule', 'rule-001', '--review', review.id
  ]);
  assert.equal(hard.status, 'hard');
  assert.equal(hard.verificationReviewId, review.id);
});

test('persists lifecycle and requires review evidence tied to an application', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rule-service-'));
  await createCandidateRule(root, feedback);
  await recordRuleApplication(root, 'rule-001', 'run-001');
  await mkdir(join(root, 'reviews'));
  await writeFile(join(root, 'reviews', 'review-001.json'), JSON.stringify({
    id: 'review-001', decision: 'approved', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001',
    createdAt: '2999-01-01T00:00:00.000Z', actor: 'human'
  }));
  const hard = await verifyRule(root, 'rule-001', 'review-001');
  assert.equal(hard.status, 'hard');
  assert.equal(JSON.parse(await readFile(join(root, 'rules', 'rule-001.json'), 'utf8')).verificationReviewId, 'review-001');

  await writeFile(join(root, 'reviews', 'review-rejected-002.json'), JSON.stringify({
    id: 'review-rejected-002', decision: 'rejected', actor: 'human', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001',
    createdAt: '2999-01-02T00:00:00.000Z'
  }));
  const revised = await reviseRule(root, 'rule-001', {
    correction: 'revised correction', evidence: ['review-rejected-002'], failedRunId: 'run-001',
    reviewId: 'review-rejected-002'
  });
  assert.equal(revised.status, 'candidate');
  assert.equal(revised.revision, 2);
});

test('rejects non-human promotion and revisions not tied to rejected review evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rule-review-boundary-'));
  await createCandidateRule(root, feedback);
  await recordRuleApplication(root, 'rule-001', 'run-001');
  await mkdir(join(root, 'reviews'));
  await writeFile(join(root, 'reviews', 'review-machine.json'), JSON.stringify({
    id: 'review-machine', decision: 'approved', actor: 'machine', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001',
    createdAt: '2999-01-01T00:00:00.000Z'
  }));
  await assert.rejects(verifyRule(root, 'rule-001', 'review-machine'), /human review/);
  await writeFile(join(root, 'reviews', 'review-wrong.json'), JSON.stringify({
    id: 'review-wrong', decision: 'approved', actor: 'human', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001',
    createdAt: '2999-01-01T00:00:00.000Z'
  }));
  await assert.rejects(reviseRule(root, 'rule-001', {
    correction: 'bad revision', evidence: ['review-wrong'], failedRunId: 'run-001', reviewId: 'review-wrong'
  }), /rejected human review/);
});

test('serializes concurrent applications without losing a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rule-concurrency-'));
  await createCandidateRule(root, feedback);
  await Promise.all([
    recordRuleApplication(root, 'rule-001', 'run-a'),
    recordRuleApplication(root, 'rule-001', 'run-b')
  ]);
  const persisted = JSON.parse(await readFile(join(root, 'rules', 'rule-001.json'), 'utf8'));
  assert.deepEqual(persisted.applications.map(({ runId }) => runId).sort(), ['run-a', 'run-b']);
});

test('keeps rule ids containing path syntax inside the rules directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rule-path-boundary-'));
  const rule = await createCandidateRule(root, { ...feedback, id: '../escaped' });
  assert.equal(rule.id, '../escaped');
  assert.equal(JSON.parse(await readFile(join(root, 'rules', '..%2Fescaped.json'), 'utf8')).id, '../escaped');
  await assert.rejects(readFile(join(root, 'escaped.json'), 'utf8'), /ENOENT/);
  assert.deepEqual((await applicableRules(root, {
    product: 'shapewear', assetType: 'storyboard', shotType: 'close_up', motionType: 'pull',
    peopleCount: 1, spaceComplexity: 'simple', reworkRuleIds: ['../escaped']
  })).map(({ id }) => id), ['../escaped']);
});

test('persistent context filtering and CLI list return source and verification evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rule-list-'));
  await createCandidateRule(root, feedback);
  await recordRuleApplication(root, 'rule-001', 'run-001');
  await mkdir(join(root, 'reviews'));
  await writeFile(join(root, 'reviews', 'review-001.json'), JSON.stringify({
    id: 'review-001', decision: 'approved', ruleId: 'rule-001', ruleRevision: 1, runId: 'run-001',
    createdAt: '2999-01-01T00:00:00.000Z', actor: 'human'
  }));
  await verifyRule(root, 'rule-001', 'review-001');
  const context = {
    product: 'shapewear', assetType: 'storyboard', shotType: 'close_up', motionType: 'pull',
    peopleCount: 1, spaceComplexity: 'simple', reworkRuleIds: []
  };
  assert.deepEqual((await applicableRules(root, context)).map(({ id }) => id), ['rule-001']);
  const contextPath = join(root, 'context.json');
  await writeFile(contextPath, JSON.stringify(context));
  const listed = await runRules(['list', '--project', root, '--status', 'hard', '--context', contextPath]);
  assert.deepEqual(listed.map(({ id }) => id), ['rule-001']);
  assert.equal(listed[0].sourceProject, 'project-001');
  assert.equal(listed[0].verificationReviewId, 'review-001');
});

test('the documented fixture list command resolves an explicit project root from context', async () => {
  const { stdout } = await execFile(process.execPath, [
    'src/cli.js', 'rules', 'list', '--status', 'hard',
    '--context', 'tests/fixtures/context-segment-001.json'
  ], { cwd: process.cwd() });
  const listed = JSON.parse(stdout);
  assert.deepEqual(listed.map(({ id }) => id), ['rule-verified']);
});
