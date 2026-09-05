import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

function validateGrid(grid) {
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) throw new TypeError('source.grid must be an object');
  for (const field of ['rows', 'columns', 'width', 'height']) {
    if (!Number.isInteger(grid[field]) || grid[field] < 1) throw new TypeError(`source.grid.${field} must be a positive integer`);
  }
  const count = grid.rows * grid.columns;
  if (![6, 9, 12].includes(count)) throw new TypeError('source grid must contain 6, 9, or 12 panels');
  if (grid.width % grid.columns !== 0 || grid.height % grid.rows !== 0) throw new TypeError('source dimensions must divide evenly into the grid');
}

export function assertStoryboardRepairPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('storyboard repair plan must be an object');
  text(plan.id, 'id');
  if (plan.kind !== 'storyboard_panel_repair_plan') throw new TypeError('kind must be storyboard_panel_repair_plan');
  if (!plan.source || typeof plan.source !== 'object') throw new TypeError('source is required');
  text(plan.source.artifactId, 'source.artifactId');
  projectPath(plan.source.path, 'source.path');
  if (!SHA256.test(plan.source.sha256 ?? '')) throw new TypeError('source.sha256 must be a lowercase SHA-256');
  validateGrid(plan.source.grid);
  if (!Array.isArray(plan.replacements) || plan.replacements.length === 0) throw new TypeError('replacements must be a non-empty array');
  const panelCount = plan.source.grid.rows * plan.source.grid.columns;
  if (plan.replacements.length * 2 >= panelCount) throw new Error('half or more storyboard panels failed; regenerate the complete sheet instead of local repair');
  const indexes = new Set();
  for (const [index, replacement] of plan.replacements.entries()) {
    if (!Number.isInteger(replacement.panelIndex) || replacement.panelIndex < 1 || replacement.panelIndex > panelCount) throw new TypeError(`replacements[${index}].panelIndex is outside the grid`);
    if (indexes.has(replacement.panelIndex)) throw new TypeError(`duplicate replacement panelIndex: ${replacement.panelIndex}`);
    indexes.add(replacement.panelIndex);
    for (const field of ['assetId', 'visualAuditId']) text(replacement[field], `replacements[${index}].${field}`);
    if (!Number.isInteger(replacement.revision) || replacement.revision < 1) throw new TypeError(`replacements[${index}].revision must be positive`);
    projectPath(replacement.path, `replacements[${index}].path`);
    if (!SHA256.test(replacement.sha256 ?? '')) throw new TypeError(`replacements[${index}].sha256 must be a lowercase SHA-256`);
  }
  projectPath(plan.outputPath, 'outputPath');
  if (plan.renderer !== 'ffmpeg-lossless-storyboard-panel-repair-v1') throw new TypeError('unknown storyboard repair renderer');
  return plan;
}

function requireReplacementAudit(state, replacement) {
  const audit = (state.artifacts ?? []).find(item => item.id === replacement.visualAuditId);
  if (!audit || audit.type !== 'asset_visual_audit' || audit.status !== 'locked' || audit.decision !== 'PASS'
    || audit.assetId !== replacement.assetId || audit.assetType !== 'storyboard_panel_repair_v1'
    || audit.assetRevision !== replacement.revision || audit.assetSha256 !== replacement.sha256
    || audit.inspectionMode !== 'multimodal_pixels' || audit.inspectorContextMode !== 'clean_zero_context'
    || audit.blockerCount !== 0) {
    throw new Error(`replacement panel ${replacement.panelIndex} requires an exact locked clean-zero-context visual PASS`);
  }
}

async function safeOutputDirectory(root, output) {
  const directory = dirname(output);
  if (outside(root, directory)) throw new Error('storyboard repair output directory escapes project root');
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('storyboard repair output directory must not contain symlinks');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (outside(actualRoot, actualDirectory)) throw new Error('storyboard repair output directory escapes project root');
}

