import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createSeedance25OperationPlan } from '../domain/seedance25-operation-profile.js';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import {
  assertSeedanceSourcePromptReferences,
  compileSeedanceMediaBoundPrompt
} from './seedance-media-binding-service.js';
import { requireCleanSeedanceExecutionPrompt } from './seedance-prompt-lint-service.js';
import { sha256Text } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';
import { assertAudioExecutionPlan } from '../domain/audio-execution-plan.js';
import { assertProjectState } from '../domain/project-state.js';
import { currentArtifactsOf } from '../domain/current-artifact.js';
import { realismContractsVersionOf } from '../domain/realism-contracts.js';
import { verifyCanonicalPromptSourceForCompilation } from './canonical-prompt-source-service.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_UNIT_ID = /^[A-Za-z0-9._-]+$/;

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

function inRange(value, start, end, field) {
  if (!Number.isFinite(value) || value < start || value > end) throw new TypeError(`${field} must be between ${start} and ${end}`);
  return value;
}

function exactRange(value, expected, field) {
  if (Math.abs(value - expected) > 0.000001) throw new Error(`${field} must equal ${expected}`);
  return value;
}

function asset(item, field) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`${field} must be an object`);
  return {
    id: text(item.assetId, `${field}.assetId`),
    path: projectPath(item.path, `${field}.path`),
    sha256: sha(item.sha256, `${field}.sha256`),
    status: text(item.status, `${field}.status`)
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

function assertCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) throw new TypeError('sourceCoverage must be an object');
  exactRange(coverage.sourceStartSec, 30, 'sourceCoverage.sourceStartSec');
  exactRange(coverage.sourceEndSec, 60, 'sourceCoverage.sourceEndSec');
  exactRange(coverage.durationSec, 30, 'sourceCoverage.durationSec');
  if (!Array.isArray(coverage.canonicalSourceSegments) || coverage.canonicalSourceSegments.length !== 2) {
    throw new Error('sourceCoverage requires exactly two canonical 15-second source segments');
  }
  const expected = [
    ['segment-003', 30, 45, 0, 15],
    ['segment-004', 45, 60, 15, 30]
  ];
  coverage.canonicalSourceSegments.forEach((segment, index) => {
    const [id, sourceStartSec, sourceEndSec, localStartSec, localEndSec] = expected[index];
    if (segment?.segmentId !== id) throw new Error(`sourceCoverage.canonicalSourceSegments[${index}].segmentId must be ${id}`);
    exactRange(segment.sourceStartSec, sourceStartSec, `sourceCoverage.canonicalSourceSegments[${index}].sourceStartSec`);
    exactRange(segment.sourceEndSec, sourceEndSec, `sourceCoverage.canonicalSourceSegments[${index}].sourceEndSec`);
    exactRange(segment.localStartSec, localStartSec, `sourceCoverage.canonicalSourceSegments[${index}].localStartSec`);
    exactRange(segment.localEndSec, localEndSec, `sourceCoverage.canonicalSourceSegments[${index}].localEndSec`);
  });
  if (/segment-005/.test(coverage.identityRule ?? '')) {
    // The wording may reference the legacy identifier only to prohibit using it.
    if (!/must not be selected|不能.*选|不得.*选/u.test(coverage.identityRule)) {
      throw new Error('sourceCoverage must explicitly prohibit legacy segment-005 from representing source 30–60 seconds');
    }
  }
  return coverage;
}

