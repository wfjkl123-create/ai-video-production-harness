import { currentArtifactsOf } from '../domain/current-artifact.js';

const CONTRACT_VERSION = 'harness-30-60-studio-projection-v2';
const EXACT_CONTRACT_VERSION = 'harness-30-60-contract-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BLOCKING_JOB_STATUSES = new Set([
  'QUEUED',
  'RUNNING',
  'PAUSED_REQUIRES_CONFIRMATION',
  'NEEDS_RECONCILIATION'
]);
const MEDIA_TAG = Object.freeze({ image: /^@图[1-9][0-9]*$/u, video: /^@视频[1-9][0-9]*$/u, audio: /^@音频[1-9][0-9]*$/u });

const CONTRACT_IDS = Object.freeze([
  'narrative_block',
  'generation_unit',
  'asset_ledger',
  'prompt_package',
  'review_decision',
  'failure_return',
  'final_edit_manifest'
]);

function latestArtifact(artifacts, type) {
  return artifacts
    .filter(item => item?.type === type)
    .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0)
      || String(right.id ?? '').localeCompare(String(left.id ?? '')))[0] ?? null;
}

function exactContract(artifacts, type) {
  const artifact = latestArtifact(artifacts, type);
  const verified = artifact
    && artifact.status === 'locked'
    && artifact.contractVersion === EXACT_CONTRACT_VERSION
    && Number.isInteger(artifact.schemaVersion) && artifact.schemaVersion >= 1
    && artifact.validationStatus === 'PASS'
    && artifact.current === true
    && SHA256.test(artifact.sha256 ?? '');
  return verified ? {
    id: type,
    evidenceMode: 'exact_contract',
    artifactId: artifact.id,
    artifactSha256: artifact.sha256 ?? null,
    status: artifact.status ?? 'draft'
  } : null;
}

function compatibilityContract(id, observed, evidence = {}) {
  return {
    id,
    evidenceMode: observed ? 'legacy_mapping' : 'not_observed',
    artifactId: null,
    artifactSha256: null,
    status: observed ? 'mapped_not_migrated' : 'not_registered',
    ...evidence
  };
}

function routeKind(routeDecision) {
  if (routeDecision?.referenceRoleStatus === 'authority') return 'remake';
  if (['inspiration', 'not_applicable'].includes(routeDecision?.referenceRoleStatus)) return 'original';
  return 'unresolved';
}

function observedUnitIds(artifacts, runs) {
  const observed = new Set();
  const videos = artifacts.filter(item => item?.type === 'video_segment' && item.status === 'locked'
    && item.segmentId && item.path && SHA256.test(item.sha256 ?? ''));
  for (const segmentId of new Set(videos.map(video => video.segmentId))) {
    const segmentVideos = videos.filter(video => video.segmentId === segmentId);
    if (segmentVideos.length !== 1) continue;
    const [video] = segmentVideos;
    const matches = runs.filter(run => ['libtv_video', 'runninghub_video'].includes(run?.kind)
      && run.status === 'SUCCESS'
      && run.segmentId === video.segmentId
      && SAFE_TASK_ID.test(run.taskId ?? '')
      && SHA256.test(run.fingerprint?.sha256 ?? '')
      && Array.isArray(run.outputs)
      && run.outputs.filter(output => output.path === video.path && output.sha256 === video.sha256).length === 1);
    if (matches.length === 1) observed.add(video.segmentId);
  }
  return observed;
}

function verifiedDeliveryBinding(state, artifacts, deliveryReceipt) {
  if (!deliveryReceipt || deliveryReceipt.status !== 'COMPLETE'
    || deliveryReceipt.projectId !== state.projectId
    || state.phase !== 'archived'
    || !SHA256.test(deliveryReceipt.deliveryFingerprint ?? '')
    || !deliveryReceipt.finalEdit) return null;
  const finalEdit = artifacts.find(item => item.id === deliveryReceipt.finalEdit.artifactId
    && item.type === 'final_edit'
    && item.status === 'locked'
    && item.sha256 === deliveryReceipt.finalEdit.sha256
    && item.path === deliveryReceipt.finalEdit.path);
  return finalEdit ?? null;
}

