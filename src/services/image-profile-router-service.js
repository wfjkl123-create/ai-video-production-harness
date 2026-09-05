import { compileImagePrompt } from './image-prompt-compiler-service.js';
import { planParallelImageTasks } from './image-task-dispatcher-service.js';
import { canonicalJson } from '../domain/image-prompt-ir.js';
import { createHash } from 'node:crypto';
import { buildStoryboardExecutionPanelIrs, buildStoryboardPanelRepairIr, buildStoryboardSheetIr } from './storyboard-prompt-service.js';
import { buildDirectorViewProxyIr, buildMannequinFrameIrs, buildSceneMultiviewIrs, buildStoryPropIrs } from './specialized-asset-prompt-service.js';

const CHARACTER_SLOTS = Object.freeze([
  {
    slot: 'top_left', suffix: 'front-face', profileId: 'character_front_face_closeup_v1',
    responsibility: 'front face identity, facial geometry, skin texture, hairline and age appearance',
    composition: { view: 'front face close-up', framing: 'head and shoulders', headDirection: 'straight to camera' },
    checks: ['exactly one person', 'front face and both eyes visible', 'identity and hair match the character contract', 'real skin texture without beauty-filter plasticity']
  },
  {
    slot: 'top_right', suffix: 'profile-face', profileId: 'character_profile_face_closeup_v1',
    responsibility: 'pure profile face identity, nose line, jaw line, ear and side hair silhouette',
    composition: { view: 'pure side profile close-up', framing: 'head and shoulders', headDirection: 'exactly 90-degree profile' },
    checks: ['exactly one person', 'pure 90-degree profile', 'nose jaw ear and hair silhouette are readable', 'identity exactly follows the identityDefinition and the declared identity input bindings in this request']
  },
  {
    slot: 'bottom_left', suffix: 'front-wardrobe', profileId: 'character_front_wardrobe_no_head_v1',
    responsibility: 'enlarged front wardrobe, body proportions, garment structure, hands, legs and shoes',
    composition: { view: 'front enlarged wardrobe view', framing: 'from below the neck through both shoes', headDirection: 'entire head outside the frame' },
    checks: ['exactly one body', 'entire head is outside the frame', 'both hands legs and shoes are complete', 'wardrobe materials and structure match the contract']
  },
  {
    slot: 'bottom_right', suffix: 'full-back', profileId: 'character_full_body_back_v1',
    responsibility: 'full back identity silhouette, back hair, back wardrobe structure and complete shoes',
    composition: { view: 'full-body back view', framing: 'entire head through both shoes', headDirection: 'back to camera' },
    checks: ['exactly one person', 'complete back full body inside frame', 'back hair wardrobe and shoes are readable', 'body proportions and wardrobe exactly follow the complete contracts declared in this request']
  },
  {
    slot: 'standalone', suffix: 'front-full-body', profileId: 'character_front_full_body_v2',
    responsibility: 'front full-body identity silhouette, body proportions, complete head, wardrobe, hands, legs and shoes',
    composition: { view: 'front full-body identity view', framing: 'entire head through both shoes', headDirection: 'front or the approved Shot-facing angle' },
    checks: ['exactly one person', 'complete head, hands, legs and shoes inside frame', 'identity, body proportions and wardrobe match the character contract']
  }
]);

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function characterSubject(board) {
  for (const field of ['characterId', 'tag', 'identityDefinition', 'wardrobe', 'bodyProportions']) string(board[field], field);
  return {
    characterId: board.characterId,
    tag: board.tag,
    identityDefinition: board.identityDefinition,
    wardrobe: board.wardrobe,
    bodyProportions: board.bodyProportions,
    position: 'single subject centered in a neutral studio',
    action: 'stable reference pose only',
    expression: 'neutral and observable',
    constraint: 'the generated subject exactly follows the identity, wardrobe and body-proportion contracts and declared input roles contained in this request'
  };
}

