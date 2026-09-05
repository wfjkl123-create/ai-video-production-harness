import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHarness3060StudioProjection } from '../../src/services/harness-3060-studio-projection-service.js';

function state(artifacts = []) {
  return {
    projectId: 'projection-test',
    phase: 'creative_review',
    routeDecision: { referenceRoleStatus: 'authority' },
    artifacts
  };
}

test('projects the remake route with exactly three key human decision types', () => {
  const projection = projectHarness3060StudioProjection({ state: state() });
  assert.equal(projection.contractVersion, 'harness-30-60-studio-projection-v2');
  assert.equal(projection.routeKind, 'remake');
  assert.deepEqual(projection.humanDecisions.map(item => item.id), [
    'creative', 'paid_package', 'final_acceptance'
  ]);
  assert.equal(projection.migrationMode, 'read_only_legacy_projection');
});

test('projects asset lineage, unresolved paid-job blocking, and the three independent state planes', () => {
  const projection = projectHarness3060StudioProjection({
    state: state([
      { id: 'asset-person-v1', type: 'project_asset', assetType: 'character_board', revision: 1, status: 'locked', sha256: '1'.repeat(64) },
      { id: 'asset-person-v2', type: 'project_asset', assetType: 'character_board', revision: 2, status: 'locked', sha256: '2'.repeat(64), supersedesArtifactId: 'asset-person-v1' },
      { id: 'story-v1', type: 'story_plan', revision: 1, status: 'locked', sha256: '3'.repeat(64) },
      { id: 'contract-001', type: 'segment_contract', segmentId: 'segment-001', revision: 1, status: 'locked', sha256: '4'.repeat(64) }
    ]),
    segments: [{ id: 'segment-001' }],
    production: [{
      segmentId: 'segment-001', packageReady: true, readyForCanvas: true, assetManifestVerified: true,
      packageEvidence: {
        packageSha256: '6'.repeat(64), promptSha256: '7'.repeat(64), mediaBindingCount: 1,
        mediaBindings: [{ tag: '@图1', semanticToken: '@素材[asset-person-v1]', id: 'asset-person-v1', mediaKind: 'image', sha256: '1'.repeat(64), controls: ['人物身份'], mustNotControl: ['产品结构'] }],
        governanceBindings: Object.fromEntries(['segmentContract', 'shotNarration', 'seedancePrompt', 'assetManifest']
          .map((name, index) => [name, { id: `${name}-v1`, status: 'locked', sha256: String(index + 6).repeat(64) }]))
      }
    }],
    generationJobs: [{
      id: 'studio-job-one', kind: 'video', status: 'NEEDS_RECONCILIATION', projectSlug: 'project-a',
      fingerprintSha256: '5'.repeat(64), request: { segmentId: 'segment-001' }
    }]
  });
  assert.equal(projection.assetIdentities.length, 1);
  assert.equal(projection.assetIdentities[0].currentArtifactId, 'asset-person-v2');
  assert.equal(projection.assetIdentities[0].digestPrefix, '111111111111');
  assert.equal(projection.assetIdentities[0].state, 'superseded_package_binding');
  assert.equal(projection.generationSafety[0].retryBlocked, true);
  assert.deepEqual(projection.generationSafety[0].blockedKinds, ['video']);
  assert.equal(projection.statePlanes.execution.status, 'submission_uncertain');
  assert.equal(projection.statePlanes.execution.retryBlocked, true);
  assert.equal(projection.statePlanes.acceptance.status, 'not_ready');
  assert.equal(projection.factInheritance.units[0].status, 'bound_current_inputs');
  assert.equal(projection.factInheritance.units[0].evidenceMode, 'exact_package_governance');
});

