// Stable ownership registry for paid-generation failures. Keys are persistent
// across prompt revisions so the same failure cannot be relabelled to bypass a
// required control-route remediation.
const entries = [
  ['ASSET_FACE_LOW_INFORMATION', 'asset', 'gate3'],
  ['ASSET_SKIN_BEAUTY_FILTER', 'asset', 'gate3'],
  ['ASSET_EYE_DEAD_CATCHLIGHT', 'asset', 'gate3'],
  ['ASSET_HEAD_BODY_JOIN_DRIFT', 'asset', 'gate3'],
  ['STATE_FULL_REPAINT_DRIFT', 'story_state', 'gate3'],
  ['SCENE_GEOMETRY_UNREADABLE', 'scene_geometry', 'gate2'],
  ['SCENE_REVERSE_MAP_MISMATCH', 'scene_geometry', 'gate2'],
  ['FIRST_FRAME_POSITION_DRIFT', 'handoff', 'gate5'],
  ['PROMPT_DENSITY_OVERLOAD', 'prompt', 'gate4'],
  ['RELATIONSHIP_BLOCKING_FLAT', 'direction', 'gate2'],
  ['ABSTRACT_EMOTION_ONLY', 'performance', 'gate2'],
  ['REACTION_BEFORE_TRIGGER', 'performance', 'gate2'],
  ['LISTENER_IDLE', 'performance', 'gate2'],
  ['MICROACTION_OVERLOAD', 'performance', 'gate2'],
  ['CHARACTER_MASTER_PROFILE_STALE', 'master_profile', 'gate2'],
  ['CHARACTER_BEHAVIOR_CORE_DRIFT', 'master_profile', 'gate2'],
  ['CHARACTER_TIC_TEMPLATE_OVERUSE', 'master_profile', 'gate2'],
  ['HANDOFF_PLANNED_OBSERVED_MISMATCH', 'handoff', 'gate5'],
  ['HANDOFF_RAW_FRAME_CONTAMINATION', 'handoff', 'gate5'],
  ['VOICE_IDENTITY_DRIFT', 'voice', 'gate3'],
  ['VOICE_STATE_MISMATCH', 'voice', 'gate2'],
  ['VOICE_AUDITION_MISMATCH', 'voice', 'gate3'],
  ['GENERATED_AUDIO_OVERWROTE_SOURCE', 'audio_execution', 'gate4'],
  ['REFERENCE_ROLE_LEAKAGE', 'reference_binding', 'gate3'],
  ['POST_GENERATION_EXTERNAL_AUDIT_FAIL', 'post_generation_external_audit', 'gate5'],
  ['MACHINE_TECHNICAL_OUTPUT_VETO', 'technical_review', 'gate5'],
  // Existing production/test keys retained as explicit compatibility entries.
  ['multi-shot-control-mismatch', 'generation', 'generation'],
  ['recovery-root-cause', 'generation', 'generation'],
  ['motion-control-overload', 'generation control', 'generation'],
  ['weak-end-state-anchor', 'handoff', 'gate5']
];

export const GENERATION_ROOT_CAUSE_REGISTRY = Object.freeze(Object.fromEntries(entries.map(([key, ownerLayer, returnStage]) => [
  key,
  Object.freeze({ key, ownerLayer, returnStage })
])));

export function generationRootCause(key) {
  return GENERATION_ROOT_CAUSE_REGISTRY[key] ?? null;
}

export function assertRegisteredGenerationRootCause(key, { stage } = {}) {
  const entry = generationRootCause(key);
  if (!entry) throw new Error(`rootCauseKey is not registered: ${key}`);
  if (stage !== undefined && stage !== entry.ownerLayer) {
    throw new Error(`rootCauseKey ${key} must be owned by stage ${entry.ownerLayer}`);
  }
  return entry;
}