export async function buildStoryboardRepairFfmpegCommand(root, input) {
  const plan = assertStoryboardRepairPlan(input);
  const state = await readJson((await inspectArtifactFile(root, 'project-state.json')).path);
  const source = await inspectArtifactFile(root, plan.source.path);
  if (source.sha256 !== plan.source.sha256) throw new Error('source storyboard checksum changed');
  const replacementPaths = [];
  for (const replacement of plan.replacements) {
    requireReplacementAudit(state, replacement);
    const inspected = await inspectArtifactFile(root, replacement.path);
    if (inspected.sha256 !== replacement.sha256) throw new Error(`replacement panel ${replacement.panelIndex} checksum changed`);
    replacementPaths.push(inspected.path);
  }
  const rootPath = resolve(root);
  const output = resolve(rootPath, plan.outputPath);
  if (outside(rootPath, output)) throw new Error('storyboard repair output must stay inside project root');
  const cellWidth = plan.source.grid.width / plan.source.grid.columns;
  const cellHeight = plan.source.grid.height / plan.source.grid.rows;
  const filters = ['[0:v]format=rgba[base0]'];
  plan.replacements.forEach((replacement, index) => {
    const x = ((replacement.panelIndex - 1) % plan.source.grid.columns) * cellWidth;
    const y = Math.floor((replacement.panelIndex - 1) / plan.source.grid.columns) * cellHeight;
    filters.push(`[${index + 1}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgba[replacement${index}]`);
    filters.push(`[base${index}][replacement${index}]overlay=${x}:${y}:format=rgb[base${index + 1}]`);
  });
  const args = ['-v', 'error', '-nostdin', '-i', source.path];
  replacementPaths.forEach(path => args.push('-i', path));
  args.push('-filter_complex', filters.join(';'), '-map', `[base${plan.replacements.length}]`, '-frames:v', '1', '-c:v', 'png', '-compression_level', '6', '-n', output);
  return { executable: 'ffmpeg', args, output, source: source.path, cellWidth, cellHeight };
}

async function probeDimensions(path, runner) {
  const result = await runner('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path], { shell: false });
  if (result.code !== 0) throw new Error(`ffprobe failed for storyboard: ${result.stderr ?? ''}`.trim());
  const stream = JSON.parse(result.stdout).streams?.[0];
  return { width: stream?.width, height: stream?.height };
}

async function panelPixelHash(path, panelIndex, grid, runner) {
  const width = grid.width / grid.columns;
  const height = grid.height / grid.rows;
  const x = ((panelIndex - 1) % grid.columns) * width;
  const y = Math.floor((panelIndex - 1) / grid.columns) * height;
  const result = await runner('ffmpeg', ['-v', 'error', '-i', path, '-vf', `crop=${width}:${height}:${x}:${y},format=rgba`, '-frames:v', '1', '-f', 'framemd5', '-'], { shell: false });
  if (result.code !== 0) throw new Error(`panel pixel hash failed for panel ${panelIndex}`);
  const line = result.stdout.split(/\r?\n/).filter(value => value && !value.startsWith('#')).at(-1);
  const hash = line?.split(',').at(-1)?.trim();
  if (!/^[a-f0-9]{32}$/i.test(hash ?? '')) throw new Error(`panel pixel hash missing for panel ${panelIndex}`);
  return hash.toLowerCase();
}

export async function repairStoryboardPanels(root, input, { runner = runProcess } = {}) {
  const plan = assertStoryboardRepairPlan(input);
  const command = await buildStoryboardRepairFfmpegCommand(root, plan);
  try {
    await access(command.output, constants.F_OK);
    throw new Error('storyboard repair output already exists');
  } catch (error) {
    if (error.message === 'storyboard repair output already exists') throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceDimensions = await probeDimensions(command.source, runner);
  if (sourceDimensions.width !== plan.source.grid.width || sourceDimensions.height !== plan.source.grid.height) throw new Error('source storyboard dimensions do not match the repair plan');
  await safeOutputDirectory(resolve(root), command.output);
  const replaced = new Set(plan.replacements.map(item => item.panelIndex));
  const unchangedIndexes = Array.from({ length: plan.source.grid.rows * plan.source.grid.columns }, (_, index) => index + 1).filter(index => !replaced.has(index));
  const before = new Map();
  for (const index of unchangedIndexes) before.set(index, await panelPixelHash(command.source, index, plan.source.grid, runner));
  const result = await runner(command.executable, command.args, { cwd: resolve(root), shell: false });
  if (result.code !== 0) throw new Error(`storyboard repair compositor failed with exit code ${result.code}: ${result.stderr ?? ''}`.trim());
  const dimensions = await probeDimensions(command.output, runner);
  if (dimensions.width !== plan.source.grid.width || dimensions.height !== plan.source.grid.height) throw new Error('repaired storyboard dimensions changed');
  const preservedPanelHashes = {};
  for (const index of unchangedIndexes) {
    const after = await panelPixelHash(command.output, index, plan.source.grid, runner);
    if (after !== before.get(index)) throw new Error(`correct panel ${index} pixels changed during local repair`);
    preservedPanelHashes[index] = after;
  }
  const output = await inspectArtifactFile(root, plan.outputPath);
  return { planId: plan.id, path: plan.outputPath, sha256: output.sha256, repairedPanelIndexes: [...replaced].sort((a, b) => a - b), preservedPanelHashes, command };
}