function decisionProjection({ state, production, lockedFinalEdit, verifiedFinalDelivery }) {
  const artifacts = state.artifacts ?? [];
  const creative = latestArtifact(artifacts, 'creative_brief');
  const generationReady = production.length > 0 && production.every(item => item.readyForCanvas === true);
  return [
    {
      id: 'creative',
      label: '创意方向确认',
      status: creative?.status === 'locked' ? 'accepted' : creative?.status === 'awaiting_review' ? 'awaiting_user' : 'not_ready'
    },
    {
      id: 'paid_package',
      label: '付费生成包确认',
      status: generationReady ? 'package_ready_not_authorized' : 'not_ready'
    },
    {
      id: 'final_acceptance',
      label: '最终成片接受',
      status: verifiedFinalDelivery ? 'accepted_and_archived' : lockedFinalEdit ? 'awaiting_user' : 'not_ready'
    }
  ];
}

function validProjectedMediaBinding(binding) {
  return binding && typeof binding === 'object' && !Array.isArray(binding)
    && SAFE_TASK_ID.test(binding.id ?? '')
    && ['image', 'video', 'audio'].includes(binding.mediaKind)
    && MEDIA_TAG[binding.mediaKind].test(binding.tag ?? '')
    && binding.semanticToken === `@素材[${binding.id}]`
    && SHA256.test(binding.sha256 ?? '')
    && Array.isArray(binding.controls) && binding.controls.length > 0
    && binding.controls.every(value => typeof value === 'string' && value.trim() !== '')
    && Array.isArray(binding.mustNotControl) && binding.mustNotControl.length > 0
    && binding.mustNotControl.every(value => typeof value === 'string' && value.trim() !== '');
}

function assetIdentityProjection(artifacts, production) {
  const byId = new Map(artifacts.map(item => [item.id, item]));
  let current = [];
  try { current = currentArtifactsOf(artifacts); } catch { current = []; }
  const currentById = new Map(current.map(item => [item.id, item]));
  const descendsFrom = (candidate, ancestorId) => {
    const visited = new Set();
    let cursor = candidate;
    while (cursor?.supersedesArtifactId) {
      if (visited.has(cursor.id)) return false;
      visited.add(cursor.id);
      if (cursor.supersedesArtifactId === ancestorId) return true;
      cursor = byId.get(cursor.supersedesArtifactId);
    }
    return false;
  };
  return production.flatMap(item => (SHA256.test(item.packageEvidence?.packageSha256 ?? '')
    && Array.isArray(item.packageEvidence?.mediaBindings) ? item.packageEvidence.mediaBindings : [])
    .filter(validProjectedMediaBinding)
    .map(binding => {
    const bound = byId.get(binding.id) ?? null;
    const currentArtifact = currentById.get(binding.id)
      ?? current.find(candidate => descendsFrom(candidate, binding.id))
      ?? null;
    const boundDigestMatchesRegistry = bound ? bound.sha256 === binding.sha256 : null;
    const currentBinding = currentArtifact?.id === binding.id && currentArtifact?.sha256 === binding.sha256;
    return {
      segmentId: item.segmentId,
      packageSha256: item.packageEvidence.packageSha256,
      tag: binding.tag,
      semanticToken: binding.semanticToken,
      boundArtifactId: binding.id,
      boundRevision: bound?.revision ?? null,
      boundSha256: binding.sha256,
      digestPrefix: binding.sha256.slice(0, 12),
      currentArtifactId: currentArtifact?.id ?? null,
      currentRevision: currentArtifact?.revision ?? null,
      currentSha256: SHA256.test(currentArtifact?.sha256 ?? '') ? currentArtifact.sha256 : null,
      current: currentBinding,
      state: boundDigestMatchesRegistry === false ? 'registry_digest_mismatch'
        : !bound ? 'package_bound_registry_unobserved'
          : currentBinding ? 'current_package_binding' : currentArtifact ? 'superseded_package_binding' : 'not_current'
    };
    }));
}

function generationSafetyProjection(segments, generationJobs) {
  return segments.map(segment => {
    const jobs = generationJobs.filter(job => (typeof job?.request?.segmentId !== 'string' || job.request.segmentId === segment.id)
      && ['image', 'video'].includes(job.kind)
      && BLOCKING_JOB_STATUSES.has(job.status));
    return {
      segmentId: segment.id,
      retryBlocked: jobs.length > 0,
      blockedKinds: [...new Set(jobs.map(job => job.kind))],
      jobs: jobs.map(job => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        fingerprintPrefix: SHA256.test(job.fingerprintSha256 ?? '') ? job.fingerprintSha256.slice(0, 12) : null
      }))
    };
  });
}