export function buildCharacterBoardIrs(board, defaults) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) throw new TypeError('character board input must be an object');
  for (const field of ['projectId', 'assetId', 'characterId', 'purpose']) string(board[field], field);
  if (!Array.isArray(board.inputBindings)) throw new TypeError('character board inputBindings must be an array');
  const subjectContract = characterSubject(board);
  const isStylizedClay = board.characterMedium === 'stylized_clay';
  if (board.characterMedium !== undefined && !['live_action', 'stylized_clay'].includes(board.characterMedium)) {
    throw new TypeError('characterMedium must be live_action or stylized_clay');
  }
  const photographyContract = board.photographyContract ?? (isStylizedClay ? {
    background: 'clean warm-neutral seamless clay studio',
    lighting: 'consistent soft three-point studio lighting with one fixed key direction, readable volume shadows and grounded contact shadows',
    realism: 'high-resolution handcrafted stop-motion clay character reference; matte clay surfaces with subtle sculpting fingerprints; unmistakably non-human and without pores'
  } : {
    background: 'clean neutral gray seamless studio',
    lighting: 'consistent three-point studio lighting with soft key, fill and rim light',
    realism: 'high-resolution live-action casting reference photography with natural skin and physical materials'
  });
  const coverageDriven = board.coveragePlan !== undefined;
  if (coverageDriven && (board.coveragePlan?.kind !== 'character_shot_coverage_v1'
    || board.coveragePlan.characterId !== board.characterId
    || !Array.isArray(board.coveragePlan.requiredProfileIds)
    || board.coveragePlan.requiredProfileIds.length === 0)) {
    throw new Error('coverage-driven character assets require a matching non-empty character_shot_coverage_v1');
  }
  const selectedSlots = coverageDriven
    ? board.coveragePlan.requiredProfileIds.map(profileId => {
        const slot = CHARACTER_SLOTS.find(candidate => candidate.profileId === profileId);
        if (!slot) throw new Error(`unsupported character coverage profile: ${profileId}`);
        return slot;
      })
    : CHARACTER_SLOTS.filter(slot => slot.slot !== 'standalone');
  return selectedSlots.map(slot => ({
    schemaVersion: 1,
    id: `ir-${board.assetId}-${slot.suffix}-v1`,
    projectId: board.projectId,
    segmentId: null,
    assetId: board.assetId,
    atomicAssetId: `${board.assetId}-${slot.suffix}-v1`,
    assetType: coverageDriven ? 'character_identity_pack_v2' : 'character_board',
    profileId: slot.profileId,
    operation: board.inputBindings.length > 0 ? 'edit' : 'create',
    purpose: coverageDriven
      ? `${board.purpose}; this atomic output satisfies only the approved ${slot.profileId} Shot coverage requirement`
      : `${board.purpose}; this output fills the ${slot.slot} slot of the final four-panel character board`,
    responsibility: slot.responsibility,
    mustNotControl: ['story scene', 'story action', 'camera movement', 'product appearance', 'final video color grade', 'final board typography'],
    templateSource: `knowledge/image-profiles/character-board.md#${slot.profileId}`,
    skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-characters'],
    selfContainedContextVersion: '1.0',
    visualStyleContract: structuredClone(defaults.visualStyleContract),
    inputBindings: structuredClone(board.inputBindings),
    subjectContract: {
      ...structuredClone(subjectContract),
      characterMedium: isStylizedClay
        ? 'original non-real stop-motion clay figure with matte sculpted surfaces and subtle hand-made fingerprints'
        : 'live-action human casting reference'
    },
    compositionContract: { ...slot.composition, slot: slot.slot, subjectCount: 1 },
    photographyContract: structuredClone(photographyContract),
    preserve: board.inputBindings.length > 0 ? ['identity definition', 'wardrobe design', 'body proportions'] : [],
    ...(board.inputBindings.length > 0 ? {
      editScope: {
        mode: 'reference_derivation',
        change: `derive only the ${slot.slot} atomic character view from the declared identity input`,
        continuityAfterChange: 'keep the declared identity definition, wardrobe design and body proportions stable outside the atomic view framing'
      }
    } : {}),
    constraints: [
      'show only one independent character',
      'exactly follow the identity, wardrobe and body-proportion contracts and declared input roles contained in this request',
      'all body parts required by this slot must remain inside this slot',
      ...(isStylizedClay ? ['the subject must remain unmistakably a non-real handcrafted clay figure in every visible surface'] : []),
      'no text, logo, watermark, UI, border, collage or extra panel'
    ],
    avoid: [
      'duplicate person', 'cast composite', 'cropped required hands or shoes', 'changed face', 'changed wardrobe',
      ...(isStylizedClay
        ? ['real human skin', 'pores', 'photoreal human', 'glossy plastic toy', 'cheap CGI']
        : ['plastic skin', 'cheap CGI']),
      'story background'
    ],
    acceptanceChecks: [
      ...slot.checks.filter(check => !(isStylizedClay && check.includes('real skin texture'))),
      ...(isStylizedClay ? ['all visible face and body surfaces read as matte handcrafted clay with subtle sculpting fingerprints and no human pores'] : []),
      coverageDriven
        ? 'the image contains one view only and is ready to enter the coverage-driven identity pack without forced collage composition'
        : 'the image contains one view only and is ready for deterministic four-panel composition'
    ],
    outputSpec: structuredClone(board.atomicOutputSpec ?? { aspectRatio: '4:3', quality: 'high', background: 'neutral gray' }),
    executionProfile: defaults.modelProfile.id,
    count: 1,
    autoRetry: false,
    modelFallbackPlan: [...(board.modelFallbackPlan ?? [])]
  }));
}

