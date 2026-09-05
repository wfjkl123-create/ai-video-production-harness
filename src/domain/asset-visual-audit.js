const SHA256 = /^[a-f0-9]{64}$/;

export const REQUIRED_VISUAL_CHECKS = Object.freeze({
  character_front_face_closeup_v1: Object.freeze([
    'single_identity', 'front_face_closeup', 'identity_anchor_match',
    'hair_silhouette_consistency', 'natural_skin_texture', 'natural_eye_focus',
    'natural_asymmetry_no_plastic_ai_face', 'no_extra_subject_text_watermark'
  ]),
  character_profile_face_closeup_v1: Object.freeze([
    'single_identity', 'pure_profile_face', 'identity_anchor_match',
    'nose_jaw_ear_readable', 'hair_silhouette_consistency', 'natural_eye_focus',
    'natural_asymmetry_no_plastic_ai_face', 'no_extra_subject_text_watermark'
  ]),
  character_front_wardrobe_no_head_v1: Object.freeze([
    'single_identity', 'entire_head_outside_frame', 'both_hands_legs_shoes_complete',
    'wardrobe_contract_match', 'body_proportion_consistency', 'no_extra_subject_text_watermark'
  ]),
  character_full_body_back_v1: Object.freeze([
    'single_identity', 'complete_back_full_body', 'back_hair_wardrobe_shoes_readable',
    'wardrobe_contract_match', 'body_proportion_consistency', 'no_extra_subject_text_watermark'
  ]),
  character_board: Object.freeze([
    'single_identity',
    'front_face_closeup',
    'profile_face_closeup',
    'enlarged_front_wardrobe',
    'full_body_back',
    'cross_panel_identity_consistency',
    'wardrobe_consistency',
    'natural_eye_focus',
    'natural_asymmetry_no_plastic_ai_face',
    'not_cast_composite'
  ]),
  character_identity_single_view: Object.freeze([
    'single_identity',
    'front_full_body',
    'identity_wardrobe_legibility',
    'not_cast_composite',
    'no_product_scene_text_watermark_ui',
    'role_suitability_identity_wardrobe_body_only'
  ]),
  // A deterministic source-frame identity reference may legitimately retain
  // the source scene and stop at the knees.  It is narrower than the canonical
  // studio/full-body profile: only the pixels actually visible in the source
  // frame may act as identity, wardrobe, and proportion authority.
  character_identity_source_visible_v1: Object.freeze([
    'single_identity',
    'front_source_visible_head_through_at_least_knees_complete',
    'face_hair_white_mesh_top_plaid_skirt_legible',
    'not_multi_person_panel_or_cast_composite',
    'no_product_text_watermark_ui',
    'source_scene_context_allowed_but_not_authoritative',
    'role_suitability_identity_wardrobe_source_visible_body_proportions_only'
  ]),
  wardrobe_board: Object.freeze([
    'declared_layering_legibility', 'garment_structure_consistency',
    'material_edge_legibility', 'no_body_or_mannequin_pollution',
    'no_text_logo_watermark'
  ]),
  expression_board: Object.freeze([
    'single_identity', 'story_required_expressions',
    'cross_panel_identity_consistency', 'restrained_expression_range',
    'motivated_eye_target_and_reaction', 'no_template_expression_or_frozen_stare'
  ]),
  // The canonical asset category is `scene_multiview`, but the A1 route
  // intentionally requests one clean assigned scene view (the prompt
  // profile is `scene_multiview_v1`).  Keep the canonical category while
  // validating the actual single-view scene contract; requiring a reverse
  // angle here would contradict the locked A1 asset scope.
  scene_multiview: Object.freeze([
    'empty_scene_only', 'assigned_camera_view', 'fixed_anchor_consistency',
    'lighting_material_consistency', 'no_text_watermark_extra_panel'
  ]),
  scene_multiview_v1: Object.freeze(['empty_scene_only', 'assigned_camera_view', 'fixed_anchor_consistency', 'lighting_material_consistency', 'no_text_watermark_extra_panel']),
  scene_overhead_v1: Object.freeze(['empty_scene_only', 'overhead_geography', 'fixed_anchor_consistency', 'lighting_material_consistency', 'no_text_watermark_extra_panel']),
  story_prop: Object.freeze([
    'front_view', 'side_view', 'back_view', 'key_detail_view',
    'cross_view_structure_consistency'
  ]),
  story_prop_v1: Object.freeze(['single_prop_only', 'assigned_view', 'geometry_material_color_scale_match', 'complete_uncropped_object', 'no_person_text_watermark_extra_panel']),
  story_prop_set_v1: Object.freeze([
    'complete_declared_prop_set', 'source_observed_front_views',
    'distinct_prop_roles_readable', 'hands_and_contact_are_source_evidence_only',
    'no_generated_text_logo_watermark_ui', 'role_suitability_prop_appearance_only'
  ]),
  color_board: Object.freeze([
    'color_values', 'semantic_color_roles', 'usage_locations', 'example_application'
  ]),
  storyboard_sheet_15s_v1: Object.freeze([
    'complete_grid_count', 'panel_reading_order', 'shot_time_mapping',
    'visible_action_endpoints', 'cross_panel_identity_wardrobe_scene_consistency',
    'screen_direction_camera_blocking_continuity', 'performance_intent_and_eyeline_readable',
    'no_frozen_or_generic_gesture_people', 'no_future_action_text_watermark'
  ]),
  storyboard_panel_repair_v1: Object.freeze([
    'single_panel_only', 'target_shot_time_action_match',
    'identity_wardrobe_scene_match', 'camera_blocking_light_match',
    'adjacent_panel_continuity', 'no_future_action_text_watermark'
  ]),
  storyboard_execution_panel: Object.freeze([
    'single_panel_only', 'target_shot_time_action_match',
    'identity_wardrobe_scene_match', 'camera_blocking_light_match',
    'strict_monochrome_line_art', 'no_future_action_text_watermark'
  ]),
  // A generated panel is only a crop source after it independently passes the
  // same clean-zero-context reading as the final native execution panel.
  storyboard_execution_panel_candidate: Object.freeze([
    'single_panel_only', 'target_shot_time_action_match',
    'identity_wardrobe_scene_match', 'camera_blocking_light_match',
    'strict_monochrome_line_art', 'no_future_action_text_watermark'
  ]),
  storyboard_proportion_support_internal: Object.freeze([
    'single_identity', 'front_full_body', 'identity_wardrobe_legibility',
    'not_cast_composite', 'no_product_scene_text_watermark_ui',
    'role_suitability_identity_wardrobe_body_only'
  ]),
  storyboard: Object.freeze([
    'complete_grid_count', 'panel_reading_order', 'shot_time_mapping',
    'visible_action_endpoints', 'cross_panel_identity_wardrobe_scene_consistency',
    'screen_direction_camera_blocking_continuity', 'performance_intent_and_eyeline_readable',
    'no_frozen_or_generic_gesture_people', 'no_future_action_text_watermark'
  ]),
  mannequin_grid_v1: Object.freeze(['single_source_frame_only', 'source_pose_camera_blocking_match', 'all_people_replaced', 'faceless_continuous_clay_material', 'five_finger_hands', 'real_scene_contact_shadow_volume', 'character_color_map_consistency', 'no_paper_cutout_identity_text_watermark'])
});

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

