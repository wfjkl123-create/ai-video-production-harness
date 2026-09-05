import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectArtifactFile } from './artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { registerArtifact } from './intake-service.js';
import { loadCanonicalSegments } from '../commands/assets.js';
import { runProcess } from '../adapters/process-runner.js';

const SHA256 = /^[a-f0-9]{64}$/;
const PANEL_COUNT = 11;

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

function rect(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  for (const key of ['left', 'top', 'width', 'height']) {
    if (!Number.isInteger(value[key]) || value[key] < 0) throw new TypeError(`${field}.${key} must be a non-negative integer`);
  }
  if (value.width < 1 || value.height < 1) throw new TypeError(`${field} dimensions must be positive`);
}

function sameBytesHash(left, right) {
  return left === right;
}

function requireCurrentSegmentation(state, plan) {
  const candidates = (state.artifacts ?? [])
    .filter(item => item.type === 'segmentation' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (candidates.length === 0) throw new Error('contact sheet requires a current locked segmentation');
  if (candidates.length > 1 && candidates[0].revision === candidates[1].revision) {
    throw new Error('contact sheet cannot choose between multiple current locked segmentations');
  }
  const segmentation = candidates[0];
  if (segmentation.id !== plan.segmentationId || segmentation.sha256 !== plan.segmentationSha256) {
    throw new Error('contact sheet segmentation binding must match the current locked segmentation exactly');
  }
  return segmentation;
}

export function assertStoryboardContactSheetPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('storyboard contact-sheet plan must be an object');
  for (const field of ['id', 'assetId', 'visualAuditId', 'projectId', 'segmentId', 'storyboardSequenceId', 'segmentationId', 'outputPath']) text(plan[field], field);
  if (!Number.isInteger(plan.revision) || plan.revision < 1) throw new TypeError('revision must be a positive integer');
  if (!SHA256.test(plan.segmentationSha256 ?? '')) throw new TypeError('segmentationSha256 must be a lowercase SHA-256');
  if (plan.kind !== 'storyboard_contact_sheet_plan') throw new TypeError('kind must be storyboard_contact_sheet_plan');
  if (plan.layoutProfile !== 'storyboard-contact-sheet-v1') throw new TypeError('layoutProfile must be storyboard-contact-sheet-v1');
  if (plan.renderer !== 'ffmpeg-lossless-native-storyboard-contact-sheet-v1') throw new TypeError('renderer must be ffmpeg-lossless-native-storyboard-contact-sheet-v1');
  if (!plan.canvas || !Number.isInteger(plan.canvas.width) || !Number.isInteger(plan.canvas.height)
    || plan.canvas.width < 36 || plan.canvas.height < 64 || plan.canvas.aspectRatio !== '3:4') {
    throw new TypeError('canvas must be a positive 3:4 storyboard sheet');
  }
  if (!plan.grid || plan.grid.rows !== 3 || plan.grid.columns !== 4
    || !Number.isInteger(plan.grid.cellWidth) || !Number.isInteger(plan.grid.cellHeight)
    || plan.grid.cellWidth < 9 || plan.grid.cellHeight < 16 || plan.grid.cellWidth * 16 !== plan.grid.cellHeight * 9
    || plan.canvas.width !== plan.grid.cellWidth * 4 || plan.canvas.height !== plan.grid.cellHeight * 3
    || plan.grid.terminalBlankCell?.row !== 3 || plan.grid.terminalBlankCell?.column !== 4) {
    throw new TypeError('grid must be a 3-by-4 360x640 sheet with the terminal row-3 column-4 cell blank');
  }
  if (!Array.isArray(plan.panels) || plan.panels.length !== PANEL_COUNT) throw new TypeError('contact-sheet plan must contain exactly eleven active panels');
  const seen = new Set();
  for (const [index, panel] of plan.panels.entries()) {
    if (!Number.isInteger(panel.panelIndex) || panel.panelIndex !== index + 1 || panel.panelIndex < 1 || panel.panelIndex > PANEL_COUNT) {
      throw new TypeError(`panels[${index}].panelIndex must be its ordered 1-based index`);
    }
    if (seen.has(panel.panelIndex)) throw new TypeError(`duplicate panel index ${panel.panelIndex}`);
    seen.add(panel.panelIndex);
    for (const field of ['assetId', 'visualAuditId', 'shotId', 'storyboardSequenceId']) text(panel[field], `panels[${index}].${field}`);
    if (panel.storyboardSequenceId !== plan.storyboardSequenceId) throw new TypeError(`panels[${index}] storyboardSequenceId must match the plan`);
    if (panel.segmentId !== plan.segmentId) throw new TypeError(`panels[${index}] segmentId must match the plan`);
    if (!Number.isInteger(panel.revision) || panel.revision < 1) throw new TypeError(`panels[${index}].revision must be positive`);
    projectPath(panel.path, `panels[${index}].path`);
    if (!SHA256.test(panel.sha256 ?? '')) throw new TypeError(`panels[${index}].sha256 must be a lowercase SHA-256`);
    rect(panel.destinationRect, `panels[${index}].destinationRect`);
    const expectedLeft = (index % 4) * plan.grid.cellWidth;
    const expectedTop = Math.floor(index / 4) * plan.grid.cellHeight;
    const target = panel.destinationRect;
    if (target.left !== expectedLeft || target.top !== expectedTop || target.width !== plan.grid.cellWidth || target.height !== plan.grid.cellHeight) {
      throw new TypeError(`panels[${index}] must occupy its exact native 9:16 grid cell`);
    }
  }
  projectPath(plan.outputPath, 'outputPath');
  return plan;
}

