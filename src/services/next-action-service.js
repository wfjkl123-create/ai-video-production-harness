import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { assertProjectState } from '../domain/project-state.js';
import { verifyArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { currentLockedSegmentVideos } from './current-segment-video-service.js';
import { requiresObservedHandoff } from './asset-service.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { requirePassingSourceComparatorAudit } from './source-comparator-audit-service.js';
import { isAssetAnchoredReferenceWorkflow } from '../domain/reference-workflow.js';
import { workflowProfileIdOf, isMachineReviewedGate } from '../domain/workflow-profile.js';
import { directorRouteFingerprint } from './director-interview-service.js';
import { failureReturnAction, inspectOpenGate5FailureReturns } from './gate5-failure-return-service.js';
import { inspectGate5ReworkWorkOrder } from './gate5-rework-work-order-service.js';

async function jsonEntries(directory) {
  return readdir(directory, { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('._')))
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
}

async function unresolvedRuns(root) {
  const ids = [];
  for (const entry of await jsonEntries(join(root, 'runs'))) {
    const run = await readJson(join(root, 'runs', entry.name));
    if (run?.kind === 'runninghub_video' && run.status === 'SUBMITTING' && run.taskId === null) ids.push(run.id);
  }
  return ids.sort();
}

async function unresolvedDirectorRuns(root) {
  const runs = [];
  const unresolvedStatuses = new Set(['PREPARED', 'CALLING', 'UNCERTAIN', 'MODEL_SUCCEEDED_UNCOMMITTED']);
  for (const entry of await jsonEntries(join(root, 'runs'))) {
    const run = await readJson(join(root, 'runs', entry.name));
    if (run?.kind === 'director_gate1' && unresolvedStatuses.has(run.status)) {
      runs.push({ id: run.id, status: run.status, paidModelCallCompleted: run.paidModelCallCompleted ?? null });
    }
  }
  return runs.sort((left, right) => left.id.localeCompare(right.id));
}

async function pendingTransactions(root) {
  const ids = [];
  for (const entry of await jsonEntries(join(root, '.transactions'))) {
    const transaction = await readJson(join(root, '.transactions', entry.name));
    if (transaction?.status === 'PENDING') ids.push(transaction.id ?? entry.name);
  }
  return ids.sort();
}

async function latestFailureHasControlRemediation(root, ledger) {
  const latest = ledger?.events?.at(-1);
  if (!latest?.rootCauseKey || !latest?.controlRouteFingerprint) return false;
  for (const entry of await jsonEntries(join(root, 'reviews'))) {
    const review = await readJson(join(root, 'reviews', entry.name));
    if (review?.kind === 'generation_control_remediation'
      && review.actor === 'human'
      && review.decision === 'approved'
      && review.failureEventId === latest.id
      && review.rootCauseKey === latest.rootCauseKey
      && review.failedControlRouteFingerprint === latest.controlRouteFingerprint
      && review.replacementControlRouteFingerprint !== latest.controlRouteFingerprint) return true;
  }
  return false;
}

async function lockedSegments(root, state) {
  const artifact = resolveCurrentArtifacts(state.artifacts).current
    .filter(item => item.type === 'segmentation' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision)[0];
  if (!artifact) return { artifact: null, segments: [] };
  await verifyLockedArtifact(root, artifact);
  const value = await readJson(join(root, artifact.path));
  return { artifact, segments: Array.isArray(value?.segments) ? value.segments : [] };
}

async function currentBoundSegmentContract(root, currentArtifacts, segmentId, segmentation) {
  const candidates = currentArtifacts
    .filter(artifact => artifact.type === 'segment_contract' && artifact.segmentId === segmentId && artifact.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  for (const artifact of candidates) {
    let inspected;
    try {
      inspected = await verifyLockedArtifact(root, artifact);
    } catch {
      continue;
    }
    const contract = await readJson(inspected.path);
    if (contract.segmentation?.id === segmentation.id
      && contract.segmentation?.revision === segmentation.revision
      && contract.segmentation?.sha256 === segmentation.sha256) return artifact;
  }
  return null;
}

async function hasLockedAssetManifest(root, segmentId, segmentation) {
  const manifest = await readJson(join(root, 'assets', `${segmentId}-asset-manifest.json`)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const sourceSegmentationId = manifest?.sourceArtifactIds?.segmentation;
  const segmentItemsMatchCurrentSegmentation = Array.isArray(manifest?.items)
    && manifest.items
      .filter(item => item.scope === 'segment')
      .every(item => item.segmentationId === segmentation.id && item.segmentationSha256 === segmentation.sha256);
  return manifest?.segmentId === segmentId
    && manifest.status === 'locked'
    && typeof manifest.lockedByReviewId === 'string'
    && manifest.lockedByReviewId.length > 0
    && sourceSegmentationId === segmentation.id
    && segmentItemsMatchCurrentSegmentation;
}

export async function determineNextActions(root) {
  const projectRoot = resolve(root);
  const uncertain = await unresolvedRuns(projectRoot);
  if (uncertain.length > 0) return {
    blocked: true,
    actions: [{ id: 'reconcile_video_submit', runIds: uncertain, reason: 'submission outcome is unknown' }]
  };
  const unresolvedDirector = await unresolvedDirectorRuns(projectRoot);
  if (unresolvedDirector.length > 0) return {
    blocked: true,
    actions: [{
      id: 'resolve_director_run',
      runs: unresolvedDirector,
      reason: unresolvedDirector.every(run => run.status === 'MODEL_SUCCEEDED_UNCOMMITTED' && run.paidModelCallCompleted === true)
        ? 'the paid Director result is saved locally and must be committed without another model call'
        : 'the Director Engine call outcome is not safe to retry automatically'
    }]
  };
  const transactions = await pendingTransactions(projectRoot);
  if (transactions.length > 0) return {
    blocked: true,
    actions: [{ id: 'recover_transactions', transactionIds: transactions, reason: 'pending transaction journals must be recovered' }]
  };
  try {
    await lstat(join(projectRoot, '.review-mutation.lock'));
    return { blocked: true, actions: [{ id: 'inspect_project_lock', reason: 'project mutation lock exists' }] };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
  if (state.phase === 'archived') return { blocked: false, actions: [] };
  const failureLedger = await readJson(join(projectRoot, 'runs', 'generation-failure-ledger.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (failureLedger?.status === 'TERMINATED_FAILURE_LIMIT_EXCEEDED') return {
    blocked: true,
    actions: [{ id: 'generation_failure_limit_reached', reason: 'the project generation failure limit is terminal' }]
  };
  if (failureLedger?.status === 'AWAITING_HUMAN_REVIEW_AFTER_REWORK'
    && !(await latestFailureHasControlRemediation(projectRoot, failureLedger))) return {
    blocked: true,
    actions: [{
      id: 'record_generation_control_remediation',
      rootCauseKey: failureLedger.events?.at(-1)?.rootCauseKey ?? null,
      reason: 'a failed generation requires human-reviewed root-cause remediation and a changed control route before any new paid attempt'
    }]
  };
  let currentArtifacts;
  try {
    currentArtifacts = resolveCurrentArtifacts(state.artifacts).current;
  } catch (error) {
    return {
      blocked: true,
      actions: [{ id: 'repair_project_evidence', reason: `artifact lineage is ambiguous or invalid: ${error.message}` }]
    };
  }
  let gate5Returns;
  try {
    gate5Returns = await inspectOpenGate5FailureReturns(projectRoot, state, currentArtifacts);
  } catch (error) {
    return {
      blocked: true,
      actions: [{ id: 'repair_project_evidence', reason: `Gate 5 rejection evidence is invalid: ${error.message}` }]
    };
  }
  if (gate5Returns.unclassified.length > 0) {
    const rejection = gate5Returns.unclassified[0];
    return {
      blocked: true,
      actions: [{
        id: 'classify_gate5_rejection',
        ...rejection,
        additionalUnclassifiedCount: gate5Returns.unclassified.length - 1,
        reason: 'Gate 5 rejection lacks an explicit root cause and minimum return stage; do not infer or restart the chain'
      }]
    };
  }
  if (gate5Returns.open.length > 0) {
    const failureReturn = gate5Returns.open[0];
    let workOrder;
    try {
      workOrder = await inspectGate5ReworkWorkOrder(projectRoot, state, currentArtifacts, failureReturn);
    } catch (error) {
      return {
        blocked: true,
        actions: [{ id: 'repair_project_evidence', reason: `Gate 5 rework work order is invalid: ${error.message}` }]
      };
    }
    if (!workOrder) return {
      blocked: false,
      actions: [{
        id: 'prepare_gate5_rework_order',
        failureReturnId: failureReturn.id,
        failureReturn,
        segmentId: failureReturn.segmentId,
        artifactId: failureReturn.rejection.artifactId,
        returnStage: failureReturn.routing.returnStage,
        additionalOpenReturnCount: gate5Returns.open.length - 1,
        reason: 'freeze current upstream evidence in a resumable local work order before changing any rework-stage artifact'
      }]
    };
    return {
      blocked: false,
      actions: [failureReturnAction(failureReturn, gate5Returns.open.length - 1, workOrder)]
    };
  }
  const reviewableVideo = currentArtifacts
    .filter(artifact => ['video_segment', 'final_edit'].includes(artifact.type) && ['draft', 'rework'].includes(artifact.status))
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'final_edit' ? -1 : 1;
      const leftActive = left.segmentId === state.activeSegmentId ? 1 : 0;
      const rightActive = right.segmentId === state.activeSegmentId ? 1 : 0;
      return rightActive - leftActive || right.revision - left.revision || left.id.localeCompare(right.id);
    })[0];
  if (reviewableVideo) {
    const predecessor = reviewableVideo.supersedesArtifactId
      ? state.artifacts.find(artifact => artifact.id === reviewableVideo.supersedesArtifactId)
      : null;
    return {
      blocked: false,
      actions: [{
        id: 'submit_gate5_video_review',
        artifactId: reviewableVideo.id,
        segmentId: reviewableVideo.segmentId ?? null,
        resolvesReviewId: predecessor?.status === 'rejected' ? predecessor.rejectedByReviewId ?? null : null,
        reason: predecessor?.status === 'rejected'
          ? 'a direct replacement exists; submit its exact revision back to Gate 5 and bind the predecessor rejection'
          : 'the video candidate must enter formal Gate 5 human review before delivery'
      }]
    };
  }
  if ((state.workflowVersion ?? 1) >= 2 && state.ingressPolicyVersion) {
    if (!state.routeDecision) return {
      blocked: false,
      actions: [{
        id: 'capture_intake_route',
        reason: 'workflow v2 ingress policy requires a deterministic route decision before Gate 1'
      }]
    };
    if (state.routeDecision.harnessRequired
      && state.routeDecision.referenceRoleStatus === 'awaiting_reference_role') return {
      blocked: false,
      actions: [{
        id: 'resolve_reference_role',
        sourceVideoIds: state.routeDecision.sourceVideoIds,
        reason: 'attached video purpose must be resolved as source authority or inspiration before Gate 1'
      }]
    };
    if (state.routeDecision.harnessRequired && state.routeDecision.sourceVideoIds.length > 0) {
      const missingSourceVideoIds = state.routeDecision.sourceVideoIds.filter(sourceVideoId => !currentArtifacts.some(artifact => (
        artifact.type === 'reference_video'
          && (artifact.id === sourceVideoId || artifact.sourceVideoId === sourceVideoId)
      )));
      if (missingSourceVideoIds.length > 0) return {
        blocked: false,
        actions: [{
          id: 'register_reference_videos',
          sourceVideoIds: missingSourceVideoIds,
          reason: 'all routed source video descriptors must be registered as project reference inputs before Gate 1'
        }]
      };
    }
    if (state.routeDecision.executionClass === 'mechanical_asset_prompt') {
      const assetInputIds = state.routeDecision.assetInputIds ?? [];
      const missingAssetInputIds = assetInputIds.filter(assetId => !currentArtifacts.some(artifact => (
        artifact.id === assetId
          && artifact.type === 'project_asset'
          && ['product_reference', 'character_identity_single_view'].includes(artifact.assetType)
          && artifact.status === 'locked'
      )));
      if (missingAssetInputIds.length > 0) return {
        blocked: false,
        actions: [{
          id: 'register_mechanical_assets',
          assetInputIds: missingAssetInputIds,
          reason: 'the declared replacement assets must be copied, checksum-verified, and locked before prompt preparation'
        }]
      };
      const source = currentArtifacts.find(artifact => artifact.id === state.routeDecision.sourceVideoIds[0]
        && artifact.type === 'reference_video' && artifact.status === 'locked');
      const replacementAsset = currentArtifacts.find(artifact => artifact.id === assetInputIds[0]
        && artifact.type === 'project_asset'
        && ['product_reference', 'character_identity_single_view'].includes(artifact.assetType)
        && artifact.status === 'locked');
      const mechanicalPackage = currentArtifacts
        .filter(artifact => artifact.type === 'execution_package'
          && artifact.executionClass === 'mechanical_asset_prompt'
          && artifact.status === 'locked'
          && artifact.sourceVideoId === source?.id
          && artifact.sourceVideoSha256 === source?.sha256
          && (artifact.replacementAssetId ?? artifact.productAssetId) === replacementAsset?.id
          && (artifact.replacementAssetSha256 ?? artifact.productAssetSha256) === replacementAsset?.sha256)
        .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id))[0];
      if (mechanicalPackage) {
        const canvas = state.mechanicalCanvas;
        if (canvas?.status === 'READY_FOR_USER_CANVAS_GENERATION'
          && canvas.packageArtifactId === mechanicalPackage.id
          && canvas.packageSha256 === mechanicalPackage.sha256
          && canvas.paidGenerationTriggered === false) {
          return {
            blocked: false,
            actions: [{
              id: 'mechanical_canvas_ready',
              packageArtifactId: mechanicalPackage.id,
              projectUuid: canvas.projectUuid,
              nodeCount: canvas.nodes?.length ?? 0,
              requiresUserCanvasGeneration: true,
              assistantMaySubmitPaidGeneration: false,
              reason: 'the exact clips, replacement image and prompts were read back on the LibTV canvas; only the user may click generation'
            }]
          };
        }
        return {
          blocked: false,
          actions: [{
            id: 'prepare_mechanical_libtv_canvas',
            packageArtifactId: mechanicalPackage.id,
            segmentCount: mechanicalPackage.segmentCount,
            assistantMaySubmitPaidGeneration: false,
            reason: 'the deterministic clips and prompts are ready; upload and bind them on a LibTV canvas without running generation'
          }]
        };
      }
      return {
        blocked: false,
        actions: [{
          id: 'prepare_mechanical_asset_prompt_package',
          sourceVideoIds: [...state.routeDecision.sourceVideoIds],
          assetInputIds: [...assetInputIds],
          reviewSurface: 'libtv_canvas',
          assistantMaySubmitPaidGeneration: false,
          skippedStages: ['director_interview', 'creative_brief', 'story_plan', 'shotlist', 'semantic_review'],
          reason: 'explicit mechanical task: process existing assets and prompts, then stop at LibTV canvas for user review'
        }]
      };
    }
    if (state.routeDecision.harnessRequired && state.videoGovernanceVersion === 2) {
      const interview = await readJson(join(projectRoot, 'brief', 'director-interview-v1.json')).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const routeFingerprint = directorRouteFingerprint(state.routeDecision);
      if (!interview || interview.routeFingerprint !== routeFingerprint
        || state.directionRevision?.interviewInputFingerprint !== interview.inputFingerprint) {
        return {
          blocked: false,
          actions: [{ id: 'prepare_director_interview', reason: 'the current video direction needs a fresh, route-bound Gate 0 interview' }]
        };
      }
      if (interview.status !== 'complete' || state.directionRevision?.status !== 'confirmed') {
        return {
          blocked: false,
          actions: [{
            id: 'answer_director_interview',
            questionIds: interview.questions.filter(item => !item.answer).map(item => item.id),
            reason: 'high-impact video direction questions must be answered before Gate 1'
          }]
        };
      }
    }
  }
  if (state.blockedReason) return {
    blocked: true,
    actions: [{ id: 'resolve_project_blocker', reason: state.blockedReason }]
  };
  const pendingArtifacts = currentArtifacts.filter(({ status }) => status === 'awaiting_review');
  if ((state.workflowVersion ?? 1) >= 2) {
    const pendingStoryPlan = pendingArtifacts
      .filter(artifact => artifact.type === 'story_plan')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    const latestCreative = currentArtifacts
      .filter(artifact => artifact.type === 'creative_brief' && artifact.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (pendingStoryPlan && latestCreative) {
      try {
        const [storyFile, creativeFile] = await Promise.all([
          verifyArtifactFile(projectRoot, pendingStoryPlan),
          verifyLockedArtifact(projectRoot, latestCreative)
        ]);
        const [storyValue, creativeValue] = await Promise.all([readJson(storyFile.path), readJson(creativeFile.path)]);
        if (storyValue.creativeBriefId !== latestCreative.id || storyValue.creativeBriefSha256 !== latestCreative.sha256) {
          const affectedArtifactIds = creativeValue.creativeDecision?.revisionImpact?.affectedArtifactIds ?? [];
          return {
            blocked: false,
            actions: [{
              id: 'prepare_story_plan', creativeBriefId: latestCreative.id, staleStoryPlanId: pendingStoryPlan.id,
              affectedArtifactIds: [...new Set([...affectedArtifactIds, pendingStoryPlan.id])].sort(),
              reason: 'the latest Gate 1 creative direction supersedes this awaiting-review Gate 2 plan; rebuild it before human review'
            }]
          };
        }
      } catch {
        return { blocked: true, actions: [{ id: 'repair_project_evidence', reason: 'awaiting-review story plan binding failed integrity checks' }] };
      }
    }
  }
  const pending = pendingArtifacts.map(({ id }) => id).sort();
  if (pending.length > 0) return {
    blocked: false,
    actions: [{ id: 'human_review', artifactIds: pending, reason: 'artifacts are awaiting human review' }]
  };

  if ((state.workflowVersion ?? 1) >= 2) {
    const creativeBrief = currentArtifacts
      .filter(artifact => artifact.type === 'creative_brief' && artifact.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!creativeBrief) return {
      blocked: false,
      actions: [{ id: 'prepare_creative_brief', reason: 'Gate 1 creative direction, segmentation, and parallel strategy must be reviewed first' }]
    };
    let creativeBriefValue;
    try {
      const creativeFile = await verifyLockedArtifact(projectRoot, creativeBrief);
      creativeBriefValue = await readJson(creativeFile.path);
    } catch {
      return { blocked: true, actions: [{ id: 'repair_project_evidence', reason: 'locked creative brief evidence failed integrity checks' }] };
    }
    const lightweightReplication = isAssetAnchoredReferenceWorkflow(
      creativeBriefValue.creativeDecision?.referenceWorkflow,
      creativeBriefValue.creativeDecision
    );
    const workflowProfileId = workflowProfileIdOf(state);
    const simpleRemakeRoute = workflowProfileId === 'simple_remake';
    const storyMachineDelegated = isMachineReviewedGate(workflowProfileId, 2);
    const lightweight = lightweightReplication || simpleRemakeRoute;
    if (state.routeDecision?.harnessRequired && state.routeDecision.referenceRoleStatus === 'authority' && !lightweight) {
      const missingSourceVideoIds = state.routeDecision.sourceVideoIds.filter(sourceVideoId => !currentArtifacts.some(artifact => (
        artifact.type === 'source_fact_analysis' && artifact.status === 'locked' && artifact.sourceVideoId === sourceVideoId
      )));
      if (missingSourceVideoIds.length > 0) return {
        blocked: false,
        actions: [{
          id: 'prepare_source_fact_analysis',
          sourceVideoIds: missingSourceVideoIds,
          creativeBriefId: creativeBrief.id,
          reason: 'source-authority projects require adaptive observed-fact evidence before the Gate 2 story plan'
        }]
      };
    }
    const draftStoryPlan = currentArtifacts
      .filter(artifact => artifact.type === 'story_plan' && ['draft', 'rework'].includes(artifact.status))
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (draftStoryPlan) {
      let draftFile;
      try {
        draftFile = await verifyArtifactFile(projectRoot, draftStoryPlan);
      } catch {
        return { blocked: true, actions: [{ id: 'repair_project_evidence', reason: 'draft story plan evidence failed integrity checks' }] };
      }
      const draftValue = await readJson(draftFile.path);
      if (draftValue.creativeBriefId !== creativeBrief.id || draftValue.creativeBriefSha256 !== creativeBrief.sha256) {
        const affectedArtifactIds = creativeBriefValue.creativeDecision?.revisionImpact?.affectedArtifactIds ?? [draftStoryPlan.id];
        return {
          blocked: false,
          actions: [{
            id: 'prepare_story_plan', creativeBriefId: creativeBrief.id, staleStoryPlanId: draftStoryPlan.id,
            affectedArtifactIds: [...new Set([...affectedArtifactIds, draftStoryPlan.id])].sort(),
            reason: 'the latest Gate 1 creative direction supersedes this Gate 2 draft; rebuild it before human review'
          }]
        };
      }
      if (state.routeDecision?.harnessRequired && state.routeDecision.referenceRoleStatus === 'authority' && !lightweight) {
        try {
          await requirePassingSourceComparatorAudit(projectRoot, draftStoryPlan);
        } catch (error) {
          return {
            blocked: false,
            actions: [{
              id: 'run_source_comparator_audit', storyPlanId: draftStoryPlan.id,
              reason: `source comparator must PASS before Gate 2 human review: ${error.message}`
            }]
          };
        }
      }
      return {
        blocked: false,
        actions: [{
          id: storyMachineDelegated ? 'machine_review_story_plan' : 'submit_story_plan_review',
          storyPlanId: draftStoryPlan.id,
          reason: storyMachineDelegated
            ? '简单复刻路线的故事与镜头由系统机审并自动锁定，无需人工审核。'
            : lightweight
            ? '三项核心资产路线已由系统完成依据整理，Gate 2 仅需审核故事与镜头计划'
            : 'all Gate 2 machine prechecks passed'
        }]
      };
    }
    const storyPlan = currentArtifacts
      .filter(artifact => artifact.type === 'story_plan' && artifact.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!storyPlan) return {
      blocked: false,
      actions: [{
        id: 'prepare_story_plan',
        creativeBriefId: creativeBrief.id,
        reason: lightweight
          ? '三项核心资产路线由系统自动整理依据，先生成一份轻量 Gate 2 故事与镜头草稿'
          : 'Gate 2 script, character bible, and shot plan must be reviewed before assets'
      }]
    };
    let storyPlanFile;
    try {
      storyPlanFile = await verifyLockedArtifact(projectRoot, storyPlan);
    } catch {
      return { blocked: true, actions: [{ id: 'repair_project_evidence', reason: 'locked story plan is stale or failed integrity checks' }] };
    }
    const storyPlanValue = await readJson(storyPlanFile.path);
    if (storyPlanValue.creativeBriefId !== creativeBrief.id || storyPlanValue.creativeBriefSha256 !== creativeBrief.sha256) {
      const affectedArtifactIds = creativeBriefValue.creativeDecision?.revisionImpact?.affectedArtifactIds
        ?? currentArtifacts.filter(item => item.type !== 'creative_brief' && item.type !== 'reference_video').map(item => item.id);
      return {
        blocked: false,
        actions: [{
          id: 'prepare_story_plan',
          creativeBriefId: creativeBrief.id,
          staleStoryPlanId: storyPlan.id,
          affectedArtifactIds: [...new Set([...affectedArtifactIds, storyPlan.id])].sort(),
          reason: 'the latest Gate 1 creative direction supersedes the prior Gate 2 plan; rebuild affected downstream work from the new creative brief'
        }]
      };
    }
    const lockedSegmentation = currentArtifacts
      .filter(artifact => artifact.type === 'segmentation' && artifact.status === 'locked')
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
    if (!lockedSegmentation) {
      const capabilityManifest = currentArtifacts.find(artifact => artifact.id === state.verifiedCapabilityManifestId
        && artifact.type === 'capability_manifest' && artifact.status === 'locked');
      if (!capabilityManifest
        || capabilityManifest.storyPlanId !== storyPlan.id
        || capabilityManifest.storyPlanSha256 !== storyPlan.sha256
        || capabilityManifest.routePrecision !== 'explicit_v2'
        || capabilityManifest.storyPlanSchemaVersion !== 2) {
        return {
          blocked: true,
          actions: [{ id: 'repair_project_evidence', reason: 'locked story plan requires an exact locked verified capability manifest before canonical segmentation' }]
        };
      }
      try {
        await verifyLockedArtifact(projectRoot, capabilityManifest);
      } catch {
        return {
          blocked: true,
          actions: [{ id: 'repair_project_evidence', reason: 'verified capability manifest failed integrity checks before canonical segmentation' }]
        };
      }
      return {
        blocked: false,
        actions: [{ id: 'propose_segmentation', reason: 'locked story plan and verified director capability manifest are ready' }]
      };
    }
  }

  let lockedSegmentation;
  try {
    lockedSegmentation = await lockedSegments(projectRoot, state);
  } catch {
    return {
      blocked: true,
      actions: [{ id: 'repair_project_evidence', reason: 'locked segmentation evidence failed integrity checks' }]
    };
  }
  const { artifact: segmentationArtifact, segments } = lockedSegmentation;
  if (segments.length > 0) {
    const currentVideos = new Map(await Promise.all(segments.map(async segment => [
      segment.id,
      await currentLockedSegmentVideos(projectRoot, state, segment.id)
    ])));
    const allComplete = segments.every(segment => currentVideos.get(segment.id).length > 0);
    if (allComplete) return { blocked: false, actions: [{ id: 'verify_delivery', reason: 'all canonical segments have locked videos' }] };
    const active = segments.find(item => item.id === state.activeSegmentId);
    const segment = active && currentVideos.get(active.id).length === 0
      ? active
      : segments.find(item => currentVideos.get(item.id).length === 0);
    const index = segments.findIndex(item => item.id === segment.id);
    if (requiresObservedHandoff(segment, index)) {
      const previous = segments[index - 1];
      const handoff = currentArtifacts.find(artifact => artifact.type === 'handoff' && artifact.segmentId === previous.id
        && artifact.status === 'locked' && artifact.observed === true);
      if (!handoff) return {
        blocked: false,
        actions: [{ id: 'complete_observed_handoff', segmentId: previous.id, reason: `observed handoff is required before ${segment.id}` }]
      };
    }
    const prerequisites = [];
    if (!currentArtifacts.some(artifact => artifact.type === 'quality_rubric' && artifact.status === 'locked')) {
      prerequisites.push({ id: 'create_quality_rubric', reason: 'a machine-validated locked quality rubric is required before the segment contract' });
    }
    const missingProjectAssetIds = (segment.projectAssetIds ?? []).filter(id => !currentArtifacts.some(artifact => (
      artifact.id === id && artifact.type === 'project_asset' && artifact.status === 'locked'
    )));
    if (missingProjectAssetIds.length > 0) prerequisites.push({
      id: 'prepare_project_assets', missingAssetIds: missingProjectAssetIds,
      reason: 'all segment-referenced project assets must be human-locked'
    });
    if (prerequisites.length > 0) return { blocked: false, actions: prerequisites };
    const contract = await currentBoundSegmentContract(projectRoot, currentArtifacts, segment.id, segmentationArtifact);
    if (!contract) return {
      blocked: false,
      actions: [{ id: 'create_segment_contract', segmentId: segment.id, reason: 'the segment needs a production contract bound to the current locked segmentation' }]
    };
    if (await hasLockedAssetManifest(projectRoot, segment.id, segmentationArtifact)) return {
      blocked: false,
      actions: [{ id: 'prepare_generation_package', segmentId: segment.id, reason: 'the required assets are locked and the generation package can now be prepared' }]
    };
    return { blocked: false, actions: [{ id: 'prepare_segment_assets', segmentId: segment.id, reason: 'segment contract and continuity gates are ready' }] };
  }

  const lockedScript = currentArtifacts.some(artifact => artifact.type === 'script' && artifact.status === 'locked');
  const lockedShotlist = currentArtifacts.some(artifact => artifact.type === 'shotlist' && artifact.status === 'locked');
  if (!lockedScript || !lockedShotlist) return {
    blocked: false,
    actions: [{ id: 'register_required_inputs', missing: [!lockedScript && 'script', !lockedShotlist && 'shotlist'].filter(Boolean), reason: 'locked script and shotlist are required' }]
  };
  return { blocked: false, actions: [{ id: 'propose_segmentation', reason: 'locked script and shotlist are ready' }] };
}