export function assertAssetVisualAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('asset visual audit must be an object');
  text(value.id, 'id');
  if (value.kind !== 'asset_visual_audit') throw new TypeError('kind must be asset_visual_audit');
  text(value.assetId, 'assetId');
  text(value.assetType, 'assetType');
  if (!Number.isInteger(value.assetRevision) || value.assetRevision < 1) throw new TypeError('assetRevision must be a positive integer');
  if (!SHA256.test(value.assetSha256 ?? '')) throw new TypeError('assetSha256 must be a lowercase SHA-256');
  if (value.decision !== 'PASS' && value.decision !== 'FAIL') throw new TypeError('decision must be PASS or FAIL');
  if (value.inspectionMode !== 'multimodal_pixels') throw new TypeError('inspectionMode must be multimodal_pixels');
  if (value.inspectorContextMode !== 'clean_zero_context') throw new TypeError('inspectorContextMode must be clean_zero_context');
  text(value.inspectorTaskId, 'inspectorTaskId');
  if (value.characterMedium !== undefined && !['live_action', 'stylized_clay'].includes(value.characterMedium)) {
    throw new TypeError('characterMedium must be live_action or stylized_clay');
  }
  if (!Number.isInteger(value.observedIdentityCount) || value.observedIdentityCount < 0) {
    throw new TypeError('observedIdentityCount must be a non-negative integer');
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) throw new TypeError('checks must be a non-empty array');
  const byId = new Map();
  for (const [index, check] of value.checks.entries()) {
    text(check?.id, `checks[${index}].id`);
    if (byId.has(check.id)) throw new TypeError(`duplicate visual check: ${check.id}`);
    if (!['PASS', 'FAIL', 'NA'].includes(check.result)) throw new TypeError(`checks[${index}].result must be PASS, FAIL, or NA`);
    text(check.evidence, `checks[${index}].evidence`);
    byId.set(check.id, check);
  }
  const required = value.characterMedium === 'stylized_clay' && value.assetType === 'character_front_face_closeup_v1'
    ? REQUIRED_VISUAL_CHECKS[value.assetType].map(id => id === 'natural_skin_texture' ? 'matte_clay_surface_no_human_skin' : id)
    : REQUIRED_VISUAL_CHECKS[value.assetType] ?? ['asset_role_fidelity'];
  for (const id of required) {
    const check = byId.get(id);
    if (!check) throw new TypeError(`required visual check is missing: ${id}`);
    if (value.decision === 'PASS' && check.result !== 'PASS') {
      throw new TypeError(`PASS audit requires visual check ${id} to PASS`);
    }
  }
  if ((['character_board', 'character_identity_single_view'].includes(value.assetType) || value.assetType.startsWith('character_'))
    && value.decision === 'PASS' && value.observedIdentityCount !== 1) {
    throw new TypeError(`${value.assetType} PASS requires exactly one observed identity`);
  }
  if (!Number.isInteger(value.blockerCount) || value.blockerCount < 0) throw new TypeError('blockerCount must be a non-negative integer');
  if (value.decision === 'PASS' && value.blockerCount !== 0) throw new TypeError('PASS audit requires blockerCount 0');
  text(value.reviewedAt, 'reviewedAt');
  if (Number.isNaN(Date.parse(value.reviewedAt))) throw new TypeError('reviewedAt must be a date-time');
  return value;
}

