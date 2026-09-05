import { assertExecutionObservation } from './execution-ledger.js';

const DECISIONS = new Set(['approved', 'rejected']);

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function percentage(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError(`${field} must be between 0 and 100`);
}

export function assertQualityRubric(value) {
  object(value, 'rubric');
  text(value.id, 'rubric.id');
  if (!Number.isInteger(value.version) || value.version < 1) throw new TypeError('rubric.version must be a positive integer');
  percentage(value.threshold, 'rubric.threshold');
  if (!Array.isArray(value.dimensions) || value.dimensions.length === 0) throw new TypeError('rubric.dimensions must be non-empty');
  const ids = new Set();
  let totalWeight = 0;
  for (const dimension of value.dimensions) {
    object(dimension, 'dimension');
    text(dimension.id, 'dimension.id');
    text(dimension.label, 'dimension.label');
    if (ids.has(dimension.id)) throw new TypeError(`duplicate dimension: ${dimension.id}`);
    ids.add(dimension.id);
    if (!Number.isFinite(dimension.weight) || dimension.weight <= 0 || dimension.weight > 100) throw new TypeError('dimension.weight must be between 0 and 100');
    percentage(dimension.minimum, 'dimension.minimum');
    if (typeof dimension.critical !== 'boolean') throw new TypeError('dimension.critical must be boolean');
    if (value.version >= 2) {
      for (const field of ['observableRequirement', 'evidenceType', 'timeOrRegion']) text(dimension[field], `dimension.${field}`);
      if (!Array.isArray(dimension.canonicalAnchorIds) || dimension.canonicalAnchorIds.length === 0) {
        throw new TypeError('version 2 dimension.canonicalAnchorIds must be non-empty');
      }
      dimension.canonicalAnchorIds.forEach(anchorId => text(anchorId, 'dimension.canonicalAnchorId'));
      object(dimension.canonicalAnchorSha256ById, 'dimension.canonicalAnchorSha256ById');
      const anchorIds = [...new Set(dimension.canonicalAnchorIds)];
      if (Object.keys(dimension.canonicalAnchorSha256ById).length !== anchorIds.length
        || anchorIds.some(anchorId => !/^[a-f0-9]{64}$/.test(dimension.canonicalAnchorSha256ById[anchorId] ?? ''))) {
        throw new TypeError('version 2 canonical anchors must each bind one lowercase SHA-256');
      }
    }
    totalWeight += dimension.weight;
  }
  if (Math.abs(totalWeight - 100) > Number.EPSILON) throw new TypeError('dimension weights must total 100');
  if (!Array.isArray(value.vetoes)) throw new TypeError('rubric.vetoes must be an array');
  const vetoIds = new Set();
  for (const veto of value.vetoes) {
    object(veto, 'veto');
    text(veto.id, 'veto.id');
    text(veto.label, 'veto.label');
    if (vetoIds.has(veto.id)) throw new TypeError(`duplicate veto: ${veto.id}`);
    vetoIds.add(veto.id);
  }
  return value;
}

