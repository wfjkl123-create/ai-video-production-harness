import { join } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';

async function reviewTime(root, artifact) {
  if (typeof artifact?.lockedByReviewId !== 'string') return null;
  try {
    const review = await readJson(join(root, 'reviews', `${encodeURIComponent(artifact.lockedByReviewId)}.json`));
    const time = Date.parse(review?.createdAt);
    return Number.isFinite(time) ? time : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function latestLockedContract(project, segmentId) {
  return resolveCurrentArtifacts(project.artifacts ?? []).current
    .filter(artifact => artifact.type === 'segment_contract'
      && artifact.segmentId === segmentId && artifact.status === 'locked')
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
}

export async function currentLockedSegmentVideos(root, project, segmentId) {
  const currentArtifacts = resolveCurrentArtifacts(project.artifacts ?? []).current;
  const videos = currentArtifacts.filter(artifact => artifact.type === 'video_segment'
    && artifact.segmentId === segmentId && artifact.status === 'locked');
  const contract = latestLockedContract(project, segmentId);
  if (!contract) return videos;

  const contractTime = await reviewTime(root, contract);
  if (contractTime === null) return [];
  const current = [];
  for (const video of videos) {
    const videoTime = await reviewTime(root, video);
    if (videoTime !== null && videoTime >= contractTime) current.push(video);
  }
  return current;
}
