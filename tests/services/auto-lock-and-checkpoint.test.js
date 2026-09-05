import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { autoLockArtifact, batchApproveByTypes, approveArtifact, submitForReview } from '../../src/services/review-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { verifyLockedArtifact } from '../../src/services/artifact-file-service.js';
import { runAssetVisualAudit } from '../../src/commands/asset-visual-audit.js';
import { persistSegmentation } from '../../src/services/segmentation-workflow-service.js';

async function addProductAudit(root, assetId, auditId) {
  const state = await readJson(join(root, 'project-state.json'));
  const asset = state.artifacts.find(item => item.id === assetId);
  const path = join(root, 'reviews', `${auditId}.json`);
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    id: auditId, kind: 'asset_visual_audit', assetId, assetType: asset.assetType, assetRevision: asset.revision,
    assetSha256: asset.sha256, decision: 'PASS', inspectionMode: 'multimodal_pixels', inspectorContextMode: 'clean_zero_context',
    inspectorTaskId: `visual-agent-${assetId}`, observedIdentityCount: 0,
    checks: [{ id: 'asset_role_fidelity', result: 'PASS', evidence: 'clean-zero-context pixels match the product role' }],
    blockerCount: 0, reviewedAt: '2026-07-30T12:00:00Z'
  }, null, 2)}\n`);
  await runAssetVisualAudit(['--project', root, '--input', path]);
}

async function projectWithArtifacts({ directorRouting = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'auto-lock-test-'));
  await initializeProject(root, { projectId: 'AUTOLOCK-TEST' });
  if (directorRouting) {
    const state = await readJson(join(root, 'project-state.json'));
    state.directorRoutingVersion = 1;
    state.verifiedCapabilityManifestId = 'capability-explicit-v2';
    state.artifacts.push({
      id: 'capability-explicit-v2', type: 'capability_manifest', revision: 1, status: 'locked',
      path: 'planning/capability-explicit-v2.json', lockedByReviewId: 'review-capability-explicit-v2',
      routePrecision: 'explicit_v2', storyPlanSchemaVersion: 2
    });
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(join(root, 'project-state.json'), state);
  }
  await mkdir(join(root, 'brief'), { recursive: true });
  await mkdir(join(root, 'assets', 'project'), { recursive: true });

  // A script (auto-lock type)
  await writeFile(join(root, 'brief', 'script-v1.md'), 'test script\n');
  await registerArtifact(root, {
    id: 'script-v1', type: 'script', revision: 1, status: 'draft', path: 'brief/script-v1.md'
  });

  // A project asset (human-review type)
  await writeFile(join(root, 'assets', 'project', 'char-main.png'), 'fake-png-data');
  await registerArtifact(root, {
    id: 'char-main', type: 'project_asset', assetType: 'product_reference', revision: 1,
    status: 'draft', path: 'assets/project/char-main.png', visualAuditId: 'audit-char-main'
  });
  await addProductAudit(root, 'char-main', 'audit-char-main');

  return root;
}

test('autoLockArtifact locks a script without human review', async () => {
  const root = await projectWithArtifacts();
  const review = await autoLockArtifact(root, 'script-v1', 'machine validated');
  assert.equal(review.actor, 'system');
  assert.equal(review.autoLocked, true);
  assert.equal(review.decision, 'approved');

  const state = await readJson(join(root, 'project-state.json'));
  const artifact = state.artifacts.find(({ id }) => id === 'script-v1');
  assert.equal(artifact.status, 'locked');
  assert.equal(artifact.lockedByReviewId, review.id);
  await assert.doesNotReject(verifyLockedArtifact(root, artifact));
});

test('autoLockArtifact refuses a human-review type', async () => {
  const root = await projectWithArtifacts();
  await assert.rejects(
    autoLockArtifact(root, 'char-main', 'should fail'),
    /requires human review/
  );
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(({ id }) => id === 'char-main').status, 'draft');
});

test('autoLockArtifact is idempotent for already-locked artifacts', async () => {
  const root = await projectWithArtifacts();
  const first = await autoLockArtifact(root, 'script-v1', 'first lock');
  const second = await autoLockArtifact(root, 'script-v1', 'second attempt');
  assert.equal(second.id, first.id);
});

test('autoLockArtifact completes an auto-lock type already awaiting review', async () => {
  const root = await projectWithArtifacts();
  await submitForReview(root, 'script-v1');
  const review = await autoLockArtifact(root, 'script-v1', 'machine validation passed');
  assert.equal(review.actor, 'system');
  assert.equal(review.autoLocked, true);
  assert.equal((await readJson(join(root, 'project-state.json'))).artifacts[0].status, 'locked');
});

test('autoLockArtifact publishes a canonical segmentation whose inner segments are locked', async () => {
  const root = await projectWithArtifacts();
  const artifact = await persistSegmentation(root, {
    id: 'segmentation-v1', revision: 1, path: 'segments/segmentation-v1.json',
    segments: [{
      id: 'segment-001', duration: 5, narrativeTask: 'one causal performance coverage',
      startState: { at: 0 }, actionNodes: ['trigger', 'reaction'], endState: { at: 4 },
      projectAssetIds: [], segmentAssetRequirements: [], previousSegmentId: null, nextSegmentId: null,
      status: 'awaiting_review'
    }]
  });
  const review = await autoLockArtifact(root, artifact.id, 'machine validated segmentation');
  const state = await readJson(join(root, 'project-state.json'));
  const locked = state.artifacts.find(({ id }) => id === artifact.id);
  assert.equal(locked.status, 'locked');
  assert.notEqual(locked.path, artifact.path);
  const canonical = await readJson(join(root, locked.path));
  assert.equal(canonical.segments[0].status, 'locked');
  assert.equal(canonical.segments[0].lockedByReviewId, review.id);
  assert.equal(review.artifactSha256, locked.sha256);
});

test('autoLockArtifact normalizes a relative project root before transactional segmentation writes', async () => {
  const root = await projectWithArtifacts();
  const artifact = await persistSegmentation(root, {
    id: 'segmentation-relative-v1', revision: 1, path: 'segments/segmentation-relative-v1.json',
    segments: [{
      id: 'segment-001', duration: 5, narrativeTask: 'relative-root write coverage',
      startState: { at: 0 }, actionNodes: ['trigger', 'reaction'], endState: { at: 4 },
      projectAssetIds: [], segmentAssetRequirements: [], previousSegmentId: null, nextSegmentId: null,
      status: 'awaiting_review'
    }]
  });
  const relativeRoot = relative(process.cwd(), root);
  assert.notEqual(relativeRoot, '');
  const review = await autoLockArtifact(relativeRoot, artifact.id, 'relative-root machine validation');

  const state = await readJson(join(root, 'project-state.json'));
  const locked = state.artifacts.find(({ id }) => id === artifact.id);
  assert.equal(locked.status, 'locked');
  assert.equal(locked.lockedByReviewId, review.id);
  assert.match(locked.path, /^versions\/segmentation\..+\.locked\.json$/);
  assert.doesNotMatch(locked.path, /projects\//);
  const canonical = await readJson(join(root, locked.path));
  assert.equal(canonical.segments[0].status, 'locked');
  await assert.doesNotReject(readJson(join(root, 'reviews', `${review.id}.json`)));
});

test('batchApproveByTypes approves all awaiting_review assets at once', async () => {
  const root = await projectWithArtifacts();
  // Move project_asset to awaiting_review via normal flow
  await submitForReview(root, 'char-main');

  // Add a second asset
  await writeFile(join(root, 'assets', 'project', 'product-v1.png'), 'fake-product');
  await registerArtifact(root, {
    id: 'product-v1', type: 'project_asset', assetType: 'product_reference', revision: 1,
    status: 'draft', path: 'assets/project/product-v1.png', visualAuditId: 'audit-product-v1'
  });
  await addProductAudit(root, 'product-v1', 'audit-product-v1');
  await submitForReview(root, 'product-v1');

  const reviews = await batchApproveByTypes(root, ['project_asset', 'segment_asset'], 'checkpoint assets approved');
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every(r => r.actor === 'human'));

  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(({ id }) => id === 'char-main').status, 'locked');
  assert.equal(state.artifacts.find(({ id }) => id === 'product-v1').status, 'locked');
});

test('batchApproveByTypes returns empty when nothing is pending', async () => {
  const root = await projectWithArtifacts();
  const reviews = await batchApproveByTypes(root, ['project_asset'], 'nothing pending');
  assert.equal(reviews.length, 0);
});

test('batchApproveByTypes does not touch auto-lock types', async () => {
  const root = await projectWithArtifacts();
  // script is still draft, not awaiting_review
  const reviews = await batchApproveByTypes(root, ['script'], 'should not match');
  assert.equal(reviews.length, 0);
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(({ id }) => id === 'script-v1').status, 'draft');
});

test('director-routed projects expose assets to humans only after exact AI visual PASS', async () => {
  const root = await projectWithArtifacts({ directorRouting: true });
  const state = await readJson(join(root, 'project-state.json'));
  const audit = state.artifacts.find(item => item.id === 'audit-char-main');
  assert.equal(audit.status, 'locked');
  assert.equal((await readJson(join(root, 'reviews', `${audit.lockedByReviewId}.json`))).actor, 'system');
  await assert.doesNotReject(submitForReview(root, 'char-main'));

  await writeFile(join(root, 'assets', 'project', 'unaudited.png'), 'fake-unaudited');
  await registerArtifact(root, {
    id: 'unaudited', type: 'project_asset', assetType: 'product_reference', revision: 1,
    status: 'draft', path: 'assets/project/unaudited.png'
  });
  await assert.rejects(submitForReview(root, 'unaudited'), /locked asset_visual_audit PASS/);
});
