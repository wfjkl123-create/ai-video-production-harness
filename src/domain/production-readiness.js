const TRANSFORM_MODES = new Set(['local_edit', 'faithful_remake', 'story_creation']);
const CONTROL_MODES = new Set(['standard', 'modeling_strong_control']);
const MODELING_INPUT_MODES = new Set(['keyframes_only', 'animatic_video']);
const FIDELITY_TARGETS = new Set(['adapted', 'faithful', 'one_to_one']);
const CANONICAL_AUTHORITIES = new Set(['identity', 'wardrobe', 'product_structure', 'texture', 'quality', 'world_style']);
const OBSERVATION_AUTHORITIES = new Set(['position', 'pose', 'eyeline', 'prop_state', 'motion_phase', 'camera_state']);

function finding(id, severity, scope, message, remedy) {
  return { id, severity, scope, message, remedy };
}

function unique(values) {
  return [...new Set(values)];
}

export function inferTransformMode(projectType, explicitMode) {
  if (explicitMode !== undefined) {
    if (!TRANSFORM_MODES.has(explicitMode)) throw new TypeError(`unknown transformMode: ${explicitMode}`);
    return { mode: explicitMode, inferred: false };
  }
  if (projectType === 'viral_remake' || projectType === 'faithful_remake') return { mode: 'faithful_remake', inferred: true };
  if (projectType === 'local_edit') return { mode: 'local_edit', inferred: true };
  return { mode: 'story_creation', inferred: true };
}

export function assertControlProfile(directorPlan = {}) {
  const controlMode = directorPlan.controlMode ?? 'standard';
  const fidelityTarget = directorPlan.fidelityTarget ?? (
    directorPlan.transformMode === 'faithful_remake' || ['viral_remake', 'faithful_remake'].includes(directorPlan.projectType)
      ? 'faithful'
      : 'adapted'
  );
  const modelingInputMode = directorPlan.modelingInputMode;
  if (!CONTROL_MODES.has(controlMode)) throw new TypeError(`unknown controlMode: ${controlMode}`);
  if (!FIDELITY_TARGETS.has(fidelityTarget)) throw new TypeError(`unknown fidelityTarget: ${fidelityTarget}`);
  if (modelingInputMode !== undefined && !MODELING_INPUT_MODES.has(modelingInputMode)) {
    throw new TypeError(`unknown modelingInputMode: ${modelingInputMode}`);
  }
  if (controlMode === 'modeling_strong_control' && modelingInputMode === undefined) {
    throw new TypeError('modeling_strong_control requires modelingInputMode');
  }
  if (controlMode === 'standard' && modelingInputMode !== undefined) {
    throw new TypeError('modelingInputMode is only valid with modeling_strong_control');
  }
  return { controlMode, fidelityTarget, modelingInputMode: modelingInputMode ?? null };
}

function validatePerformanceBeat(beat, scope) {
  if (!beat || typeof beat !== 'object' || Array.isArray(beat)) return [
    finding('PERFORMANCE_CAUSALITY_UNDECLARED', 'warning', scope,
      'Character performance has no explicit trigger -> observable reaction -> decision contract.',
      'Add performanceBeat with trigger, observableReaction, decision, partnerFeedback, cutPoint and soundRole.')
  ];
  const missing = ['trigger', 'observableReaction', 'decision', 'partnerFeedback', 'cutPoint', 'soundRole']
    .filter(field => typeof beat[field] !== 'string' || beat[field].trim() === '');
  return missing.length === 0 ? [] : [
    finding('PERFORMANCE_CAUSALITY_INCOMPLETE', 'error', scope,
      `Performance beat is missing: ${missing.join(', ')}.`,
      'Describe only visible/audible causality; do not replace missing behavior with psychology prose.')
  ];
}

function segmentGuidance(segment, shots, contexts) {
  const characterIds = unique(contexts.flatMap(context => context.characterIds ?? []));
  const signals = contexts.map(context => context.directorIntent?.signals ?? {});
  const hasDialogue = signals.some(value => value.hasDialogue);
  const relationshipPerformance = signals.some(value => value.relationshipBeat || value.emotionalTurn || value.requiresMutualEyeLine);
  const localDeterministic = signals.every(value => value.localDeterministic === true);
  const productOnly = characterIds.length === 0 && signals.some(value => value.productInteraction && value.productInteraction !== 'none');
  const generationDurationSec = segment.generationCoverage?.durationSec ?? (segment.endSec - segment.startSec);
  const base = { segmentId: segment.segmentId, finalEditDurationSec: segment.endSec - segment.startSec, generationDurationSec };
  if (localDeterministic) return { ...base, unit: 'deterministic_edit', durationRangeSec: null };
  if (productOnly) return { ...base, unit: 'product_proof_insert', durationRangeSec: [2.5, 4] };
  if (hasDialogue || relationshipPerformance || characterIds.length > 1) {
    return { ...base, unit: 'causal_performance_coverage', durationRangeSec: [4, 7] };
  }
  if (shots.length === 1 && generationDurationSec >= 8) {
    return { ...base, unit: 'continuous_performance', durationRangeSec: [8, 15] };
  }
  return { ...base, unit: 'narrative_coverage', durationRangeSec: [2.5, 4] };
}