function categoryFor(ir) {
  if (ir.assetType === 'director_view_proxy') return 'blocking';
  if (ir.assetType.includes('character')) return 'character';
  if (ir.assetType.includes('scene')) return 'scene';
  if (ir.assetType.includes('prop')) return 'prop';
  if (ir.assetType.includes('product')) return 'product';
  if (ir.assetType.includes('blocking')) return 'blocking';
  if (ir.assetType.includes('storyboard')) return 'storyboard';
  if (ir.assetType.includes('color')) return 'color';
  return 'other';
}

function subjectKeyFor(ir) {
  return ir.subjectContract.characterId ?? ir.subjectContract.sceneId ?? ir.subjectContract.propId ?? ir.subjectContract.productId ?? ir.subjectContract.shotId ?? ir.assetId;
}

function routedAssetType(assetType) {
  if (assetType === 'storyboard_sheet' || assetType === 'storyboard_panel_repair' || assetType === 'storyboard_execution_panel') return 'storyboard';
  if (assetType === 'mannequin_frame') return 'mannequin_grid';
  if (assetType === 'scene_multiview_v1') return 'scene_multiview';
  if (assetType === 'story_prop_v1') return 'story_prop';
  return assetType;
}

function sourceExecutionBinding(input, capabilityManifest) {
  const expected = capabilityManifest?.executionSourceContract;
  if (!expected) return null;
  const binding = input.sourceExecutionBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('image prompt plan must bind the verified execution-safe source contract');
  }
  if (binding.authority !== 'executionSafeActionLedger_only'
    || binding.fingerprintSha256 !== expected.fingerprintSha256) {
    throw new Error('image prompt plan sourceExecutionBinding must match the verified execution-safe source contract');
  }
  return {
    authority: expected.authority,
    fingerprintSha256: expected.fingerprintSha256
  };
}

