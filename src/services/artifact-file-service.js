import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { join } from 'node:path';
import { sha256File } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { isAutoLockType } from '../domain/review-policy.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function inspectArtifactFile(root, recordedPath) {
  if (typeof recordedPath !== 'string' || recordedPath.trim() === '' || isAbsolute(recordedPath)) {
    throw new Error('artifact path must be a project-relative path');
  }
  const requestedRoot = resolve(root);
  const requested = resolve(requestedRoot, recordedPath);
  if (outside(requestedRoot, requested)) throw new Error('artifact path must stay inside project root');
  const actualRoot = await realpath(requestedRoot);
  let actual;
  try {
    actual = await realpath(requested);
    if (outside(actualRoot, actual) || !(await stat(actual)).isFile()) throw new Error('invalid');
    await access(actual, constants.R_OK);
  } catch {
    throw new Error('artifact path must reference a readable regular project file');
  }
  return { path: actual, sha256: await sha256File(actual) };
}

export async function verifyArtifactFile(root, artifact) {
  const inspected = await inspectArtifactFile(root, artifact.path);
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? '') || inspected.sha256 !== artifact.sha256.toLowerCase()) {
    throw new Error(`artifact checksum changed for ${artifact.id}`);
  }
  return inspected;
}

export async function verifyLockedArtifact(root, artifact) {
  if (artifact.status !== 'locked' || typeof artifact.lockedByReviewId !== 'string') {
    throw new Error(`artifact ${artifact.id} must be locked by review`);
  }
  const inspected = await verifyArtifactFile(root, artifact);
  const review = await readJson(join(root, 'reviews', `${encodeURIComponent(artifact.lockedByReviewId)}.json`));
  const systemAutoLockedArtifact = isAutoLockType(artifact.type)
    && review.actor === 'system' && review.autoLocked === true;
  const profileMachineReviewed = review.actor === 'system' && review.machineReviewed === true;
  if ((!systemAutoLockedArtifact && !profileMachineReviewed && review.actor !== 'human') || review.decision !== 'approved' || review.artifactId !== artifact.id
    || review.artifactSha256 !== inspected.sha256) {
    throw new Error(`artifact review checksum binding does not match for ${artifact.id}`);
  }
  return inspected;
}