export function assessStoryPlanExecutability(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('story plan must be an object');
  const transform = inferTransformMode(plan.directorPlan?.projectType, plan.directorPlan?.transformMode);
  const control = assertControlProfile(plan.directorPlan);
  const findings = [];
  const guidance = [];
  const shots = plan.shotPlanning?.mode === 'shotlist' ? (plan.shotPlanning.shots ?? []) : [];
  const contexts = shots.map(shot => ({
    ...shot,
    characterIds: shot.characterIds ?? [],
    directorIntent: shot.directorIntent ?? {}
  }));

  if (transform.inferred) findings.push(finding(
    'TRANSFORM_MODE_INFERRED', 'warning', 'project',
    `transformMode was inferred as ${transform.mode} from projectType instead of being explicitly locked.`,
    'Lock local_edit, faithful_remake or story_creation at Gate 1 so the asset and review route cannot drift.')
  );

  if (plan.shotPlanning?.mode === 'single_take') {
    const take = plan.shotPlanning.continuousTakePlan ?? {};
    const takeContexts = (plan.videoSegments ?? []).map(segment => ({
      characterIds: take.characterIds ?? (plan.characters ?? []).map(item => item.characterId),
      directorIntent: take.directorIntent ?? {}
    }));
    for (const [index, segment] of (plan.videoSegments ?? []).entries()) {
      guidance.push(segmentGuidance(segment, [take], [takeContexts[index]]));
      if ((takeContexts[index].characterIds ?? []).length > 0) {
        findings.push(...validatePerformanceBeat(take.performanceBeat, `${segment.segmentId}:continuous_take`));
      }
    }
  } else {
    for (const segment of plan.videoSegments ?? []) {
      const segmentShots = shots.filter(shot => shot.segmentId === segment.segmentId);
      const segmentContexts = contexts.filter(shot => shot.segmentId === segment.segmentId);
      const guide = segmentGuidance(segment, segmentShots, segmentContexts);
      guidance.push(guide);
      const duration = segment.endSec - segment.startSec;
      const generationDuration = segment.generationCoverage?.durationSec ?? duration;
      const characters = unique(segmentContexts.flatMap(context => context.characterIds));
      const signals = segmentContexts.map(context => context.directorIntent?.signals ?? {});
      const performanceCritical = characters.length > 0 && signals.some(value => (
        value.hasDialogue || value.relationshipBeat || value.emotionalTurn || value.requiresMutualEyeLine
  ));

  if (control.fidelityTarget === 'one_to_one' && control.controlMode !== 'modeling_strong_control') findings.push(finding(
    'ONE_TO_ONE_REQUIRES_MODELING_CONTROL', 'error', 'project',
    'A one-to-one remake cannot use the standard image-and-prompt route as its primary spatial authority.',
    'Set controlMode=modeling_strong_control and rebuild blocking, camera, contact and timing in one locked Blender spatial-control model.'
  ));
  if (control.fidelityTarget === 'one_to_one' && transform.mode !== 'faithful_remake') findings.push(finding(
    'ONE_TO_ONE_REQUIRES_FAITHFUL_REMAKE', 'error', 'project',
    'A one-to-one fidelity target cannot use local_edit or story_creation semantics.',
    'Lock transformMode=faithful_remake before compiling the modeling-control route.'
  ));
  if (control.controlMode === 'modeling_strong_control' && control.modelingInputMode === 'keyframes_only') findings.push(finding(
    'MODELING_CONTROL_DOWNGRADED_TO_KEYFRAMES', 'warning', 'project',
    'The Blender animatic is being reduced to still keyframes, so exact continuous motion and contact cannot be claimed as video-level control.',
    'Keep the locked Blender project and animatic as the authority, expose the limitation at Gate 4, and use animatic_video when exact motion transfer is required and video-input cost is approved.'
  ));
      const localDeterministic = signals.length > 0 && signals.every(value => value.localDeterministic === true);

      if (segment.generationCoverage !== undefined) {
        const coverage = segment.generationCoverage;
        const validWindow = Number.isFinite(coverage.durationSec) && coverage.durationSec > 0 && coverage.durationSec <= 15
          && Number.isFinite(coverage.editInSec) && Number.isFinite(coverage.editOutSec)
          && coverage.editInSec >= 0 && coverage.editOutSec <= coverage.durationSec
          && coverage.editOutSec > coverage.editInSec
          && Math.abs((coverage.editOutSec - coverage.editInSec) - duration) < 0.001;
        if (!validWindow) findings.push(finding(
          'GENERATION_COVERAGE_WINDOW_INVALID', 'error', segment.segmentId,
          'Generation coverage must declare a <=15s source duration and an edit window exactly matching the final segment duration.',
          'Set durationSec, editInSec and editOutSec explicitly; generation duration is source coverage, while the edit window is the final cut.'
        ));
      }

      if (performanceCritical && !localDeterministic && generationDuration < 4) findings.push(finding(
        'MICRO_SEGMENT_PERFORMANCE_RESET', 'error', segment.segmentId,
        `A ${generationDuration.toFixed(3)}s generated coverage contains relationship/dialogue performance and is likely to restart pose, wardrobe and emotion.`,
        'Group adjacent final-edit shots into a 4-7s causal performance coverage unit; recover the exact short cut in editing.')
      );

      for (const shot of segmentShots) {
        const shotIsLocalDeterministic = shot.directorIntent?.signals?.localDeterministic === true;
        if (!shotIsLocalDeterministic && (shot.characterIds ?? []).length > 0) findings.push(...validatePerformanceBeat(shot.performanceBeat, shot.shotId));
        if (!shotIsLocalDeterministic && shot.durationSec < 1.5 && generationDuration < 4 && (shot.characterIds ?? []).length > 0) findings.push(finding(
          'FINAL_CUT_USED_AS_GENERATION_DURATION', 'warning', shot.shotId,
          `The ${shot.durationSec.toFixed(3)}s final edit duration is too short to carry a complete character beat reliably.`,
          'Generate overlapping coverage at the recommended unit duration, then trim to this edit point.')
        );
      }

      const hasProductBodyPhysics = signals.some(value => ['scale_sensitive', 'wearing'].includes(value.productInteraction));
      const hasComplexBlocking = signals.some(value => value.complexBlocking);
      if (characters.length >= 3 && hasProductBodyPhysics && (hasComplexBlocking || segmentShots.length >= 3)) findings.push(finding(
        'MULTI_SUBJECT_PHYSICS_OVERLOAD', 'error', segment.segmentId,
        'Three or more performers, subtle relationship timing and product/body physics compete inside one generation unit.',
        'Keep one focal reaction chain in the performance unit and move the physical proof into a separate insert or deterministic edit.')
      );

      const productSignals = signals.filter(value => value.productInteraction && value.productInteraction !== 'none');
      if (productSignals.length > 0 && !segmentShots.some(shot => Array.isArray(shot.mustSee) && shot.mustSee.length > 0)) findings.push(finding(
        'MUST_SEE_EVIDENCE_UNDECLARED', 'warning', segment.segmentId,
        'A product interaction exists but no Must-see evidence is declared at shot level.',
        'Declare the first-eye proof that must remain readable before relationship detail or polish.')
      );
    }
  }

  const errors = findings.filter(item => item.severity === 'error');
  return {
    transformMode: transform.mode,
    transformModeInferred: transform.inferred,
    controlMode: control.controlMode,
    fidelityTarget: control.fidelityTarget,
    modelingInputMode: control.modelingInputMode,
    status: errors.length > 0 ? 'BLOCKED' : findings.length > 0 ? 'WARN' : 'PASS',
    findings,
    generationGuidance: guidance
  };
}