async function safeOutputDirectory(root, directory) {
  if (outside(root, directory)) throw new Error('contact-sheet output directory escapes project root');
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('contact-sheet output directory must not contain symlinks');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (outside(actualRoot, actualDirectory)) throw new Error('contact-sheet output directory escapes project root');
}

async function probePng(path, runner) {
  const result = await runner('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path], { shell: false });
  if (result.code !== 0) throw new Error(`ffprobe failed for ${path}`);
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (stream?.codec_name !== 'png') throw new Error('storyboard contact-sheet source must be a PNG');
  return { width: stream.width, height: stream.height };
}

function requirePanelAudit(state, panel) {
  const source = (state.artifacts ?? []).find(item => item.id === panel.assetId);
  if (!source || source.type !== 'storyboard_panel' || source.status !== 'locked'
    || source.assetType !== 'storyboard_execution_panel' || source.segmentId !== panel.segmentId
    || source.storyboardSequenceId !== panel.storyboardSequenceId || source.panelIndex !== panel.panelIndex
    || source.revision !== panel.revision || source.path !== panel.path || source.sha256 !== panel.sha256) {
    throw new Error(`panel ${panel.panelIndex} is not the exact locked atomic storyboard asset for this sequence`);
  }
  if (typeof source.sourceCandidateArtifactId !== 'string'
    || typeof source.sourceRequestId !== 'string'
    || typeof source.sourceRequestFingerprint !== 'string'
    || typeof source.sourcePromptPlanPath !== 'string'
    || typeof source.sourcePromptPlanSha256 !== 'string') {
    throw new Error(`panel ${panel.panelIndex} is missing exact raw-request provenance`);
  }
  const raw = (state.artifacts ?? []).find(item => item.id === source.sourceCandidateArtifactId);
  if (!raw || raw.type !== 'storyboard_panel'
    || raw.assetType !== 'storyboard_execution_panel_candidate'
    || raw.expectedFinalAssetId !== source.id
    || raw.expectedFinalVisualAuditId !== panel.visualAuditId
    || raw.expectedFinalRevision !== source.revision
    || raw.sourceRequestId !== source.sourceRequestId
    || raw.sourceRequestFingerprint !== source.sourceRequestFingerprint
    || raw.sourcePromptPlanPath !== source.sourcePromptPlanPath
    || raw.sourcePromptPlanSha256 !== source.sourcePromptPlanSha256) {
    throw new Error(`panel ${panel.panelIndex} final identity does not match its exact registered raw atomic request`);
  }
  const audit = (state.artifacts ?? []).find(item => item.id === panel.visualAuditId);
  if (!audit || audit.type !== 'asset_visual_audit' || audit.status !== 'locked' || audit.decision !== 'PASS'
    || audit.assetId !== panel.assetId || audit.assetType !== 'storyboard_execution_panel'
    || audit.assetRevision !== panel.revision || audit.assetSha256 !== panel.sha256
    || audit.inspectionMode !== 'multimodal_pixels' || audit.inspectorContextMode !== 'clean_zero_context' || audit.blockerCount !== 0) {
    throw new Error(`panel ${panel.panelIndex} requires an exact locked clean-zero-context visual PASS`);
  }
}

async function requireTerminalBlankCell(path, plan, runner) {
  const left = plan.grid.cellWidth * 3;
  const top = plan.grid.cellHeight * 2;
  const result = await runner('ffmpeg', [
    '-v', 'error', '-i', path,
    '-vf', `crop=${plan.grid.cellWidth}:${plan.grid.cellHeight}:${left}:${top},format=gray,signalstats,metadata=print:file=-`,
    '-frames:v', '1', '-f', 'null', '-'
  ], { shell: false });
  if (result.code !== 0) throw new Error('contact-sheet terminal blank-cell inspection failed');
  const mean = Number(/^lavfi\.signalstats\.YAVG=(.+)$/m.exec(result.stdout)?.[1]);
  const minimum = Number(/^lavfi\.signalstats\.YMIN=(.+)$/m.exec(result.stdout)?.[1]);
  if (!Number.isFinite(mean) || !Number.isFinite(minimum) || mean < 254 || minimum < 250) {
    throw new Error('contact-sheet terminal blank cell is not an untouched white blank cell');
  }
  return { meanLuma: mean, minLuma: minimum };
}

async function nativePixelHash(path, runner, label) {
  const result = await runner('ffmpeg', ['-v', 'error', '-i', path, '-vf', 'format=rgba', '-frames:v', '1', '-f', 'framemd5', '-'], { shell: false });
  if (result.code !== 0) throw new Error(`panel pixel hash failed for ${label}`);
  const line = result.stdout.split(/\r?\n/).filter(value => value && !value.startsWith('#')).at(-1);
  const hash = line?.split(',').at(-1)?.trim()?.toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hash ?? '')) throw new Error(`panel pixel hash missing for ${label}`);
  return hash;
}

