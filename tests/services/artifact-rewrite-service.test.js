import test from 'node:test';
import assert from 'node:assert/strict';
import { getArtifactRewriteFingerprint, rewriteArtifactFields } from '../../src/services/artifact-rewrite-service.js';

function request() {
  const input = { root: '/project', model: 'gpt-6-astra', maxBudgetUsd: 0.2, instruction: '把结尾写得温暖一些', fields: [{ key: 'ending', label: '结尾', value: '她离开了' }, { key: 'opening', label: '开头', value: '她来到门口' }] };
  return { ...input, authorization: { scope: 'artifact-text-rewrite', approved: true, requestId: 'approval-1', inputSha256: getArtifactRewriteFingerprint(input) } };
}
const goodDraft = { values: { ending: '她带着笑意离开了', opening: '她来到门口' } };

test('rewrite is self-contained, claims once, returns candidate plus execution evidence', async () => {
  const input = request();
  const before = JSON.stringify(input);
  const events = [];
  const result = await rewriteArtifactFields(input, {
    consumeAuthorization: async auth => { assert.equal(auth.inputSha256, input.authorization.inputSha256); events.push('claim'); return true; },
    adapterFactory: options => { assert.equal(options.maxBudgetUsd, 0.2); return { generate: async ({ prompt }) => {
      events.push('generate');
      assert.ok(prompt.includes(input.instruction));
      for (const field of input.fields) assert.ok(prompt.includes(field.value));
      assert.match(prompt, /不得调用工具/);
      return { draft: goodDraft, model: input.model, costUsd: 0.01, executionEvidence: { exitCode: 0 } };
    } }; }
  });
  assert.deepEqual(events, ['claim', 'generate']);
  assert.deepEqual(result.values, goodDraft.values);
  assert.equal(result.metadata.applied, false);
  assert.equal(result.metadata.costUsd, 0.01);
  assert.equal(JSON.stringify(input), before);
});

test('authorization binds all text, budget and model before any execution', async () => {
  for (const change of [{ instruction: '不同要求' }, { model: 'different' }, { maxBudgetUsd: 0.3 }, { fields: [{ key: 'ending', label: '结尾', value: '不同内容' }] }]) {
    await assert.rejects(rewriteArtifactFields({ ...request(), ...change }, { adapterFactory: () => { assert.fail('must not construct adapter'); } }), /authorization/);
  }
  await assert.rejects(rewriteArtifactFields(request()), /single-use/);
});

test('consumed authorization cannot call model and failed execution does not retry', async () => {
  let calls = 0;
  const adapterFactory = () => ({ generate: async () => { calls++; throw new Error('uncertain response'); } });
  await assert.rejects(rewriteArtifactFields(request(), { adapterFactory, consumeAuthorization: async () => false }), /consumed/);
  assert.equal(calls, 0);
  await assert.rejects(rewriteArtifactFields(request(), { adapterFactory, consumeAuthorization: async () => true }), /uncertain response/);
  assert.equal(calls, 1);
});

test('malformed or incomplete model results cannot become editable candidates', async () => {
  for (const draft of [null, { values: {} }, { values: { ending: 'yes', opening: 'yes', rogue: 'no' } }, { values: { ending: 2, opening: 'yes' } }, { values: { ending: '', opening: ' ' } }, { values: goodDraft.values, action: 'submit' }]) {
    await assert.rejects(rewriteArtifactFields(request(), { consumeAuthorization: async () => true, adapterFactory: () => ({ generate: async () => ({ draft }) }) }), /Rewrite returned/);
  }
});

test('duplicate and unsafe input keys are rejected before authorization claim', () => {
  const input = request();
  assert.throws(() => getArtifactRewriteFingerprint({ ...input, fields: [input.fields[0], input.fields[0]] }), /unique/);
  assert.throws(() => getArtifactRewriteFingerprint({ ...input, fields: [{ key: '__proto__', label: '字段', value: '内容' }] }), /safe/);
});

test('execution receipt is delivered before invalid candidate validation', async () => {
  const receipts = [];
  await assert.rejects(rewriteArtifactFields(request(), {
    consumeAuthorization: async () => true,
    adapterFactory: () => ({ generate: async () => ({ draft: { values: {} }, costUsd: 0.08, sessionId: 'isolated-session' }) }),
    onExecutionResult: async metadata => { receipts.push(metadata); }
  }), /Rewrite returned/);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].costUsd, 0.08);
  assert.equal(receipts[0].sessionId, 'isolated-session');
  assert.equal(receipts[0].applied, false);
});