export function assessReferenceAuthority(references) {
  if (!Array.isArray(references)) throw new TypeError('references must be an array');
  const findings = [];
  for (const reference of references) {
    const scope = reference.id ?? 'reference';
    const authorities = new Set(reference.authorities ?? []);
    const canonicalClaims = [...authorities].filter(value => CANONICAL_AUTHORITIES.has(value));
    const observationClaims = [...authorities].filter(value => OBSERVATION_AUTHORITIES.has(value));
    if (reference.origin === 'generated_output' && reference.use === 'generation' && canonicalClaims.length > 0) findings.push(finding(
      'GENERATED_OUTPUT_AS_CANONICAL_AUTHORITY', 'error', scope,
      `Generated output is being used as authority for ${canonicalClaims.join(', ')}.`,
      'Use canonical character/wardrobe/product/world assets for appearance; keep the output only for motion-state observation.')
    );
    if (reference.origin === 'generated_output' && reference.use === 'generation' && observationClaims.length > 0) findings.push(finding(
      'GENERATED_OUTPUT_REQUIRES_CANONICAL_REANCHOR', 'warning', scope,
      `Generated output controls ${observationClaims.join(', ')} and may also leak style or texture through its pixels.`,
      'Bind independent canonical appearance assets in parallel and inspect identity, texture and color after generation.')
    );
    if (reference.derivation === 'upscale' && authorities.has('quality')) findings.push(finding(
      'UPSCALE_MISLABELED_AS_RESTORATION', 'error', scope,
      'A size-only upscale is being treated as recovered quality.',
      'Record it as upscale only; verify real detail, canonical identity/product similarity and reconstruction drift separately.')
    );
  }
  return { status: findings.some(item => item.severity === 'error') ? 'BLOCKED' : findings.length ? 'WARN' : 'PASS', findings };
}

export { TRANSFORM_MODES, CONTROL_MODES, MODELING_INPUT_MODES, FIDELITY_TARGETS };
