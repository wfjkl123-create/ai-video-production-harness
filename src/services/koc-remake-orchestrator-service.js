import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const FIRST_FRAME_POLICIES = new Set(['none', 'all_segments', 'selected_segments']);
const MAX_SEGMENT_DURATION_SEC = 15;

function sha256Json(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase sha256`);
  return value;
}

function normalizeAsset(value, label, expectedMediaKind) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} must be an object`);
  const mediaKind = requiredText(value.mediaKind, `${label}.mediaKind`);
  if (mediaKind !== expectedMediaKind) throw new TypeError(`${label}.mediaKind must be ${expectedMediaKind}`);
  return {
    id: requiredText(value.id, `${label}.id`),
    sha256: requiredSha(value.sha256, `${label}.sha256`),
    mediaKind
  };
}

function normalizeArollSegment(segment, index, sourceDurationSec) {
  if (!segment || typeof segment !== 'object') throw new TypeError(`arollSegments[${index}] must be an object`);
  const id = requiredText(segment.id, `arollSegments[${index}].id`);
  const startSec = finiteNumber(segment.startSec, `arollSegments[${index}].startSec`);
  const endSec = finiteNumber(segment.endSec, `arollSegments[${index}].endSec`);
  const durationSec = endSec - startSec;
  if (startSec < 0 || endSec > sourceDurationSec || durationSec <= 0) {
    throw new TypeError(`${id} must stay inside the source timeline and have positive duration`);
  }
  if (durationSec > MAX_SEGMENT_DURATION_SEC + 0.001) {
    throw new TypeError(`${id} exceeds the ${MAX_SEGMENT_DURATION_SEC}-second KOC generation limit`);
  }
  if (segment.contentClass !== 'aroll') throw new TypeError(`${id} must be classified as A-roll only`);
  if (segment.containsBroll !== false) throw new TypeError(`${id} must explicitly prove that B-roll is absent`);
  if (segment.continuousTakeComplete !== true) {
    throw new TypeError(`${id} must preserve a complete continuous A-roll take instead of filling a mechanical 15-second window`);
  }
  const controlVideo = normalizeAsset(segment.controlVideo, `${id}.controlVideo`, 'video');
  if (segment.maskAudit?.status !== 'PASS'
    || segment.maskAudit?.coverage !== 'full_head_above_neck'
    || segment.maskAudit?.outsideHeadPreserved !== true) {
    throw new TypeError(`${id} requires a PASS mask audit proving full-head coverage above the neck and preservation outside the head`);
  }
  if (segment.sourceAudioMode !== 'embedded_original_track') {
    throw new TypeError(`${id} must keep the original embedded source audio; detached or muted audio is forbidden`);
  }
  return {
    id,
    startSec,
    endSec,
    durationSec: Math.round(durationSec * 1000) / 1000,
    contentClass: 'aroll',
    containsBroll: false,
    continuousTakeId: requiredText(segment.continuousTakeId, `${id}.continuousTakeId`),
    continuousTakeComplete: true,
    transcript: requiredText(segment.transcript, `${id}.transcript`),
    sourceRangeSha256: requiredSha(segment.sourceRangeSha256, `${id}.sourceRangeSha256`),
    controlVideo,
    maskAudit: {
      status: 'PASS',
      coverage: 'full_head_above_neck',
      outsideHeadPreserved: true,
      auditSha256: requiredSha(segment.maskAudit.auditSha256, `${id}.maskAudit.auditSha256`)
    },
    sourceAudioMode: 'embedded_original_track',
    firstFrame: segment.firstFrame ? normalizeAsset(segment.firstFrame, `${id}.firstFrame`, 'image') : null
  };
}

function assertFirstFrameCoverage(segments, policy, selectedIds) {
  if (!FIRST_FRAME_POLICIES.has(policy)) {
    throw new TypeError('firstFramePolicy must be none, all_segments, or selected_segments');
  }
  const segmentIds = new Set(segments.map(segment => segment.id));
  const chosen = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  if (!Array.isArray(selectedIds) || chosen.size !== selectedIds.length) {
    throw new TypeError('firstFrameSegmentIds must be an array without duplicates');
  }
  for (const id of chosen) {
    if (!segmentIds.has(id)) throw new TypeError(`firstFrameSegmentIds contains unknown segment ${id}`);
  }
  if (policy === 'none' && (chosen.size > 0 || segments.some(segment => segment.firstFrame))) {
    throw new TypeError('firstFramePolicy none forbids generated first-frame assets');
  }
  if (policy === 'all_segments' && segments.some(segment => !segment.firstFrame)) {
    throw new TypeError('firstFramePolicy all_segments requires a locked first frame for every segment');
  }
  if (policy === 'selected_segments') {
    if (chosen.size === 0) throw new TypeError('selected_segments requires at least one firstFrameSegmentId');
    for (const segment of segments) {
      if (chosen.has(segment.id) !== Boolean(segment.firstFrame)) {
        throw new TypeError(`${segment.id} first-frame binding does not match firstFrameSegmentIds`);
      }
    }
  }
}