function assertUnit(value, { realismContractsVersion = 1 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('execution unit must be an object');
  if (![1, 2].includes(value.schemaVersion)) throw new TypeError('execution unit schemaVersion 1 or 2 is required');
  if (!SAFE_UNIT_ID.test(value.projectId ?? '')) throw new Error('execution unit projectId must use safe characters');
  text(value.id, 'id');
  text(value.status, 'status');
  if (value.model !== 'Seedance 2.5' || value.operation !== 'standard') {
    throw new Error('only Seedance 2.5 standard-generation execution units are accepted');
  }
  const contract = value.generationContract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new TypeError('generationContract must be an object');
  exactRange(contract.durationSec, 30, 'generationContract.durationSec');
  if (contract.aspectRatio !== '16:9') throw new Error('generationContract.aspectRatio must be 16:9');
  if (contract.resolution !== '480p') throw new Error('generationContract.resolution must be 480p');
  const audioExecutionPlan = value.audioExecutionPlan === undefined
    ? null
    : assertAudioExecutionPlan(value.audioExecutionPlan);
  if (realismContractsVersion === 2 && !audioExecutionPlan) {
    throw new Error('realism contracts v2 require audioExecutionPlan on Seedance 2.5 standard30 units');
  }
  const generateAudio = audioExecutionPlan?.generateAudio ?? true;
  if (contract.generateAudio !== generateAudio) {
    throw new Error(`generationContract.generateAudio must match audioExecutionPlan (${generateAudio})`);
  }
  if (contract.paidGenerationSubmitted !== false) throw new Error('a planning execution unit must not record paidGenerationSubmitted=true');
  assertCoverage(value.sourceCoverage);
  if (!value.prompt || typeof value.prompt !== 'object') throw new TypeError('prompt must be an object');
  projectPath(value.prompt.path, 'prompt.path');
  sha(value.prompt.sha256, 'prompt.sha256');
  if (value.prompt.dualSourceVerification !== undefined) {
    projectPath(value.prompt.dualSourceVerification, 'prompt.dualSourceVerification');
  }
  const binding = value.mediaBinding;
  if (!binding || typeof binding !== 'object') throw new TypeError('mediaBinding must be an object');
  projectPath(binding.path, 'mediaBinding.path');
  sha(binding.sha256, 'mediaBinding.sha256');
  const expectedAudioCount = audioExecutionPlan ? (audioExecutionPlan.approvedSourceAudio ? 1 : 0) : 1;
  if (binding.imageCount !== 9 || binding.videoCount !== 1 || binding.audioCount !== expectedAudioCount) {
    throw new Error(`Seedance 2.5 standard30 unit must contain exactly 9 images, 1 video and ${expectedAudioCount} audio inputs`);
  }
  if (realismContractsVersion === 2) text(value.prompt.assetId, 'prompt.assetId');
  if (value.schemaVersion >= 2) assertExecutionControlContract(value.executionControlContract);
  return value;
}

async function verifiedAsset(root, item) {
  const inspected = await inspectArtifactFile(root, item.path);
  if (inspected.sha256 !== item.sha256) throw new Error(`media checksum changed for ${item.id}`);
  return item;
}

function onlyAssetIds(sourceText) {
  return [...new Set([...sourceText.matchAll(/@素材\[([^\]]+)\]/gu)].map(match => match[1]))].sort();
}

function fingerprintHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function verifiedDualSource(root, prompt) {
  if (!prompt.dualSourceVerification) return null;
  const verificationPath = projectPath(prompt.dualSourceVerification, 'prompt.dualSourceVerification');
  const inspected = await inspectArtifactFile(root, verificationPath);
  const verification = JSON.parse(await readFile(resolve(root, verificationPath), 'utf8'));
  if (verification?.finalStatus !== 'VERIFIED_PASS'
    || verification?.prompt?.sha256 !== prompt.sha256
    || verification?.prompt?.path !== prompt.path) {
    throw new Error('dual-source verification must pass and bind the exact current prompt path and SHA');
  }
  return { path: verificationPath, sha256: inspected.sha256 };
}

/**
 * Compiles a 30-second Seedance 2.5 standard-generation candidate without
 * mutating project-state or calling any external generation surface.  The
 * caller must separately lock the unit and its inputs before it is eligible
 * for canvas preparation or a paid submission.
 */
