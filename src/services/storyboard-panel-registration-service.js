import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { registerArtifact } from './intake-service.js';
import { assertStoryboardPanelNormalizationPlan, requireLockedStoryboardPanelNormalizationSource } from './storyboard-panel-normalization-service.js';

const SHA256 = /^[a-f0-9]{64}$/;

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function projectPath(value, field) {
  text(value, field);
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`);
}

function sha(value, field) {
  if (!SHA256.test(value ?? '')) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

export function assertStoryboardPanelRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('storyboard panel registration must be an object');
  for (const field of ['id', 'projectId', 'stage', 'visualAuditId']) text(input[field], field);
  if (input.kind !== 'storyboard_panel_registration') throw new TypeError('kind must be storyboard_panel_registration');
  if (!['raw_candidate', 'final_normalized'].includes(input.stage)) throw new TypeError('stage must be raw_candidate or final_normalized');
  if (input.stage === 'raw_candidate') {
    for (const field of ['promptPlanPath', 'requestId', 'candidatePath']) projectPath(input[field], field);
    sha(input.promptPlanSha256, 'promptPlanSha256');
    sha(input.requestFingerprint, 'requestFingerprint');
  } else {
    projectPath(input.normalizationPlanPath, 'normalizationPlanPath');
    sha(input.normalizationPlanSha256, 'normalizationPlanSha256');
  }
  return input;
}

async function checkedJson(root, path, sha256, label) {
  const inspected = await inspectArtifactFile(root, path);
  if (inspected.sha256 !== sha256) throw new Error(`${label} checksum changed`);
  return { inspected, value: await readJson(inspected.path) };
}

function requestById(plan, id) {
  const request = plan.requests?.find(item => item.id === id);
  if (!request || request.profileId !== 'storyboard_execution_panel_v1' || request.assetType !== 'storyboard_execution_panel'
    || !request.storyboardPanel || request.status !== 'PREPARED' || request.lint?.decision !== 'PASS') {
    throw new Error('registration request must be an exact lint-passing atomic storyboard request');
  }
  return request;
}

function requireFrozenFinalIdentity(request, output) {
  const metadata = request.storyboardPanel;
  if (output.assetId !== metadata.finalAssetId
    || output.revision !== metadata.revision) {
    throw new Error('normalized panel identity does not match the exact atomic request final identity');
  }
}

export async function registerStoryboardPanel(root, input) {
  const registration = assertStoryboardPanelRegistration(input);
  const rootPath = resolve(root);
  if (registration.stage === 'raw_candidate') {
    const { value: plan } = await checkedJson(rootPath, registration.promptPlanPath, registration.promptPlanSha256, 'prompt plan');
    if (plan.projectId !== registration.projectId) throw new Error('prompt plan project does not match registration');
    const request = requestById(plan, registration.requestId);
    if (request.requestFingerprint !== registration.requestFingerprint) throw new Error('atomic request fingerprint does not match registration');
    const metadata = request.storyboardPanel;
    if (registration.visualAuditId !== metadata.rawCandidateVisualAuditId) {
      throw new Error('raw candidate registration must use the exact visual-audit identity frozen by the atomic request');
    }
    const candidate = await inspectArtifactFile(rootPath, registration.candidatePath);
    return registerArtifact(rootPath, {
      id: metadata.rawCandidateAssetId,
      type: 'storyboard_panel',
      assetType: 'storyboard_execution_panel_candidate',
      segmentId: request.segmentId,
      storyboardSequenceId: metadata.storyboardSequenceId,
      panelIndex: metadata.panelIndex,
      shotId: metadata.shotId,
      revision: 1,
      status: 'draft',
      path: registration.candidatePath,
      sha256: candidate.sha256,
      visualAuditId: registration.visualAuditId,
      sourceRequestId: request.id,
      sourceRequestFingerprint: request.requestFingerprint,
      sourcePromptPlanPath: registration.promptPlanPath,
      sourcePromptPlanSha256: registration.promptPlanSha256,
      expectedFinalAssetId: metadata.finalAssetId,
      expectedFinalVisualAuditId: metadata.finalVisualAuditId,
      expectedFinalRevision: metadata.revision
    });
  }
  const { value: plan } = await checkedJson(rootPath, registration.normalizationPlanPath, registration.normalizationPlanSha256, 'normalization plan');
  assertStoryboardPanelNormalizationPlan(plan);
  if (plan.projectId !== registration.projectId) throw new Error('normalization plan project does not match registration');
  const state = await readJson((await inspectArtifactFile(rootPath, 'project-state.json')).path);
  requireLockedStoryboardPanelNormalizationSource(state, plan);
  const raw = state.artifacts.find(item => item.id === plan.source.assetId);
  const { value: promptPlan } = await checkedJson(rootPath, plan.source.sourcePromptPlanPath, plan.source.sourcePromptPlanSha256, 'source prompt plan');
  const request = requestById(promptPlan, plan.source.sourceRequestId);
  if (request.requestFingerprint !== plan.source.sourceRequestFingerprint) {
    throw new Error('normalization source request fingerprint changed');
  }
  requireFrozenFinalIdentity(request, plan.output);
  if (!raw || raw.expectedFinalVisualAuditId !== registration.visualAuditId) {
    throw new Error('final normalized registration must use the exact visual-audit identity frozen by the atomic request');
  }
  const output = await inspectArtifactFile(rootPath, plan.output.path);
  return registerArtifact(rootPath, {
    id: plan.output.assetId,
    type: 'storyboard_panel',
    assetType: 'storyboard_execution_panel',
    segmentId: plan.segmentId,
    storyboardSequenceId: plan.storyboardSequenceId,
    panelIndex: plan.output.panelIndex,
    shotId: plan.output.shotId,
    revision: plan.output.revision,
    status: 'draft',
    path: plan.output.path,
    sha256: output.sha256,
    visualAuditId: registration.visualAuditId,
    sourceCandidateArtifactId: plan.source.assetId,
    sourceCandidateSha256: plan.source.sha256,
    sourceNormalizationPlanPath: registration.normalizationPlanPath,
    sourceNormalizationPlanSha256: registration.normalizationPlanSha256,
    sourceRequestId: plan.source.sourceRequestId,
    sourceRequestFingerprint: plan.source.sourceRequestFingerprint,
    sourcePromptPlanPath: plan.source.sourcePromptPlanPath,
    sourcePromptPlanSha256: plan.source.sourcePromptPlanSha256,
    crop: structuredClone(plan.crop)
  });
}