export function buildImagePromptPlan(input, modelProfile, { capabilityManifest = null, satisfiedAssetTypes = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('image prompt plan input must be an object');
  for (const field of ['id', 'projectId']) string(input[field], field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.id)) throw new TypeError('id must be a safe identifier');
  if (!Array.isArray(input.characterBoards) || !Array.isArray(input.promptIrs)) throw new TypeError('characterBoards and promptIrs must be arrays');
  const planScope = input.planScope ?? 'project_and_segments';
  if (!['project_only', 'project_and_segments', 'staged_project_batch'].includes(planScope)) {
    throw new TypeError('planScope must be project_only, project_and_segments, or staged_project_batch');
  }
  if (planScope === 'staged_project_batch') {
    if (!Array.isArray(input.deferredAssetTypes) || input.deferredAssetTypes.length === 0) {
      throw new TypeError('staged_project_batch requires a non-empty deferredAssetTypes array');
    }
    if (new Set(input.deferredAssetTypes).size !== input.deferredAssetTypes.length
      || input.deferredAssetTypes.some(type => typeof type !== 'string' || type.trim() === '')) {
      throw new TypeError('deferredAssetTypes must contain unique non-empty strings');
    }
    const lifecycle = input.remainingAssetLifecycle;
    if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
      throw new TypeError('staged_project_batch requires remainingAssetLifecycle');
    }
    for (const field of ['deferredGeneratedAssetTypes', 'deferredDeterministicAssetTypes', 'existingAssetsPendingGate3Lock']) {
      if (!Array.isArray(lifecycle[field])) throw new TypeError(`remainingAssetLifecycle.${field} must be an array`);
    }
    for (const field of ['deferredGeneratedAssetTypes', 'deferredDeterministicAssetTypes']) {
      if (new Set(lifecycle[field]).size !== lifecycle[field].length
        || lifecycle[field].some(type => typeof type !== 'string' || type.trim() === '')) {
        throw new TypeError(`remainingAssetLifecycle.${field} must contain unique non-empty strings`);
      }
    }
    const generatedDeferred = new Set(lifecycle.deferredGeneratedAssetTypes);
    const missingProjectDeferrals = input.deferredAssetTypes.filter(type => !generatedDeferred.has(type));
    if (missingProjectDeferrals.length > 0) {
      throw new TypeError(`remainingAssetLifecycle.deferredGeneratedAssetTypes must include deferredAssetTypes: ${missingProjectDeferrals.join(', ')}`);
    }
    for (const asset of lifecycle.existingAssetsPendingGate3Lock) {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new TypeError('existingAssetsPendingGate3Lock entries must be objects');
      for (const field of ['assetType', 'assetId', 'sha256']) string(asset[field], `existingAssetsPendingGate3Lock.${field}`);
      if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new TypeError('existingAssetsPendingGate3Lock.sha256 must be lowercase sha256');
    }
    if (lifecycle.stageCompletionClaim !== 'anchor_inputs_only_not_gate3_complete') {
      throw new TypeError('remainingAssetLifecycle.stageCompletionClaim must be anchor_inputs_only_not_gate3_complete');
    }
  } else if (input.deferredAssetTypes !== undefined) {
    throw new TypeError('deferredAssetTypes is only valid for staged_project_batch');
  } else if (input.remainingAssetLifecycle !== undefined) {
    throw new TypeError('remainingAssetLifecycle is only valid for staged_project_batch');
  }
  if (input.storyboardSheets !== undefined && !Array.isArray(input.storyboardSheets)) throw new TypeError('storyboardSheets must be an array');
  if (input.storyboardRepairs !== undefined && !Array.isArray(input.storyboardRepairs)) throw new TypeError('storyboardRepairs must be an array');
  if (input.storyboardExecutionPanels !== undefined && !Array.isArray(input.storyboardExecutionPanels)) throw new TypeError('storyboardExecutionPanels must be an array');
  if (input.sceneMultiviews !== undefined && !Array.isArray(input.sceneMultiviews)) throw new TypeError('sceneMultiviews must be an array');
  if (input.storyProps !== undefined && !Array.isArray(input.storyProps)) throw new TypeError('storyProps must be an array');
  if (input.directorViewProxies !== undefined && !Array.isArray(input.directorViewProxies)) throw new TypeError('directorViewProxies must be an array');
  if (input.mannequinSequences !== undefined && !Array.isArray(input.mannequinSequences)) throw new TypeError('mannequinSequences must be an array');
  const safeSourceBinding = sourceExecutionBinding(input, capabilityManifest);
  const irs = [
    ...input.characterBoards.flatMap(board => buildCharacterBoardIrs(board, { visualStyleContract: input.visualStyleContract, modelProfile })),
    ...(input.sceneMultiviews ?? []).flatMap(scene => buildSceneMultiviewIrs(scene, { visualStyleContract: input.visualStyleContract, modelProfile })),
    ...(input.storyProps ?? []).flatMap(prop => buildStoryPropIrs(prop, { visualStyleContract: input.visualStyleContract, modelProfile })),
    ...(input.directorViewProxies ?? []).map(proxy => buildDirectorViewProxyIr(proxy, { visualStyleContract: input.visualStyleContract, modelProfile })),
    ...(input.mannequinSequences ?? []).flatMap(sequence => buildMannequinFrameIrs(sequence, { visualStyleContract: input.visualStyleContract, modelProfile })),
    ...(input.storyboardSheets ?? []).map(sheet => buildStoryboardSheetIr(sheet, { visualStyleContract: input.visualStyleContract, modelProfile })),
    ...(input.storyboardRepairs ?? []).map(repair => buildStoryboardPanelRepairIr(repair, { visualStyleContract: input.visualStyleContract, modelProfile })),
    ...(input.storyboardExecutionPanels ?? []).flatMap(sequence => buildStoryboardExecutionPanelIrs(sequence, { visualStyleContract: input.visualStyleContract, modelProfile })),
    // A mixed control batch can contain text-light overhead diagrams and
    // textless atomic story frames.  Each request must retain its explicit
    // contract rather than inheriting an incompatible sheet-wide contract.
    ...input.promptIrs.map(ir => ({
      ...structuredClone(ir),
      visualStyleContract: structuredClone(ir.visualStyleContract ?? input.visualStyleContract),
      executionProfile: modelProfile.id
    }))
  ];
  if (irs.length === 0) throw new TypeError('image prompt plan requires at least one image task');
  const tasks = irs.map(ir => {
    const request = compileImagePrompt(ir, modelProfile);
    const category = categoryFor(ir);
    const subjectKey = subjectKeyFor(ir);
    return {
      id: request.id,
      category,
      subjectKey,
      workerRole: `${category}_image_worker`,
      dependencies: [...(ir.dependencies ?? [])],
      request
    };
  });
  const plan = {
    id: input.id,
    kind: 'compiled_image_prompt_plan',
    projectId: input.projectId,
    planScope,
    executionMode: input.executionMode ?? 'parallel',
    ...(planScope === 'staged_project_batch' ? {
      deferredAssetTypes: [...input.deferredAssetTypes],
      remainingAssetLifecycle: structuredClone(input.remainingAssetLifecycle)
    } : {}),
    requests: tasks.map(task => task.request),
    dispatch: planParallelImageTasks(tasks, {
      executionMode: input.executionMode ?? 'parallel',
      maxConcurrency: input.maxConcurrency ?? 8
    }),
    ...(capabilityManifest ? {
      capabilityBinding: {
        id: capabilityManifest.id,
        storyPlanId: capabilityManifest.storyPlanId,
        storyPlanSha256: capabilityManifest.storyPlanSha256,
        routeVersion: capabilityManifest.routeVersion
      }
    } : {}),
    ...(safeSourceBinding ? { sourceExecutionBinding: safeSourceBinding } : {})
  };
  if (capabilityManifest) {
    if (input.capabilityManifestId !== capabilityManifest.id) throw new Error(`image prompt plan must bind capability manifest ${capabilityManifest.id}`);
    const targetSegments = ['project_only', 'staged_project_batch'].includes(planScope)
      ? []
      : Array.isArray(input.segmentIds) && input.segmentIds.length > 0
        ? input.segmentIds
        : Object.keys(capabilityManifest.requiredAssetsBySegment);
    const planned = new Set(tasks.map(task => routedAssetType(task.request.assetType)));
    const available = new Set([...planned, ...satisfiedAssetTypes]);
    const deferred = new Set(planScope === 'staged_project_batch' ? input.deferredAssetTypes : []);
    const unknownDeferredAssets = [...deferred].filter(type => !(capabilityManifest.projectRequiredAssets ?? []).includes(type));
    if (unknownDeferredAssets.length > 0) throw new Error(`image prompt plan defers assets outside the director-required project scope: ${unknownDeferredAssets.join(', ')}`);
    const missingProjectAssets = (capabilityManifest.projectRequiredAssets ?? []).filter(type => !available.has(type) && !deferred.has(type));
    if (missingProjectAssets.length > 0) throw new Error(`image prompt plan is missing director-required project assets: ${missingProjectAssets.join(', ')}`);
    if (planScope === 'staged_project_batch') {
      const alreadyAvailableDeferred = [...deferred].filter(type => available.has(type));
      if (alreadyAvailableDeferred.length > 0) throw new Error(`image prompt plan cannot defer already planned or satisfied assets: ${alreadyAvailableDeferred.join(', ')}`);
    }
    for (const segmentId of targetSegments) {
      const required = capabilityManifest.requiredAssetsBySegment[segmentId];
      if (!Array.isArray(required)) throw new Error(`capability manifest has no asset route for ${segmentId}`);
      const missing = required.filter(type => !available.has(type));
      if (missing.length > 0) throw new Error(`image prompt plan is missing director-required assets for ${segmentId}: ${missing.join(', ')}`);
    }
  }
  return {
    ...plan,
    planFingerprint: createHash('sha256').update(canonicalJson(plan)).digest('hex')
  };
}
