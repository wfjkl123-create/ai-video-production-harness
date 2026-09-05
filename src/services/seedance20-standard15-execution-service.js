import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import {
  assertSeedanceSourcePromptReferences,
  compileSeedanceMediaBoundPrompt
} from './seedance-media-binding-service.js';
import { requireCleanSeedanceExecutionPrompt } from './seedance-prompt-lint-service.js';
import { sha256Text } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_UNIT_ID = /^[A-Za-z0-9._-]+$/;
const CURRENT_MODEL = 'Seedance 2.0 VIP';
const HISTORICAL_MODEL = 'Seedance 2.0';
const NO_BGM_SOUND_MODE = 'generated_dialogue_no_bgm';
const DEPTH_ONLY_VISUAL_MODE = 'depth_video_only';
const DIALOGUE_ONLY_ASSERTION = '动作、表情、走位、镜头和切镜时机只由';

function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function checksum(value, field) {
  nonEmpty(value, field);
  if (!SHA256.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
  return value;
}

function projectPath(value, field) {
  nonEmpty(value, field);
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`);
  return value.split(sep).join('/');
}

function exact(value, target, field) {
  if (!Number.isFinite(value) || Math.abs(value - target) > 0.000001) throw new Error(`${field} must equal ${target}`);
  return value;
}

function media(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  const item = {
    id: nonEmpty(value.assetId ?? value.id, `${field}.assetId`),
    path: projectPath(value.path, `${field}.path`),
    sha256: checksum(value.sha256, `${field}.sha256`),
    status: nonEmpty(value.status, `${field}.status`)
  };
  if (value.derived === true) {
    item.derived = true;
    item.derivedFromArtifactId = nonEmpty(value.derivedFromArtifactId, `${field}.derivedFromArtifactId`);
    item.derivedFromReviewId = nonEmpty(value.derivedFromReviewId, `${field}.derivedFromReviewId`);
    if (!value.trim || typeof value.trim !== 'object') throw new TypeError(`${field}.trim must be an object`);
    if (!Number.isFinite(value.trim.start) || !Number.isFinite(value.trim.end) || value.trim.start < 0 || value.trim.end <= value.trim.start) {
      throw new TypeError(`${field}.trim must contain a valid range`);
    }
    item.trim = { start: value.trim.start, end: value.trim.end };
    item.derivation = nonEmpty(value.derivation, `${field}.derivation`);
  }
  return item;
}

function expectedSourceCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) throw new TypeError('sourceCoverage must be an object');
  exact(coverage.sourceStartSec, 30, 'sourceCoverage.sourceStartSec');
  exact(coverage.sourceEndSec, 45, 'sourceCoverage.sourceEndSec');
  exact(coverage.durationSec, 15, 'sourceCoverage.durationSec');
  if (!Array.isArray(coverage.canonicalSourceSegments) || coverage.canonicalSourceSegments.length !== 1) {
    throw new Error('sourceCoverage requires exactly segment-003');
  }
  const source = coverage.canonicalSourceSegments[0];
  if (source?.segmentId !== 'segment-003') throw new Error('sourceCoverage segment must be segment-003');
  exact(source.sourceStartSec, 30, 'sourceCoverage.segment-003.sourceStartSec');
  exact(source.sourceEndSec, 45, 'sourceCoverage.segment-003.sourceEndSec');
  exact(source.localStartSec, 0, 'sourceCoverage.segment-003.localStartSec');
  exact(source.localEndSec, 15, 'sourceCoverage.segment-003.localEndSec');
  return coverage;
}

function idsInPrompt(prompt) {
  return [...new Set([...prompt.matchAll(/@素材\[([^\]]+)\]/gu)].map(match => match[1]))].sort();
}

function fingerprintHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * A locked artifact remains valuable historical evidence, but it must never be
 * eligible for a new paid-capable canvas once a later locked artifact replaces
 * it.  Resolve that from project-state rather than trusting a caller-supplied
 * execution-unit revision.
 */
function assertNotSuperseded(state, artifact, field) {
  const successor = (state.artifacts ?? []).find(candidate => (
    candidate.status === 'locked'
    && candidate.supersedesArtifactId === artifact.id
  ));
  if (successor) throw new Error(`${field} was superseded by locked artifact ${successor.id}`);
  return artifact;
}

function responsibilities(value, ids) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('mediaResponsibilities must be an object');
  const output = {};
  for (const id of ids) {
    const item = value[id];
    if (!item || !Array.isArray(item.controls) || item.controls.length === 0
      || !Array.isArray(item.mustNotControl) || item.mustNotControl.length === 0) {
      throw new Error(`mediaResponsibilities.${id} requires controls and mustNotControl`);
    }
    output[id] = {
      controls: item.controls.map((entry, index) => nonEmpty(entry, `mediaResponsibilities.${id}.controls[${index}]`)),
      mustNotControl: item.mustNotControl.map((entry, index) => nonEmpty(entry, `mediaResponsibilities.${id}.mustNotControl[${index}]`))
    };
  }
  const extras = Object.keys(value).filter(id => !ids.includes(id));
  if (extras.length) throw new Error(`mediaResponsibilities includes unselected asset ids: ${extras.join(', ')}`);
  return output;
}

function isNoBgmSoundPolicy(value) {
  return value?.mode === NO_BGM_SOUND_MODE
    && value.externalAudioInput === false
    && value.backgroundMusic === 'forbidden'
    && value.generatedDialogue === true;
}

function isDepthOnlyVisualPolicy(value) {
  return value?.mode === DEPTH_ONLY_VISUAL_MODE
    && value.promptDescribesVisualActions === false
    && value.depthVideoControlsVisualMotion === true;
}

function assertDialogueOnlyPrompt(prompt) {
  if (!prompt.includes(DIALOGUE_ONLY_ASSERTION)) {
    throw new Error('dialogue-only prompt must delegate visual actions exclusively to the depth video');
  }
  const visualActionDescriptions = [
    '食指停在', '双手提住', '缓步巡视', '送向针脚', '各自稳稳托住',
    '一手扶半身假模', '把假模转正', '先看两位同伴', '再抬食指发问'
  ];
  for (const phrase of visualActionDescriptions) {
    if (prompt.includes(phrase)) throw new Error(`dialogue-only prompt must not describe visual action: ${phrase}`);
  }
}

function assertUnit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('execution unit must be an object');
  if (![1, 2].includes(value.schemaVersion) || !SAFE_UNIT_ID.test(value.projectId ?? '')) throw new Error('execution unit project identity is invalid');
  nonEmpty(value.id, 'id');
  nonEmpty(value.status, 'status');
  if (value.model !== CURRENT_MODEL || value.operation !== 'standard') throw new Error(`unit must be ${CURRENT_MODEL} standard generation`);
  const contract = value.generationContract;
  if (!contract || typeof contract !== 'object') throw new TypeError('generationContract must be an object');
  exact(contract.durationSec, 15, 'generationContract.durationSec');
  if (contract.aspectRatio !== '16:9' || contract.resolution !== '480p' || contract.generateAudio !== true || contract.paidGenerationSubmitted !== false) {
    throw new Error('unit must be 15 seconds, 16:9, 480p, generated audio enabled, and unsubmitted');
  }
  expectedSourceCoverage(value.sourceCoverage);
  if (!value.prompt || typeof value.prompt !== 'object') throw new TypeError('prompt must be an object');
  projectPath(value.prompt.path, 'prompt.path');
  checksum(value.prompt.sha256, 'prompt.sha256');
  if (!value.mediaBinding || typeof value.mediaBinding !== 'object') throw new TypeError('mediaBinding must be an object');
  projectPath(value.mediaBinding.path, 'mediaBinding.path');
  checksum(value.mediaBinding.sha256, 'mediaBinding.sha256');
  if (value.mediaBinding.imageCount !== 6 || value.mediaBinding.videoCount !== 1 || value.mediaBinding.audioCount !== 0) {
    throw new Error('the no-BGM Seedance 2.0 standard15 unit uses exactly 6 images, 1 depth video, and no audio input');
  }
  if (!isNoBgmSoundPolicy(value.soundPolicy)) {
    throw new Error('the unit must explicitly require generated dialogue with no external audio or background music');
  }
  if (!isDepthOnlyVisualPolicy(value.visualActionAuthority)) {
    throw new Error('the unit must explicitly assign all visual actions to the depth-video reference');
  }
  if (value.schemaVersion >= 2) assertExecutionControlContract(value.executionControlContract);
  return value;
}

async function exactMedia(root, state, item, field) {
  const inspected = await inspectArtifactFile(root, item.path);
  if (inspected.sha256 !== item.sha256) throw new Error(`${field} checksum changed for ${item.id}`);
  const sourceId = item.derived ? item.derivedFromArtifactId : item.id;
  const source = (state.artifacts ?? []).find(candidate => candidate.id === sourceId);
  if (!source || source.status !== 'locked') throw new Error(`${field} requires a locked source artifact: ${sourceId}`);
  await verifyLockedArtifact(root, source);
  if (item.derived) {
    if (source.lockedByReviewId !== item.derivedFromReviewId) throw new Error(`${field} derivation review does not match its locked source`);
  } else if (source.path !== item.path || source.sha256 !== item.sha256 || source.lockedByReviewId === undefined) {
    throw new Error(`${field} does not match its locked project artifact`);
  }
  if (item.status !== 'locked') throw new Error(`${field} must be locked before canvas preparation`);
  return { ...item, absolutePath: inspected.path };
}

async function packageProvenance(root, state, value) {
  const source = value.compiledFrom?.prompt;
  const binding = value.compiledFrom?.mediaBinding;
  if (!source || !binding) throw new Error('package lacks source-prompt and media-binding provenance');
  const sourcePath = projectPath(source.path, 'compiledFrom.prompt.path');
  const bindingPath = projectPath(binding.path, 'compiledFrom.mediaBinding.path');
  const [sourceFile, bindingFile, executionFile] = await Promise.all([
    inspectArtifactFile(root, sourcePath),
    inspectArtifactFile(root, bindingPath),
    inspectArtifactFile(root, projectPath(value.executionPromptPath, 'executionPromptPath'))
  ]);
  if (sourceFile.sha256 !== checksum(source.sha256, 'compiledFrom.prompt.sha256')
    || bindingFile.sha256 !== checksum(binding.sha256, 'compiledFrom.mediaBinding.sha256')
    || executionFile.sha256 !== checksum(value.executionPromptSha256, 'executionPromptSha256')) {
    throw new Error('package provenance checksum changed');
  }
  const promptArtifact = (state.artifacts ?? []).find(candidate => candidate.path === sourcePath && candidate.sha256 === sourceFile.sha256);
  if (!promptArtifact || promptArtifact.status !== 'locked') throw new Error('source prompt must be registered and locked before package inspection');
  assertNotSuperseded(state, promptArtifact, 'source prompt');
  await verifyLockedArtifact(root, promptArtifact);
  const [sourceText, bindingRaw, executionPrompt] = await Promise.all([
    readFile(sourceFile.path, 'utf8'),
    readFile(bindingFile.path, 'utf8').then(JSON.parse),
    readFile(executionFile.path, 'utf8')
  ]);
  assertSeedanceSourcePromptReferences(sourceText);
  assertDialogueOnlyPrompt(sourceText);
  requireCleanSeedanceExecutionPrompt(executionPrompt, { bindings: value.mediaBindings });
  return { sourcePath, bindingPath, sourceFile, bindingFile, executionPrompt: executionPrompt.trim() };
}

export async function compileSeedance20Standard15Execution(root, rawUnit) {
  const unit = assertUnit(rawUnit);
  const promptPath = projectPath(unit.prompt.path, 'prompt.path');
  const bindingPath = projectPath(unit.mediaBinding.path, 'mediaBinding.path');
  const [promptFile, bindingFile, sourcePrompt, bindingRaw] = await Promise.all([
    inspectArtifactFile(root, promptPath),
    inspectArtifactFile(root, bindingPath),
    readFile(resolve(root, promptPath), 'utf8'),
    readFile(resolve(root, bindingPath), 'utf8').then(JSON.parse)
  ]);
  if (promptFile.sha256 !== unit.prompt.sha256 || bindingFile.sha256 !== unit.mediaBinding.sha256) {
    throw new Error('execution unit source prompt or media binding checksum no longer matches');
  }
  assertSeedanceSourcePromptReferences(sourcePrompt);
  assertDialogueOnlyPrompt(sourcePrompt);
  if (!Array.isArray(bindingRaw.images) || bindingRaw.images.length !== 6 || !bindingRaw.video || bindingRaw.audio !== undefined) {
    throw new Error('the no-BGM media binding must contain exactly 6 images, 1 video, and no audio');
  }
  const images = bindingRaw.images.map((entry, index) => media(entry, `mediaBinding.images[${index}]`));
  const video = media(bindingRaw.video, 'mediaBinding.video');
  const inputs = [...images, video];
  if (new Set(inputs.map(item => item.id)).size !== inputs.length || new Set(inputs.map(item => item.sha256)).size !== inputs.length) {
    throw new Error('media binding has duplicate identities or ambiguous media bytes');
  }
  const ids = inputs.map(item => item.id);
  if (JSON.stringify(idsInPrompt(sourcePrompt)) !== JSON.stringify([...ids].sort())) {
    throw new Error('source prompt semantic media references must match selected inputs exactly');
  }
  const responsibilityMap = responsibilities(unit.mediaResponsibilities, ids);
  await Promise.all(inputs.map(item => inspectArtifactFile(root, item.path).then(file => {
    if (file.sha256 !== item.sha256) throw new Error(`media checksum changed for ${item.id}`);
  })));
  const base = {
    executionUnitId: unit.id,
    sourceCoverage: unit.sourceCoverage,
    model: CURRENT_MODEL, operation: 'standard_generation', duration: 15, editorialDuration: 15,
    ratio: '16:9', resolution: '480p', generateAudio: true,
    sourcePromptPath: promptPath,
    imageInputs: images.map(({ id, path, sha256, status }) => ({ id, path, sha256, status })),
    videoInputs: [Object.fromEntries(['id', 'path', 'sha256', 'status'].map(key => [key, video[key]]))],
    audioInputs: [],
    soundPolicy: structuredClone(unit.soundPolicy),
    visualActionAuthority: structuredClone(unit.visualActionAuthority),
    ...(unit.executionControlContract ? { executionControlContract: structuredClone(unit.executionControlContract) } : {}),
    responsibilityMap,
    excludedInputs: [], hardRuleIds: []
  };
  const bound = compileSeedanceMediaBoundPrompt(sourcePrompt, base);
  requireCleanSeedanceExecutionPrompt(bound.text, { bindings: bound.bindings });
  return {
    schemaVersion: 1, kind: 'seedance20_standard15_execution_package', status: 'draft_pending_package_registration',
    compiledFrom: { executionUnitPath: null, executionUnitId: unit.id, prompt: { path: promptPath, sha256: promptFile.sha256 }, mediaBinding: { path: bindingPath, sha256: bindingFile.sha256 } },
    ...base,
    mediaBindingContractVersion: bound.contractVersion, mediaBindings: bound.bindings,
    executionPrompt: bound.text, executionPromptSha256: sha256Text(bound.text),
    canvasPreparationAllowed: false, paidGenerationSubmitted: false,
    submissionBlockers: ['a canvas node may only be prepared from this registered, locked package']
  };
}

function assertPackage(value, unitId) {
  if (!SAFE_UNIT_ID.test(unitId ?? '')) throw new Error('execution unit id must use safe characters');
  if (!value || typeof value !== 'object' || value.kind !== 'seedance20_standard15_execution_package') throw new Error('package must be a Seedance 2.0 standard15 package');
  if (value.executionUnitId !== unitId || value.compiledFrom?.executionUnitId !== unitId) throw new Error('package does not belong to the requested execution unit');
  if (![CURRENT_MODEL, HISTORICAL_MODEL].includes(value.model) || value.operation !== 'standard_generation' || value.duration !== 15 || value.editorialDuration !== 15
    || value.ratio !== '16:9' || value.resolution !== '480p' || value.generateAudio !== true) {
    throw new Error('package must be Seedance 2.0, 15 seconds, 16:9, 480p, with generated audio');
  }
  expectedSourceCoverage(value.sourceCoverage);
  if (!Array.isArray(value.imageInputs) || value.imageInputs.length !== 6 || !Array.isArray(value.videoInputs) || value.videoInputs.length !== 1
    || !Array.isArray(value.audioInputs)) {
    throw new Error('package requires exactly 6 images, 1 depth video, and a declared audio-input policy');
  }
  const legacyPercussiveClock = value.audioInputs.length === 1 && value.audioInputs[0]?.derived === true;
  const noBgm = isNoBgmSoundPolicy(value.soundPolicy) && value.audioInputs.length === 0
    && isDepthOnlyVisualPolicy(value.visualActionAuthority);
  if (!legacyPercussiveClock && !noBgm) {
    throw new Error('package audio policy must be either the historical derived clock or no-BGM generated dialogue');
  }
  if (!Array.isArray(value.mediaBindings) || value.mediaBindings.length !== (7 + value.audioInputs.length) || typeof value.executionPromptPath !== 'string' || !SHA256.test(value.executionPromptSha256 ?? '')) {
    throw new Error('package media binding or execution prompt metadata is invalid');
  }
  return value;
}

/** Inspect only an exact registered, locked 00:30–00:45 Seedance 2.0 package. */
export async function inspectSeedance20Standard15ExecutionPackage(root, unitId, {
  libtvProjectUuid, nodeName, model = CURRENT_MODEL
} = {}) {
  if (model !== CURRENT_MODEL) throw new Error(`this package supports the current LibTV ${CURRENT_MODEL} model only`);
  const packagePath = `prompts/${unitId}/seedance20-standard15-package.json`;
  const packageFile = await inspectArtifactFile(root, packagePath);
  const state = await readJson(resolve(root, 'project-state.json'));
  const packageArtifact = (state.artifacts ?? []).find(candidate => candidate.path === packagePath && candidate.sha256 === packageFile.sha256);
  if (!packageArtifact || packageArtifact.status !== 'locked') throw new Error('execution package must be registered and locked before canvas preparation');
  assertNotSuperseded(state, packageArtifact, 'execution package');
  await verifyLockedArtifact(root, packageArtifact);
  const value = assertPackage(JSON.parse(await readFile(packageFile.path, 'utf8')), unitId);
  if (state.videoGovernanceVersion === 2 && value.executionControlContract === undefined) {
    throw new Error('strict video governance requires executionControlContract on Seedance 2.0 standard15 packages');
  }
  if (value.executionControlContract) assertExecutionControlContract(value.executionControlContract);
  if (value.model !== model) throw new Error(`execution package model must equal current LibTV model ${model}`);
  if (!isNoBgmSoundPolicy(value.soundPolicy) || !isDepthOnlyVisualPolicy(value.visualActionAuthority) || value.audioInputs.length !== 0) {
    throw new Error('canvas preparation is restricted to the current no-BGM, depth-video-only, generated-dialogue package');
  }
  const [images, videos, audio, provenance] = await Promise.all([
    Promise.all(value.imageInputs.map((item, index) => exactMedia(root, state, media(item, `imageInputs[${index}]`), `imageInputs[${index}]`))),
    Promise.all(value.videoInputs.map((item, index) => exactMedia(root, state, media(item, `videoInputs[${index}]`), `videoInputs[${index}]`))),
    Promise.all(value.audioInputs.map((item, index) => exactMedia(root, state, media(item, `audioInputs[${index}]`), `audioInputs[${index}]`))),
    packageProvenance(root, state, value)
  ]);
  const contract = {
    provider: 'libtv', transport: 'official_cli', projectUuid: libtvProjectUuid, nodeName,
    model, modeType: 'mixed2video',
    request: {
      duration: 15, ratio: '16:9', resolution: '480p', enableSound: true,
      count: 1, searchEnabled: 0, autoCompliance: true,
      ...(value.executionControlContract?.executionUnitStrategy === 'platform_multi_shot' ? { multi_shots: true } : {})
    }
  };
  const fingerprint = {
    executionUnitId: unitId, generationContract: contract, packagePath, packageSha256: packageFile.sha256,
    ...(value.executionControlContract ? { executionControlContract: structuredClone(value.executionControlContract) } : {}),
    sourcePromptPath: provenance.sourcePath, sourcePromptSha256: provenance.sourceFile.sha256,
    executionPromptPath: value.executionPromptPath, executionPromptSha256: value.executionPromptSha256,
    inputMedia: {
      image: images.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      video: videos.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      audio: audio.map(({ id, path, sha256, derivedFromArtifactId, derivedFromReviewId, trim, derivation }) => ({ id, path, sha256, derivedFromArtifactId, derivedFromReviewId, trim, derivation }))
    }
  };
  fingerprint.sha256 = fingerprintHash(fingerprint);
  return {
    value, fingerprint,
    input: { prompt: provenance.executionPrompt, duration: 15, ratio: '16:9', resolution: '480p', generateAudio: true,
      imageInputs: images.map(item => item.absolutePath), videoInputs: videos.map(item => item.absolutePath), audioInputs: audio.map(item => item.absolutePath) },
    plan: { executionUnitId: unitId, executor: 'libtv', mutatesLibTv: false, requiresPaidApproval: true, duration: 15, ratio: '16:9', resolution: '480p', generationContract: contract }
  };
}
