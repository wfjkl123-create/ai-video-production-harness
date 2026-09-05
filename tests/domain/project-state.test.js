import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  assertArtifact,
  canTransition,
  transitionArtifact
} from '../../src/domain/artifact.js';
import { assertProjectState } from '../../src/domain/project-state.js';

const draft = { id: 'script-v1', type: 'script', revision: 1, status: 'draft', path: 'brief/script-v1.md' };

test('cannot lock an artifact without a human review id', () => {
  assert.throws(() => transitionArtifact(draft, 'locked'), /reviewId/);
});

test('locks an awaiting_review artifact with human evidence', () => {
  const review = { ...draft, status: 'awaiting_review' };
  const locked = transitionArtifact(review, 'locked', 'review-001');
  assert.equal(locked.status, 'locked');
  assert.equal(locked.lockedByReviewId, 'review-001');
});

test('binds a rejection review and clears it when rework starts', () => {
  const review = { ...draft, status: 'awaiting_review' };
  const rejected = transitionArtifact(review, 'rejected', 'review-rejected-001');
  assert.equal(rejected.rejectedByReviewId, 'review-rejected-001');
  const rework = transitionArtifact(rejected, 'rework');
  assert.equal(Object.hasOwn(rework, 'rejectedByReviewId'), false);
});

test('exports the exact artifact statuses and types', () => {
  assert.deepEqual([...ARTIFACT_STATUSES], ['draft', 'awaiting_review', 'locked', 'rejected', 'rework', 'blocked']);
  assert.deepEqual([...ARTIFACT_TYPES], ['brief', 'creative_brief', 'script', 'shotlist', 'story_plan', 'source_fact_analysis', 'capability_manifest', 'segmentation', 'reference_video', 'spatial_control_model', 'project_asset', 'segment_asset', 'storyboard_panel', 'asset_visual_audit', 'human_visual_exception', 'character_acting_master', 'character_story_state', 'voice_identity', 'scene_geometry', 'handoff_reconciliation', 'shot_narration', 'seedance_prompt', 'canonical_prompt_source', 'execution_package', 'independent_creative_audit', 'video_segment', 'final_edit', 'handoff', 'rule', 'quality_rubric', 'segment_contract']);
});

test('permits only transitions in the approved graph', () => {
  assert.equal(canTransition('draft', 'awaiting_review'), true);
  assert.equal(canTransition('awaiting_review', 'locked'), true);
  assert.equal(canTransition('locked', 'draft'), false);
  assert.equal(canTransition('unknown', 'draft'), false);
  assert.throws(() => transitionArtifact(draft, 'locked', 'review-001'), /invalid transition/);
});

test('validates required artifact fields and enums', () => {
  assert.equal(assertArtifact(draft), draft);
  assert.throws(() => assertArtifact({ ...draft, id: '' }), /id/);
  assert.throws(() => assertArtifact({ ...draft, revision: 0 }), /revision/);
  assert.throws(() => assertArtifact({ ...draft, type: 'unknown' }), /type/);
  assert.throws(() => assertArtifact({ ...draft, status: 'unknown' }), /status/);
});

test('validates optional supersession lineage without deleting old evidence', () => {
  const next = { ...draft, id: 'script-v2', revision: 2, supersedesArtifactId: 'script-v1' };
  assert.equal(assertArtifact(next).supersedesArtifactId, 'script-v1');
  assert.throws(() => assertArtifact({ ...next, supersedesArtifactId: '   ' }), /supersedesArtifactId/);
  assert.throws(() => assertArtifact({ ...next, supersedesArtifactId: next.id }), /supersede itself/);
});

test('scope-invalidated artifacts require a non-empty revision marker and reason', () => {
  const invalidated = {
    ...draft, invalidatedByScopeRevisionId: 'direction-revision-2',
    invalidationReason: '用户确认修改核心视觉优先级'
  };
  assert.equal(assertArtifact(invalidated).invalidatedByScopeRevisionId, 'direction-revision-2');
  assert.throws(() => assertArtifact({ ...invalidated, invalidationReason: '  ' }), /invalidationReason/);
  assert.throws(() => assertArtifact({ ...draft, invalidationReason: '孤立原因' }), /requires invalidatedByScopeRevisionId/);
});

test('rejects whitespace-only required artifact strings and review ids', () => {
  assert.throws(() => assertArtifact({ ...draft, id: '   ' }), /id/);
  assert.throws(() => assertArtifact({ ...draft, path: '\t\n' }), /path/);
  const review = { ...draft, status: 'awaiting_review' };
  assert.throws(() => transitionArtifact(review, 'locked', '   '), /reviewId/);
});

