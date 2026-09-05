import { join, resolve } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { currentArtifactsOf } from '../domain/current-artifact.js';
import {
  buildHandoffReconciliation,
  observedHandoffState,
  OBSERVED_FIELD_BY_HANDOFF_DIMENSION
} from '../domain/handoff-reconciliation.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { verifyLockedArtifact } from './artifact-file-service.js';
import { verifyObservedHandoffEvidence } from './handoff-evidence-service.js';
import { registerArtifact } from './intake-service.js';
import { autoLockArtifact } from './review-service.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CANONICAL_AUTHORITY_TYPES = new Set([
  'character_acting_master', 'character_story_state', 'voice_identity', 'scene_geometry',
  'project_asset', 'segment_asset', 'spatial_control_model'
]);
const CANONICAL_ASSET_TYPES = new Set([
  'character_identity_pack_v2', 'character_board', 'character_identity_single_view', 'character_front_face_closeup_v1',
  'product_reference', 'scene_multiview', 'scene_overhead', 'story_prop', 'wardrobe_board', 'color_board', 'character_product_state'
]);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function binding(artifact) {
  return { id: artifact.id, revision: artifact.revision, sha256: artifact.sha256 };
}

function observedCandidates(state, previousSegmentId) {
  return currentArtifactsOf(state.artifacts, artifact => artifact.type === 'handoff'
    && artifact.segmentId === previousSegmentId
    && artifact.status === 'locked'
    && artifact.observed === true)
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
}

function canonicalAuthority(artifact) {
  if (!CANONICAL_AUTHORITY_TYPES.has(artifact.type)) return false;
  if (!['project_asset', 'segment_asset'].includes(artifact.type)) return true;
  return CANONICAL_ASSET_TYPES.has(artifact.assetType);
}

function spatialProxy(artifact, previousSegmentId) {
  return artifact.type === 'handoff'
    ? artifact.segmentId === previousSegmentId && artifact.handoffKind === 'canonical_hd_restoration'
    : artifact.type === 'segment_asset'
      && artifact.segmentId === previousSegmentId
      && artifact.assetType === 'handoff_blocking';
}

