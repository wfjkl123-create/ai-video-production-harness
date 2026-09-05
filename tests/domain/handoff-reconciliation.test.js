import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_DIMENSIONS,
  OBSERVED_FIELD_BY_HANDOFF_DIMENSION,
  assertHandoffReconciliation,
  buildHandoffReconciliation,
  observedHandoffState
} from '../../src/domain/handoff-reconciliation.js';

const binding = (id, sha = 'a'.repeat(64)) => ({ id, revision: 1, sha256: sha });

function assessments(overrides = {}) {
  return HANDOFF_DIMENSIONS.map(dimension => ({
    dimension,
    disposition: overrides[dimension] ?? 'consistent',
    evidence: `${dimension} was compared across planned end, observed end and next planned start`,
    resolution: overrides[dimension] ? `resolve ${dimension} before continuing` : `${dimension} is aligned`,
    observedEvidence: { field: OBSERVED_FIELD_BY_HANDOFF_DIMENSION[dimension], basis: 'observed', timestamps: [1] },
    ...(overrides[dimension] && overrides[dimension] !== 'consistent'
      ? { nextStateInstruction: `apply the approved ${dimension} correction at the next opening` }
      : {})
  }));
}

function input(overrides = {}) {
  return {
    id: 'reconcile-001-002',
    projectId: 'project-001',
    previousSegmentId: 'segment-001',
    nextSegmentId: 'segment-002',
    segmentationBinding: binding('segmentation-v2'),
    observedHandoffBinding: binding('observed-handoff-001', 'b'.repeat(64)),
    canonicalAuthorityBindings: [binding('character-identity-pack', 'c'.repeat(64))],
    plannedEndState: { people: ['lead on screen-left'] },
    observedEndState: { people: ['lead slightly closer to center'] },
    nextPlannedStartState: { people: ['lead on screen-left'] },
    dimensionAssessments: assessments(),
    spatialProxyPolicy: { useObservedFrame: false, reason: 'the next shot is an editorial cut and does not need an observed-frame proxy' },
    ...overrides
  };
}

test('requires a complete three-way assessment and computes PASS', () => {
  const value = buildHandoffReconciliation(input());
  assert.equal(value.decision, 'PASS');
  assert.equal(assertHandoffReconciliation(value), value);
  assert.equal(value.dimensionAssessments.length, HANDOFF_DIMENSIONS.length);
});

test('absorbs a harmless observed deviation into the next opening but blocks unknowns and failed prior takes', () => {
  assert.equal(buildHandoffReconciliation(input({
    dimensionAssessments: assessments({ distances: 'absorb_in_next' })
  })).decision, 'PASS');
  assert.equal(buildHandoffReconciliation(input({
    dimensionAssessments: assessments({ light: 'unknown' })
  })).decision, 'HOLD');
  assert.equal(buildHandoffReconciliation(input({
    dimensionAssessments: assessments({ identity: 'repair_previous' })
  })).decision, 'FAIL');
});

test('rejects partial assessment sets and fixed decisions supplied by callers', () => {
  assert.throws(() => buildHandoffReconciliation(input({ dimensionAssessments: assessments().slice(0, -1) })), /cover all 9/);
  const value = buildHandoffReconciliation(input());
  assert.throws(() => assertHandoffReconciliation({ ...value, decision: 'FAIL' }), /decision must be PASS/);
});

test('uses an observed frame only as a spatial proxy and never as identity or product authority', () => {
  const value = buildHandoffReconciliation(input({
    spatialProxyPolicy: {
      useObservedFrame: true,
      binding: binding('observed-tail-frame', 'd'.repeat(64)),
      responsibility: 'instantaneous position, pose, gaze and motion phase only',
      mustNotControl: ['character identity', 'product structure']
    }
  }));
  assert.equal(value.decision, 'PASS');
  assert.throws(() => assertHandoffReconciliation({
    ...value,
    spatialProxyPolicy: { ...value.spatialProxyPolicy, mustNotControl: ['character identity', 'wardrobe'] }
  }), /identity and product structure/);
});

test('normalizes the observed handoff evidence into an end-state comparison view', () => {
  const field = value => ({ value, basis: 'observed', timestamps: [1] });
  assert.deepEqual(observedHandoffState({
    people: field(['lead']), distances: field(['near']), productState: field({ description: 'held' }),
    props: field(['phone']), camera: field({ shotSize: 'medium' }), openMotion: field(['turning']),
    light: field({ description: 'window key from screen-left' }), audio: field({ description: 'room tone continues' }),
    identity: field([{ personId: 'lead', observedContinuity: 'face and hair remain consistent' }]), unknowns: field(['lens'])
  }), {
    people: ['lead'], distances: ['near'], product: { description: 'held' }, props: ['phone'],
    camera: { shotSize: 'medium' }, openMotion: ['turning'], light: { description: 'window key from screen-left' },
    audio: { description: 'room tone continues' }, identity: [{ personId: 'lead', observedContinuity: 'face and hair remain consistent' }],
    unknowns: ['lens']
  });
});