test('requires checksum evidence for locked media-bearing artifacts', () => {
  const lockedMedia = {
    ...draft,
    type: 'video_segment',
    status: 'locked',
    lockedByReviewId: 'review-001'
  };
  assert.throws(() => assertArtifact(lockedMedia), /sha256/);
  assert.equal(assertArtifact({ ...lockedMedia, sha256: 'a'.repeat(64) }).sha256, 'a'.repeat(64));
});

test('does not transition media to locked without checksum evidence', () => {
  const mediaReview = { ...draft, type: 'video_segment', status: 'awaiting_review' };
  assert.throws(() => transitionArtifact(mediaReview, 'locked', 'review-001'), /sha256/);
});

test('enforces the exact media-bearing type boundary', () => {
  const mediaTypes = ['project_asset', 'segment_asset', 'storyboard_panel', 'video_segment', 'final_edit'];
  const nonMediaTypes = ARTIFACT_TYPES.filter(type => !mediaTypes.includes(type));
  for (const type of mediaTypes) {
    const locked = { ...draft, type, status: 'locked', lockedByReviewId: 'review-001' };
    assert.throws(() => assertArtifact(locked), /sha256/, `${type} must require sha256`);
    assert.equal(assertArtifact({ ...locked, sha256: 'a'.repeat(64) }).type, type);
  }
  for (const type of nonMediaTypes) {
    const locked = { ...draft, type, status: 'locked', lockedByReviewId: 'review-001' };
    assert.equal(assertArtifact(locked).type, type, `${type} must not require sha256`);
  }
});

test('validates all required project state fields', () => {
  const state = {
    projectId: 'QC-001',
    phase: 'intake',
    activeSegmentId: null,
    blockedReason: null,
    artifacts: [draft],
    updatedAt: '2026-07-12T00:00:00.000Z'
  };
  assert.equal(assertProjectState(state), state);
  for (const field of ['projectId', 'phase', 'activeSegmentId', 'blockedReason', 'artifacts', 'updatedAt']) {
    const invalid = { ...state };
    delete invalid[field];
    assert.throws(() => assertProjectState(invalid), new RegExp(field));
  }
});

test('rejects whitespace-only required project state strings', () => {
  const state = {
    projectId: 'QC-001',
    phase: 'intake',
    activeSegmentId: null,
    blockedReason: null,
    artifacts: [],
    updatedAt: '2026-07-12T00:00:00Z'
  };
  for (const field of ['projectId', 'phase']) {
    assert.throws(() => assertProjectState({ ...state, [field]: '   ' }), new RegExp(field));
  }
  assert.throws(() => assertProjectState({ ...state, activeSegmentId: '\t' }), /activeSegmentId/);
  assert.throws(() => assertProjectState({ ...state, blockedReason: '\n' }), /blockedReason/);
});

test('accepts only precise RFC3339 date-time values for updatedAt', () => {
  const state = {
    projectId: 'QC-001',
    phase: 'intake',
    activeSegmentId: null,
    blockedReason: null,
    artifacts: [],
    updatedAt: '2026-07-12T08:30:45Z'
  };
  for (const updatedAt of ['2026-07-12T08:30:45Z', '2026-07-12T08:30:45.123+08:00']) {
    assert.equal(assertProjectState({ ...state, updatedAt }).updatedAt, updatedAt);
  }
  for (const updatedAt of ['2026-07-12', '2026-07-12 08:30:45Z', '2026-02-30T08:30:45Z', '2026-07-12T08:30:45+24:00']) {
    assert.throws(() => assertProjectState({ ...state, updatedAt }), /updatedAt/);
  }
});

test('accepts legacy projects without workflowVersion and validates explicit versions', () => {
  const state = { projectId: 'QC-001', phase: 'intake', activeSegmentId: null, blockedReason: null, artifacts: [], updatedAt: '2026-07-30T00:00:00Z' };
  assert.doesNotThrow(() => assertProjectState(state));
  assert.equal(assertProjectState({ ...state, workflowVersion: 2 }).workflowVersion, 2);
  assert.throws(() => assertProjectState({ ...state, workflowVersion: 3 }), /workflowVersion/);
});

