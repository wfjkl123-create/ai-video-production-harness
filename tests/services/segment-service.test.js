import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeSegments, storyboardGridFor, validateSegmentPlan } from '../../src/services/segment-service.js';

test('no proposed segment exceeds 15 seconds', () => {
  const result = proposeSegments({ totalDuration: 32, beats: [0, 8, 15, 24, 32] });
  assert.ok(result.every((segment) => segment.duration <= 15));
  assert.equal(result.reduce((sum, segment) => sum + segment.duration, 0), 32);
});

test('chooses storyboard grids from actual complexity', () => {
  assert.equal(storyboardGridFor({ shots: 2, people: 1, largeMotion: false, complexBlocking: false }), 6);
  assert.equal(storyboardGridFor({ shots: 3, people: 2, largeMotion: true, complexBlocking: false }), 9);
  assert.equal(storyboardGridFor({ shots: 4, people: 4, largeMotion: true, complexBlocking: true }), 12);
});

test('proposals satisfy segment invariants and always await review', () => {
  const result = proposeSegments({ totalDuration: 20, beats: [0, 10, 20] });
  assert.deepEqual(result.map(({ id }) => id), ['segment-001', 'segment-002']);
  for (const [index, segment] of result.entries()) {
    for (const field of [
      'id', 'duration', 'narrativeTask', 'startState', 'actionNodes', 'endState',
      'projectAssetIds', 'segmentAssetRequirements', 'continuityStrategy', 'previousSegmentId', 'nextSegmentId'
    ]) assert.ok(Object.hasOwn(segment, field), `${field} is required`);
    assert.equal(segment.status, 'awaiting_review');
    assert.equal(segment.continuityStrategy, index === 0 ? 'canonical_open' : 'continuous_proxy_handoff');
    assert.equal(segment.previousSegmentId, index === 0 ? null : result[index - 1].id);
    assert.equal(segment.nextSegmentId, index === result.length - 1 ? null : result[index + 1].id);
  }
});

test('rejects invalid duration and beat boundaries', () => {
  assert.throws(() => proposeSegments({ totalDuration: 0, beats: [0] }), /totalDuration/);
  assert.throws(() => proposeSegments({ totalDuration: 10, beats: [1, 10] }), /start at 0/);
  assert.throws(() => proposeSegments({ totalDuration: 10, beats: [0, 7] }), /end at totalDuration/);
  assert.throws(() => proposeSegments({ totalDuration: 10, beats: [0, 8, 7, 10] }), /strictly increasing/);
});

test('accepts a complete reviewed segment spec without dropping asset responsibilities', () => {
  const segments = proposeSegments({ totalDuration: 14, beats: [0, 14] });
  segments[0] = {
    ...segments[0],
    narrativeTask: '夫妻入场、撞衫，A开始揭示收腹裤',
    startState: { at: 0, blocking: 'B挽C从右侧入场，A在左侧画外' },
    actionNodes: ['B邀请C吃火锅', 'A入画发现撞衫', 'A把包递给C并提起裙摆'],
    endState: { at: 14, blocking: 'A保持提裙，B和C看向A腰腹' },
    projectAssetIds: ['character-a-v2', 'scene-windmill-plaza-v2'],
    segmentAssetRequirements: ['initial_blocking', 'camera_blocking', 'storyboard']
  };
  const result = validateSegmentPlan({ segments });
  assert.deepEqual(result, segments);
  assert.notEqual(result, segments);
});

test('rejects malformed complete segment specs before persistence', () => {
  const segments = proposeSegments({ totalDuration: 20, beats: [0, 10, 20] });
  segments[1].previousSegmentId = null;
  assert.throws(() => validateSegmentPlan(segments), /previousSegmentId/);
  segments[1].previousSegmentId = 'segment-001';
  segments[0].projectAssetIds = ['duplicate', 'duplicate'];
  assert.throws(() => validateSegmentPlan(segments), /duplicates/);
});
