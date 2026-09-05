const SHOT_STRUCTURES = new Set(['standalone', 'editorial_sequence', 'continuous_take']);
const PRODUCT_INTERACTIONS = new Set(['none', 'display', 'scale_sensitive', 'wearing']);
const CAMERA_COMPOSITIONS = new Set(['standard', 'over_shoulder', 'foreground_layered', 'multi_subject']);
const CONTROL_MODES = new Set(['standard', 'modeling_strong_control']);
const MODELING_INPUT_MODES = new Set(['keyframes_only', 'animatic_video']);

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
}

function unique(values) {
  return [...new Set(values)];
}

export function classifyShotStrategy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('shot strategy input must be an object');
  if (!SHOT_STRUCTURES.has(input.shotStructure)) throw new Error(`unknown shotStructure: ${input.shotStructure ?? ''}`);
  if (!PRODUCT_INTERACTIONS.has(input.productInteraction)) {
    throw new Error(`unknown productInteraction: ${input.productInteraction ?? ''}`);
  }
  const cameraComposition = input.cameraComposition ?? 'standard';
  if (!CAMERA_COMPOSITIONS.has(cameraComposition)) {
    throw new Error(`unknown cameraComposition: ${cameraComposition}`);
  }
  const controlMode = input.controlMode ?? 'standard';
  const modelingInputMode = input.modelingInputMode;
  if (!CONTROL_MODES.has(controlMode)) throw new Error(`unknown controlMode: ${controlMode}`);
  if (controlMode === 'modeling_strong_control' && !MODELING_INPUT_MODES.has(modelingInputMode)) {
    throw new Error('modeling_strong_control requires modelingInputMode');
  }
  if (controlMode === 'standard' && modelingInputMode !== undefined) {
    throw new Error('modelingInputMode is only valid with modeling_strong_control');
  }

  integer(input.shotCount, 'shotCount', { min: 1, max: 20 });
  integer(input.peopleCount, 'peopleCount', { min: 0, max: 20 });
  integer(input.extensionDepth, 'extensionDepth', { min: 0, max: 3 });
  for (const field of [
    'hasPreviousSegment', 'strictSpatialCarryover', 'hasDialogue', 'complexPhysicalAction',
    'complexBlocking', 'motionReferenceAvailable', 'visibleDrift'
  ]) boolean(input[field], field);

  const continuousHandoff = input.shotStructure === 'continuous_take'
    && input.hasPreviousSegment && input.strictSpatialCarryover;
  const editorialCut = input.shotStructure === 'editorial_sequence';
  const reanchor = input.visibleDrift || input.extensionDepth >= 2;
  const directorViewProxy = input.peopleCount >= 4
    || (cameraComposition === 'over_shoulder' && input.peopleCount >= 2)
    || (cameraComposition === 'foreground_layered' && input.peopleCount >= 2)
    || (cameraComposition === 'multi_subject' && input.peopleCount >= 3);
  const modelingControlled = controlMode === 'modeling_strong_control';

  const capabilities = [];
  const assetRequirements = [];
  const checks = [];
  const warnings = [];

  if (input.peopleCount > 0) capabilities.push('canonical_character_references');
  if (input.peopleCount > 1) {
    capabilities.push('character_identity_position_map');
    checks.push('character IDs remain stable even when screen positions change');
  }
  if (input.hasDialogue) {
    capabilities.push('speaker_position_dialogue_map');
    checks.push('every line binds speaker ID, current position, and listener reaction');
  }
  if (input.complexBlocking) {
    capabilities.push('overhead_blocking_map');
    assetRequirements.push('camera_blocking');
  }
  if (directorViewProxy || modelingControlled) {
    capabilities.push('director_view_proxy');
    assetRequirements.push('director_view_proxy');
    checks.push('colored mannequin IDs, foreground/background order, scale, occlusion, and camera view match the locked character map');
    checks.push('director proxy controls composition only; final people, wardrobe, product, texture, and color come from canonical assets');
  }
  if (!modelingControlled && (input.shotCount > 1 || input.complexPhysicalAction || input.complexBlocking)) {
    capabilities.push('line_storyboard');
    assetRequirements.push('storyboard');
    checks.push('generation receives only the current clean panel, never the annotated grid');
  }
  if (modelingControlled) {
    capabilities.push('spatial_control_model', 'blender_camera_match', 'modeling_animatic_validation');
    if (modelingInputMode === 'animatic_video') assetRequirements.push('spatial_control_animatic');
    checks.push('all proxy frames and the animatic derive from one locked Blender scene and camera');
    checks.push('source-to-model comparison passes screen position, shot scale, camera path, contact timing, occlusion, cut points, and action endpoints');
    checks.push('the Blender model controls space and motion only; canonical assets remain identity, wardrobe, product, scene texture, color, and quality authority');
    if (modelingInputMode === 'keyframes_only') warnings.push('keyframes_only is model-derived control but cannot claim exact continuous motion transfer; expose this downgrade at generation preflight');
  }
  if (input.complexPhysicalAction) {
    if (input.motionReferenceAvailable) capabilities.push('motion_reference_video');
    else {
      capabilities.push('action_decomposition');
      warnings.push('complex physical action has no motion reference; split into smaller physical beats');
    }
  }
  if (input.productInteraction === 'scale_sensitive' || input.productInteraction === 'wearing') {
    capabilities.push('product_human_scale_board');
    assetRequirements.push('character_product_state');
    checks.push('product scale and held-versus-worn state are unambiguous');
  }
  if (continuousHandoff) {
    capabilities.push('proxy_handoff_model');
    assetRequirements.push('handoff_blocking');
    checks.push('proxy handoff controls blocking and pose only, never identity, texture, or first-frame pixels');
  }
  if (reanchor) {
    capabilities.push('canonical_reanchor');
    checks.push('open from canonical high-resolution assets instead of another output-sourced generation');
  }

  const route = continuousHandoff
    ? 'continuous_proxy_handoff'
    : editorialCut
      ? 'editorial_cut'
      : 'canonical_open';

  return {
    route,
    controlRoute: modelingControlled ? 'modeling_strong_control' : 'standard',
    capabilities: unique(capabilities),
    assetRequirements: unique(assetRequirements),
    checks: unique(checks),
    warnings: unique(warnings),
    referencePolicy: {
      generatedTailFrame: continuousHandoff ? 'observation_only' : 'not_required',
      proxyHandoff: continuousHandoff ? 'blocking_pose_camera_only' : 'not_required',
      storyboard: capabilities.includes('line_storyboard') ? 'current_clean_panel_only' : 'not_required',
      directorViewProxy: modelingControlled
        ? 'model_derived_camera_view_subject_layout_only'
        : directorViewProxy
          ? 'camera_view_subject_layout_only'
          : 'not_required',
      spatialControlModel: modelingControlled ? 'locked_spatial_motion_authority' : 'not_required',
      spatialControlAnimatic: modelingInputMode === 'animatic_video' ? 'blocking_pose_contact_camera_timing_only' : 'internal_validation_only',
      motionReference: capabilities.includes('motion_reference_video') ? 'motion_timing_camera_only' : 'not_required',
      canonicalAssets: 'identity_product_scene_authority'
    },
    explicitlyNotRequired: unique([
      ...(!continuousHandoff ? ['proxy_handoff_model'] : []),
      ...(!(directorViewProxy || modelingControlled) ? ['director_view_proxy'] : []),
      ...(!modelingControlled ? ['spatial_control_model', 'spatial_control_animatic'] : []),
      ...(!input.hasDialogue ? ['speaker_position_dialogue_map'] : []),
      ...(!input.complexPhysicalAction ? ['motion_reference_video', 'action_decomposition'] : []),
      ...(!(input.productInteraction === 'scale_sensitive' || input.productInteraction === 'wearing')
        ? ['product_human_scale_board'] : [])
    ])
  };
}