test('dual-reads legacy realism contracts and validates explicit v2 write mode', () => {
  const legacy = { projectId: 'QC-001', phase: 'intake', activeSegmentId: null, blockedReason: null, artifacts: [], updatedAt: '2026-07-30T00:00:00Z' };
  assert.doesNotThrow(() => assertProjectState(legacy));
  assert.equal(assertProjectState({ ...legacy, realismContractsVersion: 2, realismContractsWriteMode: 'enabled' }).realismContractsVersion, 2);
  assert.throws(() => assertProjectState({ ...legacy, realismContractsVersion: 2 }), /realismContractsWriteMode/);
  assert.throws(() => assertProjectState({ ...legacy, realismContractsVersion: 3, realismContractsWriteMode: 'enabled' }), /realismContractsVersion/);
  assert.throws(() => assertProjectState({ ...legacy, realismContractsVersion: 2, realismContractsWriteMode: 'unknown' }), /realismContractsWriteMode/);
});

test('validates optional ingress routing state without breaking legacy projects', () => {
  const legacy = {
    projectId: 'QC-001', phase: 'intake', activeSegmentId: null, blockedReason: null,
    artifacts: [], updatedAt: '2026-08-08T00:00:00Z'
  };
  assert.doesNotThrow(() => assertProjectState(legacy));
  assert.doesNotThrow(() => assertProjectState({
    ...legacy,
    workflowVersion: 2,
    ingressPolicyVersion: 'ingress-route-v1'
  }));

  const routeDecision = {
    policyVersion: 'ingress-route-v1', harnessRequired: true, reason: 'video_input',
    inputTypes: ['video'], sourceVideoIds: ['source-video-001'],
    referenceRoleStatus: 'awaiting_reference_role'
  };
  assert.equal(assertProjectState({
    ...legacy, workflowVersion: 2, ingressPolicyVersion: 'ingress-route-v1', routeDecision
  }).routeDecision, routeDecision);
  assert.throws(
    () => assertProjectState({ ...legacy, workflowVersion: 2, routeDecision }),
    /ingressPolicyVersion/
  );
  assert.throws(
    () => assertProjectState({
      ...legacy, workflowVersion: 2, ingressPolicyVersion: 'ingress-route-v1',
      routeDecision: { ...routeDecision, policyVersion: 'ingress-route-v2' }
    }),
    /policyVersion/
  );
  assert.throws(
    () => assertProjectState({
      ...legacy, workflowVersion: 2, ingressPolicyVersion: 'ingress-route-v1',
      routeDecision: { ...routeDecision, sourceVideoIds: ['same', 'same'] }
    }),
    /sourceVideoIds/
  );
});

test('publishes JSON schemas with the required contracts', async () => {
  const artifactSchema = JSON.parse(await readFile(new URL('../../schemas/artifact.schema.json', import.meta.url), 'utf8'));
  const projectSchema = JSON.parse(await readFile(new URL('../../schemas/project-state.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(artifactSchema.required, ['id', 'type', 'revision', 'status', 'path']);
  assert.ok(JSON.stringify(artifactSchema).includes('sha256'));
  assert.equal(artifactSchema.properties.supersedesArtifactId.pattern, '.*\\S.*');
  assert.deepEqual(projectSchema.required, ['projectId', 'phase', 'activeSegmentId', 'blockedReason', 'artifacts', 'updatedAt']);
  assert.equal(projectSchema.properties.ingressPolicyVersion.const, 'ingress-route-v1');
  assert.equal(projectSchema.properties.routeDecision.$ref, 'ingress-route-decision.schema.json');
  assert.deepEqual(projectSchema.properties.realismContractsVersion.enum, [1, 2]);
});

test('JSON schemas reject whitespace-only required strings', async () => {
  const artifactSchema = JSON.parse(await readFile(new URL('../../schemas/artifact.schema.json', import.meta.url), 'utf8'));
  const projectSchema = JSON.parse(await readFile(new URL('../../schemas/project-state.schema.json', import.meta.url), 'utf8'));
  for (const field of ['id', 'path', 'lockedByReviewId']) {
    assert.equal(artifactSchema.properties[field].pattern, '.*\\S.*');
  }
  for (const field of ['projectId', 'phase', 'activeSegmentId', 'blockedReason']) {
    assert.equal(projectSchema.properties[field].pattern, '.*\\S.*');
  }
});

test('artifact schema uses the exact media-bearing type boundary', async () => {
  const artifactSchema = JSON.parse(await readFile(new URL('../../schemas/artifact.schema.json', import.meta.url), 'utf8'));
  const mediaBoundary = artifactSchema.allOf.find(item => Array.isArray(item.if?.properties?.type?.enum));
  assert.deepEqual(mediaBoundary.if.properties.type.enum, ['project_asset', 'segment_asset', 'storyboard_panel', 'video_segment', 'final_edit']);
});
