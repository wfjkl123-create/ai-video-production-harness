import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_DIMENSIONS } from '../../src/domain/handoff-reconciliation.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { reconcileSegmentHandoff } from '../../src/services/handoff-reconciliation-service.js';

const jsonSha = value => createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
const field = value => ({ value, basis: 'observed', timestamps: [9.75] });

function assessments(change = {}) {
  return HANDOFF_DIMENSIONS.map(dimension => ({
    dimension,
    disposition: change[dimension] ?? 'consistent',
    evidence: `${dimension} compared against all three states`,
    resolution: change[dimension] ? `${dimension} needs the stated handling` : `${dimension} aligned`,
    ...(change[dimension] && change[dimension] !== 'consistent'
      ? { nextStateInstruction: `apply ${dimension} handling at the next opening` }
      : {})
  }));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'handoff-reconciliation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = [];
  async function locked(descriptor, payload, { auto = true } = {}) {
    await writeJsonAtomic(join(root, descriptor.path), payload);
    const sha256 = jsonSha(payload);
    const reviewId = `review-${descriptor.id}`;
    const artifact = { ...descriptor, status: 'locked', lockedByReviewId: reviewId, sha256 };
    await writeJsonAtomic(join(root, 'reviews', `${reviewId}.json`), {
      id: reviewId, artifactId: descriptor.id, decision: 'approved', actor: auto ? 'system' : 'human',
      ...(auto ? { autoLocked: true } : {}), artifactSha256: sha256
    });
    artifacts.push(artifact);
    return artifact;
  }
  const segmentationPayload = {
    id: 'segmentation-v2',
    segments: [
      { id: 'segment-001', status: 'locked', previousSegmentId: null, nextSegmentId: 'segment-002', endState: { people: ['lead left'], openMotion: ['turning'] } },
      { id: 'segment-002', status: 'locked', previousSegmentId: 'segment-001', nextSegmentId: null, startState: { people: ['lead left'], openMotion: ['turning'] } }
    ]
  };
  const segmentation = await locked({ id: 'segmentation-v2', type: 'segmentation', revision: 2, path: 'story/segmentation-v2.json' }, segmentationPayload);
  const identity = await locked({
    id: 'identity-pack-a', type: 'project_asset', assetType: 'character_identity_pack_v2', characterId: 'lead', revision: 1,
    path: 'assets/identity-pack-a.json'
  }, { id: 'identity-pack-a', coverage: ['front close-up', 'three-quarter medium'] }, { auto: false });
  const observedPayload = {
    id: 'observed-handoff-001', type: 'handoff', revision: 1, status: 'locked', path: 'outputs/segment-001/observed-handoff.json',
    lockedByReviewId: 'review-observed-handoff-001', segmentId: 'segment-001', observed: true,
    realismContractsVersion: 2,
    preparedHandoffId: 'prepared-001', preparedHandoffSha256: 'b'.repeat(64), sourceVideoId: 'video-001', sourceVideoSha256: 'c'.repeat(64),
    evidenceTimestamps: [9.75],
    people: field([{ personId: 'lead', leftRight: 'left', depth: 'foreground', bodyDirection: 'right', faceDirection: 'right', gaze: 'door' }]),
    distances: field([]), productState: field({ description: 'held at waist' }), props: field([]),
    camera: field({ position: 'front-left', direction: 'toward lead', shotSize: 'medium' }),
    openMotion: field(['turning right']), light: field({ description: 'window key remains on screen-left' }),
    audio: field({ description: 'room tone and trailing breath continue' }),
    identity: field([{ personId: 'lead', observedContinuity: 'face, hair and body proportions remain consistent' }]),
    unknowns: field([])
  };
  await writeJsonAtomic(join(root, observedPayload.path), observedPayload);
  const observed = { ...observedPayload, sha256: jsonSha(observedPayload) };
  await writeJsonAtomic(join(root, 'reviews', 'review-observed-handoff-001.json'), {
    id: 'review-observed-handoff-001', kind: 'handoff_observation', actor: 'human', decision: 'approved',
    handoffArtifactId: observed.id, handoffSha256: observed.sha256,
    preparedHandoffId: observed.preparedHandoffId, preparedHandoffSha256: observed.preparedHandoffSha256,
    sourceVideoId: observed.sourceVideoId, sourceVideoSha256: observed.sourceVideoSha256
  });
  artifacts.push(observed);
  const proxyPayload = { id: 'handoff-restoration-001', source: observed.id, role: 'spatial proxy only' };
  const proxy = await locked({
    id: 'handoff-restoration-001', type: 'handoff', revision: 1, path: 'outputs/segment-001/canonical-handoff.json',
    segmentId: 'segment-001', observed: false, handoffKind: 'canonical_hd_restoration', derivation: 'canonical_hd_reconstruction',
    sourceArtifactId: observed.id, sourceArtifactSha256: observed.sha256
  }, proxyPayload);
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'project-001', workflowVersion: 2, videoGovernanceVersion: 2,
    realismContractsVersion: 2, realismContractsWriteMode: 'enabled',
    phase: 'gate3', activeSegmentId: 'segment-002', blockedReason: null, artifacts, updatedAt: new Date().toISOString()
  });
  return { root, segmentation, identity, observed, proxy };
}

