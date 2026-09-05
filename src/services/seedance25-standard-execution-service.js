import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { createSeedance25OperationPlan } from '../domain/seedance25-operation-profile.js';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { assertSeedanceSourcePromptReferences, compileSeedanceMediaBoundPrompt } from './seedance-media-binding-service.js';
import { requireCleanSeedanceExecutionPrompt, requireSeedanceNarrativePerformancePrompt } from './seedance-prompt-lint-service.js';
import { sha256Text } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RATIOS = new Set(['9:16', '16:9', '1:1']);
const RESOLUTIONS = new Set(['480p', '720p']);

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

function asset(item, field, { timed = false } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`${field} must be an object`);
  const result = {
    id: text(item.assetId, `${field}.assetId`),
    path: projectPath(item.path, `${field}.path`),
    sha256: sha(item.sha256, `${field}.sha256`),
    status: text(item.status, `${field}.status`)
  };
  if (timed) {
    if (!Number.isFinite(item.durationSec) || item.durationSec <= 0) throw new TypeError(`${field}.durationSec must be positive`);
    result.durationSec = item.durationSec;
  }
  return result;
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
  const extras = Object.keys(value).filter(id => !ids.includes(id));
  if (extras.length > 0) throw new Error(`mediaResponsibilities includes unselected asset ids: ${extras.join(', ')}`);
  return result;
}

function assertUnit(value, projectId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('execution unit must be an object');
  if (value.schemaVersion !== 1) throw new TypeError('execution unit schemaVersion 1 is required');
  if (value.projectId !== projectId) throw new Error(`execution unit projectId must match ${projectId}`);
  text(value.id, 'id');
  if (!SAFE_ID.test(value.id)) throw new Error('execution unit id must use safe characters');
  text(value.segmentId, 'segmentId');
  text(value.status, 'status');
  if (value.model !== 'Seedance 2.5' || value.operation !== 'standard') {
    throw new Error('only Seedance 2.5 standard-generation execution units are accepted');
  }
  const contract = value.generationContract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new TypeError('generationContract must be an object');
  if (!Number.isFinite(contract.durationSec) || contract.durationSec < 4 || contract.durationSec > 30) {
    throw new Error('generationContract.durationSec must be between 4 and 30');
  }
  if (!RATIOS.has(contract.aspectRatio)) throw new Error('generationContract.aspectRatio must be 9:16, 16:9, or 1:1');
  if (!RESOLUTIONS.has(contract.resolution)) throw new Error('generationContract.resolution must be 480p or 720p');
  if (contract.generateAudio !== true || contract.enableSound !== true) throw new Error('generateAudio and enableSound must both remain true');
  if (contract.paidGenerationSubmitted !== false) throw new Error('a planning execution unit must not record paidGenerationSubmitted=true');
  if (!value.prompt || typeof value.prompt !== 'object') throw new TypeError('prompt must be an object');
  for (const field of ['path', 'narrativePerformanceReport']) projectPath(value.prompt[field], `prompt.${field}`);
  sha(value.prompt.sha256, 'prompt.sha256');
  if (value.prompt.dualSourceVerification !== undefined) projectPath(value.prompt.dualSourceVerification, 'prompt.dualSourceVerification');
  if (!value.mediaBinding || typeof value.mediaBinding !== 'object') throw new TypeError('mediaBinding must be an object');
  projectPath(value.mediaBinding.path, 'mediaBinding.path');
  sha(value.mediaBinding.sha256, 'mediaBinding.sha256');
  assertExecutionControlContract(value.executionControlContract);
  return value;
}

