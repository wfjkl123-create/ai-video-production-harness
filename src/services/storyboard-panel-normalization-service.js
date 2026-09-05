import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { inspectArtifactFile } from './artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { runProcess } from '../adapters/process-runner.js';

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

function positiveInt(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
}

function nonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
}

function assertCrop(crop) {
  if (!crop || typeof crop !== 'object' || Array.isArray(crop)) throw new TypeError('crop must be an object');
  for (const key of ['left', 'top', 'width', 'height']) {
    (key === 'left' || key === 'top' ? nonNegativeInt : positiveInt)(crop[key], `crop.${key}`);
  }
  if (crop.width * 16 !== crop.height * 9) throw new TypeError('crop must be exactly 9:16 without scaling');
}

async function safeOutputDirectory(root, directory) {
  if (outside(root, directory)) throw new Error('normalization output directory escapes project root');
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('normalization output directory must not contain symlinks');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (outside(actualRoot, actualDirectory)) throw new Error('normalization output directory escapes project root');
}

export function assertStoryboardPanelNormalizationPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('storyboard panel normalization plan must be an object');
  for (const field of ['id', 'projectId', 'segmentId', 'storyboardSequenceId']) text(plan[field], field);
  if (plan.kind !== 'storyboard_panel_normalization_plan') throw new TypeError('kind must be storyboard_panel_normalization_plan');
  if (plan.renderer !== 'ffmpeg-lossless-native-storyboard-panel-crop-v1') throw new TypeError('renderer must be ffmpeg-lossless-native-storyboard-panel-crop-v1');
  const source = plan.source;
  const output = plan.output;
  for (const [label, value] of [['source', source], ['output', output]]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  }
  for (const field of [
    'assetId', 'visualAuditId', 'path', 'sourcePromptPlanPath', 'sourceRequestId',
    'expectedFinalAssetId', 'expectedFinalVisualAuditId'
  ]) text(source[field], `source.${field}`);
  projectPath(source.path, 'source.path');
  projectPath(source.sourcePromptPlanPath, 'source.sourcePromptPlanPath');
  sha(source.sha256, 'source.sha256');
  sha(source.sourcePromptPlanSha256, 'source.sourcePromptPlanSha256');
  sha(source.sourceRequestFingerprint, 'source.sourceRequestFingerprint');
  positiveInt(source.revision, 'source.revision');
  positiveInt(source.expectedFinalRevision, 'source.expectedFinalRevision');
  positiveInt(source.panelIndex, 'source.panelIndex');
  text(source.shotId, 'source.shotId');
  if (source.segmentId !== plan.segmentId || source.storyboardSequenceId !== plan.storyboardSequenceId) throw new TypeError('source segment/sequence must match the plan');
  for (const field of ['assetId', 'path']) text(output[field], `output.${field}`);
  projectPath(output.path, 'output.path');
  positiveInt(output.revision, 'output.revision');
  if (output.assetType !== 'storyboard_execution_panel') throw new TypeError('output.assetType must be storyboard_execution_panel');
  if (output.segmentId !== plan.segmentId || output.storyboardSequenceId !== plan.storyboardSequenceId
    || output.panelIndex !== source.panelIndex || output.shotId !== source.shotId) {
    throw new TypeError('output identity must exactly preserve the source sequence, panel and shot');
  }
  if (output.assetId !== source.expectedFinalAssetId
    || output.revision !== source.expectedFinalRevision) {
    throw new TypeError('normalization output must use the exact final asset identity and revision frozen by the source atomic request');
  }
  assertCrop(plan.crop);
  return plan;
}