test('does not infer fact inheritance from readiness flags without exact package governance', () => {
  const projection = projectHarness3060StudioProjection({
    state: state(),
    segments: [{ id: 'segment-001' }],
    production: [{ segmentId: 'segment-001', packageReady: true, readyForCanvas: true, assetManifestVerified: true }]
  });
  assert.equal(projection.factInheritance.allBound, false);
  assert.equal(projection.factInheritance.units[0].status, 'incomplete');
  assert.equal(projection.factInheritance.units[0].evidenceMode, 'not_observed');
  assert.equal(projection.assetIdentities.length, 0);
});

test('fails closed for legacy unscoped jobs and malformed package evidence', () => {
  const governanceBindings = Object.fromEntries(['segmentContract', 'shotNarration', 'seedancePrompt', 'assetManifest']
    .map((name, index) => [name, { id: `${name}-v1`, status: 'locked', sha256: String(index + 1).repeat(64) }]));
  const projection = projectHarness3060StudioProjection({
    state: state(),
    segments: [{ id: 'segment-001' }, { id: 'segment-002' }],
    production: [{
      segmentId: 'segment-001', packageReady: true, readyForCanvas: true, assetManifestVerified: true,
      packageEvidence: {
        packageSha256: 'a'.repeat(64), promptSha256: 'b'.repeat(64), governanceBindings, mediaBindingCount: 1,
        mediaBindings: [{ tag: '', semanticToken: '', id: '', mediaKind: 'image', sha256: 'c'.repeat(64), controls: [], mustNotControl: [] }]
      }
    }],
    generationJobs: [{ id: 'legacy-job', kind: 'video', status: 'NEEDS_RECONCILIATION', request: {} }]
  });
  assert.ok(projection.generationSafety.every(item => item.retryBlocked));
  assert.ok(projection.generationSafety.every(item => item.blockedKinds.includes('video')));
  assert.equal(projection.factInheritance.units[0].status, 'incomplete');
  assert.equal(projection.factInheritance.units[0].evidenceMode, 'invalid_package_evidence');
  assert.equal(projection.assetIdentities.length, 0);
});

test('keeps the same asset binding separate across segment package scopes', () => {
  const artifact = { id: 'shared-product', type: 'project_asset', revision: 1, status: 'locked', sha256: 'a'.repeat(64) };
  const packageEvidence = packageSha256 => ({
    packageSha256, promptSha256: 'b'.repeat(64), mediaBindingCount: 1,
    mediaBindings: [{ tag: '@图1', semanticToken: '@素材[shared-product]', id: 'shared-product', mediaKind: 'image', sha256: artifact.sha256, controls: ['产品结构'], mustNotControl: ['人物身份'] }],
    governanceBindings: Object.fromEntries(['segmentContract', 'shotNarration', 'seedancePrompt', 'assetManifest']
      .map((name, index) => [name, { id: `${name}-v1`, status: 'locked', sha256: String(index + 1).repeat(64) }]))
  });
  const projection = projectHarness3060StudioProjection({
    state: state([artifact]),
    segments: [{ id: 'segment-001' }, { id: 'segment-002' }],
    production: [
      { segmentId: 'segment-001', packageEvidence: packageEvidence('c'.repeat(64)) },
      { segmentId: 'segment-002', packageEvidence: packageEvidence('d'.repeat(64)) }
    ]
  });
  assert.deepEqual(projection.assetIdentities.map(item => [item.segmentId, item.packageSha256]), [
    ['segment-001', 'c'.repeat(64)], ['segment-002', 'd'.repeat(64)]
  ]);
});

test('projects idea and inspiration work into the original route without source-authority requirements', () => {
  const originalState = state();
  originalState.routeDecision = { referenceRoleStatus: 'inspiration' };
  const projection = projectHarness3060StudioProjection({ state: originalState });
  assert.equal(projection.routeKind, 'original');
  assert.equal(projection.contracts.asset_ledger.evidenceMode, 'not_observed');
});

