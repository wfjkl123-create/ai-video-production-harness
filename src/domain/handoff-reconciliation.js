import { assertAuthorityBinding } from './realism-authority.js';

export const HANDOFF_DIMENSIONS = Object.freeze([
  'people', 'distances', 'product', 'props', 'camera', 'open_motion', 'light', 'audio', 'identity'
]);

const DISPOSITIONS = new Set(['consistent', 'absorb_in_next', 'repair_previous', 'unknown']);
export const OBSERVED_FIELD_BY_HANDOFF_DIMENSION = Object.freeze({
  people: 'people', distances: 'distances', product: 'productState', props: 'props', camera: 'camera',
  open_motion: 'openMotion', light: 'light', audio: 'audio', identity: 'identity'
});

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function bindingList(value, field, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) throw new TypeError(`${field} must contain at least ${min} bindings`);
  value.forEach((entry, index) => assertAuthorityBinding(entry, `${field}[${index}]`));
  if (new Set(value.map(entry => entry.id)).size !== value.length) throw new TypeError(`${field} must not repeat artifact IDs`);
  return value;
}

export function assertHandoffReconciliation(value) {
  object(value, 'handoff reconciliation');
  if (value.kind !== 'handoff_reconciliation_v1' || value.version !== 1) throw new TypeError('handoff_reconciliation_v1 is required');
  for (const field of ['id', 'projectId', 'previousSegmentId', 'nextSegmentId']) text(value[field], field);
  assertAuthorityBinding(value.segmentationBinding, 'segmentationBinding');
  assertAuthorityBinding(value.observedHandoffBinding, 'observedHandoffBinding');
  bindingList(value.canonicalAuthorityBindings, 'canonicalAuthorityBindings', { min: 1 });
  for (const field of ['plannedEndState', 'observedEndState', 'nextPlannedStartState']) {
    object(value[field], field);
    if (Object.keys(value[field]).length === 0) throw new TypeError(`${field} must contain observable state evidence`);
  }
  if (!Array.isArray(value.dimensionAssessments) || value.dimensionAssessments.length !== HANDOFF_DIMENSIONS.length) {
    throw new TypeError(`dimensionAssessments must cover all ${HANDOFF_DIMENSIONS.length} handoff dimensions exactly once`);
  }
  const dimensions = new Set();
  for (const [index, assessment] of value.dimensionAssessments.entries()) {
    object(assessment, `dimensionAssessments[${index}]`);
    if (!HANDOFF_DIMENSIONS.includes(assessment.dimension)) throw new TypeError(`dimensionAssessments[${index}].dimension is invalid`);
    if (dimensions.has(assessment.dimension)) throw new TypeError(`dimensionAssessments repeats ${assessment.dimension}`);
    dimensions.add(assessment.dimension);
    if (!DISPOSITIONS.has(assessment.disposition)) throw new TypeError(`dimensionAssessments[${index}].disposition is invalid`);
    for (const field of ['evidence', 'resolution']) text(assessment[field], `dimensionAssessments[${index}].${field}`);
    object(assessment.observedEvidence, `dimensionAssessments[${index}].observedEvidence`);
    if (assessment.observedEvidence.field !== OBSERVED_FIELD_BY_HANDOFF_DIMENSION[assessment.dimension]) {
      throw new TypeError(`dimensionAssessments[${index}].observedEvidence.field must be ${OBSERVED_FIELD_BY_HANDOFF_DIMENSION[assessment.dimension]}`);
    }
    if (!['observed', 'multi_frame_inference'].includes(assessment.observedEvidence.basis)) {
      throw new TypeError(`dimensionAssessments[${index}].observedEvidence.basis is invalid`);
    }
    if (!Array.isArray(assessment.observedEvidence.timestamps) || assessment.observedEvidence.timestamps.length === 0
      || assessment.observedEvidence.timestamps.some(timestamp => !Number.isFinite(timestamp) || timestamp < 0)) {
      throw new TypeError(`dimensionAssessments[${index}].observedEvidence.timestamps must contain non-negative numbers`);
    }
    if (assessment.disposition !== 'consistent') text(assessment.nextStateInstruction, `dimensionAssessments[${index}].nextStateInstruction`);
  }
  const missingDimensions = HANDOFF_DIMENSIONS.filter(dimension => !dimensions.has(dimension));
  if (missingDimensions.length > 0) throw new TypeError(`dimensionAssessments is missing: ${missingDimensions.join(', ')}`);
  const computedDecision = value.dimensionAssessments.some(item => item.disposition === 'repair_previous')
    ? 'FAIL'
    : value.dimensionAssessments.some(item => item.disposition === 'unknown') ? 'HOLD' : 'PASS';
  if (value.decision !== computedDecision) throw new Error(`handoff reconciliation decision must be ${computedDecision}`);
  object(value.spatialProxyPolicy, 'spatialProxyPolicy');
  if (typeof value.spatialProxyPolicy.useObservedFrame !== 'boolean') throw new TypeError('spatialProxyPolicy.useObservedFrame must be boolean');
  if (value.spatialProxyPolicy.useObservedFrame) {
    assertAuthorityBinding(value.spatialProxyPolicy.binding, 'spatialProxyPolicy.binding');
    if (value.canonicalAuthorityBindings.length === 0) throw new Error('observed-frame spatial proxy requires canonical authority bindings');
    if (value.spatialProxyPolicy.responsibility !== 'instantaneous position, pose, gaze and motion phase only') throw new TypeError('spatialProxyPolicy responsibility is invalid');
    if (!Array.isArray(value.spatialProxyPolicy.mustNotControl)
      || !value.spatialProxyPolicy.mustNotControl.includes('character identity')
      || !value.spatialProxyPolicy.mustNotControl.includes('product structure')) {
      throw new TypeError('spatialProxyPolicy must forbid identity and product structure control');
    }
  } else {
    text(value.spatialProxyPolicy.reason, 'spatialProxyPolicy.reason');
    if (value.spatialProxyPolicy.binding !== undefined) throw new TypeError('unused spatial proxy must not bind an artifact');
  }
  return value;
}

export function observedHandoffState(handoff) {
  object(handoff, 'observed handoff');
  const read = name => handoff[name]?.value;
  return {
    people: read('people'), distances: read('distances'), product: read('productState'), props: read('props'),
    camera: read('camera'), openMotion: read('openMotion'), light: read('light'), audio: read('audio'),
    identity: read('identity'), unknowns: read('unknowns')
  };
}

export function buildHandoffReconciliation(input) {
  object(input, 'handoff reconciliation input');
  const assessments = structuredClone(input.dimensionAssessments);
  const decision = assessments.some(item => item.disposition === 'repair_previous')
    ? 'FAIL'
    : assessments.some(item => item.disposition === 'unknown') ? 'HOLD' : 'PASS';
  return assertHandoffReconciliation({
    kind: 'handoff_reconciliation_v1', version: 1,
    id: input.id, projectId: input.projectId, previousSegmentId: input.previousSegmentId, nextSegmentId: input.nextSegmentId,
    segmentationBinding: structuredClone(input.segmentationBinding),
    observedHandoffBinding: structuredClone(input.observedHandoffBinding),
    canonicalAuthorityBindings: structuredClone(input.canonicalAuthorityBindings ?? []),
    plannedEndState: structuredClone(input.plannedEndState),
    observedEndState: structuredClone(input.observedEndState),
    nextPlannedStartState: structuredClone(input.nextPlannedStartState),
    dimensionAssessments: assessments,
    decision,
    spatialProxyPolicy: structuredClone(input.spatialProxyPolicy)
  });
}