export async function compileSeedance25Standard30Execution(root, rawUnit) {
  root = resolve(root);
  const state = assertProjectState(await readJson(resolve(root, 'project-state.json')));
  const realismContractsVersion = realismContractsVersionOf(state);
  const unit = assertUnit(rawUnit, { realismContractsVersion });
  let canonicalPromptSource = null;
  if (realismContractsVersion === 2) {
    const promptCandidates = currentArtifactsOf(state.artifacts, artifact => artifact.type === 'seedance_prompt'
      && artifact.id === unit.prompt.assetId && artifact.status === 'locked');
    if (promptCandidates.length !== 1
      || promptCandidates[0].segmentId !== unit.id
      || promptCandidates[0].path !== unit.prompt.path
      || promptCandidates[0].sha256 !== unit.prompt.sha256) {
      throw new Error('realism contracts v2 require the current locked Seedance prompt artifact for this standard30 unit');
    }
    canonicalPromptSource = await verifyCanonicalPromptSourceForCompilation(root, state, promptCandidates[0]);
  }
  const unitPromptPath = projectPath(unit.prompt.path, 'prompt.path');
  const unitBindingPath = projectPath(unit.mediaBinding.path, 'mediaBinding.path');
  const promptFile = await inspectArtifactFile(root, unitPromptPath);
  const bindingFile = await inspectArtifactFile(root, unitBindingPath);
  if (promptFile.sha256 !== unit.prompt.sha256) throw new Error('execution unit prompt SHA no longer matches its file');
  if (bindingFile.sha256 !== unit.mediaBinding.sha256) throw new Error('execution unit media binding SHA no longer matches its file');
  const [sourcePrompt, bindingRaw] = await Promise.all([
    readFile(resolve(root, unitPromptPath), 'utf8'),
    readFile(resolve(root, unitBindingPath), 'utf8').then(JSON.parse)
  ]);
  const dualSource = await verifiedDualSource(root, unit.prompt);
  assertSeedanceSourcePromptReferences(sourcePrompt);
  const expectedAudioCount = unit.audioExecutionPlan ? (unit.audioExecutionPlan.approvedSourceAudio ? 1 : 0) : 1;
  if (!Array.isArray(bindingRaw.images) || bindingRaw.images.length !== 9 || !bindingRaw.video
    || (expectedAudioCount === 1 && !bindingRaw.audio)
    || (expectedAudioCount === 0 && bindingRaw.audio !== undefined)) {
    throw new Error(`media binding must contain exactly 9 images, 1 video and ${expectedAudioCount} audio inputs`);
  }
  const images = bindingRaw.images.map((item, index) => asset(item, `mediaBinding.images[${index}]`));
  const video = asset(bindingRaw.video, 'mediaBinding.video');
  const audio = expectedAudioCount === 1 ? asset(bindingRaw.audio, 'mediaBinding.audio') : null;
  if (audio && unit.audioExecutionPlan?.approvedSourceAudio
    && (audio.id !== unit.audioExecutionPlan.approvedSourceAudio.artifactId
      || audio.sha256 !== unit.audioExecutionPlan.approvedSourceAudio.sha256)) {
    throw new Error('audioExecutionPlan approvedSourceAudio must match the selected standard30 audio input');
  }
  const all = [...images, video, ...(audio ? [audio] : [])];
  const allInputsLocked = all.every(item => item.status === 'locked');
  const ids = all.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('media binding contains duplicate asset ids');
  if (new Set(all.map(item => item.sha256)).size !== all.length) throw new Error('media binding contains duplicate media bytes with ambiguous responsibilities');
  await Promise.all(all.map(item => verifiedAsset(root, item)));
  const sourceIds = onlyAssetIds(sourcePrompt);
  if (JSON.stringify(sourceIds) !== JSON.stringify([...ids].sort())) {
    throw new Error('source prompt media references must match the selected 9+1+1 asset IDs exactly');
  }
  const responsibilities = responsibilityMap(unit.mediaResponsibilities, ids);
  const operationPlan = createSeedance25OperationPlan({
    operation: 'standard_generation', durationSec: 30, outputResolution: '480p',
    imageCount: images.length, videoCount: 1, audioCount: audio ? 1 : 0,
    videoDurationsSec: [30], audioDurationsSec: audio ? [30] : [],
    videoTotalDurationSec: 30, audioTotalDurationSec: audio ? 30 : 0
  });
  const base = {
    executionUnitId: unit.id,
    sourceCoverage: unit.sourceCoverage,
    model: unit.model,
    operation: 'standard_generation',
    duration: 30,
    editorialDuration: 30,
    ratio: '16:9',
    resolution: '480p',
    generateAudio: unit.audioExecutionPlan?.generateAudio ?? true,
    ...(unit.audioExecutionPlan ? { audioExecutionPlan: structuredClone(unit.audioExecutionPlan) } : {}),
    sourcePromptPath: unitPromptPath,
    imageInputs: images.map(({ id, path, sha256, status }) => ({ id, path, sha256, status })),
    videoInputs: [Object.fromEntries(['id', 'path', 'sha256', 'status'].map(key => [key, video[key]]))],
    audioInputs: audio ? [Object.fromEntries(['id', 'path', 'sha256', 'status'].map(key => [key, audio[key]]))] : [],
    responsibilityMap: responsibilities,
    excludedInputs: [],
    hardRuleIds: []
  };
  if (unit.executionControlContract) base.executionControlContract = structuredClone(unit.executionControlContract);
  const bound = compileSeedanceMediaBoundPrompt(sourcePrompt, base);
  requireCleanSeedanceExecutionPrompt(bound.text, { bindings: bound.bindings });
  return {
    schemaVersion: 1,
    kind: 'seedance25_standard30_execution_package',
    status: allInputsLocked
      ? (dualSource ? 'draft_pending_package_registration' : 'draft_pending_dual_source_verification')
      : (dualSource ? 'draft_pending_gate3_lock' : 'draft_pending_gate3_and_dual_source_verification'),
    compiledFrom: {
      executionUnitPath: null,
      executionUnitId: unit.id,
      prompt: { path: unitPromptPath, sha256: promptFile.sha256 },
      mediaBinding: { path: unitBindingPath, sha256: bindingFile.sha256 },
      dualSourceVerification: dualSource,
      ...(canonicalPromptSource ? { canonicalPromptSource: {
        id: canonicalPromptSource.artifact.id,
        revision: canonicalPromptSource.artifact.revision,
        sha256: canonicalPromptSource.artifact.sha256
      } } : {})
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
      ...(allInputsLocked
        ? []
        : ['current execution unit has one or more non-locked media inputs and therefore still requires Gate 3 lock']),
      ...(dualSource ? [] : ['a current Seedance 2.5 dual-source verification must bind this exact prompt SHA']),
      'a canvas node may only be prepared from a registered locked execution package'
    ]
  };
}

