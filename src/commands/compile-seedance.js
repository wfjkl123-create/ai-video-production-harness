import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { option } from './args.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { compileSeedancePackage } from '../services/seedance-package-service.js';
import { assertArtifact } from '../domain/artifact.js';
import { loadCanonicalSegments } from './assets.js';
import { applicableRules } from '../services/rule-service.js';
import { verifyLockedArtifact } from '../services/artifact-file-service.js';
import { verifyAssetManifestEvidence } from '../services/asset-manifest-evidence-service.js';
import {
  assertPromptExcludesEmotionPerformanceCapsule,
  renderEmotionPerformanceCapsules
} from '../domain/emotion-performance.js';
import { loadVerifiedCapabilityManifest } from '../services/director-route-service.js';
import {
  assertNarrationMatchesCapabilityManifest,
  assertPromptExcludesDirectorCapsuleMetadata,
  renderDirectorCapabilityCapsules
} from '../domain/director-narration.js';
import {
  requireCleanSeedanceExecutionPrompt,
  requireSeedanceNarrativePerformancePrompt
} from '../services/seedance-prompt-lint-service.js';
import { compileSeedanceMediaBoundPrompt, verifySeedanceMediaTokenMapping } from '../services/seedance-media-binding-service.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { sha256Text } from '../storage/checksum.js';
import { resolveProjectVideoResolution } from '../services/video-resolution-service.js';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';
import { realismContractsVersionOf, assertRequiredBindingsSatisfied } from '../domain/realism-contracts.js';
import { verifyCanonicalPromptSourceForCompilation } from '../services/canonical-prompt-source-service.js';
import { assertAudioExecutionPlan } from '../domain/audio-execution-plan.js';

function lockedPrompt(project, segmentId) {
  const prompts = (project.artifacts ?? [])
    .filter(artifact => artifact.type === 'seedance_prompt' && artifact.segmentId === segmentId && artifact.status === 'locked')
    .map(assertArtifact)
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (prompts.length > 1 && prompts[0].revision === prompts[1].revision) {
    throw new Error(`multiple locked Seedance prompts for ${segmentId} have revision ${prompts[0].revision}`);
  }
  return prompts[0];
}

function latestLockedArtifact(project, type, segmentId, label) {
  const candidates = (project.artifacts ?? [])
    .filter(artifact => artifact.type === type && artifact.segmentId === segmentId && artifact.status === 'locked')
    .map(assertArtifact)
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (candidates.length === 0) throw new Error(`a locked ${label} for ${segmentId} is required`);
  if (candidates.length > 1 && candidates[0].revision === candidates[1].revision) {
    throw new Error(`multiple locked ${label} artifacts have revision ${candidates[0].revision}`);
  }
  return candidates[0];
}

function latestLockedProjectArtifact(project, type, label) {
  const candidates = (project.artifacts ?? [])
    .filter(artifact => artifact.type === type && artifact.status === 'locked')
    .map(assertArtifact)
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[0].revision === candidates[1].revision) {
    throw new Error(`multiple locked ${label} artifacts have revision ${candidates[0].revision}`);
  }
  return candidates[0];
}

function binding(artifact) {
  return {
    id: artifact.id,
    revision: artifact.revision,
    status: artifact.status,
    sha256: artifact.sha256,
    lockedByReviewId: artifact.lockedByReviewId
  };
}

