import { join } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { canonicalAssetType } from './asset-service.js';
import { workflowProfileIdOf } from '../domain/workflow-profile.js';

function itemPath(item) {
  return item.outputPath ?? item.path;
}

export async function verifyAssetManifestEvidence(root, project, manifest, recordedPath) {
  const manifestFile = await inspectArtifactFile(root, recordedPath);
  const review = await readJson(join(root, 'reviews', `${encodeURIComponent(manifest.lockedByReviewId ?? '')}.json`)).catch(() => null);
  const acceptedActor = review?.actor === 'human'
    || (workflowProfileIdOf(project) === 'simple_remake'
      && review?.actor === 'system' && review?.machineReviewed === true && review?.delegatedByProfile === 'simple_remake');
  if (!review || review.artifactKind !== 'asset_manifest' || review.artifactId !== manifest.id
    || review.segmentId !== manifest.segmentId || !acceptedActor || review.decision !== 'approved'
    || review.manifestSha256 !== manifestFile.sha256) {
    throw new Error('asset manifest human review checksum binding does not match');
  }
  for (const item of manifest.items ?? []) {
    const expectedType = item.scope === 'project' ? 'project_asset' : item.scope === 'segment' ? 'segment_asset' : null;
    const matches = (project.artifacts ?? []).filter(artifact => artifact.id === item.id && artifact.type === expectedType);
    if (matches.length !== 1) throw new Error(`asset manifest item ${item.id ?? ''} must map to exactly one project-state artifact`);
    const artifact = matches[0];
    if (artifact.status !== 'locked' || artifact.revision !== item.revision || canonicalAssetType(artifact.assetType) !== item.type
      || artifact.path !== itemPath(item) || artifact.sha256 !== item.sha256
      || artifact.lockedByReviewId !== item.lockedByReviewId
      || (expectedType === 'segment_asset' && artifact.segmentId !== manifest.segmentId)) {
      throw new Error(`asset manifest item ${item.id} does not match its locked project-state artifact`);
    }
    try {
      await verifyLockedArtifact(root, artifact);
    } catch {
      throw new Error(`artifact review checksum binding does not match for ${item.id}`);
    }
  }
  return { manifestSha256: manifestFile.sha256, reviewId: review.id };
}