export function evaluateQualityRubric(rubric, input) {
  assertQualityRubric(rubric);
  object(input, 'quality input');
  object(input.scores, 'scores');
  if (!Array.isArray(input.triggeredVetoIds)) throw new TypeError('triggeredVetoIds must be an array');
  const dimensions = new Map(rubric.dimensions.map(dimension => [dimension.id, dimension]));
  if (rubric.version >= 2) object(input.evidenceByDimension, 'evidenceByDimension');
  for (const id of Object.keys(input.scores)) if (!dimensions.has(id)) throw new TypeError(`unknown score dimension: ${id}`);
  let overall = 0;
  const failures = [];
  for (const dimension of rubric.dimensions) {
    if (!Object.hasOwn(input.scores, dimension.id)) throw new TypeError(`score is required for ${dimension.id}`);
    const score = input.scores[dimension.id];
    percentage(score, `scores.${dimension.id}`);
    overall += score * dimension.weight / 100;
    if (dimension.critical && score < dimension.minimum) failures.push(`critical minimum failed: ${dimension.id}`);
    if (rubric.version >= 2) {
      const evidence = input.evidenceByDimension[dimension.id];
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError(`evidence is required for ${dimension.id}`);
      text(evidence.observation, `evidenceByDimension.${dimension.id}.observation`);
      if (!Array.isArray(evidence.timestampsOrRegions) || evidence.timestampsOrRegions.length === 0) {
        throw new TypeError(`evidenceByDimension.${dimension.id}.timestampsOrRegions must be non-empty`);
      }
      evidence.timestampsOrRegions.forEach(item => text(item, `evidenceByDimension.${dimension.id}.timestampsOrRegions`));
      if (!Array.isArray(evidence.anchorIds) || evidence.anchorIds.length === 0) {
        throw new TypeError(`evidenceByDimension.${dimension.id}.anchorIds must be non-empty`);
      }
      evidence.anchorIds.forEach(anchorId => text(anchorId, `evidenceByDimension.${dimension.id}.anchorIds`));
      const allowedAnchors = new Set(dimension.canonicalAnchorIds);
      if (evidence.anchorIds.some(anchorId => !allowedAnchors.has(anchorId))) {
        throw new TypeError(`evidenceByDimension.${dimension.id}.anchorIds contains an unbound anchor`);
      }
      if (!evidence.anchorSha256ById || typeof evidence.anchorSha256ById !== 'object' || Array.isArray(evidence.anchorSha256ById)
        || evidence.anchorIds.some(anchorId => evidence.anchorSha256ById[anchorId] !== dimension.canonicalAnchorSha256ById[anchorId])) {
        throw new TypeError(`evidenceByDimension.${dimension.id} must bind the exact canonical anchor SHA-256 values`);
      }
    }
  }
  const allowedVetoes = new Set(rubric.vetoes.map(({ id }) => id));
  const triggered = [...new Set(input.triggeredVetoIds)];
  for (const id of triggered) {
    text(id, 'triggeredVetoId');
    if (!allowedVetoes.has(id)) throw new TypeError(`unknown veto: ${id}`);
    failures.push(`veto triggered: ${id}`);
  }
  const rounded = Math.round((overall + Number.EPSILON) * 100) / 100;
  if (rounded < rubric.threshold) failures.push(`overall below threshold: ${rounded} < ${rubric.threshold}`);
  return { overall: rounded, qualifies: failures.length === 0, failures };
}

export function assertQualityReview(value) {
  object(value, 'quality review');
  for (const field of ['id', 'artifactId', 'artifactSha256', 'rubricId', 'rubricSha256', 'note', 'createdAt']) text(value[field], field);
  if (value.kind !== 'quality_review') throw new TypeError('kind must be quality_review');
  if (value.actor !== 'human') throw new TypeError('final quality review actor must be human');
  if (!DECISIONS.has(value.decision)) throw new TypeError('decision must be approved or rejected');
  if (!Number.isInteger(value.rubricVersion) || value.rubricVersion < 1) throw new TypeError('rubricVersion must be positive');
  object(value.scores, 'scores');
  if (!Array.isArray(value.triggeredVetoIds) || !Array.isArray(value.failures)) throw new TypeError('quality evidence arrays are required');
  if (value.rubricVersion >= 2) object(value.evidenceByDimension, 'evidenceByDimension');
  percentage(value.overall, 'overall');
  if (typeof value.qualifies !== 'boolean') throw new TypeError('qualifies must be boolean');
  if (value.decision === 'rejected') text(value.correction, 'correction');
  if (value.failureObservation !== undefined) {
    if (value.decision !== 'rejected') throw new TypeError('failureObservation is only valid for rejected quality reviews');
    const normalized = assertExecutionObservation({
      subjectId: value.id,
      scope: 'segment',
      stage: 'gate5',
      failure: value.failureObservation
    });
    if (normalized.failure.retryKind !== 'none') {
      throw new TypeError('a Gate 5 rejection must use retryKind none until rework actually occurs');
    }
  }
  if (value.resolvedRejection !== undefined) {
    if (value.decision !== 'approved') throw new TypeError('resolvedRejection is only valid for approved quality reviews');
    object(value.resolvedRejection, 'resolvedRejection');
    for (const field of ['reviewId', 'artifactId', 'artifactSha256', 'reviewPath', 'reviewSha256']) {
      text(value.resolvedRejection[field], `resolvedRejection.${field}`);
    }
    if (!/^[a-f0-9]{64}$/.test(value.resolvedRejection.artifactSha256)
      || !/^[a-f0-9]{64}$/.test(value.resolvedRejection.reviewSha256)) {
      throw new TypeError('resolvedRejection must bind lowercase SHA-256 evidence');
    }
  }
  if ((value.decision === 'approved') !== value.qualifies) text(value.overrideReason, 'overrideReason');
  return value;
}