function applyExactSourceAudioAuthority(compiled, segmentContractPayload) {
  const constraints = segmentContractPayload?.immutableConstraints ?? [];
  const exactAudioConstraint = constraints.find(value => typeof value === 'string'
    && value.includes('唯一声音') && value.includes('不改词') && value.includes('不变速')
    && value.includes('不变调') && value.includes('不重配'));
  if (!exactAudioConstraint) return;
  for (const audio of compiled.audioInputs ?? []) {
    const declared = segmentContractPayload?.assetResponsibilities?.[audio.id];
    if (typeof declared !== 'string' || !declared.includes('原音频内容')) continue;
    compiled.responsibilityMap[audio.id] = {
      controls: ['source_audio_waveform', 'dialogue_words', 'original_speaker_timbre', 'dialogue_timing', 'cadence', 'pauses', 'stress', 'dialogue_lipsync_clock', 'action_clock', 'trim_window'],
      mustNotControl: ['visual_identity', 'wardrobe', 'product_appearance', 'scene', 'camera', 'framing']
    };
    compiled.responsibilityMap.text = {
      ...compiled.responsibilityMap.text,
      controls: compiled.responsibilityMap.text.controls.filter(control => control !== 'sound'),
      mustNotControl: [...new Set([...(compiled.responsibilityMap.text.mustNotControl ?? []), 'locked source audio content, timbre, speed, pitch, pauses and timing'])]
    };
  }
}