function assertLockedStandard30Package(value, unitId, { realismContractsVersion = 1 } = {}) {
  if (!SAFE_UNIT_ID.test(unitId ?? '')) throw new Error('execution unit id must use safe characters');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('standard30 execution package must be an object');
  if (value.kind !== 'seedance25_standard30_execution_package') {
    throw new Error('execution package must be a Seedance 2.5 standard30 package');
  }
  if (value.executionUnitId !== unitId || value.compiledFrom?.executionUnitId !== unitId) {
    throw new Error('execution package does not belong to the requested execution unit');
  }
  const audioExecutionPlan = value.audioExecutionPlan === undefined
    ? null
    : assertAudioExecutionPlan(value.audioExecutionPlan);
  if (realismContractsVersion === 2 && !audioExecutionPlan) {
    throw new Error('realism contracts v2 require audioExecutionPlan on the standard30 package');
  }
  const expectedGenerateAudio = audioExecutionPlan?.generateAudio ?? true;
  if (value.model !== 'Seedance 2.5' || value.operation !== 'standard_generation'
    || value.duration !== 30 || value.editorialDuration !== 30
    || value.ratio !== '16:9' || value.resolution !== '480p' || value.generateAudio !== expectedGenerateAudio) {
    throw new Error(`standard30 execution package must be Seedance 2.5, 30 seconds, 16:9, 480p, with generateAudio=${expectedGenerateAudio}`);
  }
  const expectedAudioCount = audioExecutionPlan ? (audioExecutionPlan.approvedSourceAudio ? 1 : 0) : 1;
  if (!Array.isArray(value.imageInputs) || value.imageInputs.length !== 9
    || !Array.isArray(value.videoInputs) || value.videoInputs.length !== 1
    || !Array.isArray(value.audioInputs) || value.audioInputs.length !== expectedAudioCount) {
    throw new Error(`standard30 execution package must contain exactly 9 images, 1 video and ${expectedAudioCount} audio inputs`);
  }
  if (typeof value.executionPromptPath !== 'string' || !SHA256.test(value.executionPromptSha256 ?? '')) {
    throw new Error('standard30 execution package requires a checksum-bound execution prompt');
  }
  if (!Array.isArray(value.mediaBindings) || value.mediaBindings.length !== 10 + expectedAudioCount) {
    throw new Error(`standard30 execution package requires all ${10 + expectedAudioCount} media bindings`);
  }
  if (realismContractsVersion === 2 && !value.compiledFrom?.canonicalPromptSource) {
    throw new Error('realism contracts v2 require canonical prompt source provenance on the standard30 package');
  }
  return value;
}