async function exactReport(root, prompt, field, requiredStatus, expectedDuration) {
  const reportPath = projectPath(prompt[field], `prompt.${field}`);
  const file = await inspectArtifactFile(root, reportPath);
  const report = JSON.parse(await readFile(file.path, 'utf8'));
  const status = report.status ?? report.finalStatus;
  if (status !== requiredStatus || report.promptSha256 !== prompt.sha256 && report.prompt?.sha256 !== prompt.sha256) {
    throw new Error(`${field} must ${requiredStatus === 'PASS' ? 'pass' : 'verify'} and bind the exact current prompt SHA`);
  }
  if (field === 'narrativePerformanceReport' && report.duration !== expectedDuration) {
    throw new Error('narrativePerformanceReport duration must match the generation contract');
  }
  const reportPromptPath = report.promptPath ?? report.prompt?.path;
  if (reportPromptPath && !reportPromptPath.endsWith(prompt.path)) {
    throw new Error(`${field} must bind the exact current prompt path`);
  }
  return { path: reportPath, sha256: file.sha256 };
}

async function verifySelectedArtifact(root, state, item) {
  if (item.status !== 'locked') throw new Error(`media input ${item.id} must be locked`);
  const matches = (state.artifacts ?? []).filter(artifact => artifact.id === item.id);
  if (matches.length !== 1) throw new Error(`media input ${item.id} must map to exactly one project-state artifact`);
  const artifact = matches[0];
  if (artifact.path !== item.path || artifact.sha256 !== item.sha256 || artifact.status !== 'locked') {
    throw new Error(`media input ${item.id} does not match its locked project-state artifact`);
  }
  await verifyLockedArtifact(root, artifact);
}

function selectedIds(sourceText) {
  return [...new Set([...sourceText.matchAll(/@素材\[([^\]]+)\]/gu)].map(match => match[1]))].sort();
}