test('keeps an unresolved reference role out of both original and remake routes', () => {
  const unresolvedState = state();
  unresolvedState.routeDecision = { referenceRoleStatus: 'awaiting_reference_role' };
  const projection = projectHarness3060StudioProjection({ state: unresolvedState });
  assert.equal(projection.routeKind, 'unresolved');
});

test('bare SUCCESS runs are not output evidence and bound unit outputs never count as a whole film', () => {
  const artifacts = [
    { id: 'creative-v1', type: 'creative_brief', revision: 1, status: 'locked', sha256: 'a'.repeat(64) },
    { id: 'video-001', type: 'video_segment', segmentId: 'unit-001', revision: 1, status: 'locked', path: 'outputs/unit-001.mp4', sha256: '1'.repeat(64) },
    { id: 'video-002', type: 'video_segment', segmentId: 'unit-002', revision: 1, status: 'locked', path: 'outputs/unit-002.mp4', sha256: '2'.repeat(64) }
  ];
  const input = {
    state: state(artifacts),
    segments: [{ id: 'unit-001' }, { id: 'unit-002' }],
    production: [
      { segmentId: 'unit-001', packageReady: true, readyForCanvas: true },
      { segmentId: 'unit-002', packageReady: true, readyForCanvas: true }
    ]
  };
  const bareSuccess = projectHarness3060StudioProjection({
    ...input,
    runs: [{ kind: 'libtv_video', segmentId: 'unit-001', status: 'SUCCESS' }]
  });
  assert.equal(bareSuccess.completion.level, 'units_ready');
  assert.equal(bareSuccess.completion.unitOutputCount, 0);

  const projection = projectHarness3060StudioProjection({
    ...input,
    runs: [
      { kind: 'libtv_video', segmentId: 'unit-001', status: 'SUCCESS', taskId: 'task-001', fingerprint: { sha256: '3'.repeat(64) }, outputs: [{ path: 'outputs/unit-001.mp4', sha256: '1'.repeat(64) }] },
      { kind: 'libtv_video', segmentId: 'unit-002', status: 'SUCCESS', taskId: 'task-002', fingerprint: { sha256: '4'.repeat(64) }, outputs: [{ path: 'outputs/unit-002.mp4', sha256: '2'.repeat(64) }] }
    ]
  });
  assert.equal(projection.completion.level, 'unit_outputs_observed');
  assert.equal(projection.completion.wholeFilmComplete, false);
  assert.equal(projection.completion.unitOutputCount, 2);
  assert.ok(projection.generationUnits.every(item => item.eligibleForWholeFilmCompletion === false));
  assert.equal(projection.humanDecisions[1].status, 'package_ready_not_authorized');
  assert.equal(projection.humanDecisions[2].status, 'not_ready');
});

test('rejects ambiguous unit evidence with duplicate locked videos or duplicate matching outputs', () => {
  const duplicateVideos = projectHarness3060StudioProjection({
    state: state([
      { id: 'video-001-a', type: 'video_segment', segmentId: 'unit-001', revision: 1, status: 'locked', path: 'outputs/unit-001-a.mp4', sha256: '1'.repeat(64) },
      { id: 'video-001-b', type: 'video_segment', segmentId: 'unit-001', revision: 2, status: 'locked', path: 'outputs/unit-001-b.mp4', sha256: '2'.repeat(64) }
    ]),
    segments: [{ id: 'unit-001' }],
    runs: [
      { kind: 'libtv_video', segmentId: 'unit-001', status: 'SUCCESS', taskId: 'task-001-a', fingerprint: { sha256: '3'.repeat(64) }, outputs: [{ path: 'outputs/unit-001-a.mp4', sha256: '1'.repeat(64) }] },
      { kind: 'libtv_video', segmentId: 'unit-001', status: 'SUCCESS', taskId: 'task-001-b', fingerprint: { sha256: '4'.repeat(64) }, outputs: [{ path: 'outputs/unit-001-b.mp4', sha256: '2'.repeat(64) }] }
    ]
  });
  assert.equal(duplicateVideos.completion.unitOutputCount, 0);

  const duplicateOutputs = projectHarness3060StudioProjection({
    state: state([
      { id: 'video-001', type: 'video_segment', segmentId: 'unit-001', revision: 1, status: 'locked', path: 'outputs/unit-001.mp4', sha256: '1'.repeat(64) }
    ]),
    segments: [{ id: 'unit-001' }],
    runs: [{
      kind: 'libtv_video', segmentId: 'unit-001', status: 'SUCCESS', taskId: 'task-001', fingerprint: { sha256: '3'.repeat(64) },
      outputs: [
        { path: 'outputs/unit-001.mp4', sha256: '1'.repeat(64) },
        { path: 'outputs/unit-001.mp4', sha256: '1'.repeat(64) }
      ]
    }]
  });
  assert.equal(duplicateOutputs.completion.unitOutputCount, 0);
});