async function assertExactInputFiles(root, items, kind) {
  const verified = await Promise.all(items.map(async (item, index) => {
    // Raw media bindings use assetId; compiled execution packages normalize it
    // to id.  Accept only those two explicit spellings at this boundary, then
    // immediately normalize back through the common asset validator.
    const current = asset({ ...item, assetId: item?.assetId ?? item?.id }, `${kind}[${index}]`);
    if (current.status !== 'locked') throw new Error(`${kind}[${index}] must be locked before canvas preparation`);
    const inspected = await inspectArtifactFile(root, current.path);
    if (inspected.sha256 !== current.sha256) throw new Error(`${kind}[${index}] checksum changed for ${current.id}`);
    return { ...current, absolutePath: inspected.path };
  }));
  if (new Set(verified.map(item => item.id)).size !== verified.length) throw new Error(`${kind} contains duplicate asset ids`);
  return verified;
}

async function verifyPackageProvenance(root, value) {
  const source = value.compiledFrom?.prompt;
  const binding = value.compiledFrom?.mediaBinding;
  const dualSource = value.compiledFrom?.dualSourceVerification;
  if (!source || !binding || !dualSource) throw new Error('standard30 execution package lacks its source, binding, or dual-source provenance');
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
    throw new Error('standard30 package provenance checksum changed');
  }
  const [sourceText, bindingRaw, dualRaw, executionPrompt] = await Promise.all([
    readFile(sourceFile.path, 'utf8'),
    readFile(bindingFile.path, 'utf8').then(JSON.parse),
    readFile(dualFile.path, 'utf8').then(JSON.parse),
    readFile(executionFile.path, 'utf8')
  ]);
  assertSeedanceSourcePromptReferences(sourceText);
  if (dualRaw?.finalStatus !== 'VERIFIED_PASS'
    || dualRaw?.prompt?.path !== sourcePath
    || dualRaw?.prompt?.sha256 !== source.sha256) {
    throw new Error('dual-source verification must pass and bind the exact source prompt');
  }
  const expectedAudioCount = value.audioInputs.length;
  if (!Array.isArray(bindingRaw.images) || bindingRaw.images.length !== 9 || !bindingRaw.video
    || (expectedAudioCount === 1 && !bindingRaw.audio)
    || (expectedAudioCount === 0 && bindingRaw.audio !== undefined)) {
    throw new Error(`compiled media binding no longer contains the required 9+1+${expectedAudioCount} inputs`);
  }
  requireCleanSeedanceExecutionPrompt(executionPrompt, { bindings: value.mediaBindings });
  return { sourcePath, bindingPath, dualPath, sourceSha256: sourceFile.sha256, bindingSha256: bindingFile.sha256, dualSha256: dualFile.sha256, executionPrompt: executionPrompt.trim(), executionPromptPath: projectPath(value.executionPromptPath, 'executionPromptPath') };
}

/**
 * Inspects the exact, project-registered 30-second Seedance 2.5 package. This
 * deliberately does not route through the 15-second segment inspector: the
 * 30-second unit spans source segments 003 and 004 and must stay a single,
 * checksum-bound LibTV node.
 */
