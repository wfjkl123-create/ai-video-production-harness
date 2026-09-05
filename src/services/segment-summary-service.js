import { join } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';

function latestMatching(artifacts, predicate) {
  let selected = null;
  for (const artifact of artifacts) {
    if (!predicate(artifact)) continue;
    if (!selected || artifact.revision >= selected.revision) selected = artifact;
  }
  return selected;
}

/**
 * Generate a compact summary card for a completed segment.
 * ~500 bytes instead of the full segment state (~4-8KB).
 * Used by subsequent segments to understand continuity without
 * loading the entire predecessor's artifact list.
 */
export async function generateSegmentSummary(root, segmentId) {
  return withProjectLock(root, async () => {
    const state = assertProjectState(await readJson(join(root, 'project-state.json')));
    const segmentArtifacts = state.artifacts.filter(a => a.segmentId === segmentId);

    const video = latestMatching(segmentArtifacts, a => a.type === 'video_segment' && a.status === 'locked');
    const prompt = latestMatching(segmentArtifacts, a => a.type === 'seedance_prompt' && a.status === 'locked');
    const latestNarration = latestMatching(segmentArtifacts, a => a.type === 'shot_narration' && a.status === 'locked');
    const narration = prompt?.narrationSourceId
      ? segmentArtifacts.find(a => a.type === 'shot_narration' && a.status === 'locked'
        && a.id === prompt.narrationSourceId && a.sha256 === prompt.narrationSha256)
      : latestNarration;
    const handoff = latestMatching(segmentArtifacts, a => a.type === 'handoff' && a.status === 'locked' && a.observed === true);
    const audit = latestMatching(segmentArtifacts, a => a.type === 'independent_creative_audit' && a.status === 'locked');

    if (!video) throw new Error(`segment ${segmentId} has no locked video; cannot summarize`);
    if (prompt?.narrationSourceId && !narration) {
      throw new Error(`segment ${segmentId} latest prompt has no exact locked narration binding; cannot summarize`);
    }

    const summary = {
      segmentId,
      status: 'complete',
      videoArtifactId: video.id,
      videoRevision: video.revision,
      videoSha256: video.sha256,
      videoPath: video.path,
      promptArtifactId: prompt?.id ?? null,
      promptRevision: prompt?.revision ?? null,
      promptSha256: prompt?.sha256 ?? null,
      narrationArtifactId: narration?.id ?? null,
      narrationRevision: narration?.revision ?? null,
      narrationSha256: narration?.sha256 ?? null,
      handoffArtifactId: handoff?.id ?? null,
      handoffRevision: handoff?.revision ?? null,
      handoffSha256: handoff?.sha256 ?? null,
      auditArtifactId: audit?.id ?? null,
      auditRevision: audit?.revision ?? null,
      auditDecision: audit?.decision ?? null,
      lockedAt: video.lockedAt ?? state.updatedAt,
      artifactCount: segmentArtifacts.length
    };

    const outPath = join(root, 'segments', `${segmentId}-summary.json`);
    await writeJsonAtomic(outPath, summary);
    return summary;
  });
}

/**
 * Read a segment summary card. Returns null if not yet generated.
 */
export async function readSegmentSummary(root, segmentId) {
  try {
    return await readJson(join(root, 'segments', `${segmentId}-summary.json`));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