test('publishes and auto-locks a passing three-way handoff reconciliation', async t => {
  const { root, identity, observed, proxy } = await fixture(t);
  const result = await reconcileSegmentHandoff(root, {
    id: 'reconcile-001-002', previousSegmentId: 'segment-001', nextSegmentId: 'segment-002',
    observedHandoffArtifactId: observed.id, canonicalAuthorityArtifactIds: [identity.id],
    spatialProxyArtifactId: proxy.id, dimensionAssessments: assessments()
  });
  assert.equal(result.reconciliation.decision, 'PASS');
  assert.equal(result.artifact.status, 'locked');
  assert.equal(result.artifact.segmentId, 'segment-002');
  assert.equal(result.reconciliation.spatialProxyPolicy.responsibility, 'instantaneous position, pose, gaze and motion phase only');
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(artifact => artifact.id === result.artifact.id).status, 'locked');
});

test('keeps unresolved or failed reconciliation evidence unlocked so it cannot feed the next segment', async t => {
  const { root, identity } = await fixture(t);
  const result = await reconcileSegmentHandoff(root, {
    id: 'reconcile-hold-001-002', previousSegmentId: 'segment-001', nextSegmentId: 'segment-002',
    canonicalAuthorityArtifactIds: [identity.id], dimensionAssessments: assessments({ light: 'unknown' })
  });
  assert.equal(result.reconciliation.decision, 'HOLD');
  assert.equal(result.artifact.status, 'draft');
  assert.equal(result.artifact.lockedByReviewId, undefined);
});

test('rejects non-authority assets before a reconciliation artifact is written', async t => {
  const { root } = await fixture(t);
  const state = await readJson(join(root, 'project-state.json'));
  const badPayload = { id: 'storyboard-a' };
  await writeJsonAtomic(join(root, 'assets', 'storyboard-a.json'), badPayload);
  const badSha = jsonSha(badPayload);
  state.artifacts.push({
    id: 'storyboard-a', type: 'segment_asset', assetType: 'storyboard', revision: 1, status: 'locked',
    path: 'assets/storyboard-a.json', segmentId: 'segment-001', sha256: badSha, lockedByReviewId: 'review-storyboard-a'
  });
  await writeJsonAtomic(join(root, 'reviews', 'review-storyboard-a.json'), {
    id: 'review-storyboard-a', artifactId: 'storyboard-a', actor: 'human', decision: 'approved', artifactSha256: badSha
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await assert.rejects(() => reconcileSegmentHandoff(root, {
    id: 'reconcile-bad', previousSegmentId: 'segment-001', nextSegmentId: 'segment-002',
    canonicalAuthorityArtifactIds: ['storyboard-a'], dimensionAssessments: assessments()
  }), /canonical handoff authority/);
});