export function buildKocRemakePlan({
  projectId,
  sourceVideo,
  sourceInventoryAudit,
  identityReference,
  arollSegments,
  firstFramePolicy,
  firstFrameSegmentIds = []
} = {}) {
  const normalizedSource = normalizeAsset(sourceVideo, 'sourceVideo', 'video');
  const sourceDurationSec = finiteNumber(sourceVideo.durationSec, 'sourceVideo.durationSec');
  if (sourceDurationSec <= 0) throw new TypeError('sourceVideo.durationSec must be positive');
  if (!sourceInventoryAudit || typeof sourceInventoryAudit !== 'object'
    || sourceInventoryAudit.status !== 'PASS'
    || sourceInventoryAudit.allArollRangesAccountedFor !== true
    || sourceInventoryAudit.brollRangesExcluded !== true
    || sourceInventoryAudit.sourceVideoSha256 !== normalizedSource.sha256) {
    throw new TypeError('sourceInventoryAudit must PASS against the same source SHA and prove complete A-roll coverage with B-roll excluded');
  }
  const inventoryAuditSha256 = requiredSha(sourceInventoryAudit.auditSha256, 'sourceInventoryAudit.auditSha256');
  const normalizedIdentity = normalizeAsset(identityReference, 'identityReference', 'image');
  if (!Array.isArray(arollSegments) || arollSegments.length === 0) {
    throw new TypeError('arollSegments must contain the complete source A-roll inventory');
  }
  const segments = arollSegments.map((segment, index) => normalizeArollSegment(segment, index, sourceDurationSec));
  const ids = new Set();
  let previousEnd = -1;
  for (const segment of segments) {
    if (ids.has(segment.id)) throw new TypeError(`duplicate A-roll segment id: ${segment.id}`);
    ids.add(segment.id);
    if (segment.startSec < previousEnd - 0.001) throw new TypeError(`${segment.id} overlaps or is out of source order`);
    previousEnd = segment.endSec;
  }
  assertFirstFrameCoverage(segments, firstFramePolicy, firstFrameSegmentIds);

  const lanes = segments.map((segment, index) => ({
    laneId: `koc-lane-${String(index + 1).padStart(3, '0')}`,
    segmentId: segment.id,
    sourceRange: { startSec: segment.startSec, endSec: segment.endSec },
    dependencies: ['koc-preparation-barrier'],
    parallelizable: true,
    steps: [
      'compile_zero_context_seedance_prompt',
      'bind_control_identity_and_optional_first_frame',
      'review_source_fidelity_and_timing',
      'review_identity_replacement_and_liveness',
      'review_delivery_completeness_and_authorization',
      'prepare_480p_libtv_canvas_node'
    ],
    mediaBindings: [
      { role: 'koc_aroll_control', ...segment.controlVideo },
      { role: 'character_reference', ...normalizedIdentity },
      ...(segment.firstFrame ? [{ role: 'first_frame', ...segment.firstFrame }] : [])
    ],
    promptInputs: {
      transcript: segment.transcript,
      sourceAudioMode: segment.sourceAudioMode,
      sourceRangeSha256: segment.sourceRangeSha256,
      maskAuditSha256: segment.maskAudit.auditSha256
    },
    generation: {
      resolution: '480p',
      assistantMaySubmitPaidGeneration: false,
      requiresCurrentNodeReadbackAndExplicitApproval: true
    }
  }));

  const plan = {
    schemaVersion: 1,
    kind: 'koc_remake_plan',
    projectId: requiredText(projectId, 'projectId'),
    sourceVideo: { ...normalizedSource, durationSec: sourceDurationSec },
    sourceInventoryAudit: {
      status: 'PASS',
      sourceVideoSha256: normalizedSource.sha256,
      allArollRangesAccountedFor: true,
      brollRangesExcluded: true,
      auditSha256: inventoryAuditSha256
    },
    identityReference: normalizedIdentity,
    firstFramePolicy,
    firstFrameSegmentIds: [...firstFrameSegmentIds],
    preparationBarrier: {
      id: 'koc-preparation-barrier',
      status: 'PASS',
      checks: [
        'complete_aroll_inventory',
        'continuous_boundaries_at_or_below_15_seconds',
        'broll_excluded_from_generation',
        'full_head_above_neck_mask_audit',
        'outside_head_pixels_preserved',
        'embedded_original_audio_preserved',
        'identity_reference_sha_locked',
        'first_frame_policy_satisfied'
      ]
    },
    execution: {
      strategy: 'event_driven_parallel_dag',
      maxParallelLanes: lanes.length,
      lanes,
      serialCloseout: [
        'collect_only_human_accepted_or_audited_usable_subranges',
        'reinsert_at_exact_source_ranges',
        'verify_100_percent_accepted_aroll_coverage',
        'verify_broll_pixel_preservation',
        'verify_original_audio_sync_and_duration',
        'gate5_source_comparison'
      ]
    },
    durableMemory: {
      authority: 'project_artifacts_and_sha_bound_checkpoints',
      checkpointPerLane: true,
      resumableFromLastPassedStep: true,
      conversationMemoryIsNonAuthoritative: true
    }
  };
  return { ...plan, fingerprintSha256: sha256Json(plan) };
}
