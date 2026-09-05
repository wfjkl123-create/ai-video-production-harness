import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { verifyArtifactFile } from './artifact-file-service.js';
import { assertObservedHandoffArtifact } from './handoff-service.js';

export async function verifyObservedHandoffEvidence(root, artifact) {
  const file = await verifyArtifactFile(root, artifact);
  const persisted = await readJson(file.path);
  const { sha256, ...payload } = artifact;
  if (!isDeepStrictEqual(persisted, payload)) throw new Error(`persisted observed handoff does not match project state for ${artifact.id}`);
  assertObservedHandoffArtifact(artifact);
  const review = await readJson(join(root, 'reviews', `${encodeURIComponent(artifact.lockedByReviewId)}.json`)).catch(() => null);
  if (!review || review.kind !== 'handoff_observation' || review.actor !== 'human' || review.decision !== 'approved'
    || review.handoffArtifactId !== artifact.id || review.handoffSha256 !== sha256
    || review.preparedHandoffId !== artifact.preparedHandoffId
    || review.preparedHandoffSha256 !== artifact.preparedHandoffSha256
    || review.sourceVideoId !== artifact.sourceVideoId
    || review.sourceVideoSha256 !== artifact.sourceVideoSha256) {
    throw new Error(`observed handoff human review checksum binding does not match for ${artifact.id}`);
  }
  return { artifactId: artifact.id, sha256, reviewId: review.id };
}