async function sheetRectPixelHash(path, rectValue, runner) {
  const result = await runner('ffmpeg', ['-v', 'error', '-i', path, '-vf', `crop=${rectValue.width}:${rectValue.height}:${rectValue.left}:${rectValue.top},format=rgba`, '-frames:v', '1', '-f', 'framemd5', '-'], { shell: false });
  if (result.code !== 0) throw new Error(`contact-sheet cell hash failed for ${path}`);
  const line = result.stdout.split(/\r?\n/).filter(value => value && !value.startsWith('#')).at(-1);
  const hash = line?.split(',').at(-1)?.trim()?.toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hash ?? '')) throw new Error(`contact-sheet cell hash missing for ${path}`);
  return hash;
}

export async function buildStoryboardContactSheetFfmpegCommand(root, input, { runner = runProcess } = {}) {
  const plan = assertStoryboardContactSheetPlan(input);
  const state = await readJson((await inspectArtifactFile(root, 'project-state.json')).path);
  requireCurrentSegmentation(state, plan);
  const canonicalSegments = await loadCanonicalSegments(root, state, { requireLockedSegmentation: true });
  if (!canonicalSegments.some(segment => segment?.id === plan.segmentId)) {
    throw new Error('contact sheet segment does not exist in the current locked segmentation');
  }
  const panelPaths = [];
  for (const panel of plan.panels) {
    requirePanelAudit(state, panel);
    const inspected = await inspectArtifactFile(root, panel.path);
    if (!sameBytesHash(inspected.sha256, panel.sha256)) throw new Error(`panel ${panel.panelIndex} checksum changed`);
    const dimensions = await probePng(inspected.path, runner);
    if (dimensions.width !== plan.grid.cellWidth || dimensions.height !== plan.grid.cellHeight) {
      throw new Error(`panel ${panel.panelIndex} must already be the exact native ${plan.grid.cellWidth}x${plan.grid.cellHeight} execution frame; contact-sheet composition never crops, scales, pads or redraws panel pixels`);
    }
    panelPaths.push(inspected.path);
  }
  const rootPath = resolve(root);
  const output = resolve(rootPath, plan.outputPath);
  if (outside(rootPath, output)) throw new Error('contact-sheet output must stay inside project root');
  const layout = plan.panels.map(panel => `${panel.destinationRect.left}_${panel.destinationRect.top}`).join('|');
  const args = ['-v', 'error', '-nostdin'];
  panelPaths.forEach(path => args.push('-i', path));
  const filters = plan.panels.map((_panel, index) => `[${index}:v]format=rgba[p${index}]`);
  filters.push(`${plan.panels.map((_panel, index) => `[p${index}]`).join('')}xstack=inputs=${PANEL_COUNT}:layout=${layout}:fill=white[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-c:v', 'png', '-compression_level', '6', '-n', output);
  return { executable: 'ffmpeg', args, output, panelPaths };
}

export async function composeStoryboardContactSheet(root, input, { runner = runProcess } = {}) {
  const plan = assertStoryboardContactSheetPlan(input);
  const command = await buildStoryboardContactSheetFfmpegCommand(root, plan, { runner });
  try {
    await access(command.output, constants.F_OK);
    throw new Error('contact-sheet output already exists');
  } catch (error) {
    if (error.message === 'contact-sheet output already exists') throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  const before = new Map();
  for (const [index, panel] of plan.panels.entries()) {
    before.set(panel.panelIndex, await nativePixelHash(command.panelPaths[index], runner, `panel ${panel.panelIndex}`));
  }
  await safeOutputDirectory(resolve(root), dirname(command.output));
  const result = await runner(command.executable, command.args, { cwd: resolve(root), shell: false });
  if (result.code !== 0) throw new Error(`storyboard contact-sheet compositor failed with exit code ${result.code}: ${result.stderr ?? ''}`.trim());
  const dimensions = await probePng(command.output, runner);
  if (dimensions.width !== plan.canvas.width || dimensions.height !== plan.canvas.height) throw new Error('contact-sheet output dimensions changed');
  const panelPixelHashes = {};
  for (const panel of plan.panels) {
    const outputHash = await sheetRectPixelHash(command.output, panel.destinationRect, runner);
    if (outputHash !== before.get(panel.panelIndex)) throw new Error(`contact-sheet changed panel ${panel.panelIndex} pixels; scaling or redrawing is forbidden`);
    panelPixelHashes[panel.panelIndex] = outputHash;
  }
  const output = await inspectArtifactFile(root, plan.outputPath);
  const terminalBlankCell = await requireTerminalBlankCell(command.output, plan, runner);
  return { planId: plan.id, assetId: plan.assetId, path: plan.outputPath, sha256: output.sha256, panelPixelHashes, terminalBlankCell, command };
}

export async function composeAndRegisterStoryboardContactSheet(root, input, { runner = runProcess, planSha256 = null } = {}) {
  const plan = assertStoryboardContactSheetPlan(input);
  const result = await composeStoryboardContactSheet(root, plan, { runner });
  const artifact = await registerArtifact(root, {
    id: plan.assetId,
    type: 'segment_asset',
    assetType: 'storyboard',
    segmentId: plan.segmentId,
    revision: plan.revision,
    status: 'draft',
    path: plan.outputPath,
    storyboardSequenceId: plan.storyboardSequenceId,
    panelCount: PANEL_COUNT,
    panelPixelHashes: result.panelPixelHashes,
    terminalBlankCell: result.terminalBlankCell,
    sourceContactSheetPlanId: plan.id,
    ...(planSha256 ? { sourceContactSheetPlanSha256: planSha256 } : {}),
    visualAuditId: plan.visualAuditId,
    segmentationId: plan.segmentationId,
    segmentationSha256: plan.segmentationSha256,
    requiredVisualChecks: [
      'complete_grid_count', 'panel_reading_order', 'shot_time_mapping',
      'visible_action_endpoints', 'cross_panel_identity_wardrobe_scene_consistency',
      'screen_direction_camera_blocking_continuity', 'performance_intent_and_eyeline_readable',
      'no_frozen_or_generic_gesture_people', 'no_future_action_text_watermark'
    ]
  });
  return { ...result, artifact };
}
