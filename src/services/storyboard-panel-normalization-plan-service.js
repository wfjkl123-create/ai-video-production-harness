import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { normalizeStoryboardPanel } from './storyboard-panel-normalization-service.js';
import { assertStoryboardPanelNormalizationPlan, requireLockedStoryboardPanelNormalizationSource } from './storyboard-panel-normalization-service.js';
import { runProcess } from '../adapters/process-runner.js';

const PANEL_COUNT = 11;

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function projectPath(value, field) {
  text(value, field);
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`);
}

function safeStem(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

function centeredCrop(width, height, targetWidth, targetHeight) {
  if (targetWidth > width || targetHeight > height) {
    throw new Error('raw storyboard candidate cannot contain the requested common native 9:16 crop');
  }
  return {
    left: Math.floor((width - targetWidth) / 2),
    top: Math.floor((height - targetHeight) / 2),
    width: targetWidth,
    height: targetHeight
  };
}

function commonNativeCellSize(dimensions) {
  const candidate = dimensions.reduce((current, value) => ({
    width: Math.min(current.width, value.width),
    height: Math.min(current.height, value.height)
  }));
  const maxWidth = Math.min(candidate.width, Math.floor((candidate.height * 9) / 16));
  const width = maxWidth - (maxWidth % 9);
  const height = (width / 9) * 16;
  if (width < 9 || height < 16) throw new Error('raw storyboard candidates do not share a usable common 9:16 native crop size');
  return { width, height };
}

async function probePng(path, runner) {
  const result = await runner('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path], { shell: false });
  if (result.code !== 0) throw new Error(`ffprobe failed for ${path}`);
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (stream?.codec_name !== 'png') throw new Error('atomic storyboard candidate must be a PNG');
  positiveInteger(stream.width, 'source width');
  positiveInteger(stream.height, 'source height');
  return { width: stream.width, height: stream.height };
}

function requestById(plan, requestId) {
  const request = plan?.requests?.find(item => item.id === requestId);
  if (!request || request.profileId !== 'storyboard_execution_panel_v1' || request.assetType !== 'storyboard_execution_panel'
    || request.status !== 'PREPARED' || request.lint?.decision !== 'PASS' || !request.storyboardPanel) {
    throw new Error('atomic storyboard candidate must trace to one exact lint-passing storyboard request');
  }
  return request;
}

async function safeDirectory(root, directory) {
  const absolute = resolve(root, directory);
  if (outside(root, absolute)) throw new Error('normalization-plan output directory escapes project root');
  const entries = await readdir(absolute).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  if (entries.length > 0) throw new Error('normalization-plan output directory must be empty before deterministic plan publication');
  try {
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error('normalization-plan output directory cannot be a symlink');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function buildStoryboardPanelNormalizationPlans(root, input, { runner = runProcess } = {}) {
  if (typeof runner !== 'function') throw new TypeError('normalization-plan builder requires a process runner');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('normalization-plan batch must be an object');
  for (const field of ['id', 'projectId', 'segmentId', 'storyboardSequenceId', 'promptPlanPath', 'promptPlanSha256', 'outputDirectory', 'revision']) {
    if (field === 'revision') positiveInteger(input[field], field); else text(input[field], field);
  }
  projectPath(input.promptPlanPath, 'promptPlanPath');
  projectPath(input.outputDirectory, 'outputDirectory');
  if (!/^[a-f0-9]{64}$/.test(input.promptPlanSha256 ?? '')) throw new TypeError('promptPlanSha256 must be a lowercase SHA-256');
  if (!Array.isArray(input.panels) || input.panels.length !== PANEL_COUNT) throw new TypeError('normalization-plan batch must name exactly eleven raw atomic panels');
  const ordered = [...input.panels].sort((left, right) => left.panelIndex - right.panelIndex);
  for (const [index, panel] of ordered.entries()) {
    if (panel.panelIndex !== index + 1) throw new Error('normalization-plan batch panels must be exactly ordered 1 through 11');
    if (panel.promptPlanPath !== undefined) projectPath(panel.promptPlanPath, `panels[${index}].promptPlanPath`);
    if (panel.promptPlanSha256 !== undefined && !/^[a-f0-9]{64}$/.test(panel.promptPlanSha256)) {
      throw new TypeError(`panels[${index}].promptPlanSha256 must be a lowercase SHA-256`);
    }
    if ((panel.promptPlanPath === undefined) !== (panel.promptPlanSha256 === undefined)) {
      throw new TypeError(`panels[${index}] prompt-plan overrides require both path and sha256`);
    }
  }
  const rootPath = resolve(root);
  const state = await readJson((await inspectArtifactFile(rootPath, 'project-state.json')).path);
  const compiledPlans = new Map();
  async function compiledPlan(path, sha256) {
    const key = `${path}:${sha256}`;
    if (compiledPlans.has(key)) return compiledPlans.get(key);
    const inspected = await inspectArtifactFile(rootPath, path);
    if (inspected.sha256 !== sha256) throw new Error('normalization-plan batch prompt-plan checksum changed');
    const compiled = await readJson(inspected.path);
    compiledPlans.set(key, compiled);
    return compiled;
  }
  const sources = [];
  for (const requested of ordered) {
    const promptPlanPath = requested.promptPlanPath ?? input.promptPlanPath;
    const promptPlanSha256 = requested.promptPlanSha256 ?? input.promptPlanSha256;
    const compiled = await compiledPlan(promptPlanPath, promptPlanSha256);
    const raw = state.artifacts?.find(item => item.id === requested.assetId);
    if (!raw || raw.type !== 'storyboard_panel') throw new Error(`raw atomic panel is not registered: ${requested.assetId}`);
    const request = requestById(compiled, raw.sourceRequestId);
    if (request.requestFingerprint !== raw.sourceRequestFingerprint
      || raw.sourcePromptPlanPath !== promptPlanPath
      || raw.sourcePromptPlanSha256 !== promptPlanSha256
      || request.storyboardPanel.panelIndex !== requested.panelIndex
      || request.storyboardPanel.storyboardSequenceId !== input.storyboardSequenceId) {
      throw new Error(`raw atomic panel ${requested.panelIndex} does not trace to the frozen request sequence`);
    }
    const provisional = {
      id: 'provisional', kind: 'storyboard_panel_normalization_plan', projectId: input.projectId,
      segmentId: input.segmentId, storyboardSequenceId: input.storyboardSequenceId,
      source: {
        assetId: raw.id, visualAuditId: raw.visualAuditId, path: raw.path, sha256: raw.sha256,
        revision: raw.revision, panelIndex: raw.panelIndex, shotId: raw.shotId,
        segmentId: raw.segmentId, storyboardSequenceId: raw.storyboardSequenceId,
        sourcePromptPlanPath: raw.sourcePromptPlanPath, sourcePromptPlanSha256: raw.sourcePromptPlanSha256,
        sourceRequestId: raw.sourceRequestId, sourceRequestFingerprint: raw.sourceRequestFingerprint,
        expectedFinalAssetId: raw.expectedFinalAssetId, expectedFinalVisualAuditId: raw.expectedFinalVisualAuditId,
        expectedFinalRevision: raw.expectedFinalRevision
      },
      output: {
        assetId: raw.expectedFinalAssetId, assetType: 'storyboard_execution_panel', path: 'provisional.png',
        revision: raw.expectedFinalRevision, panelIndex: raw.panelIndex, shotId: raw.shotId,
        segmentId: raw.segmentId, storyboardSequenceId: raw.storyboardSequenceId
      },
      crop: { left: 0, top: 0, width: 9, height: 16 }, renderer: 'ffmpeg-lossless-native-storyboard-panel-crop-v1'
    };
    requireLockedStoryboardPanelNormalizationSource(state, provisional);
    const inspected = await inspectArtifactFile(rootPath, raw.path);
    if (inspected.sha256 !== raw.sha256) throw new Error(`raw atomic panel checksum changed: ${raw.id}`);
    sources.push({ raw, request, dimensions: await probePng(inspected.path, runner) });
  }
  await safeDirectory(rootPath, input.outputDirectory);
  const cell = commonNativeCellSize(sources.map(item => item.dimensions));
  const plans = sources.map(({ raw, request, dimensions }) => {
    const crop = centeredCrop(dimensions.width, dimensions.height, cell.width, cell.height);
    const output = {
      assetId: raw.expectedFinalAssetId,
      assetType: 'storyboard_execution_panel',
      path: `${input.outputDirectory}/${safeStem(raw.expectedFinalAssetId)}.png`,
      revision: raw.expectedFinalRevision,
      panelIndex: raw.panelIndex,
      shotId: raw.shotId,
      segmentId: raw.segmentId,
      storyboardSequenceId: raw.storyboardSequenceId
    };
    return assertStoryboardPanelNormalizationPlan({
      id: `${input.id}-panel-${String(raw.panelIndex).padStart(2, '0')}`,
      kind: 'storyboard_panel_normalization_plan', projectId: input.projectId,
      segmentId: input.segmentId, storyboardSequenceId: input.storyboardSequenceId,
      source: {
        assetId: raw.id, visualAuditId: raw.visualAuditId, path: raw.path, sha256: raw.sha256,
        revision: raw.revision, panelIndex: raw.panelIndex, shotId: raw.shotId,
        segmentId: raw.segmentId, storyboardSequenceId: raw.storyboardSequenceId,
        sourcePromptPlanPath: raw.sourcePromptPlanPath, sourcePromptPlanSha256: raw.sourcePromptPlanSha256,
        sourceRequestId: raw.sourceRequestId, sourceRequestFingerprint: raw.sourceRequestFingerprint,
        expectedFinalAssetId: raw.expectedFinalAssetId, expectedFinalVisualAuditId: raw.expectedFinalVisualAuditId,
        expectedFinalRevision: raw.expectedFinalRevision
      },
      output, crop, renderer: 'ffmpeg-lossless-native-storyboard-panel-crop-v1'
    });
  });
  const output = {
    id: input.id, kind: 'storyboard_panel_normalization_plan_batch', projectId: input.projectId,
    segmentId: input.segmentId, storyboardSequenceId: input.storyboardSequenceId,
    promptPlanPath: input.promptPlanPath, promptPlanSha256: input.promptPlanSha256,
    revision: input.revision, outputDirectory: input.outputDirectory,
    nativeCell: { width: cell.width, height: cell.height, aspectRatio: '9:16' },
    plans
  };
  return output;
}

export async function buildAndWriteStoryboardPanelNormalizationPlans(root, input, outputPath, options = {}) {
  const rootPath = resolve(root);
  projectPath(outputPath, 'outputPath');
  const absolute = resolve(rootPath, outputPath);
  if (outside(rootPath, absolute)) throw new Error('normalization-plan batch output escapes project root');
  const built = await buildStoryboardPanelNormalizationPlans(rootPath, input, options);
  await writeJsonAtomic(absolute, built);
  const inspected = await inspectArtifactFile(rootPath, outputPath);
  return { ...built, path: outputPath, sha256: inspected.sha256 };
}

export async function normalizeStoryboardPanelBatch(root, input, outputPath, plansDirectory, options = {}) {
  const rootPath = resolve(root);
  projectPath(outputPath, 'outputPath');
  projectPath(plansDirectory, 'plansDirectory');
  const built = await buildStoryboardPanelNormalizationPlans(rootPath, input, options);
  await safeDirectory(rootPath, plansDirectory);
  await writeJsonAtomic(resolve(rootPath, outputPath), built);
  const planPaths = [];
  for (const plan of built.plans) {
    const planPath = `${plansDirectory}/${safeStem(plan.output.assetId)}.normalization-plan.json`;
    await writeJsonAtomic(resolve(rootPath, planPath), plan);
    planPaths.push(planPath);
  }
  const results = [];
  for (const planPath of planPaths) {
    results.push(await normalizeStoryboardPanel(rootPath, await readJson(resolve(rootPath, planPath)), options));
  }
  const batchInspected = await inspectArtifactFile(rootPath, outputPath);
  return { batchPath: outputPath, batchSha256: batchInspected.sha256, plansDirectory, planPaths, results };
}