export async function reconcileSegmentHandoff(root, input) {
  root = resolve(root);
  for (const field of ['id', 'previousSegmentId', 'nextSegmentId']) text(input?.[field], field);
  if (!SAFE_ID.test(input.id)) throw new TypeError('id must be a safe identifier');
  if (!Array.isArray(input.canonicalAuthorityArtifactIds) || input.canonicalAuthorityArtifactIds.length === 0
    || new Set(input.canonicalAuthorityArtifactIds).size !== input.canonicalAuthorityArtifactIds.length) {
    throw new TypeError('canonicalAuthorityArtifactIds must be a non-empty array of unique IDs');
  }
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  if ((state.realismContractsVersion ?? 1) !== 2 || state.realismContractsWriteMode === 'read_only') {
    throw new Error('handoff reconciliation writes require realismContractsVersion 2 with write mode enabled');
  }
  const current = currentArtifactsOf(state.artifacts);
  const currentById = new Map(current.map(artifact => [artifact.id, artifact]));
  const segmentations = current.filter(artifact => artifact.type === 'segmentation' && artifact.status === 'locked');
  if (segmentations.length !== 1) throw new Error('exactly one current locked segmentation is required');
  const segmentation = segmentations[0];
  await verifyLockedArtifact(root, segmentation);
  const segmentationPayload = await readJson(join(root, segmentation.path));
  const segments = segmentationPayload.segments ?? [];
  const previousIndex = segments.findIndex(segment => segment.id === input.previousSegmentId);
  if (previousIndex < 0 || segments[previousIndex + 1]?.id !== input.nextSegmentId) {
    throw new Error('handoff reconciliation requires adjacent previous and next segments in the current locked segmentation');
  }
  const previous = segments[previousIndex];
  const next = segments[previousIndex + 1];
  if (previous.status !== 'locked' || next.status !== 'locked') throw new Error('both handoff segments must be locked');

  const observed = observedCandidates(state, previous.id);
  if (observed.length !== 1) throw new Error(`exactly one current locked observed handoff for ${previous.id} is required`);
  if (input.observedHandoffArtifactId !== undefined && input.observedHandoffArtifactId !== observed[0].id) {
    throw new Error('observedHandoffArtifactId does not match the current observed handoff');
  }
  await verifyObservedHandoffEvidence(root, observed[0]);
  if (observed[0].realismContractsVersion !== 2) {
    throw new Error('realism contracts v2 require an observed handoff with light, audio and identity evidence');
  }

  const authorities = [];
  for (const id of input.canonicalAuthorityArtifactIds) {
    text(id, 'canonicalAuthorityArtifactIds entry');
    const artifact = currentById.get(id);
    if (!artifact || artifact.status !== 'locked' || !canonicalAuthority(artifact)) {
      throw new Error(`canonical handoff authority must be a current locked identity, acting, voice, scene, product, prop, wardrobe or state artifact: ${id}`);
    }
    await verifyLockedArtifact(root, artifact);
    authorities.push(artifact);
  }

  let spatialProxyPolicy;
  if (input.spatialProxyArtifactId !== undefined) {
    const artifact = currentById.get(text(input.spatialProxyArtifactId, 'spatialProxyArtifactId'));
    if (!artifact || artifact.status !== 'locked' || !spatialProxy(artifact, previous.id)) {
      throw new Error('spatialProxyArtifactId must reference a current locked prior-segment handoff spatial proxy');
    }
    await verifyLockedArtifact(root, artifact);
    spatialProxyPolicy = {
      useObservedFrame: true,
      binding: binding(artifact),
      responsibility: 'instantaneous position, pose, gaze and motion phase only',
      mustNotControl: ['character identity', 'product structure']
    };
  } else {
    spatialProxyPolicy = {
      useObservedFrame: false,
      reason: input.spatialProxyNotUsedReason ?? 'the next segment can preserve continuity from the reconciled state without an observed-frame spatial proxy'
    };
  }

  const prior = current.filter(artifact => artifact.type === 'handoff_reconciliation'
    && artifact.segmentId === next.id && artifact.previousSegmentId === previous.id);
  if (prior.length > 1) throw new Error('multiple current handoff reconciliations exist for the same boundary');
  if (prior.length === 1 && input.supersedesArtifactId !== prior[0].id) {
    throw new Error('a current handoff reconciliation exists; explicit supersedesArtifactId is required');
  }
  if (prior.length === 0 && input.supersedesArtifactId !== undefined) throw new Error('supersedesArtifactId does not match a current handoff reconciliation');
  const revision = (prior[0]?.revision ?? 0) + 1;
  const dimensionAssessments = input.dimensionAssessments.map(assessment => {
    const field = OBSERVED_FIELD_BY_HANDOFF_DIMENSION[assessment.dimension];
    const observedField = observed[0][field];
    if (!observedField) throw new Error(`observed handoff is missing ${field} evidence for ${assessment.dimension}`);
    return {
      ...assessment,
      observedEvidence: {
        field,
        basis: observedField.basis,
        timestamps: [...observedField.timestamps]
      }
    };
  });
  const payload = buildHandoffReconciliation({
    id: input.id,
    projectId: state.projectId,
    previousSegmentId: previous.id,
    nextSegmentId: next.id,
    segmentationBinding: binding(segmentation),
    observedHandoffBinding: binding(observed[0]),
    canonicalAuthorityBindings: authorities.map(binding),
    plannedEndState: previous.endState ?? {},
    observedEndState: observedHandoffState(observed[0]),
    nextPlannedStartState: next.startState ?? {},
    dimensionAssessments,
    spatialProxyPolicy
  });
  const path = `outputs/${next.id}/handoff-reconciliation-from-${previous.id}-r${revision}.json`;
  await writeJsonAtomic(join(root, path), payload);
  const descriptor = await registerArtifact(root, {
    id: input.id,
    type: 'handoff_reconciliation',
    revision,
    status: prior.length === 0 ? 'draft' : 'rework',
    path,
    segmentId: next.id,
    previousSegmentId: previous.id,
    nextSegmentId: next.id,
    decision: payload.decision,
    sourceSegmentationId: segmentation.id,
    sourceSegmentationSha256: segmentation.sha256,
    observedHandoffId: observed[0].id,
    observedHandoffSha256: observed[0].sha256,
    canonicalAuthorityArtifactIds: authorities.map(artifact => artifact.id),
    ...(input.spatialProxyArtifactId ? { spatialProxyArtifactId: input.spatialProxyArtifactId } : {}),
    ...(prior[0] ? { supersedesArtifactId: prior[0].id } : {})
  });
  if (payload.decision === 'PASS') {
    await autoLockArtifact(root, descriptor.id, 'auto-locked: planned end, observed end and next planned start fully reconciled against current canonical authorities');
  }
  const refreshed = assertProjectState(await readJson(join(root, 'project-state.json')));
  return {
    artifact: refreshed.artifacts.find(artifact => artifact.id === descriptor.id),
    reconciliation: payload
  };
}
