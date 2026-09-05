import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from '../adapters/process-runner.js';
import { createVideoResolutionContract, resolveVideoModelProfile } from '../domain/video-model-profile.js';
import { verifyLockedArtifact } from './artifact-file-service.js';

function latestReferenceVideo(project, segmentId) {
  const locked = (project.artifacts ?? []).filter(item => item.type === 'reference_video' && item.status === 'locked');
  const segmentSpecific = locked.filter(item => item.segmentId === segmentId);
  const candidates = segmentSpecific.length > 0 ? segmentSpecific : locked.filter(item => !item.segmentId);
  candidates.sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || left.id.localeCompare(right.id));
  if (candidates.length > 1 && (candidates[0].revision ?? 0) === (candidates[1].revision ?? 0)) {
    throw new Error(`multiple locked reference videos have revision ${candidates[0].revision ?? 0} for ${segmentId}`);
  }
  return candidates[0] ?? null;
}

function lockedControlVideo(project, segmentId, artifactId) {
  if (!artifactId) return null;
  const candidates = (project.artifacts ?? [])
    .filter(item => item.id === artifactId && item.status === 'locked' && item.segmentId === segmentId);
  if (candidates.length !== 1) {
    throw new Error(`locked control video ${artifactId} must appear exactly once for ${segmentId}`);
  }
  return candidates[0];
}

async function probeVideo(path, root, runner) {
  let result;
  try {
    result = await runner('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path
    ], { cwd: root, shell: false });
  } catch (error) {
    throw new Error(`ffprobe could not inspect the locked source video: ${error.message}`);
  }
  if (result.code !== 0) throw new Error(`ffprobe failed for locked source video: ${result.stderr ?? ''}`.trim());
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('ffprobe returned invalid JSON for locked source video'); }
  const stream = value.streams?.[0];
  if (!Number.isInteger(stream?.width) || stream.width <= 0 || !Number.isInteger(stream?.height) || stream.height <= 0) {
    throw new Error('locked source video has no valid width and height');
  }
  return { width: stream.width, height: stream.height };
}

export async function resolveProjectVideoResolution(root, project, segmentId, options = {}) {
  const projectRoot = await realpath(resolve(root));
  const modelProfile = resolveVideoModelProfile({ executor: options.executor, model: options.model });
  // A locked source video may exist as analysis evidence without being uploaded
  // to generation. Only use its dimensions when the caller explicitly opts in
  // to the source-video generation path.
  const reference = options.lockedVideoBaselineAssetId
    ? lockedControlVideo(project, segmentId, options.lockedVideoBaselineAssetId)
    : options.includeReferenceVideo === true
      ? latestReferenceVideo(project, segmentId)
      : null;
  let sourceBaseline = null;
  if (reference) {
    const inspected = await verifyLockedArtifact(projectRoot, reference);
    const dimensions = await probeVideo(inspected.path, projectRoot, options.runner ?? runProcess);
    sourceBaseline = {
      artifactId: reference.id,
      path: reference.path,
      sha256: inspected.sha256,
      ...dimensions
    };
  }
  return createVideoResolutionContract({
    profileId: modelProfile.id,
    requestedResolution: options.requestedResolution,
    sourceBaseline
  });
}
