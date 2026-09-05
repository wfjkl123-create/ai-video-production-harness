import test from 'node:test';
import assert from 'node:assert/strict';
import { detectReferenceWorkflow } from '../../src/services/reference-workflow-service.js';

test('routes a referenced remake or replacement through source facts', () => {
  const remake = detectReferenceWorkflow({ requestText: '照着原视频复刻剧情', sourceVideoIds: ['source-001'] });
  assert.equal(remake.workflowRoute, 'source_fact');
  assert.equal(remake.referenceIntent, 'faithful_remake');

  const modification = detectReferenceWorkflow({ requestText: '在原视频基础上替换产品', sourceVideoIds: ['source-001'] });
  assert.equal(modification.workflowRoute, 'source_fact');
  assert.equal(modification.referenceIntent, 'source_modification');

  const colloquialModification = detectReferenceWorkflow({
    requestText: '照着原视频前12秒一比一还原，只替换成我们的黑色收腹裤和包装',
    sourceVideoIds: ['source-001']
  });
  assert.equal(colloquialModification.workflowRoute, 'source_fact');
  assert.equal(colloquialModification.referenceIntent, 'source_modification');

  const rhythm = detectReferenceWorkflow({ requestText: '照原视频的节奏和剧情来做', sourceVideoIds: ['source-001'] });
  assert.equal(rhythm.workflowRoute, 'source_fact');
});

test('routes a pure idea through normal creative development', () => {
  const result = detectReferenceWorkflow({ requestText: '我有一个萌娃和奶奶对话促销的想法' });
  assert.equal(result.referenceIntent, 'idea_only');
  assert.equal(result.workflowRoute, 'standard_creation');
});

test('keeps style-only references out of source-fact analysis', () => {
  const result = detectReferenceWorkflow({ requestText: '这条视频只参考风格，不需要复刻', sourceVideoIds: ['source-001'] });
  assert.equal(result.referenceIntent, 'inspiration_only');
  assert.equal(result.workflowRoute, 'standard_creation');
});

test('does not guess when a source video exists but its role is unclear', () => {
  const result = detectReferenceWorkflow({ requestText: '看看这个视频，我想做个广告', sourceVideoIds: ['source-001'] });
  assert.equal(result.status, 'awaiting_reference_role');
  assert.equal(result.workflowRoute, null);
});

test('asks for the missing source when source-authority intent is explicit', () => {
  const result = detectReferenceWorkflow({ requestText: '帮我一比一复刻这个原视频' });
  assert.equal(result.status, 'awaiting_source_video');
  assert.equal(result.workflowRoute, null);
});

test('does not mistake a source-free product replacement for a video remake', () => {
  const result = detectReferenceWorkflow({ requestText: '把文案里的产品替换成收腹裤，做一个原创口播' });
  assert.equal(result.referenceIntent, 'idea_only');
  assert.equal(result.workflowRoute, 'standard_creation');
});

test('conflicting source-role language is clarified instead of resolved by keyword order', () => {
  const result = detectReferenceWorkflow({
    requestText: '不需要复刻，但要按原视频节奏替换产品',
    sourceVideoIds: ['source-001']
  });
  assert.equal(result.status, 'awaiting_reference_role');
  assert.equal(result.workflowRoute, null);
});