export async function compileSeedance25StandardExecution(root, rawUnit) {
  root = resolve(root);
  const state = await readJson(resolve(root, 'project-state.json'));
  const unit = assertUnit(rawUnit, state.projectId);
  const promptPath = projectPath(unit.prompt.path, 'prompt.path');
  const bindingPath = projectPath(unit.mediaBinding.path, 'mediaBinding.path');
  const [promptFile, bindingFile] = await Promise.all([
    inspectArtifactFile(root, promptPath),
    inspectArtifactFile(root, bindingPath)
  ]);
  if (promptFile.sha256 !== unit.prompt.sha256) throw new Error('execution unit prompt SHA no longer matches its file');
  if (bindingFile.sha256 !== unit.mediaBinding.sha256) throw new Error('execution unit media binding SHA no longer matches its file');
  const [sourcePrompt, bindingRaw] = await Promise.all([
    readFile(promptFile.path, 'utf8'),
    readFile(bindingFile.path, 'utf8').then(JSON.parse)
  ]);
  assertSeedanceSourcePromptReferences(sourcePrompt);
  const images = (bindingRaw.images ?? []).map((item, index) => asset(item, `mediaBinding.images[${index}]`));
  const videos = (bindingRaw.videos ?? []).map((item, index) => asset(item, `mediaBinding.videos[${index}]`, { timed: true }));
  const audios = (bindingRaw.audios ?? []).map((item, index) => asset(item, `mediaBinding.audios[${index}]`, { timed: true }));
  const all = [...images, ...videos, ...audios];
  if (all.length === 0) throw new Error('media binding must contain at least one selected input');
  const ids = all.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('media binding contains duplicate asset ids');
  if (new Set(all.map(item => item.sha256)).size !== all.length) throw new Error('media binding contains duplicate media bytes with ambiguous responsibilities');
  if (JSON.stringify(selectedIds(sourcePrompt)) !== JSON.stringify([...ids].sort())) {
    throw new Error('source prompt media references must match the selected asset IDs exactly');
  }
  await Promise.all(all.map(item => verifySelectedArtifact(root, state, item)));
  const responsibilities = responsibilityMap(unit.mediaResponsibilities, ids);
  const duration = unit.generationContract.durationSec;
  const narrativePerformance = await exactReport(root, unit.prompt, 'narrativePerformanceReport', 'PASS', duration);
  const dualSource = unit.prompt.dualSourceVerification
    ? await exactReport(root, unit.prompt, 'dualSourceVerification', 'VERIFIED_PASS', duration)
    : null;
  const operationPlan = createSeedance25OperationPlan({
    operation: 'standard_generation',
    durationSec: duration,
    outputResolution: unit.generationContract.resolution,
    imageCount: images.length,
    videoCount: videos.length,
    audioCount: audios.length,
    videoDurationsSec: videos.map(item => item.durationSec),
    audioDurationsSec: audios.map(item => item.durationSec),
    videoTotalDurationSec: videos.reduce((sum, item) => sum + item.durationSec, 0),
    audioTotalDurationSec: audios.reduce((sum, item) => sum + item.durationSec, 0)
  });
  const base = {
    executionUnitId: unit.id,
    projectId: unit.projectId,
    segmentId: unit.segmentId,
    model: unit.model,
    operation: 'standard_generation',
    duration,
    editorialDuration: duration,
    ratio: unit.generationContract.aspectRatio,
    resolution: unit.generationContract.resolution,
    generateAudio: true,
    enableSound: true,
    sourcePromptPath: promptPath,
    imageInputs: images,
    videoInputs: videos,
    audioInputs: audios,
    responsibilityMap: responsibilities,
    excludedInputs: [...(unit.excludedInputs ?? [])],
    hardRuleIds: [...(unit.hardRuleIds ?? [])],
    executionControlContract: structuredClone(unit.executionControlContract)
  };
  const bound = compileSeedanceMediaBoundPrompt(sourcePrompt, base);
  requireCleanSeedanceExecutionPrompt(bound.text, { bindings: bound.bindings });
  requireSeedanceNarrativePerformancePrompt(bound.text);
  return {
    schemaVersion: 1,
    kind: 'seedance25_standard_execution_package',
    status: dualSource ? 'draft_pending_package_registration' : 'draft_pending_dual_source_verification',
    compiledFrom: {
      executionUnitPath: null,
      executionUnitId: unit.id,
      prompt: { path: promptPath, sha256: promptFile.sha256 },
      mediaBinding: { path: bindingPath, sha256: bindingFile.sha256 },
      narrativePerformanceReport: narrativePerformance,
      dualSourceVerification: dualSource
    },
    ...base,
    mediaBindingContractVersion: bound.contractVersion,
    mediaBindings: bound.bindings,
    executionPrompt: bound.text,
    executionPromptSha256: sha256Text(bound.text),
    operationPlan: {
      requested: operationPlan.requested,
      stabilityWarnings: operationPlan.stabilityWarnings,
      evidenceStatus: operationPlan.evidenceStatus
    },
    canvasPreparationAllowed: false,
    paidGenerationSubmitted: false,
    submissionBlockers: [
      ...(dualSource ? [] : ['a current Seedance 2.5 dual-source verification must bind this exact prompt SHA']),
      'the current live model alias, parameter surface and pricing snapshot must be read back before canvas preparation',
      'a canvas node may only be prepared from a registered locked execution package'
    ]
  };
}

function fingerprintHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertLockedStandardPackage(value, unitId) {
  if (!SAFE_ID.test(unitId ?? '')) throw new Error('execution unit id must use safe characters');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('standard execution package must be an object');
  if (value.kind !== 'seedance25_standard_execution_package') {
    throw new Error('execution package must be a Seedance 2.5 standard package');
  }
  if (value.executionUnitId !== unitId || value.compiledFrom?.executionUnitId !== unitId) {
    throw new Error('execution package does not belong to the requested execution unit');
  }
  if (value.model !== 'Seedance 2.5' || value.operation !== 'standard_generation' || value.generateAudio !== true) {
    throw new Error('standard execution package must be Seedance 2.5 standard generation with generated audio enabled');
  }
  if (!Number.isFinite(value.duration) || value.duration < 4 || value.duration > 30) {
    throw new Error('standard execution package duration must stay inside the live 4-30 second surface');
  }
  if (!RATIOS.has(value.ratio) || !RESOLUTIONS.has(value.resolution)) {
    throw new Error('standard execution package ratio or resolution left the validated surface');
  }
  for (const [field, list] of [['imageInputs', value.imageInputs], ['videoInputs', value.videoInputs], ['audioInputs', value.audioInputs]]) {
    if (!Array.isArray(list)) throw new TypeError(`${field} must be an array`);
  }
  if (value.imageInputs.length + value.videoInputs.length + value.audioInputs.length === 0) {
    throw new Error('standard execution package requires at least one media input');
  }
  if (typeof value.executionPromptPath !== 'string' || !SHA256.test(value.executionPromptSha256 ?? '')) {
    throw new Error('standard execution package requires a checksum-bound execution prompt');
  }
  if (!Array.isArray(value.mediaBindings)
    || value.mediaBindings.length !== (value.imageInputs.length + value.videoInputs.length + value.audioInputs.length)) {
    throw new Error('standard execution package media bindings must cover every input exactly once');
  }
  return value;
}