function statePlaneProjection({ contracts, generationJobs, observedUnits, allPackagesReady, lockedFinalEdit, verifiedFinalDelivery }) {
  const contractValues = Object.values(contracts);
  const contractStatus = contractValues.every(item => item.evidenceMode === 'exact_contract') ? 'verified'
    : contractValues.some(item => item.evidenceMode !== 'not_observed') ? 'legacy_evidence_only' : 'not_ready';
  const activeJobs = generationJobs.filter(job => BLOCKING_JOB_STATUSES.has(job.status));
  let executionStatus = allPackagesReady ? 'packages_ready' : 'planning';
  if (observedUnits.size > 0) executionStatus = 'outputs_observed';
  if (activeJobs.some(job => job.status === 'QUEUED')) executionStatus = 'queued';
  if (activeJobs.some(job => job.status === 'RUNNING')) executionStatus = 'running';
  if (activeJobs.some(job => job.status === 'PAUSED_REQUIRES_CONFIRMATION')) executionStatus = 'paused_requires_reconfirmation';
  if (activeJobs.some(job => job.status === 'NEEDS_RECONCILIATION')) executionStatus = 'submission_uncertain';
  const acceptanceStatus = verifiedFinalDelivery ? 'accepted'
    : lockedFinalEdit ? 'whole_film_waiting_acceptance'
      : observedUnits.size > 0 ? 'unit_outputs_unaccepted' : 'not_ready';
  return {
    contract: { status: contractStatus, exactCount: contractValues.filter(item => item.evidenceMode === 'exact_contract').length, totalCount: contractValues.length },
    execution: { status: executionStatus, retryBlocked: activeJobs.length > 0, activeJobCount: activeJobs.length },
    acceptance: { status: acceptanceStatus, accepted: Boolean(verifiedFinalDelivery) }
  };
}

function factInheritanceProjection(production) {
  const units = production.map(item => {
    const packageEvidence = item.packageEvidence ?? null;
    const requiredBindings = ['segmentContract', 'shotNarration', 'seedancePrompt', 'assetManifest'];
    const bindings = packageEvidence?.governanceBindings ?? {};
    const validMediaBindings = Array.isArray(packageEvidence?.mediaBindings)
      && packageEvidence.mediaBindings.length === packageEvidence.mediaBindingCount
      && packageEvidence.mediaBindings.every(validProjectedMediaBinding);
    const packageBound = SHA256.test(packageEvidence?.packageSha256 ?? '')
      && SHA256.test(packageEvidence?.promptSha256 ?? '')
      && requiredBindings.every(name => bindings[name]?.status === 'locked'
      && SHA256.test(bindings[name]?.sha256 ?? ''))
      && Number.isInteger(packageEvidence?.mediaBindingCount)
      && packageEvidence.mediaBindingCount >= 0
      && validMediaBindings;
    return {
      segmentId: item.segmentId,
      evidenceMode: packageBound ? 'exact_package_governance' : packageEvidence ? 'invalid_package_evidence' : 'not_observed',
      status: packageBound && item.readyForCanvas === true ? 'bound_current_inputs' : packageBound ? 'blocked_before_generation' : 'incomplete',
      packageSha256: SHA256.test(packageEvidence?.packageSha256 ?? '') ? packageEvidence.packageSha256 : null,
      promptSha256: SHA256.test(packageEvidence?.promptSha256 ?? '') ? packageEvidence.promptSha256 : null,
      mediaBindingCount: Number.isInteger(packageEvidence?.mediaBindingCount) ? packageEvidence.mediaBindingCount : null,
      governanceBindings: packageBound ? bindings : null
    };
  });
  return { allBound: units.length > 0 && units.every(item => item.status === 'bound_current_inputs'), units };
}

/**
 * Builds a read-only Studio projection for the stable 30–60 second workflow.
 * It never upgrades legacy evidence into a new contract and never mutates the
 * project.  Consumers must keep evidenceMode visible until actual contracts
 * are registered by the Harness service layer.
 */