export function requireMatchingAtomicVisualAudit(state, panel) {
  const audit = (state.artifacts ?? []).find(candidate => candidate.id === panel.visualAuditId);
  if (!audit || audit.type !== 'asset_visual_audit' || audit.status !== 'locked') {
    throw new Error(`atomic image ${panel.atomicAssetId} requires a locked asset_visual_audit PASS`);
  }
  const exception = panel.humanVisualExceptionId
    ? (state.artifacts ?? []).find(candidate => candidate.id === panel.humanVisualExceptionId)
    : null;
  const acceptedByExactHumanException = audit.decision === 'FAIL'
    && exception?.type === 'human_visual_exception'
    && exception.status === 'locked'
    && exception.assetId === panel.atomicAssetId
    && exception.assetRevision === panel.revision
    && exception.assetSha256 === panel.sha256
    && exception.visualAuditId === audit.id
    && Array.isArray(exception.acceptedFailedCheckIds)
    && exception.acceptedFailedCheckIds.length > 0;
  const characterProfile = ['character_front_face_closeup_v1', 'character_profile_face_closeup_v1', 'character_front_wardrobe_no_head_v1', 'character_full_body_back_v1'].includes(panel.profileId);
  if ((!acceptedByExactHumanException && audit.decision !== 'PASS')
    || audit.assetId !== panel.atomicAssetId
    || audit.assetType !== panel.profileId
    || audit.assetRevision !== panel.revision
    || audit.assetSha256 !== panel.sha256
    || audit.inspectionMode !== 'multimodal_pixels'
    || audit.inspectorContextMode !== 'clean_zero_context'
    || (characterProfile && audit.observedIdentityCount !== 1)
    || (!acceptedByExactHumanException && audit.blockerCount !== 0)) {
    throw new Error(`asset_visual_audit ${audit.id} is stale or does not match ${panel.atomicAssetId}`);
  }
  if (acceptedByExactHumanException) {
    const failedIds = new Set((audit.failedCheckIds ?? []));
    for (const id of exception.acceptedFailedCheckIds) {
      if (failedIds.size > 0 && !failedIds.has(id)) throw new Error(`human visual exception ${exception.id} accepts a check not failed by ${audit.id}: ${id}`);
    }
  }
  return { audit, exception };
}

