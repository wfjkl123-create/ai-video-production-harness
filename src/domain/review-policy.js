// Review policy: determines which artifact types require human review
// and which are auto-locked by the system after machine validation.
//
// The five user-visible gates are all explicit. Gate 1 and Gate 2 each lock
// exactly one decision artifact; the remaining gates cover assets, the exact
// paid-generation fingerprint, and generated video.
//
// Everything else (scripts, segmentations, contracts, narrations, prompts,
// internal audits) is auto-locked after machine validation passes.
// The human checkpoint reviews batch-approve all accumulated auto-locked
// artifacts of the relevant type at once.

// Artifact types that are auto-locked after machine validation.
// These never require individual human approval.
export const AUTO_LOCK_TYPES = Object.freeze([
  'brief',
  'script',
  'shotlist',
  'source_fact_analysis',
  'capability_manifest',
  'segmentation',
  'segment_contract',
  'shot_narration',
  'seedance_prompt',
  'canonical_prompt_source',
  'execution_package',
  'independent_creative_audit',
  // Atomic storyboard frames are system-verified intermediates. The one
  // canonical sheet remains the only storyboard asset reviewed at Gate 3.
  'storyboard_panel',
  'asset_visual_audit',
  'quality_rubric',
  'character_acting_master',
  'character_story_state',
  'voice_identity',
  'scene_geometry',
  'handoff_reconciliation',
  'rule',
  'handoff',
  'reference_video'
]);

// Artifact types that require human review at a checkpoint.
export const HUMAN_REVIEW_TYPES = Object.freeze([
  'creative_brief',
  'story_plan',
  'spatial_control_model',
  'project_asset',
  'segment_asset',
  'human_visual_exception',
  'video_segment',
  'final_edit'
]);

// The 5 human checkpoints, in workflow order.
export const CHECKPOINTS = Object.freeze({
  CHECKPOINT_CREATIVE: {
    id: 'checkpoint_creative',
    description: '创意方向、时长、分段方式、资产与视频并行策略统一审核',
    coversTypes: ['creative_brief'],
    singleArtifact: true
  },
  CHECKPOINT_STORY: {
    id: 'checkpoint_story',
    description: '剧本、人物圣经、分段、Shotlist或一镜到底计划统一审核',
    coversTypes: ['story_plan'],
    singleArtifact: true
  },
  CHECKPOINT_ASSETS: {
    id: 'checkpoint_assets',
    description: '所有资产图准备完毕，人工审核',
    coversTypes: ['spatial_control_model', 'project_asset', 'segment_asset', 'human_visual_exception']
  },
  CHECKPOINT_PREFLIGHT: {
    id: 'checkpoint_preflight',
    description: '编译包（资产+提示词）准备完毕，在 LibTV/立布 TV 画布内由用户审核并点击生成',
    coversTypes: [],
    reviewSurface: 'libtv_canvas',
    assistantMaySubmitByDefault: false,
    // The system prepares and binds the exact preflight fingerprint, then stops.
    // The user reviews the node in the LibTV canvas and clicks generation themselves.
  },
  CHECKPOINT_VIDEO: {
    id: 'checkpoint_video',
    description: '视频生成完毕，人工审片',
    coversTypes: ['video_segment', 'final_edit']
  }
});

const AUTO_LOCK_SET = new Set(AUTO_LOCK_TYPES);
const HUMAN_REVIEW_SET = new Set(HUMAN_REVIEW_TYPES);

/**
 * Returns true if the artifact type should be auto-locked
 * (no individual human approval needed).
 */
export function isAutoLockType(type) {
  return AUTO_LOCK_SET.has(type);
}

/**
 * Returns true if the artifact type requires human review
 * at a checkpoint.
 */
export function isHumanReviewType(type) {
  return HUMAN_REVIEW_SET.has(type);
}

/**
 * Returns the checkpoint that covers the given artifact type,
 * or null if it's auto-locked.
 */
export function checkpointForType(type) {
  for (const checkpoint of Object.values(CHECKPOINTS)) {
    if (checkpoint.coversTypes.includes(type)) return checkpoint;
  }
  return null;
}
