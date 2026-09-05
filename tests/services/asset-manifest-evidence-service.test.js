import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAssetManifestEvidence } from '../../src/services/asset-manifest-evidence-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';

test('manifest evidence accepts a source-visible character artifact for the canonical single-view item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-manifest-source-visible-'));
  await mkdir(join(root, 'assets/project'), { recursive: true });
  await mkdir(join(root, 'reviews'), { recursive: true });
  const assetPath = 'assets/project/character-lead-source-visible-v1.png';
  await writeFile(join(root, assetPath), 'source-visible-character-pixels');
  const assetSha256 = await sha256File(join(root, assetPath));
  const asset = {
    id: 'character-lead-source-visible-v1', type: 'project_asset',
    assetType: 'character_identity_source_visible_v1', revision: 1, status: 'locked',
    path: assetPath, sha256: assetSha256, lockedByReviewId: 'review-source-visible'
  };
  await writeJsonAtomic(join(root, 'reviews/review-source-visible.json'), {
    id: 'review-source-visible', artifactId: asset.id, actor: 'human', decision: 'approved',
    artifactSha256: assetSha256
  });
  const manifestPath = 'assets/segment-001-asset-manifest.json';
  const manifest = {
    id: 'segment-001-asset-manifest', segmentId: 'segment-001', status: 'locked',
    lockedByReviewId: 'review-manifest-source-visible',
    items: [{
      id: asset.id, type: 'character_identity_single_view', scope: 'project', status: 'locked',
      revision: 1, path: asset.path, sha256: asset.sha256, lockedByReviewId: asset.lockedByReviewId
    }]
  };
  await writeJsonAtomic(join(root, manifestPath), manifest);
  const manifestSha256 = await sha256File(join(root, manifestPath));
  await writeJsonAtomic(join(root, 'reviews/review-manifest-source-visible.json'), {
    id: 'review-manifest-source-visible', artifactKind: 'asset_manifest', artifactId: manifest.id,
    segmentId: manifest.segmentId, actor: 'human', decision: 'approved', manifestSha256
  });

  const evidence = await verifyAssetManifestEvidence(root, { artifacts: [asset] }, manifest, manifestPath);
  assert.equal(evidence.manifestSha256, manifestSha256);
  assert.equal(evidence.reviewId, 'review-manifest-source-visible');
});
