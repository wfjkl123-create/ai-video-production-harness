import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKocRemakePlan } from '../../src/services/koc-remake-orchestrator-service.js';

const SHA = 'a'.repeat(64);

function segment(id, startSec, endSec, { firstFrame = false } = {}) {
  return {
    id,
    startSec,
    endSec,
    contentClass: 'aroll',
    containsBroll: false,
    continuousTakeId: `take-${id}`,
    continuousTakeComplete: true,
    transcript: `第 ${id} 段完整台词`,
    sourceRangeSha256: SHA,
    controlVideo: { id: `control-${id}`, sha256: SHA, mediaKind: 'video' },
    maskAudit: {
      status: 'PASS', coverage: 'full_head_above_neck', outsideHeadPreserved: true, auditSha256: SHA
    },
    sourceAudioMode: 'embedded_original_track',
    firstFrame: firstFrame ? { id: `frame-${id}`, sha256: SHA, mediaKind: 'image' } : undefined
  };
}

function input(overrides = {}) {
  return {
    projectId: 'KOC-1',
    sourceVideo: { id: 'source-1', sha256: SHA, mediaKind: 'video', durationSec: 40 },
    sourceInventoryAudit: {
      status: 'PASS', sourceVideoSha256: SHA, allArollRangesAccountedFor: true,
      brollRangesExcluded: true, auditSha256: SHA
    },
    identityReference: { id: 'identity-1', sha256: SHA, mediaKind: 'image' },
    arollSegments: [segment('A01', 0, 12), segment('A02', 16, 29)],
    firstFramePolicy: 'none',
    ...overrides
  };
}

test('builds independent parallel KOC lanes only after the preparation barrier passes', () => {
  const plan = buildKocRemakePlan(input());
  assert.equal(plan.preparationBarrier.status, 'PASS');
  assert.equal(plan.execution.strategy, 'event_driven_parallel_dag');
  assert.equal(plan.execution.lanes.length, 2);
  assert.equal(plan.execution.lanes.every(lane => lane.parallelizable), true);
  assert.equal(plan.execution.lanes.every(lane => lane.generation.resolution === '480p'), true);
  assert.equal(plan.execution.lanes.every(lane => lane.generation.assistantMaySubmitPaidGeneration === false), true);
  assert.match(plan.fingerprintSha256, /^[a-f0-9]{64}$/);
});

test('selected first frames are bound only to the chosen segments', () => {
  const plan = buildKocRemakePlan(input({
    arollSegments: [segment('A01', 0, 12, { firstFrame: true }), segment('A02', 16, 29)],
    firstFramePolicy: 'selected_segments',
    firstFrameSegmentIds: ['A01']
  }));
  assert.deepEqual(plan.execution.lanes[0].mediaBindings.map(item => item.role), [
    'koc_aroll_control', 'character_reference', 'first_frame'
  ]);
  assert.deepEqual(plan.execution.lanes[1].mediaBindings.map(item => item.role), [
    'koc_aroll_control', 'character_reference'
  ]);
});

test('rejects B-roll, overlong windows, incomplete takes, weak masks and detached audio', () => {
  const cases = [
    { patch: { containsBroll: true }, error: /B-roll/ },
    { patch: { endSec: 16 }, error: /15-second/ },
    { patch: { continuousTakeComplete: false }, error: /complete continuous A-roll/ },
    { patch: { maskAudit: { status: 'PASS', coverage: 'inner_face', outsideHeadPreserved: true, auditSha256: SHA } }, error: /full-head coverage/ },
    { patch: { sourceAudioMode: 'detached_audio' }, error: /embedded source audio/ }
  ];
  for (const item of cases) {
    const bad = { ...segment('A01', 0, 12), ...item.patch };
    assert.throws(() => buildKocRemakePlan(input({ arollSegments: [bad] })), item.error);
  }
});

test('rejects a partial A-roll inventory that lacks a source-SHA-bound completeness audit', () => {
  assert.throws(
    () => buildKocRemakePlan(input({ sourceInventoryAudit: undefined })),
    /complete A-roll coverage/
  );
  assert.throws(
    () => buildKocRemakePlan(input({
      sourceInventoryAudit: {
        status: 'PASS', sourceVideoSha256: 'c'.repeat(64), allArollRangesAccountedFor: true,
        brollRangesExcluded: true, auditSha256: SHA
      }
    })),
    /same source SHA/
  );
});