export async function runCompileSeedance(args) {
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  const project = await readJson(join(root, 'project-state.json'));
  const prompt = lockedPrompt(project, segmentId);
  const assetManifestPath = `assets/${segmentId}-asset-manifest.json`;
  const assetManifest = await readJson(join(root, assetManifestPath));
  const segments = await loadCanonicalSegments(root, project, { requireLockedSegmentation: true });
  await verifyLockedArtifact(root, prompt);
  const manifestEvidence = await verifyAssetManifestEvidence(root, project, assetManifest, assetManifestPath);
  const contract = latestLockedArtifact(project, 'segment_contract', segmentId, 'segment contract');
  const narration = latestLockedArtifact(project, 'shot_narration', segmentId, 'shot narration');
  const sourceFactAnalysis = latestLockedProjectArtifact(project, 'source_fact_analysis', 'source fact analysis');
  if (narration.id !== prompt.narrationSourceId || narration.sha256 !== prompt.narrationSha256) {
    throw new Error('latest locked shot narration does not match the locked prompt binding');
  }
  await verifyLockedArtifact(root, contract);
  const segmentContractPayload = await readJson(join(root, contract.path));
  await verifyLockedArtifact(root, narration);
  if (sourceFactAnalysis) await verifyLockedArtifact(root, sourceFactAnalysis);
  const narrationPayload = await readJson(join(root, narration.path));
  const promptText = await readFile(join(root, prompt.path), 'utf8');
  const realismContractsVersion = realismContractsVersionOf(project);
  const canonicalPromptSource = realismContractsVersion === 2
    ? await verifyCanonicalPromptSourceForCompilation(root, project, prompt)
    : null;
  const audioExecutionPlan = segmentContractPayload.audioExecutionPlan === undefined
    ? null
    : structuredClone(assertAudioExecutionPlan(segmentContractPayload.audioExecutionPlan));
  if (realismContractsVersion === 2) {
    assertRequiredBindingsSatisfied(segmentContractPayload.requiredBindings, project.artifacts);
    if (!audioExecutionPlan) throw new Error('realism contracts v2 require a locked segment audio execution plan');
  }
  assertPromptExcludesEmotionPerformanceCapsule(promptText);
  assertPromptExcludesDirectorCapsuleMetadata(promptText);
  const directorRoute = await loadVerifiedCapabilityManifest(root, project, { segmentId });
  if (directorRoute) {
    assertNarrationMatchesCapabilityManifest(narrationPayload, directorRoute.manifest, directorRoute.sha256);
  }
  const contextPath = option(args, 'rule-context', { required: false });
  const matchedRules = contextPath
    ? await applicableRules(root, await readJson(resolve(contextPath)))
    : [];
  const videoExecutor = option(args, 'video-executor', { required: false }) ?? 'libtv';
  const videoModel = option(args, 'video-model', { required: false });
  const includeReferenceVideo = args.includes('--include-source-video');
  const userConfirmedVideoUpload = args.includes('--user-confirmed-video-upload');
  const legacyDisableAudio = args.includes('--disable-audio');
  if (audioExecutionPlan && legacyDisableAudio && audioExecutionPlan.generateAudio) {
    throw new Error('--disable-audio conflicts with the locked audio execution plan; revise the plan instead of overriding Gate 2 at compile time');
  }
  const generateAudio = audioExecutionPlan?.generateAudio ?? !legacyDisableAudio;
  if (includeReferenceVideo && !userConfirmedVideoUpload) {
    throw new Error('--include-source-video requires prior user confirmation; ask the user before uploading any video input');
  }
  const lockedVideoBaseline = userConfirmedVideoUpload
    ? assetManifest.items.find(item => ['director_view_proxy', 'depth_video_reference'].includes(item.type)
      && item.mediaKind === 'video' && item.status === 'locked')
    : undefined;
  const resolutionContract = await resolveProjectVideoResolution(root, project, segmentId, {
    executor: videoExecutor,
    model: videoModel,
    requestedResolution: option(args, 'resolution', { required: false }),
    // A depth map is geometric guidance, not a source-pixel authority. It must
    // still be verified and packaged below, but its raster dimensions must not
    // silently raise the user's requested output resolution.
    includeReferenceVideo: includeReferenceVideo && lockedVideoBaseline?.type !== 'depth_video_reference',
    lockedVideoBaselineAssetId: lockedVideoBaseline?.type === 'depth_video_reference'
      ? undefined
      : lockedVideoBaseline?.id
  });
  const compiled = await compileSeedancePackage(
    {
      ...project,
      root,
      // compileSeedancePackage validates the exact prompt that will enter the
      // package.  `lockedPrompt` above intentionally selects the latest
      // segment-scoped artifact, so pass that selection through instead of
      // relying on the legacy project-level `project.prompt` field.
      prompt,
      segments,
      assetManifest,
      prompt,
      verifiedAssetManifestEvidence: {
        id: assetManifest.id,
        sha256: manifestEvidence.manifestSha256,
        reviewId: manifestEvidence.reviewId
      }
    },
    segmentId,
    {
      applicableHardRules: matchedRules.filter(rule => rule.status === 'hard'),
      resolutionContract,
      includeReferenceVideo,
      allowVideoInputs: userConfirmedVideoUpload,
      generateAudio
    }
  );
  applyExactSourceAudioAuthority(compiled, segmentContractPayload);
  const generationDurationOption = option(args, 'generation-duration', { required: false });
  if (generationDurationOption !== undefined) {
    const generationDuration = Number(generationDurationOption);
    const editorialDuration = compiled.duration;
    if (!Number.isInteger(generationDuration)
      || generationDuration < Math.ceil(editorialDuration)
      || generationDuration > 15) {
      throw new Error('--generation-duration must be an integer covering the editorial duration and no longer than 15 seconds');
    }
    compiled.duration = generationDuration;
    compiled.editorialDuration = editorialDuration;
    compiled.postprocessTrim = {
      startSeconds: 0,
      endSeconds: editorialDuration,
      holdTailSeconds: Number((generationDuration - editorialDuration).toFixed(6))
    };
  }
  const executionPromptPath = `prompts/${segmentId}/execution-prompt.txt`;
  const mediaBoundPrompt = compileSeedanceMediaBoundPrompt(promptText, compiled);
  verifySeedanceMediaTokenMapping(promptText, mediaBoundPrompt.text, mediaBoundPrompt.mediaTokenMappingManifest);
  compiled.realismContractsVersion = realismContractsVersion;
  if (audioExecutionPlan) compiled.audioExecutionPlan = audioExecutionPlan;
  compiled.sourcePromptPath = prompt.path;
  compiled.promptPath = executionPromptPath;
  compiled.sourceBodySha256 = sha256Text(promptText);
  compiled.compiledBodySha256 = sha256Text(mediaBoundPrompt.text);
  compiled.executionPromptSha256 = compiled.compiledBodySha256;
  compiled.assistantMayPrepareCanvas = segmentContractPayload.immutableConstraints?.some(value => typeof value === 'string' && value.includes('允许') && value.includes('LibTV画布')) === true;
  compiled.assistantMaySubmitPaidGeneration = false;
  compiled.mediaBindingContractVersion = mediaBoundPrompt.contractVersion;
  compiled.mediaBindings = mediaBoundPrompt.bindings;
  compiled.mediaTokenMappingManifest = mediaBoundPrompt.mediaTokenMappingManifest;
  requireCleanSeedanceExecutionPrompt(mediaBoundPrompt.text, { bindings: mediaBoundPrompt.bindings });
  if (project.workflowVersion === 2) requireSeedanceNarrativePerformancePrompt(mediaBoundPrompt.text, {
    sourceControlledPerformance: [
      'native_source_replacement_instruction_only',
      'koc_source_bound_identity_replacement'
    ].includes(project.remakeControlSelection?.promptPolicy)
  });
  assertPromptExcludesEmotionPerformanceCapsule(mediaBoundPrompt.text);
  assertPromptExcludesDirectorCapsuleMetadata(mediaBoundPrompt.text);
  const capsuleArchiveText = [
    renderEmotionPerformanceCapsules(narrationPayload),
    directorRoute
      ? renderDirectorCapabilityCapsules(narrationPayload, directorRoute.manifest, directorRoute.sha256)
      : ''
  ].filter(Boolean).join('\n\n');
  const capsuleArchivePath = `prompts/${segmentId}/capsule-archive.txt`;
  await writeTextAtomic(join(root, capsuleArchivePath), `${capsuleArchiveText}\n`);
  compiled.governanceBindings = {
    segmentContract: binding(contract),
    shotNarration: binding(narration),
    ...(sourceFactAnalysis ? { sourceFactAnalysis: binding(sourceFactAnalysis) } : {}),
    ...(directorRoute ? { capabilityManifest: binding(directorRoute.artifact) } : {}),
    ...(directorRoute?.segmentIdentityMap
      ? { segmentIdentityReconciliation: directorRoute.segmentIdentityMap }
      : {}),
    seedancePrompt: binding(prompt),
    ...(canonicalPromptSource ? { canonicalPromptSource: binding(canonicalPromptSource.artifact) } : {}),
    ...(realismContractsVersion === 2 ? { requiredBindings: structuredClone(segmentContractPayload.requiredBindings) } : {}),
    capsuleArchive: {
      path: capsuleArchivePath,
      sha256: sha256Text(`${capsuleArchiveText}\n`),
      embeddedInPrompt: false
    },
    assetManifest: {
      id: assetManifest.id,
      status: assetManifest.status,
      sha256: manifestEvidence.manifestSha256,
      lockedByReviewId: manifestEvidence.reviewId
    }
  };
  if (project.videoGovernanceVersion === 2) {
    compiled.executionControlContract = structuredClone(assertExecutionControlContract(segmentContractPayload.executionControl));
  } else if (segmentContractPayload.executionControl) {
    compiled.executionControlContract = structuredClone(assertExecutionControlContract(segmentContractPayload.executionControl));
  }
  const path = join(root, 'prompts', segmentId, 'seedance-package.json');
  await writeTextAtomic(join(root, executionPromptPath), mediaBoundPrompt.text);
  await writeJsonAtomic(path, compiled);
  return {
    path,
    summary: {
      segmentId,
      duration: compiled.duration,
      editorialDuration: compiled.editorialDuration ?? compiled.duration,
      ratio: compiled.ratio,
      resolution: compiled.resolution,
      imageInputCount: compiled.imageInputs.length,
      videoInputCount: compiled.videoInputs.length,
      audioInputCount: compiled.audioInputs.length,
      mediaBindingCount: compiled.mediaBindings.length,
      excludedInputCount: compiled.excludedInputs.length,
      hardRuleCount: compiled.hardRuleIds.length,
      capabilityManifestId: directorRoute?.artifact.id ?? null
    }
  };
}