test('marks whole-film completion only when locked final edit and delivery receipt coexist', () => {
  const artifacts = [
    { id: 'final-v1', type: 'final_edit', revision: 1, status: 'locked', path: 'outputs/final.mp4', sha256: 'b'.repeat(64) }
  ];
  const withoutReceipt = projectHarness3060StudioProjection({ state: state(artifacts) });
  assert.equal(withoutReceipt.completion.level, 'final_edit_ready');
  assert.equal(withoutReceipt.completion.wholeFilmComplete, false);

  const isolatedReceipt = projectHarness3060StudioProjection({
    state: state(artifacts),
    deliveryReceipt: { id: 'delivery-v1', status: 'COMPLETE', projectId: 'projection-test' }
  });
  assert.equal(isolatedReceipt.completion.level, 'final_edit_ready');
  assert.equal(isolatedReceipt.completion.wholeFilmComplete, false);

  const archivedState = state(artifacts);
  archivedState.phase = 'archived';
  const withReceipt = projectHarness3060StudioProjection({
    state: archivedState,
    deliveryReceipt: {
      id: 'delivery-v1', status: 'COMPLETE', projectId: 'projection-test',
      deliveryFingerprint: 'f'.repeat(64),
      finalEdit: { artifactId: 'final-v1', path: 'outputs/final.mp4', sha256: 'b'.repeat(64) }
    }
  });
  assert.equal(withReceipt.completion.level, 'accepted');
  assert.equal(withReceipt.completion.wholeFilmComplete, true);
  assert.equal(withReceipt.humanDecisions[2].status, 'accepted_and_archived');
});

test('labels legacy evidence as a mapping instead of an exact new contract', () => {
  const projection = projectHarness3060StudioProjection({
    state: state([
      { id: 'story-v1', type: 'story_plan', revision: 1, status: 'locked', sha256: 'c'.repeat(64) }
    ]),
    segments: [{ id: 'segment-001' }]
  });
  assert.equal(projection.contracts.narrative_block.evidenceMode, 'legacy_mapping');
  assert.equal(projection.contracts.generation_unit.evidenceMode, 'legacy_mapping');
  assert.equal(projection.contracts.final_edit_manifest.evidenceMode, 'not_observed');
});

test('prefers an exact registered contract over a legacy mapping', () => {
  const projection = projectHarness3060StudioProjection({
    state: state([
      {
        id: 'narrative-block-v1', type: 'narrative_block', revision: 1, status: 'locked', sha256: 'd'.repeat(64),
        contractVersion: 'harness-30-60-contract-v1', schemaVersion: 1, validationStatus: 'PASS', current: true
      },
      { id: 'story-v1', type: 'story_plan', revision: 1, status: 'locked', sha256: 'e'.repeat(64) }
    ])
  });
  assert.equal(projection.contracts.narrative_block.evidenceMode, 'exact_contract');
  assert.equal(projection.contracts.narrative_block.artifactId, 'narrative-block-v1');
  assert.equal(projection.narrativeBlocks.count, 1);
});