async function assertExactInputFiles(root, items, kind) {
  const verified = await Promise.all(items.map(async (item, index) => {
    const current = asset({ ...item, assetId: item?.assetId ?? item?.id }, `${kind}[${index}]`);
    if (current.status !== 'locked') throw new Error(`${kind}[${index}] must be locked before canvas preparation`);
    const inspected = await inspectArtifactFile(root, current.path);
    if (inspected.sha256 !== current.sha256) throw new Error(`${kind}[${index}] checksum changed for ${current.id}`);
    return { ...current, absolutePath: inspected.path };
  }));
  if (new Set(verified.map(item => item.id)).size !== verified.length) throw new Error(`${kind} contains duplicate asset ids`);
  return verified;
}

async function verifyStandardPackageProvenance(root, value) {
  const source = value.compiledFrom?.prompt;
  const binding = value.compiledFrom?.mediaBinding;
  const dualSource = value.compiledFrom?.dualSourceVerification;
  if (!source || !binding || !dualSource) throw new Error('standard execution package lacks its source, binding, or dual-source provenance');
  const sourcePath = projectPath(source.path, 'compiledFrom.prompt.path');
  const bindingPath = projectPath(binding.path, 'compiledFrom.mediaBinding.path');
  const dualPath = projectPath(dualSource.path, 'compiledFrom.dualSourceVerification.path');
  const [sourceFile, bindingFile, dualFile, executionFile] = await Promise.all([
    inspectArtifactFile(root, sourcePath),
    inspectArtifactFile(root, bindingPath),
    inspectArtifactFile(root, dualPath),
    inspectArtifactFile(root, projectPath(value.executionPromptPath, 'executionPromptPath'))
  ]);
  if (sourceFile.sha256 !== sha(source.sha256, 'compiledFrom.prompt.sha256')
    || bindingFile.sha256 !== sha(binding.sha256, 'compiledFrom.mediaBinding.sha256')
    || dualFile.sha256 !== sha(dualSource.sha256, 'compiledFrom.dualSourceVerification.sha256')
    || executionFile.sha256 !== value.executionPromptSha256) {
    throw new Error('standard package provenance checksum changed');
  }
  const [sourceText, executionPrompt, dualRaw] = await Promise.all([
    readFile(sourceFile.path, 'utf8'),
    readFile(executionFile.path, 'utf8'),
    readFile(dualFile.path, 'utf8').then(JSON.parse)
  ]);
  assertSeedanceSourcePromptReferences(sourceText);
  if (dualRaw?.finalStatus !== 'VERIFIED_PASS'
    || !(typeof dualRaw?.prompt?.path === 'string' && dualRaw.prompt.path.split(/[\\/]+/).join('/').endsWith(sourcePath))
    || dualRaw?.prompt?.sha256 !== source.sha256) {
    throw new Error('dual-source verification must pass and bind the exact source prompt');
  }
  requireCleanSeedanceExecutionPrompt(executionPrompt, { bindings: value.mediaBindings });
  requireSeedanceNarrativePerformancePrompt(executionPrompt);
  return { sourcePath, sourceSha256: sourceFile.sha256, executionPrompt: executionPrompt.trim(), executionPromptPath: projectPath(value.executionPromptPath, 'executionPromptPath') };
}