export function assertCharacterBoardDescriptor(value) {
  if (value?.type !== 'project_asset' || ![
    'character_board',
    'character_identity_single_view',
    'character_identity_source_visible_v1'
  ].includes(value?.assetType)) return value;
  text(value.characterId, 'characterId');
  if (value.visualContractVersion !== 1) throw new TypeError(`${value.assetType} visualContractVersion must be 1`);
  if (Array.isArray(value.characterIds) || value.characterId.includes(',')) {
    throw new TypeError(`${value.assetType} must bind exactly one characterId; cast composites are forbidden`);
  }
  return value;
}

export function requireMatchingAssetVisualAudit(state, asset) {
  assertCharacterBoardDescriptor(asset);
  const auditArtifact = (state.artifacts ?? []).find(candidate => candidate.id === asset.visualAuditId);
  if (!auditArtifact || auditArtifact.type !== 'asset_visual_audit' || auditArtifact.status !== 'locked') {
    throw new Error(`asset ${asset.id} requires a locked asset_visual_audit PASS`);
  }
  const exception = asset.humanVisualExceptionId
    ? (state.artifacts ?? []).find(candidate => candidate.id === asset.humanVisualExceptionId)
    : null;
  const acceptedByExactHumanException = auditArtifact.decision === 'FAIL'
    && exception?.type === 'human_visual_exception'
    && exception.status === 'locked'
    && exception.assetId === asset.id
    && exception.assetRevision === asset.revision
    && exception.assetSha256 === asset.sha256
    && exception.visualAuditId === auditArtifact.id
    && Array.isArray(exception.acceptedFailedCheckIds)
    && exception.acceptedFailedCheckIds.length > 0;
  const characterAsset = ['character_board', 'character_identity_single_view'].includes(asset.assetType) || asset.assetType?.startsWith('character_');
  if ((!acceptedByExactHumanException && auditArtifact.decision !== 'PASS')
    || auditArtifact.assetId !== asset.id
    || auditArtifact.assetType !== asset.assetType
    || auditArtifact.assetRevision !== asset.revision
    || auditArtifact.assetSha256 !== asset.sha256
    || auditArtifact.inspectionMode !== 'multimodal_pixels'
    || auditArtifact.inspectorContextMode !== 'clean_zero_context'
    || typeof auditArtifact.inspectorTaskId !== 'string'
    || auditArtifact.inspectorTaskId.trim() === ''
    || (characterAsset && auditArtifact.observedIdentityCount !== 1)
    || (!acceptedByExactHumanException && auditArtifact.blockerCount !== 0)) {
    throw new Error(`asset_visual_audit ${auditArtifact.id} is stale or does not match ${asset.id}`);
  }
  if (acceptedByExactHumanException) {
    const failedIds = new Set(auditArtifact.failedCheckIds ?? []);
    for (const id of exception.acceptedFailedCheckIds) {
      if (failedIds.size > 0 && !failedIds.has(id)) throw new Error(`human visual exception ${exception.id} accepts a check not failed by ${auditArtifact.id}: ${id}`);
    }
  }
  if (Array.isArray(asset.requiredVisualChecks)) {
    const checks = new Set(auditArtifact.checkIds ?? []);
    for (const id of asset.requiredVisualChecks) if (!checks.has(id)) throw new Error(`asset_visual_audit ${auditArtifact.id} is missing route-required check ${id}`);
  }
  return acceptedByExactHumanException ? { audit: auditArtifact, exception } : auditArtifact;
}