export async function inspectSeedance25Standard30ExecutionPackage(root, unitId, {
  libtvProjectUuid,
  nodeName,
  model = 'Seedance 2.5'
} = {}) {
  if (!SAFE_UNIT_ID.test(unitId ?? '')) throw new Error('execution unit id must use safe characters');
  if (model !== 'Seedance 2.5') throw new Error('the standard30 canvas supports Seedance 2.5 only');
  const packagePath = `prompts/${unitId}/seedance25-standard30-package.json`;
  const packageFile = await inspectArtifactFile(root, packagePath);
  const state = assertProjectState(await readJson(resolve(root, 'project-state.json')));
  const realismContractsVersion = realismContractsVersionOf(state);
  const value = assertLockedStandard30Package(JSON.parse(await readFile(packageFile.path, 'utf8')), unitId, { realismContractsVersion });
  if (state.videoGovernanceVersion === 2 && value.executionControlContract === undefined) {
    throw new Error('strict video governance requires executionControlContract on Seedance 2.5 standard30 packages');
  }
  if (value.executionControlContract) assertExecutionControlContract(value.executionControlContract);
  if (realismContractsVersion === 2) {
    const promptCandidates = currentArtifactsOf(state.artifacts, artifact => artifact.type === 'seedance_prompt'
      && artifact.segmentId === unitId && artifact.status === 'locked'
      && artifact.path === value.compiledFrom?.prompt?.path && artifact.sha256 === value.compiledFrom?.prompt?.sha256);
    if (promptCandidates.length !== 1) throw new Error('standard30 package lost its current locked Seedance prompt artifact');
    const canonical = await verifyCanonicalPromptSourceForCompilation(root, state, promptCandidates[0]);
    const expected = value.compiledFrom.canonicalPromptSource;
    if (expected.id !== canonical.artifact.id || expected.revision !== canonical.artifact.revision || expected.sha256 !== canonical.artifact.sha256) {
      throw new Error('standard30 package canonical prompt source provenance is stale');
    }
  }
  const registered = (state.artifacts ?? []).filter(artifact => artifact?.path === packagePath);
  if (registered.length !== 1) throw new Error('standard30 package must have exactly one registered project artifact');
  if (registered[0].sha256 !== packageFile.sha256) throw new Error('registered standard30 package checksum changed');
  await verifyLockedArtifact(root, registered[0]);

  const [images, videos, audio, provenance] = await Promise.all([
    assertExactInputFiles(root, value.imageInputs, 'imageInputs'),
    assertExactInputFiles(root, value.videoInputs, 'videoInputs'),
    assertExactInputFiles(root, value.audioInputs, 'audioInputs'),
    verifyPackageProvenance(root, value)
  ]);
  const all = [...images, ...videos, ...audio];
  if (new Set(all.map(item => item.sha256)).size !== all.length) {
    throw new Error('standard30 package contains duplicate media bytes with ambiguous responsibilities');
  }
  const contract = {
    provider: 'libtv', transport: 'official_cli', projectUuid: libtvProjectUuid, nodeName,
    model, modeType: 'mixed2video',
    request: {
      duration: 30, ratio: '16:9', resolution: '480p', enableSound: value.audioExecutionPlan?.enableSound ?? true,
      count: 1, searchEnabled: 0, autoCompliance: true,
      ...(value.executionControlContract?.executionUnitStrategy === 'platform_multi_shot' ? { multi_shots: true } : {})
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
    dualSourceVerification: { path: provenance.dualPath, sha256: provenance.dualSha256 },
    inputMedia: {
      image: images.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      video: videos.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
      audio: audio.map(({ id, path, sha256 }) => ({ id, path, sha256 }))
    }
  };
  fingerprint.sha256 = fingerprintHash(fingerprint);
  return {
    value,
    fingerprint,
    input: {
      prompt: provenance.executionPrompt,
      duration: 30, ratio: '16:9', resolution: '480p', generateAudio: value.audioExecutionPlan?.generateAudio ?? true,
      imageInputs: images.map(item => item.absolutePath),
      videoInputs: videos.map(item => item.absolutePath),
      audioInputs: audio.map(item => item.absolutePath)
    },
    plan: {
      executionUnitId: unitId, executor: 'libtv', mutatesLibTv: false, requiresPaidApproval: true,
      duration: 30, ratio: '16:9', resolution: '480p', generationContract: contract
    }
  };
}
