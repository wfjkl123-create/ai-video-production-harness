import { dirname, join, resolve } from 'node:path';
import { option } from './args.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { extractCandidateFrames, FFMPEG_UNAVAILABLE_REASON, FFPROBE_UNAVAILABLE_REASON } from '../services/handoff-service.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';

function sourceArtifact(project, artifactId) {
  const matches = (project.artifacts ?? []).filter(({ id }) => id === artifactId);
  if (matches.length !== 1) throw new Error(`approved video artifact ${artifactId} must appear exactly once`);
  return matches[0];
}

function sourceStillMatches(latest, original) {
  return latest.type === 'video_segment'
    && latest.status === 'locked'
    && typeof latest.lockedByReviewId === 'string'
    && latest.lockedByReviewId.trim() !== ''
    && latest.id === original.id
    && latest.path === original.path
    && latest.sha256?.toLowerCase() === original.sha256?.toLowerCase();
}

function staleSourceError(result) {
  const retained = result.candidates?.[0] ? dirname(result.candidates[0].path) : null;
  return new Error(
    retained
      ? `source video changed during handoff extraction; candidates retained at ${retained} and no prepared review was persisted`
      : 'source video changed during handoff extraction; no prepared review was persisted'
  );
}

export async function runPrepareHandoff(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const artifactId = option(args, 'artifact');
  const statePath = join(root, 'project-state.json');
  const initialProject = await readJson(statePath);
  const videoArtifact = sourceArtifact(initialProject, artifactId);

  // Media probing and extraction are intentionally outside the short project mutation lock.
  const result = await extractCandidateFrames(resolve(root, videoArtifact.path), join(root, 'outputs', videoArtifact.segmentId, 'handoff-candidates'), {
    projectRoot: root,
    videoArtifact,
    runner: options.runner,
    ffmpegExecutable: options.ffmpegExecutable,
    ffprobeExecutable: options.ffprobeExecutable
  });

  return withProjectLock(root, async () => {
    const project = await readJson(statePath);
    let latest;
    try {
      latest = sourceArtifact(project, artifactId);
    } catch {
      throw staleSourceError(result);
    }
    if (!sourceStillMatches(latest, videoArtifact)) throw staleSourceError(result);

    if (result.status === 'blocked') {
      const blocked = {
        id: `handoff-${videoArtifact.segmentId}`,
        type: 'handoff',
        revision: 1,
        status: 'blocked',
        path: `outputs/${videoArtifact.segmentId}/observed-handoff.json`,
        segmentId: videoArtifact.segmentId,
        blockedReason: result.blockedReason
      };
      project.artifacts = [...(project.artifacts ?? []).filter(({ id }) => id !== blocked.id), blocked];
      project.blockedReason = result.blockedReason;
      project.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, project);
      return result;
    }

    const preparedPayload = {
      id: `handoff-prepared-${videoArtifact.segmentId}`,
      type: 'handoff',
      revision: 1,
      status: 'awaiting_review',
      path: `outputs/${videoArtifact.segmentId}/handoff-prepared.json`,
      segmentId: videoArtifact.segmentId,
      prepared: true,
      sourceVideoId: result.sourceVideoId,
      sourceVideoSha256: result.sourceVideoSha256,
      actualDuration: result.actualDuration,
      candidateFrames: result.candidates,
      evidenceTimestamps: result.candidates.map(({ timestamp }) => timestamp)
    };
    await writeJsonAtomic(join(root, preparedPayload.path), preparedPayload);
    const { sha256 } = await inspectArtifactFile(root, preparedPayload.path);
    const prepared = { ...preparedPayload, sha256 };
    project.artifacts = [...(project.artifacts ?? []).filter(({ id }) => id !== prepared.id && id !== `handoff-${videoArtifact.segmentId}`), prepared];
    if ([FFMPEG_UNAVAILABLE_REASON, FFPROBE_UNAVAILABLE_REASON].includes(project.blockedReason)) project.blockedReason = null;
    project.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, project);
    return result;
  });
}
