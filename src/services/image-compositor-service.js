import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { inspectArtifactFile } from './artifact-file-service.js';
import { runProcess } from '../adapters/process-runner.js';
import { readJson } from '../storage/json-store.js';
import { requireMatchingAtomicVisualAudit } from '../domain/asset-visual-audit.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SLOT_ORDER = Object.freeze(['top_left', 'top_right', 'bottom_left', 'bottom_right']);

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

async function createSafeProjectDirectory(root, directory) {
  const relativeDirectory = relative(root, directory);
  if (outside(root, directory)) throw new Error('composite output directory escapes project root');
  let current = root;
  for (const part of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('composite output directory must not contain symlinks');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function projectPath(value, field) {
  string(value, field);
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`);
}

export function assertImageCompositePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('image composite plan must be an object');
  string(plan.id, 'id');
  string(plan.assetId, 'assetId');
  if (plan.layoutProfile !== 'character-board-template-b-v1') throw new TypeError('layoutProfile must be character-board-template-b-v1');
  if (!plan.canvas || !Number.isInteger(plan.canvas.width) || !Number.isInteger(plan.canvas.height)
    || plan.canvas.width < 4 || plan.canvas.height < 6 || plan.canvas.width % 2 !== 0 || plan.canvas.height % 3 !== 0) {
    throw new TypeError('canvas width must be even and height must be divisible by 3');
  }
  if (!Array.isArray(plan.panels) || plan.panels.length !== 4) throw new TypeError('character board composite requires exactly four panels');
  const ordered = [...plan.panels].sort((left, right) => SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot));
  if (ordered.some((panel, index) => panel.slot !== SLOT_ORDER[index])) throw new TypeError('panels must contain each required slot exactly once');
  for (const [index, panel] of ordered.entries()) {
    string(panel.atomicAssetId, `panels[${index}].atomicAssetId`);
    string(panel.profileId, `panels[${index}].profileId`);
    string(panel.visualAuditId, `panels[${index}].visualAuditId`);
    if (panel.humanVisualExceptionId !== undefined) string(panel.humanVisualExceptionId, `panels[${index}].humanVisualExceptionId`);
    if (!Number.isInteger(panel.revision) || panel.revision < 1) throw new TypeError(`panels[${index}].revision must be a positive integer`);
    projectPath(panel.path, `panels[${index}].path`);
    if (!SHA256.test(panel.sha256 ?? '')) throw new TypeError(`panels[${index}].sha256 must be a lowercase SHA-256`);
  }
  projectPath(plan.outputPath, 'outputPath');
  if (!/^#[A-Fa-f0-9]{6}$/.test(plan.background ?? '')) throw new TypeError('background must be a six-digit HEX color');
  if (plan.renderer !== 'ffmpeg-deterministic-character-board-v1') throw new TypeError('renderer must be ffmpeg-deterministic-character-board-v1');
  return plan;
}

export function buildCharacterBoardCompositePlan({ id, assetId, panels, outputPath, width = 2048, height = 1536, background = '#D7D7D7' }) {
  return assertImageCompositePlan({
    id,
    assetId,
    layoutProfile: 'character-board-template-b-v1',
    canvas: { aspectRatio: '4:3', width, height },
    panels: structuredClone(panels),
    background,
    outputPath,
    renderer: 'ffmpeg-deterministic-character-board-v1'
  });
}

export async function buildCharacterBoardFfmpegCommand(root, plan) {
  assertImageCompositePlan(plan);
  const stateFile = await inspectArtifactFile(root, 'project-state.json');
  const state = await readJson(stateFile.path);
  const inputs = [];
  for (const slot of SLOT_ORDER) {
    const panel = plan.panels.find(item => item.slot === slot);
    requireMatchingAtomicVisualAudit(state, panel);
    const inspected = await inspectArtifactFile(root, panel.path);
    if (inspected.sha256 !== panel.sha256) throw new Error(`panel checksum changed for ${panel.atomicAssetId}`);
    inputs.push(inspected.path);
  }
  const projectRoot = resolve(root);
  const output = resolve(projectRoot, plan.outputPath);
  if (outside(projectRoot, output)) throw new Error('composite output must stay inside project root');
  const halfWidth = plan.canvas.width / 2;
  const topHeight = plan.canvas.height / 3;
  const bottomHeight = plan.canvas.height - topHeight;
  const fill = `0x${plan.background.slice(1)}`;
  const filters = [
    `[0:v]scale=${halfWidth}:${topHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${topHeight}:(ow-iw)/2:(oh-ih)/2:${fill}[p0]`,
    `[1:v]scale=${halfWidth}:${topHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${topHeight}:(ow-iw)/2:(oh-ih)/2:${fill}[p1]`,
    `[2:v]scale=${halfWidth}:${bottomHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${bottomHeight}:(ow-iw)/2:(oh-ih)/2:${fill}[p2]`,
    `[3:v]scale=${halfWidth}:${bottomHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${bottomHeight}:(ow-iw)/2:(oh-ih)/2:${fill}[p3]`,
    `[p0][p1][p2][p3]xstack=inputs=4:layout=0_0|${halfWidth}_0|0_${topHeight}|${halfWidth}_${topHeight}:fill=${fill}[out]`
  ].join(';');
  const args = ['-v', 'error', '-nostdin'];
  inputs.forEach(path => args.push('-i', path));
  args.push('-filter_complex', filters, '-map', '[out]', '-frames:v', '1', '-c:v', 'png', '-compression_level', '6', '-n', output);
  return { executable: 'ffmpeg', args, output };
}

export async function composeCharacterBoard(root, plan, { runner = runProcess } = {}) {
  const command = await buildCharacterBoardFfmpegCommand(root, plan);
  try {
    await access(command.output, constants.F_OK);
    throw new Error('composite output already exists');
  } catch (error) {
    if (error.message === 'composite output already exists') throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  await createSafeProjectDirectory(resolve(root), dirname(command.output));
  const [actualRoot, actualParent] = await Promise.all([realpath(root), realpath(dirname(command.output))]);
  if (outside(actualRoot, actualParent)) throw new Error('composite output directory escapes project root');
  const result = await runner(command.executable, command.args, { cwd: resolve(root), shell: false });
  if (result.code !== 0) throw new Error(`character board compositor failed with exit code ${result.code}: ${result.stderr ?? ''}`.trim());
  const output = await inspectArtifactFile(root, plan.outputPath);
  return { planId: plan.id, assetId: plan.assetId, path: plan.outputPath, sha256: output.sha256, command };
}
