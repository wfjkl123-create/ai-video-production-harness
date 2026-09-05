import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { assertQualityRubric } from '../domain/quality-review.js';
import { assertProjectState } from '../domain/project-state.js';
import { readJson } from '../storage/json-store.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { withProjectLock } from '../storage/project-lock.js';
import { verifyLockedArtifact } from './artifact-file-service.js';
import { verifyAssetManifestEvidence } from './asset-manifest-evidence-service.js';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';
import { assertRequiredBindings, assertRequiredBindingsSatisfied, deriveRequiredBindingsFromAssets } from '../domain/realism-contracts.js';
import { assertAudioExecutionPlan } from '../domain/audio-execution-plan.js';
import { currentArtifactsOf } from '../domain/current-artifact.js';

const REALISM_AUTHORITY_ARTIFACT_TYPES = new Set([
  'character_acting_master', 'character_story_state', 'voice_identity', 'scene_geometry', 'handoff_reconciliation'
]);

const STRATEGIES = new Set(['refine', 'pivot', 'escalate']);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function textArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  value.forEach((item, index) => text(item, `${field}[${index}]`));
}

function attemptLimit(value, field) {
  if (value !== null && (!Number.isInteger(value) || value < 1)) throw new TypeError(`${field} must be null or a positive integer`);
}