async function probePng(path, runner) {
  const result = await runner('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path], { shell: false });
  if (result.code !== 0) throw new Error(`ffprobe failed for ${path}`);
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (stream?.codec_name !== 'png') throw new Error('storyboard panel source must be a PNG');
  return { width: stream.width, height: stream.height };
}

export function requireLockedStoryboardPanelNormalizationSource(state, plan) {
  const source = state.artifacts?.find(item => item.id === plan.source.assetId);
  if (!source || source.type !== 'storyboard_panel' || source.status !== 'locked'
    || source.assetType !== 'storyboard_execution_panel_candidate'
    || source.segmentId !== plan.segmentId || source.storyboardSequenceId !== plan.storyboardSequenceId
    || source.panelIndex !== plan.source.panelIndex || source.shotId !== plan.source.shotId
    || source.revision !== plan.source.revision || source.path !== plan.source.path || source.sha256 !== plan.source.sha256
    || source.sourcePromptPlanPath !== plan.source.sourcePromptPlanPath
    || source.sourcePromptPlanSha256 !== plan.source.sourcePromptPlanSha256
    || source.sourceRequestId !== plan.source.sourceRequestId
    || source.sourceRequestFingerprint !== plan.source.sourceRequestFingerprint
    || source.expectedFinalAssetId !== plan.source.expectedFinalAssetId
    || source.expectedFinalVisualAuditId !== plan.source.expectedFinalVisualAuditId
    || source.expectedFinalRevision !== plan.source.expectedFinalRevision) {
    throw new Error('normalization source must be the exact locked clean-reviewed raw storyboard panel candidate');
  }
  const audit = state.artifacts?.find(item => item.id === plan.source.visualAuditId);
  if (!audit || audit.type !== 'asset_visual_audit' || audit.status !== 'locked' || audit.decision !== 'PASS'
    || audit.assetId !== source.id || audit.assetType !== source.assetType || audit.assetRevision !== source.revision
    || audit.assetSha256 !== source.sha256 || audit.inspectionMode !== 'multimodal_pixels'
    || audit.inspectorContextMode !== 'clean_zero_context' || audit.blockerCount !== 0) {
    throw new Error('normalization source must have an exact locked clean-zero-context visual PASS');
  }
}

export async function buildStoryboardPanelNormalizationCommand(root, input, { runner = runProcess } = {}) {
  const plan = assertStoryboardPanelNormalizationPlan(input);
  const rootPath = resolve(root);
  const state = await readJson((await inspectArtifactFile(rootPath, 'project-state.json')).path);
  requireLockedStoryboardPanelNormalizationSource(state, plan);
  const inspected = await inspectArtifactFile(rootPath, plan.source.path);
  if (inspected.sha256 !== plan.source.sha256) throw new Error('normalization source checksum changed');
  const dimensions = await probePng(inspected.path, runner);
  if (plan.crop.left + plan.crop.width > dimensions.width || plan.crop.top + plan.crop.height > dimensions.height) {
    throw new Error('normalization crop escapes the locked source PNG');
  }
  const output = resolve(rootPath, plan.output.path);
  if (outside(rootPath, output)) throw new Error('normalization output must stay inside project root');
  if (outside(rootPath, dirname(output))) throw new Error('normalization output directory escapes project root');
  return {
    executable: 'ffmpeg',
    args: ['-v', 'error', '-nostdin', '-i', inspected.path, '-vf', `crop=${plan.crop.width}:${plan.crop.height}:${plan.crop.left}:${plan.crop.top}`, '-frames:v', '1', '-c:v', 'png', '-compression_level', '6', '-n', output],
    output,
    sourcePath: inspected.path
  };
}

export async function normalizeStoryboardPanel(root, input, { runner = runProcess } = {}) {
  const plan = assertStoryboardPanelNormalizationPlan(input);
  const command = await buildStoryboardPanelNormalizationCommand(root, plan, { runner });
  try {
    await access(command.output, constants.F_OK);
    throw new Error('normalized storyboard panel output already exists');
  } catch (error) {
    if (error.message === 'normalized storyboard panel output already exists') throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  await safeOutputDirectory(resolve(root), dirname(command.output));
  const result = await runner(command.executable, command.args, { cwd: resolve(root), shell: false });
  if (result.code !== 0) throw new Error(`lossless storyboard panel crop failed: ${result.stderr ?? ''}`.trim());
  const dimensions = await probePng(command.output, runner);
  if (dimensions.width !== plan.crop.width || dimensions.height !== plan.crop.height) throw new Error('normalization output dimensions changed');
  const inspected = await inspectArtifactFile(root, plan.output.path);
  return { planId: plan.id, sourceAssetId: plan.source.assetId, output: { ...plan.output, sha256: inspected.sha256 }, crop: structuredClone(plan.crop), command };
}
