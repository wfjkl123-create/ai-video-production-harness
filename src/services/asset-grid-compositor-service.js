import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectArtifactFile } from './artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { runProcess } from '../adapters/process-runner.js';

const SHA256 = /^[a-f0-9]{64}$/;
const PROFILES = new Map([
  ['scene-multiview-grid-v1', { count: 9, assetTypes: new Set(['scene_multiview_v1', 'scene_overhead_v1']) }],
  ['story-prop-grid-v1', { count: 4, assetTypes: new Set(['story_prop_v1']) }],
  ['mannequin-grid-v1', { min: 1, max: 16, assetTypes: new Set(['mannequin_grid_v1']) }]
]);

function outside(root, candidate) { const value = relative(root, candidate); return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value); }
function text(value, field) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`); }
function projectPath(value, field) { text(value, field); if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`); }

export function assertAssetGridPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('asset grid plan must be an object');
  text(plan.id, 'id'); text(plan.assetId, 'assetId');
  const profile = PROFILES.get(plan.layoutProfile);
  if (!profile) throw new TypeError('unknown asset grid layoutProfile');
  if (!plan.grid || !Number.isInteger(plan.grid.rows) || !Number.isInteger(plan.grid.columns) || !Number.isInteger(plan.grid.width) || !Number.isInteger(plan.grid.height)) throw new TypeError('grid rows columns width height must be integers');
  const count = plan.grid.rows * plan.grid.columns;
  if ((profile.count && count !== profile.count) || (profile.min && (count < profile.min || count > profile.max))) throw new TypeError('grid dimensions do not match layoutProfile');
  if (plan.grid.width % plan.grid.columns !== 0 || plan.grid.height % plan.grid.rows !== 0) throw new TypeError('grid canvas must divide evenly');
  if (!Array.isArray(plan.panels) || plan.panels.length !== count) throw new TypeError(`panels must contain exactly ${count} entries`);
  for (const [index, panel] of plan.panels.entries()) {
    if (panel.panelIndex !== index + 1) throw new TypeError(`panels[${index}].panelIndex must be ${index + 1}`);
    for (const field of ['assetId', 'assetType', 'visualAuditId']) text(panel[field], `panels[${index}].${field}`);
    if (!profile.assetTypes.has(panel.assetType)) throw new TypeError(`panels[${index}].assetType is incompatible with ${plan.layoutProfile}`);
    if (!Number.isInteger(panel.revision) || panel.revision < 1) throw new TypeError(`panels[${index}].revision must be positive`);
    projectPath(panel.path, `panels[${index}].path`);
    if (!SHA256.test(panel.sha256 ?? '')) throw new TypeError(`panels[${index}].sha256 is invalid`);
  }
  projectPath(plan.outputPath, 'outputPath');
  if (plan.renderer !== 'ffmpeg-deterministic-asset-grid-v1') throw new TypeError('unknown asset grid renderer');
  return plan;
}

function requireAudit(state, panel) {
  const audit = (state.artifacts ?? []).find(item => item.id === panel.visualAuditId);
  if (!audit || audit.type !== 'asset_visual_audit' || audit.status !== 'locked' || audit.decision !== 'PASS'
    || audit.assetId !== panel.assetId || audit.assetType !== panel.assetType || audit.assetRevision !== panel.revision
    || audit.assetSha256 !== panel.sha256 || audit.inspectionMode !== 'multimodal_pixels'
    || audit.inspectorContextMode !== 'clean_zero_context' || audit.blockerCount !== 0) throw new Error(`panel ${panel.panelIndex} lacks exact locked visual PASS`);
}

async function safeDirectory(root, output) {
  const directory = dirname(output); let current = root;
  if (outside(root, directory)) throw new Error('grid output escapes project root');
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('grid output directory must not contain symlinks'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(current); }
  }
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (outside(actualRoot, actualDirectory)) throw new Error('grid output escapes project root');
}

export async function buildAssetGridFfmpegCommand(root, input) {
  const plan = assertAssetGridPlan(input);
  const state = await readJson((await inspectArtifactFile(root, 'project-state.json')).path);
  const paths = [];
  for (const panel of plan.panels) {
    requireAudit(state, panel);
    const inspected = await inspectArtifactFile(root, panel.path);
    if (inspected.sha256 !== panel.sha256) throw new Error(`panel ${panel.panelIndex} checksum changed`);
    paths.push(inspected.path);
  }
  const cellWidth = plan.grid.width / plan.grid.columns;
  const cellHeight = plan.grid.height / plan.grid.rows;
  const filters = paths.map((_, index) => `[${index}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black[p${index}]`);
  const layout = plan.panels.map(panel => `${((panel.panelIndex - 1) % plan.grid.columns) * cellWidth}_${Math.floor((panel.panelIndex - 1) / plan.grid.columns) * cellHeight}`).join('|');
  filters.push(`${plan.panels.map((_, index) => `[p${index}]`).join('')}xstack=inputs=${plan.panels.length}:layout=${layout}:fill=black[out]`);
  const output = resolve(root, plan.outputPath);
  if (outside(resolve(root), output)) throw new Error('grid output escapes project root');
  const args = ['-v', 'error', '-nostdin']; paths.forEach(path => args.push('-i', path));
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-c:v', 'png', '-compression_level', '6', '-n', output);
  return { executable: 'ffmpeg', args, output };
}

export async function composeAssetGrid(root, plan, { runner = runProcess } = {}) {
  const command = await buildAssetGridFfmpegCommand(root, plan);
  try { await access(command.output, constants.F_OK); throw new Error('grid output already exists'); }
  catch (error) { if (error.message === 'grid output already exists') throw error; if (error.code !== 'ENOENT') throw error; }
  await safeDirectory(resolve(root), command.output);
  const result = await runner(command.executable, command.args, { cwd: resolve(root), shell: false });
  if (result.code !== 0) throw new Error(`asset grid compositor failed with exit code ${result.code}`);
  const output = await inspectArtifactFile(root, plan.outputPath);
  return { planId: plan.id, assetId: plan.assetId, path: plan.outputPath, sha256: output.sha256, command };
}