export async function createSegmentContract(root, input) {
  // Transaction entries are relative to the project root. Normalise callers
  // here so a relative root cannot be joined twice during the commit.
  root = resolve(root);
  for (const field of ['id', 'segmentId', 'rubricId']) text(input?.[field], field);
  if (!Number.isInteger(input.revision) || input.revision < 1) throw new TypeError('revision must be a positive integer');
  textArray(input.immutableConstraints, 'immutableConstraints');
  textArray(input.allowedStrategies, 'allowedStrategies');
  textArray(input.completionEvidence, 'completionEvidence');
  for (const strategy of input.allowedStrategies) if (!STRATEGIES.has(strategy)) throw new TypeError(`unknown strategy: ${strategy}`);
  if (!input.attemptPolicy || input.attemptPolicy.automaticPaidRetries !== false) throw new Error('automatic paid retries must remain disabled');
  attemptLimit(input.attemptPolicy.maxPaidAttempts, 'maxPaidAttempts');
  attemptLimit(input.attemptPolicy.maxAssetAttempts, 'maxAssetAttempts');
  if (!input.assetResponsibilities || typeof input.assetResponsibilities !== 'object' || Array.isArray(input.assetResponsibilities)) {
    throw new TypeError('assetResponsibilities must be an object');
  }

  const state = await readJson(join(root, 'project-state.json'));
  const strictVideoGovernance = state.videoGovernanceVersion === 2;
  const strictRealismContracts = state.realismContractsVersion === 2;
  if (strictVideoGovernance && input.executionControl === undefined) {
    throw new Error('workflow v2 video projects require an executionControl contract before Gate 3/4');
  }
  const executionControl = input.executionControl === undefined
    ? null
    : structuredClone(assertExecutionControlContract(input.executionControl));
  if (strictRealismContracts && input.audioExecutionPlan === undefined) {
    throw new Error('realism contracts v2 require an audioExecutionPlan before the segment contract enters review');
  }
  const audioExecutionPlan = input.audioExecutionPlan === undefined
    ? null
    : structuredClone(assertAudioExecutionPlan(input.audioExecutionPlan));
  const segmentation = currentArtifactsOf(state.artifacts, artifact => artifact.type === 'segmentation' && artifact.status === 'locked')
    .sort((left, right) => right.revision - left.revision)[0];
  if (!segmentation) throw new Error('locked segmentation is required');
  await verifyLockedArtifact(root, segmentation);
  const canonical = await readJson(join(root, segmentation.path));
  const segment = canonical.segments?.find(({ id }) => id === input.segmentId);
  if (!segment || segment.status !== 'locked') throw new Error('locked canonical segment is required');

  const assetManifestPath = `assets/${input.segmentId}-asset-manifest.json`;
  let assetManifest = null;
  let assetManifestEvidence = null;
  try {
    const candidate = await readJson(join(root, assetManifestPath));
    // A manifest may remain locked as historical evidence after the director
    // replaces the canonical segmentation.  It must never be silently reused
    // by a contract for the newer cut: its own segmentation binding has to
    // match the currently locked segmentation exactly.
    const sourceSegmentationId = candidate?.sourceArtifactIds?.segmentation;
    const segmentItemsMatchCurrentSegmentation = Array.isArray(candidate?.items)
      && candidate.items
        .filter(item => item.scope === 'segment')
        .every(item => item.segmentationId === segmentation.id && item.segmentationSha256 === segmentation.sha256);
    if (
      candidate?.status === 'locked'
      && candidate.segmentId === input.segmentId
      && sourceSegmentationId === segmentation.id
      && segmentItemsMatchCurrentSegmentation
    ) {
      assetManifestEvidence = await verifyAssetManifestEvidence(root, state, candidate, assetManifestPath);
      assetManifest = candidate;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const reviewedInputIds = assetManifest
    ? assetManifest.items.map(item => item.id)
    : (segment.projectAssetIds ?? []);
  const manifestCharacterIds = new Set((assetManifest?.items ?? [])
    .map(item => item.characterId).filter(Boolean));
  const manifestSceneIds = new Set((assetManifest?.items ?? [])
    .map(item => item.sceneId).filter(Boolean));
  if (segment.sceneId) manifestSceneIds.add(segment.sceneId);
  const currentAuthority = currentArtifactsOf(state.artifacts, artifact => artifact.status === 'locked'
    && REALISM_AUTHORITY_ARTIFACT_TYPES.has(artifact.type));
  let requiredMasterCharacterIds = new Set();
  let requiredVoiceCharacterIds = new Set();
  if (strictRealismContracts) {
    const storyPlans = currentArtifactsOf(state.artifacts, artifact => artifact.type === 'story_plan' && artifact.status === 'locked');
    if (storyPlans.length !== 1) throw new Error('realism contracts v2 require exactly one current locked Story Plan before a segment contract');
    await verifyLockedArtifact(root, storyPlans[0]);
    const storyPlan = await readJson(join(root, storyPlans[0].path));
    const allCharacters = (storyPlan.characters ?? []).map(character => character.characterId);
    const allShots = storyPlan.shotPlanning?.mode === 'shotlist' ? (storyPlan.shotPlanning.shots ?? []) : [];
    const segmentShots = storyPlan.shotPlanning?.mode === 'shotlist'
      ? allShots.filter(shot => shot.segmentId === input.segmentId)
      : [{ characterIds: allCharacters, visibleSpeakerIds: [] }];
    const segmentCharacters = new Set(segmentShots.flatMap(shot => shot.visibleCharacterIds ?? shot.characterIds ?? []));
    for (const characterId of segmentCharacters) manifestCharacterIds.add(characterId);
    const authorityReference = ['faithful_remake', 'source_modification'].includes(
      storyPlan.creativeDecision?.referenceWorkflow?.referenceIntent
    );
    requiredMasterCharacterIds = new Set([...segmentCharacters].filter(characterId => authorityReference
      || allShots.filter(shot => (shot.visibleCharacterIds ?? shot.characterIds ?? []).includes(characterId)).length > 1));
    const audioNeedsVoiceIdentity = !['preserve_source_audio_exact', 'silent_visual_test'].includes(audioExecutionPlan?.strategy);
    if (audioNeedsVoiceIdentity) {
      requiredVoiceCharacterIds = new Set(segmentShots.flatMap(shot => shot.visibleSpeakerIds ?? []));
    }
  }
  let authorityArtifacts;
  if (input.authorityArtifactIds !== undefined) {
    if (!Array.isArray(input.authorityArtifactIds) || new Set(input.authorityArtifactIds).size !== input.authorityArtifactIds.length) {
      throw new TypeError('authorityArtifactIds must be an array of unique artifact IDs');
    }
    const byId = new Map(currentAuthority.map(artifact => [artifact.id, artifact]));
    authorityArtifacts = input.authorityArtifactIds.map(id => {
      text(id, 'authorityArtifactIds entry');
      const artifact = byId.get(id);
      if (!artifact) throw new Error(`authorityArtifactIds must reference current locked realism authority: ${id}`);
      return artifact;
    });
  } else {
    authorityArtifacts = currentAuthority.filter(artifact => {
      if (artifact.type === 'handoff_reconciliation') return artifact.segmentId === input.segmentId;
      if (artifact.type === 'scene_geometry') return manifestSceneIds.has(artifact.sceneId);
      if (artifact.type === 'character_story_state') {
        return artifact.scopeKey === input.segmentId || manifestCharacterIds.has(artifact.characterId);
      }
      return manifestCharacterIds.has(artifact.characterId);
    });
  }
  for (const characterId of requiredMasterCharacterIds) {
    const matches = authorityArtifacts.filter(artifact => artifact.type === 'character_acting_master' && artifact.characterId === characterId);
    if (matches.length !== 1) throw new Error(`realism contracts v2 require one current locked Master Profile for reusable or replicated character ${characterId}`);
  }
  for (const characterId of requiredVoiceCharacterIds) {
    const matches = authorityArtifacts.filter(artifact => artifact.type === 'voice_identity' && artifact.characterId === characterId);
    if (matches.length !== 1) throw new Error(`realism contracts v2 require one current locked Voice Identity for visible speaker ${characterId}`);
  }
  const requiresHandoffReconciliation = strictRealismContracts
    && segment.previousSegmentId
    && !['canonical_open', 'editorial_cut'].includes(segment.continuityStrategy);
  if (requiresHandoffReconciliation && !authorityArtifacts.some(artifact => artifact.type === 'handoff_reconciliation')) {
    throw new Error(`realism contracts v2 require a locked PASS handoff reconciliation for ${input.segmentId}`);
  }
  const inputIds = [...new Set([...reviewedInputIds, ...authorityArtifacts.map(item => item.id), input.rubricId])];
  const lockedInputs = [];
  let rubric;
  for (const id of inputIds) {
    const artifact = state.artifacts.find(item => item.id === id);
    if (!artifact || artifact.status !== 'locked') throw new Error(`locked input is required: ${id}`);
    const inspected = await verifyLockedArtifact(root, artifact);
    lockedInputs.push({ id: artifact.id, type: artifact.type, revision: artifact.revision, sha256: inspected.sha256 });
    if (id === input.rubricId) {
      if (artifact.type !== 'quality_rubric') throw new Error('rubricId must reference a quality_rubric');
      rubric = assertQualityRubric(await readJson(join(root, artifact.path)));
      if (rubric.id !== artifact.id) {
        throw new Error(`quality rubric payload id ${rubric.id} must match artifact id ${artifact.id}`);
      }
      if (strictVideoGovernance && rubric.version < 2) {
        throw new Error('workflow v2 video projects require quality rubric version 2 with observable evidence anchors');
      }
    }
  }
  for (const id of reviewedInputIds) text(input.assetResponsibilities[id], `assetResponsibilities.${id}`);
  const requiredBindingCandidates = [
    ...(assetManifest?.items ?? state.artifacts.filter(artifact => reviewedInputIds.includes(artifact.id))),
    ...authorityArtifacts
  ];
  const derivedRequiredBindings = deriveRequiredBindingsFromAssets(requiredBindingCandidates, { segmentId: input.segmentId });
  if (input.requiredBindings !== undefined) {
    const supplied = structuredClone(assertRequiredBindings(input.requiredBindings));
    const normalize = contract => contract.entries
      .map(entry => JSON.stringify(entry))
      .sort();
    if (JSON.stringify(normalize(supplied)) !== JSON.stringify(normalize(derivedRequiredBindings))) {
      throw new Error('caller requiredBindings must exactly match the complete server-derived binding set');
    }
  }
  const requiredBindings = derivedRequiredBindings;
  assertRequiredBindingsSatisfied(requiredBindings, currentArtifactsOf(state.artifacts));

  const contract = {
    id: input.id,
    segmentId: input.segmentId,
    revision: input.revision,
    status: 'awaiting_review',
    segmentation: {
      id: segmentation.id,
      revision: segmentation.revision,
      sha256: segmentation.sha256
    },
    narrativeTask: segment.narrativeTask,
    immutableConstraints: [...input.immutableConstraints],
    expectedStartState: segment.startState,
    expectedEndState: segment.endState,
    actionNodes: [...(segment.actionNodes ?? [])],
    segmentAssetRequirements: assetManifest
      ? [...new Set(assetManifest.items.map(item => item.type))]
      : [...(segment.segmentAssetRequirements ?? [])],
    assetResponsibilities: structuredClone(input.assetResponsibilities),
    lockedInputs,
    requiredBindings,
    ...(audioExecutionPlan ? { audioExecutionPlan } : {}),
    ...(assetManifest ? {
      assetManifest: {
        id: assetManifest.id,
        path: assetManifestPath,
        sha256: assetManifestEvidence.manifestSha256,
        lockedByReviewId: assetManifestEvidence.reviewId
      }
    } : {}),
    rubric: { id: rubric.id, version: rubric.version, threshold: rubric.threshold, sha256: lockedInputs.find(({ id }) => id === rubric.id).sha256 },
    ...(executionControl ? { executionControl } : {}),
    allowedStrategies: [...new Set(input.allowedStrategies)],
    attemptPolicy: structuredClone(input.attemptPolicy),
    completionEvidence: [...input.completionEvidence]
  };
  const path = `segments/${input.segmentId}-contract-v${input.revision}.json`;
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const current = assertProjectState(await readJson(join(root, 'project-state.json')));
    if (current.artifacts.some(artifact => artifact.id === input.id || artifact.path === path)) {
      throw new Error(`segment contract already exists: ${input.id}`);
    }
    const currentArtifacts = currentArtifactsOf(current.artifacts);
    const currentById = new Map(currentArtifacts.map(artifact => [artifact.id, artifact]));
    const currentSegmentation = currentById.get(segmentation.id);
    if (!currentSegmentation || currentSegmentation.type !== 'segmentation'
      || currentSegmentation.status !== 'locked'
      || currentSegmentation.revision !== segmentation.revision
      || currentSegmentation.sha256 !== segmentation.sha256) {
      throw new Error('locked segmentation changed before contract publication');
    }
    await verifyLockedArtifact(root, currentSegmentation);
    for (const lockedInput of lockedInputs) {
      const artifact = currentById.get(lockedInput.id);
      if (!artifact || (await verifyLockedArtifact(root, artifact)).sha256 !== lockedInput.sha256) {
        throw new Error(`locked input changed before contract publication: ${lockedInput.id}`);
      }
      if (artifact.status !== 'locked' || artifact.revision !== lockedInput.revision) {
        throw new Error(`locked input changed before contract publication: ${lockedInput.id}`);
      }
    }
    const currentAuthorityArtifacts = authorityArtifacts.map(artifact => {
      const currentArtifact = currentById.get(artifact.id);
      if (!currentArtifact || currentArtifact.status !== 'locked'
        || currentArtifact.revision !== artifact.revision
        || currentArtifact.sha256 !== artifact.sha256) {
        throw new Error(`realism authority changed before contract publication: ${artifact.id}`);
      }
      return currentArtifact;
    });
    const currentRequiredBindingCandidates = [
      ...(assetManifest?.items ?? reviewedInputIds.map(id => currentById.get(id)).filter(Boolean)),
      ...currentAuthorityArtifacts
    ];
    const currentRequiredBindings = deriveRequiredBindingsFromAssets(currentRequiredBindingCandidates, { segmentId: input.segmentId });
    const normalizedBindingEntries = bindingContract => bindingContract.entries
      .map(entry => JSON.stringify(entry))
      .sort();
    if (JSON.stringify(normalizedBindingEntries(currentRequiredBindings))
      !== JSON.stringify(normalizedBindingEntries(contract.requiredBindings))) {
      throw new Error('required bindings changed before contract publication');
    }
    assertRequiredBindingsSatisfied(currentRequiredBindings, currentArtifacts);
    const sha256 = createHash('sha256').update(`${JSON.stringify(contract, null, 2)}\n`).digest('hex');
    const artifact = {
      id: input.id, type: 'segment_contract', segmentId: input.segmentId,
      revision: input.revision, status: 'awaiting_review', path, sha256
    };
    current.artifacts.push(artifact);
    current.updatedAt = new Date().toISOString();
    assertProjectState(current);
    await commitJsonTransaction(root, `segment-contract-${input.id}`, [
      { path: join(root, path), value: contract },
      { path: join(root, 'project-state.json'), value: current }
    ]);
    return artifact;
  });
}