/**
 * Inspects the exact, project-registered Seedance 2.5 standard-generation
 * package (any 4-30 second duration, 9:16/16:9/1:1, 480p/720p). Unlike the
 * 30-second one-shot inspector this stays generic over the validated surface
 * of compile-seedance25-standard, so same-shape projects reuse one path.
 * Canvas preparation still never submits the paid run: the user clicks
 * generation on the canvas after reading the node back.
 */
export async function inspectSeedance25StandardExecutionPackage(root, unitId, {
  libtvProjectUuid,
  nodeName,
  model = 'Seedance 2.5'
} = {}) {
  if (model !== 'Seedance 2.5') throw new Error('the standard canvas supports Seedance 2.5 only');
  const packagePath = `prompts/${unitId}/seedance25-standard-package.json`;
  const packageFile = await inspectArtifactFile(root, packagePath);
  const value = assertLockedStandardPackage(JSON.parse(await readFile(packageFile.path, 'utf8')), unitId);
  if (value.executionControlContract) assertExecutionControlContract(value.executionControlContract);
  const state = await readJson(resolve(root, 'project-state.json'));
  // Superseded revisions keep their historical path but bind an older checksum;
  // only the artifact whose SHA matches the current file is the live package.
  const registered = (state.artifacts ?? []).filter(artifact => artifact?.path === packagePath && artifact?.sha256 === packageFile.sha256);
  if (registered.length !== 1) throw new Error('standard package must have exactly one registered project artifact binding the current checksum');
  await verifyLockedArtifact(root, registered[0]);

  const [images, videos, audio, provenance] = await Promise.all([
    assertExactInputFiles(root, value.imageInputs, 'imageInputs'),
    assertExactInputFiles(root, value.videoInputs, 'videoInputs'),
    assertExactInputFiles(root, value.audioInputs, 'audioInputs'),
    verifyStandardPackageProvenance(root, value)
  ]);
  const all = [...images, ...videos, ...audio];
  if (new Set(all.map(item => item.sha256)).size !== all.length) {
    throw new Error('standard package contains duplicate media bytes with ambiguous responsibilities');
  }
  const contract = {
    provider: 'libtv', transport: 'official_cli', projectUuid: libtvProjectUuid, nodeName,
    model, modeType: 'mixed2video',
    request: {
      duration: value.duration, ratio: value.ratio, resolution: value.resolution, enableSound: true,
      count: 1, searchEnabled: 0, autoCompliance: true
    }
  };
  const fingerprint = {
    executionUnitId: unitId,
    generationContract: contract,
    ...(value.executionControlContract ? { executionControlContract: structuredClone(value.executionControlContract) } : {}),
    packagePath,
    packageSha256: packageFile.sha256,
    sourcePromptPath: provenance.sourcePath,
    sourcePromptSha256: provenance.sourceSha256,
    executionPromptPath: provenance.executionPromptPath,
    executionPromptSha256: value.executionPromptSha256,
    dualSourceVerification: { path: projectPath(value.compiledFrom.dualSourceVerification.path, 'compiledFrom.dualSourceVerification.path'), sha256: sha(value.compiledFrom.dualSourceVerification.sha256, 'compiledFrom.dualSourceVerification.sha256') },
    inputMedia: {
      images: images.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      videos: videos.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      audio: audio.map(({ id, path, sha256 }) => ({ id, path, sha256 }))
    }
  };
  fingerprint.sha256 = fingerprintHash(fingerprint);
  return {
    value,
    fingerprint,
    input: {
      prompt: provenance.executionPrompt,
      duration: value.duration, ratio: value.ratio, resolution: value.resolution, generateAudio: true,
      imageInputs: images.map(item => item.absolutePath),
      videoInputs: videos.map(item => item.absolutePath),
      audioInputs: audio.map(item => item.absolutePath)
    },
    plan: {
      executionUnitId: unitId, executor: 'libtv', mutatesLibTv: false, requiresPaidApproval: true,
      duration: value.duration, ratio: value.ratio, resolution: value.resolution, generationContract: contract
    }
  };
}
