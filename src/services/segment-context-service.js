import { join } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { readJson } from '../storage/json-store.js';
import { readSegmentSummary } from './segment-summary-service.js';

/**
 * Build a minimal context bundle for working on a single segment.
 * Returns only what a sub-agent needs: project-level info, this segment's
 * artifacts, and the previous segment's summary card (for continuity).
 *
 * This replaces reading the full 222KB project-state.json when a sub-agent
 * only needs ~4KB of relevant data.
 */
export async function getSegmentContext(root, segmentId) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));

  // Project-level info (always needed)
  const projectInfo = {
    projectId: state.projectId,
    phase: state.phase,
    executionMode: state.executionMode ?? null
  };

  // Project-level artifacts (shared across segments: project_asset, quality_rubric, etc.)
  const projectArtifacts = state.artifacts
    .filter(a => !a.segmentId)
    .map(a => ({ id: a.id, type: a.type, status: a.status, path: a.path, sha256: a.sha256 ?? null }));

  // This segment's artifacts (full detail)
  const segmentArtifacts = state.artifacts
    .filter(a => a.segmentId === segmentId)
    .map(a => ({ id: a.id, type: a.type, status: a.status, path: a.path, sha256: a.sha256 ?? null, segmentId: a.segmentId }));

  // Previous segment summary (for continuity handoff)
  const segments = await loadSegmentOrder(root, state);
  const segIndex = segments.findIndex(s => s === segmentId);
  let previousSummary = null;
  if (segIndex > 0) {
    previousSummary = await readSegmentSummary(root, segments[segIndex - 1]);
  }

  return {
    project: projectInfo,
    projectArtifacts,
    segment: { segmentId, artifacts: segmentArtifacts },
    previousSegmentSummary: previousSummary
  };
}

async function loadSegmentOrder(root, state) {
  const segArtifact = state.artifacts
    .filter(a => a.type === 'segmentation' && a.status === 'locked')
    .sort((a, b) => b.revision - a.revision)[0];
  if (!segArtifact) return [];
  try {
    const canonical = await readJson(join(root, segArtifact.path));
    return (canonical?.segments ?? []).map(s => s.id);
  } catch {
    return [];
  }
}
