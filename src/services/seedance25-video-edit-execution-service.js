import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { assertSeedanceSourcePromptReferences, compileSeedanceMediaBoundPrompt } from './seedance-media-binding-service.js';
import { requireCleanSeedanceExecutionPrompt, requireSeedanceNarrativePerformancePrompt } from './seedance-prompt-lint-service.js';
import { sha256Text } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const MODEL = 'Seedance 2.5';

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function sha(value, field) {
  text(value, field);
  if (!SHA256.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
  return value;
}

function projectPath(value, field) {
  text(value, field);
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`);
  return value.split(sep).join('/');
}

function duration(value, field) {
  if (!Number.isFinite(value) || value <= 0 || value > 30) throw new Error(`${field} must be a finite duration between 0 and 30 seconds`);
  return value;
}

function asset(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return {
    id: text(value.id ?? value.assetId, `${field}.id`),
    path: projectPath(value.path, `${field}.path`),
    sha256: sha(value.sha256, `${field}.sha256`)
  };
}

function responsibilityMap(value, ids) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('mediaResponsibilities must be an object');
  const result = {};
  for (const id of ids) {
    const item = value[id];
    if (!item || !Array.isArray(item.controls) || item.controls.length === 0
      || !Array.isArray(item.mustNotControl) || item.mustNotControl.length === 0) {
      throw new Error(`mediaResponsibilities.${id} requires non-empty controls and mustNotControl`);
    }
    result[id] = {
      controls: item.controls.map((entry, index) => text(entry, `mediaResponsibilities.${id}.controls[${index}]`)),
      mustNotControl: item.mustNotControl.map((entry, index) => text(entry, `mediaResponsibilities.${id}.mustNotControl[${index}]`))
    };
  }
  const extra = Object.keys(value).filter(id => !ids.includes(id));
  if (extra.length > 0) throw new Error(`mediaResponsibilities includes unselected asset ids: ${extra.join(', ')}`);
  return result;
}

function onlyAssetIds(sourceText) {
  return [...new Set([...sourceText.matchAll(/@素材\[([^\]]+)\]/gu)].map(match => match[1]))].sort();
}

function fingerprintHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertUnit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('video edit execution unit must be an object');
  if (value.schemaVersion !== 1) throw new Error('video edit execution unit schemaVersion must be 1');
  if (!SAFE_ID.test(value.id ?? '')) throw new Error('video edit execution unit id must use safe characters');
  if (!SAFE_ID.test(value.projectId ?? '') || !SAFE_ID.test(value.segmentId ?? '')) throw new Error('video edit execution unit must use safe project and segment identifiers');
  if (value.model !== MODEL || value.operation !== 'video_edit') throw new Error('video edit execution unit must use Seedance 2.5 video_edit');
  const generation = value.generationContract;
  if (!generation || typeof generation !== 'object') throw new TypeError('generationContract must be an object');
  if (generation.modeType !== 'videoEdit2video') throw new Error('generationContract.modeType must be videoEdit2video');
  if (generation.ratio_auto !== 'adaptive' || generation.duration_auto !== 0 || generation.resolution !== '1080p') {
    throw new Error('videoEdit2video must request ratio_auto=adaptive, duration_auto=0, resolution=1080p');
  }
  if (generation.enableSound !== true) throw new Error('generated audio is mandatory: generationContract.enableSound must be true');
  if (generation.paidGenerationSubmitted !== false) throw new Error('a video edit execution unit cannot claim paidGenerationSubmitted=true before canvas generation');
  const unitDuration = duration(value.duration, 'duration');
  const editorialDuration = duration(value.editorialDuration, 'editorialDuration');
  if (Math.abs(unitDuration - editorialDuration) > 0.000001) throw new Error('duration and editorialDuration must match for a direct source-video edit unit');
  const prompt = value.prompt;
  if (!prompt || typeof prompt !== 'object') throw new TypeError('prompt must be an object');
  const sourceVideo = {
    ...asset(value.sourceVideo, 'sourceVideo'),
    derivedFromArtifactId: text(value.sourceVideo?.derivedFromArtifactId, 'sourceVideo.derivedFromArtifactId')
  };
  const images = value.images?.map((item, index) => asset(item, `images[${index}]`));
  if (!Array.isArray(images) || images.length < 1 || images.length > 30) throw new Error('videoEdit2video unit requires between 1 and 30 approved image inputs');
  const timingAudioEvidence = asset(value.timingAudioEvidence, 'timingAudioEvidence');
  if (value.timingAudioEvidence.runtimeUpload !== false) {
    throw new Error('timing audio must be explicitly marked runtimeUpload=false because current videoEdit2video schema has no audio input slot');
  }
  const ids = [...images.map(item => item.id), sourceVideo.id];
  if (new Set(ids).size !== ids.length) throw new Error('video edit unit contains duplicate runtime media ids');
  const responsibilities = responsibilityMap(value.mediaResponsibilities, ids);
  const executionControlContract = assertExecutionControlContract(value.executionControlContract);
  return {
    ...value,
    prompt: { path: projectPath(prompt.path, 'prompt.path'), sha256: sha(prompt.sha256, 'prompt.sha256'), narrationSourceId: text(prompt.narrationSourceId, 'prompt.narrationSourceId'), narrationSha256: sha(prompt.narrationSha256, 'prompt.narrationSha256') },
    duration: unitDuration,
    editorialDuration,
    sourceVideo,
    images,
    timingAudioEvidence,
    mediaResponsibilities: responsibilities,
    executionControlContract
  };
}

async function exactLockedArtifact(root, state, descriptor, label) {
  const artifact = state.artifacts?.find(item => item.id === descriptor.id);
  if (!artifact || artifact.status !== 'locked') throw new Error(`${label} must be a locked project artifact: ${descriptor.id}`);
  if (artifact.path !== descriptor.path || artifact.sha256 !== descriptor.sha256) throw new Error(`${label} registry binding changed for ${descriptor.id}`);
  await verifyLockedArtifact(root, artifact);
  return artifact;
}

async function verifiedFile(root, descriptor, label) {
  const inspected = await inspectArtifactFile(root, descriptor.path);
  if (inspected.sha256 !== descriptor.sha256) throw new Error(`${label} checksum changed for ${descriptor.id}`);
  return inspected;
}

async function loadAndVerifyUnitInputs(root, unit) {
  const state = await readJson(join(root, 'project-state.json'));
  const [promptArtifact, sourceArtifact, images, timingAudio] = await Promise.all([
    exactLockedArtifact(root, state, { id: unit.prompt.narrationSourceId, path: state.artifacts?.find(item => item.id === unit.prompt.narrationSourceId)?.path, sha256: unit.prompt.narrationSha256 }, 'shot narration'),
    exactLockedArtifact(root, state, (() => {
      const source = state.artifacts?.find(item => item.id === unit.sourceVideo.derivedFromArtifactId);
      if (!source) throw new Error(`source authority is not registered: ${unit.sourceVideo.derivedFromArtifactId}`);
      return { id: source.id, path: source.path, sha256: source.sha256 };
    })(), 'source authority'),
    Promise.all(unit.images.map(item => exactLockedArtifact(root, state, item, 'image input'))),
    exactLockedArtifact(root, state, unit.timingAudioEvidence, 'timing audio evidence')
  ]);
  if (promptArtifact.type !== 'shot_narration' || promptArtifact.sha256 !== unit.prompt.narrationSha256) {
    throw new Error('video edit unit narration binding is not a locked current shot narration');
  }
  await verifiedFile(root, unit.sourceVideo, 'derived silent source video');
  if (unit.sourceVideo.derivedFromArtifactId !== sourceArtifact.id) {
    throw new Error('derived silent source video must declare source-001 provenance');
  }
  return { state, sourceArtifact, images, timingAudio };
}

/**
 * Compiles a source-video direct-edit package.  It intentionally leaves the
 * source timing WAV outside runtime media: the current live videoEdit2video
 * schema exposes one video plus images, but no audio input list.  Generated
 * audio remains enabled and the timing evidence stays checksum-bound locally.
 */
export async function compileSeedance25VideoEditExecution(root, rawUnit) {
  const unit = assertUnit(rawUnit);
  const promptFile = await inspectArtifactFile(root, unit.prompt.path);
  if (promptFile.sha256 !== unit.prompt.sha256) throw new Error('video edit source prompt checksum changed');
  const sourcePrompt = await readFile(promptFile.path, 'utf8');
  assertSeedanceSourcePromptReferences(sourcePrompt);
  const { sourceArtifact, images, timingAudio } = await loadAndVerifyUnitInputs(root, unit);
  const sourceVideo = { ...unit.sourceVideo, status: 'locked' };
  const imageInputs = images.map(item => ({ id: item.id, path: item.path, sha256: item.sha256, status: 'locked' }));
  const runtimeIds = [...imageInputs.map(item => item.id), sourceVideo.id];
  if (JSON.stringify(onlyAssetIds(sourcePrompt)) !== JSON.stringify([...runtimeIds].sort())) {
    throw new Error('source prompt media references must match the exact runtime image inputs plus one derived source video');
  }
  const base = {
    executionUnitId: unit.id,
    segmentId: unit.segmentId,
    model: MODEL,
    operation: 'video_edit',
    duration: unit.duration,
    editorialDuration: unit.editorialDuration,
    ratio: 'adaptive',
    resolution: '1080p',
    generateAudio: true,
    sourcePromptPath: unit.prompt.path,
    imageInputs,
    videoInputs: [sourceVideo],
    audioInputs: [],
    responsibilityMap: unit.mediaResponsibilities,
    excludedInputs: [{ id: timingAudio.id, reason: 'current live videoEdit2video schema exposes no runtime audio input; retained only as checksum-bound local timing evidence' }],
    hardRuleIds: ['GENERATED_AUDIO_REQUIRED', 'SOURCE_AUDIO_DIRECT_INJECTION_FORBIDDEN', 'DIRECT_SOURCE_VIDEO_EDIT_ONLY']
  };
  const bound = compileSeedanceMediaBoundPrompt(sourcePrompt, base);
  requireCleanSeedanceExecutionPrompt(bound.text, { bindings: bound.bindings });
  requireSeedanceNarrativePerformancePrompt(bound.text);
  return {
    schemaVersion: 1,
    kind: 'seedance25_video_edit_execution_package',
    // This file is a compiled, immutable input.  Registration and the later
    // canvas readback are state transitions outside the file, so do not leave
    // a stale "pending registration" status inside an otherwise locked
    // package.
    status: 'compiled',
    compiledFrom: {
      executionUnitPath: null,
      executionUnitId: unit.id,
      prompt: { path: unit.prompt.path, sha256: promptFile.sha256 },
      narration: { id: unit.prompt.narrationSourceId, sha256: unit.prompt.narrationSha256 },
      sourceAuthority: { id: sourceArtifact.id, sha256: sourceArtifact.sha256 }
    },
    ...base,
    timingAudioEvidence: {
      id: timingAudio.id,
      path: timingAudio.path,
      sha256: timingAudio.sha256,
      lockedByReviewId: timingAudio.lockedByReviewId,
      runtimeUpload: false,
      reason: 'videoEdit2video live schema does not expose audio inputs; evidence drives the authored timing contract only'
    },
    executionControlContract: structuredClone(unit.executionControlContract),
    mediaBindingContractVersion: bound.contractVersion,
    mediaBindings: bound.bindings,
    executionPrompt: bound.text,
    executionPromptSha256: sha256Text(bound.text),
    canvasPreparation: {
      prerequisite: 'the exact package file must be registered as one locked execution_package artifact before a canvas node is prepared',
      userActionAfterReadback: 'user must click Generate in the canvas or explicitly authorize exactly one matching paid submission'
    },
    paidGenerationSubmitted: false,
    submissionBlockers: ['before canvas preparation: register and lock the exact package artifact', 'before paid generation: prepare and read back the LibTV canvas node', 'user must click Generate in the canvas or explicitly authorize exactly one matching paid submission']
  };
}

function assertPackage(value, unitId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('video edit execution package must be an object');
  if (value.kind !== 'seedance25_video_edit_execution_package' || value.executionUnitId !== unitId) throw new Error('execution package does not belong to the requested video edit unit');
  if (value.model !== MODEL || value.operation !== 'video_edit' || !Number.isFinite(value.duration) || !Number.isFinite(value.editorialDuration)
    || value.ratio !== 'adaptive' || value.resolution !== '1080p' || value.generateAudio !== true) {
    throw new Error('video edit package must be Seedance 2.5 1080p with generated audio enabled');
  }
  duration(value.duration, 'video edit package duration');
  duration(value.editorialDuration, 'video edit package editorialDuration');
  if (Math.abs(value.duration - value.editorialDuration) > 0.000001) throw new Error('video edit package duration and editorialDuration must match');
  if (!Array.isArray(value.imageInputs) || value.imageInputs.length < 1 || value.imageInputs.length > 30
    || !Array.isArray(value.videoInputs) || value.videoInputs.length !== 1 || !Array.isArray(value.audioInputs) || value.audioInputs.length !== 0) {
    throw new Error('video edit package requires 1-30 images, 1 video, and no runtime audio inputs');
  }
  if (value.timingAudioEvidence?.runtimeUpload !== false) throw new Error('video edit package must retain timing audio as non-uploaded evidence');
  if (typeof value.executionPromptPath !== 'string' || !SHA256.test(value.executionPromptSha256 ?? '')) throw new Error('video edit package needs a checksum-bound execution prompt');
  if (!Array.isArray(value.mediaBindings) || value.mediaBindings.length !== value.imageInputs.length + value.videoInputs.length) throw new Error('video edit package needs exactly one media binding per runtime input');
  assertExecutionControlContract(value.executionControlContract);
  return value;
}

async function assertPackageProvenance(root, state, value) {
  const prompt = value.compiledFrom?.prompt;
  const narration = value.compiledFrom?.narration;
  if (!prompt || !narration) throw new Error('video edit package lacks prompt or narration provenance');
  const [sourcePrompt, executionPrompt] = await Promise.all([
    inspectArtifactFile(root, projectPath(prompt.path, 'compiledFrom.prompt.path')),
    inspectArtifactFile(root, projectPath(value.executionPromptPath, 'executionPromptPath'))
  ]);
  if (sourcePrompt.sha256 !== sha(prompt.sha256, 'compiledFrom.prompt.sha256') || executionPrompt.sha256 !== value.executionPromptSha256) {
    throw new Error('video edit package prompt provenance checksum changed');
  }
  const narrationArtifact = state.artifacts?.find(item => item.id === narration.id);
  if (!narrationArtifact || narrationArtifact.status !== 'locked' || narrationArtifact.sha256 !== narration.sha256) {
    throw new Error('video edit package narration provenance is no longer locked/current');
  }
  await verifyLockedArtifact(root, narrationArtifact);
  const [sourceText, executionText] = await Promise.all([readFile(sourcePrompt.path, 'utf8'), readFile(executionPrompt.path, 'utf8')]);
  assertSeedanceSourcePromptReferences(sourceText);
  requireCleanSeedanceExecutionPrompt(executionText, { bindings: value.mediaBindings });
  requireSeedanceNarrativePerformancePrompt(executionText);
  return { sourcePrompt, executionPrompt: executionText.trim() };
}

async function verifyRuntimeInput(root, state, item, label) {
  const normalized = asset(item, label);
  const registered = state.artifacts?.find(artifact => artifact.id === normalized.id);
  if (item.derivedFromArtifactId) {
    const sourceArtifactId = text(item.derivedFromArtifactId, `${label}.derivedFromArtifactId`);
    await verifiedFile(root, normalized, label);
    const source = state.artifacts?.find(artifact => artifact.id === sourceArtifactId);
    if (!source || source.status !== 'locked') throw new Error(`derived video requires locked source authority: ${sourceArtifactId}`);
    await verifyLockedArtifact(root, source);
  } else {
    if (!registered || registered.status !== 'locked' || registered.path !== normalized.path || registered.sha256 !== normalized.sha256) {
      throw new Error(`${label} must match a locked registered asset`);
    }
    await verifyLockedArtifact(root, registered);
  }
  return { ...normalized, status: 'locked', absolutePath: (await inspectArtifactFile(root, normalized.path)).path };
}

export async function inspectSeedance25VideoEditExecutionPackage(root, unitId, { libtvProjectUuid, nodeName, model = MODEL } = {}) {
  if (!SAFE_ID.test(unitId ?? '')) throw new Error('video edit unit id must use safe characters');
  if (model !== MODEL) throw new Error('video edit canvas supports Seedance 2.5 only');
  const packagePath = `prompts/${unitId}/seedance25-video-edit-package.json`;
  const packageFile = await inspectArtifactFile(root, packagePath);
  const state = await readJson(join(root, 'project-state.json'));
  const registered = state.artifacts?.filter(item => item.type === 'execution_package' && item.path === packagePath) ?? [];
  if (registered.length !== 1 || registered[0].status !== 'locked' || registered[0].sha256 !== packageFile.sha256) {
    throw new Error('video edit execution package must be exactly one registered locked artifact');
  }
  await verifyLockedArtifact(root, registered[0]);
  const value = assertPackage(JSON.parse(await readFile(packageFile.path, 'utf8')), unitId);
  const provenance = await assertPackageProvenance(root, state, value);
  const [images, videos] = await Promise.all([
    Promise.all(value.imageInputs.map((item, index) => verifyRuntimeInput(root, state, item, `imageInputs[${index}]`))),
    Promise.all(value.videoInputs.map((item, index) => verifyRuntimeInput(root, state, item, `videoInputs[${index}]`)))
  ]);
  const timingArtifact = state.artifacts?.find(item => item.id === value.timingAudioEvidence.id);
  if (!timingArtifact || timingArtifact.status !== 'locked' || timingArtifact.sha256 !== value.timingAudioEvidence.sha256) {
    throw new Error('timing audio evidence is no longer locked/current');
  }
  await verifyLockedArtifact(root, timingArtifact);
  const contract = {
    provider: 'libtv', transport: 'official_cli', projectUuid: libtvProjectUuid, nodeName,
    model: MODEL, modeType: 'videoEdit2video',
    request: { ratio_auto: 'adaptive', duration_auto: 0, resolution: '1080p', enableSound: true, count: 1, searchEnabled: 0, autoCompliance: true }
  };
  const fingerprint = {
    executionUnitId: unitId,
    generationContract: contract,
    executionControlContract: structuredClone(value.executionControlContract),
    packagePath,
    packageSha256: packageFile.sha256,
    sourcePromptPath: value.compiledFrom.prompt.path,
    sourcePromptSha256: provenance.sourcePrompt.sha256,
    executionPromptPath: value.executionPromptPath,
    executionPromptSha256: value.executionPromptSha256,
    inputMedia: {
      image: images.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      video: videos.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      audio: []
    },
    localTimingAudioEvidence: { id: value.timingAudioEvidence.id, sha256: value.timingAudioEvidence.sha256, runtimeUpload: false }
  };
  fingerprint.sha256 = fingerprintHash(fingerprint);
  return {
    value,
    fingerprint,
    input: {
      prompt: provenance.executionPrompt,
      duration: value.duration,
      ratio: 'adaptive',
      resolution: '1080p',
      generateAudio: true,
      imageInputs: images.map(item => item.absolutePath),
      videoInputs: videos.map(item => item.absolutePath),
      audioInputs: []
    },
    plan: { executionUnitId: unitId, executor: 'libtv', mutatesLibTv: false, requiresPaidApproval: true, duration: value.duration, ratio: 'adaptive', resolution: '1080p', generationContract: contract }
  };
}