export function projectHarness3060StudioProjection({
  state,
  routeDecision = state?.routeDecision ?? null,
  segments = [],
  production = [],
  runs = [],
  reviews = [],
  generationJobs = [],
  nextAction = null,
  deliveryReceipt = null
}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('state must be an object');
  const artifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
  const finalEdit = latestArtifact(artifacts, 'final_edit');
  const lockedFinalEdit = finalEdit?.status === 'locked' ? finalEdit : null;
  const verifiedFinalDelivery = verifiedDeliveryBinding(state, artifacts, deliveryReceipt);
  const observedUnits = observedUnitIds(artifacts, runs);
  const allUnitsHaveObservedOutput = segments.length > 0 && segments.every(segment => observedUnits.has(segment.id));
  const allPackagesReady = production.length > 0 && production.every(item => item.packageReady === true);

  let completionLevel = 'planning';
  if (allPackagesReady) completionLevel = 'units_ready';
  if (allUnitsHaveObservedOutput) completionLevel = 'unit_outputs_observed';
  if (lockedFinalEdit) completionLevel = 'final_edit_ready';
  if (verifiedFinalDelivery) completionLevel = 'accepted';

  const contracts = Object.fromEntries(CONTRACT_IDS.map(id => [id, exactContract(artifacts, id)]));
  contracts.narrative_block ??= compatibilityContract('narrative_block', artifacts.some(item =>
    ['story_plan', 'segmentation'].includes(item.type) && item.status === 'locked'));
  contracts.generation_unit ??= compatibilityContract('generation_unit', segments.length > 0, { count: segments.length });
  contracts.asset_ledger ??= compatibilityContract('asset_ledger', production.some(item => item.assetManifestVerified === true));
  contracts.prompt_package ??= compatibilityContract('prompt_package', production.some(item => item.packageReady === true));
  contracts.review_decision ??= compatibilityContract('review_decision', reviews.length > 0, { count: reviews.length });
  contracts.failure_return ??= compatibilityContract('failure_return', Boolean(nextAction?.failureReturn || nextAction?.failureReturnId));
  contracts.final_edit_manifest ??= compatibilityContract('final_edit_manifest', Boolean(finalEdit || deliveryReceipt));
  const safeGenerationJobs = Array.isArray(generationJobs) ? generationJobs : [];

  return {
    contractVersion: CONTRACT_VERSION,
    migrationMode: 'read_only_legacy_projection',
    routeKind: routeKind(routeDecision),
    humanDecisions: decisionProjection({ state, production, lockedFinalEdit, verifiedFinalDelivery }),
    narrativeBlocks: {
      evidenceMode: contracts.narrative_block.evidenceMode,
      count: contracts.narrative_block.evidenceMode === 'exact_contract'
        ? artifacts.filter(item => item.type === 'narrative_block').length
        : null
    },
    generationUnits: segments.map(segment => ({
      id: segment.id,
      narrativeBlockIds: Array.isArray(segment.narrativeBlockIds) ? [...segment.narrativeBlockIds] : [],
      status: observedUnits.has(segment.id) ? 'output_observed_not_delivery_verified' : 'not_generated',
      completionScope: 'generation_unit',
      eligibleForWholeFilmCompletion: false
    })),
    contracts,
    assetIdentities: assetIdentityProjection(artifacts, production),
    generationSafety: generationSafetyProjection(segments, safeGenerationJobs),
    factInheritance: factInheritanceProjection(production),
    statePlanes: statePlaneProjection({ contracts, generationJobs: safeGenerationJobs, observedUnits, allPackagesReady, lockedFinalEdit, verifiedFinalDelivery }),
    failureReturns: nextAction?.failureReturn ? [nextAction.failureReturn] : [],
    finalEditManifest: contracts.final_edit_manifest,
    completion: {
      level: completionLevel,
      unitOutputCount: observedUnits.size,
      wholeFilmComplete: Boolean(verifiedFinalDelivery),
      finalEditArtifactId: verifiedFinalDelivery?.id ?? lockedFinalEdit?.id ?? null,
      deliveryReceiptObserved: Boolean(deliveryReceipt),
      deliveryReceiptVerified: Boolean(verifiedFinalDelivery)
    },
    nextAction
  };
}

export { CONTRACT_VERSION as HARNESS_3060_STUDIO_CONTRACT_VERSION };
