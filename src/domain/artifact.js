export const ARTIFACT_STATUSES = Object.freeze(['draft', 'awaiting_review', 'locked', 'rejected', 'rework', 'blocked']);
export const ARTIFACT_TYPES = Object.freeze(['brief', 'creative_brief', 'script', 'shotlist', 'story_plan', 'source_fact_analysis', 'capability_manifest', 'segmentation', 'reference_video', 'spatial_control_model', 'project_asset', 'segment_asset', 'storyboard_panel', 'asset_visual_audit', 'human_visual_exception', 'character_acting_master', 'character_story_state', 'voice_identity', 'scene_geometry', 'handoff_reconciliation', 'shot_narration', 'seedance_prompt', 'canonical_prompt_source', 'execution_package', 'independent_creative_audit', 'video_segment', 'final_edit', 'handoff', 'rule', 'quality_rubric', 'segment_contract']);

const transitions = new Map([
  ['draft', new Set(['awaiting_review', 'blocked'])],
  ['awaiting_review', new Set(['locked', 'rejected', 'blocked'])],
  ['rejected', new Set(['rework'])],
  ['rework', new Set(['awaiting_review', 'blocked'])],
  ['blocked', new Set(['draft', 'rework'])],
  ['locked', new Set()]
]);

const MEDIA_BEARING_TYPES = new Set(['project_asset', 'segment_asset', 'storyboard_panel', 'video_segment', 'final_edit']);

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

export function assertArtifact(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('artifact must be an object');
  requireNonEmptyString(value.id, 'id');
  if (!ARTIFACT_TYPES.includes(value.type)) throw new TypeError(`type must be one of ${ARTIFACT_TYPES.join(', ')}`);
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError('revision must be a positive integer');
  if (!ARTIFACT_STATUSES.includes(value.status)) throw new TypeError(`status must be one of ${ARTIFACT_STATUSES.join(', ')}`);
  requireNonEmptyString(value.path, 'path');
  if (value.supersedesArtifactId !== undefined) {
    requireNonEmptyString(value.supersedesArtifactId, 'supersedesArtifactId');
    if (value.supersedesArtifactId === value.id) throw new TypeError('artifact cannot supersede itself');
  }
  if (value.invalidatedByScopeRevisionId !== undefined) {
    requireNonEmptyString(value.invalidatedByScopeRevisionId, 'invalidatedByScopeRevisionId');
    requireNonEmptyString(value.invalidationReason, 'invalidationReason');
  } else if (value.invalidationReason !== undefined) {
    throw new TypeError('invalidationReason requires invalidatedByScopeRevisionId');
  }
  if (value.status === 'locked') requireNonEmptyString(value.lockedByReviewId, 'lockedByReviewId');
  if (value.rejectedByReviewId !== undefined) {
    requireNonEmptyString(value.rejectedByReviewId, 'rejectedByReviewId');
    if (value.status !== 'rejected') throw new TypeError('rejectedByReviewId is only valid for rejected artifacts');
  }
  if (value.status === 'locked' && MEDIA_BEARING_TYPES.has(value.type) && !/^[a-fA-F0-9]{64}$/.test(value.sha256 ?? '')) {
    throw new TypeError('sha256 must be a 64-character hexadecimal checksum for locked media');
  }
  return value;
}

export function canTransition(from, to) {
  return transitions.get(from)?.has(to) ?? false;
}

export function transitionArtifact(artifact, to, reviewId) {
  if (to === 'locked' && (typeof reviewId !== 'string' || reviewId.trim().length === 0)) throw new Error('reviewId is required to lock an artifact');
  if (!canTransition(artifact.status, to)) throw new Error(`invalid transition ${artifact.status} -> ${to}`);
  const { lockedByReviewId: _lockedByReviewId, rejectedByReviewId: _rejectedByReviewId, ...base } = artifact;
  const transitioned = {
    ...base,
    status: to,
    ...(to === 'locked' ? { lockedByReviewId: reviewId } : {}),
    ...(to === 'rejected' && reviewId ? { rejectedByReviewId: reviewId } : {})
  };
  assertArtifact(transitioned);
  return transitioned;
}
