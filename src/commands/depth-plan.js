import { access, lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option } from './args.js';
import { runProcess } from '../adapters/process-runner.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { sha256File } from '../storage/checksum.js';
import { buildDepthConversionPlan, depthExtensions, resolveUniqueDepthInput } from '../services/depth-conversion-plan-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function projectRelative(root, value, label) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) throw new Error(`${label} must be project-relative`);
  const path = resolve(root, value);
  if (outside(root, path)) throw new Error(`${label} must stay inside project root`);
  return path;
}

async function verifiedInput(root, relativePath, mediaKind) {
  const path = projectRelative(root, relativePath, 'depth input');
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error('depth input must be a readable regular project file, not a symlink');
  await access(path, constants.R_OK);
  const [actualRoot, actual] = await Promise.all([realpath(root), realpath(path)]);
  if (outside(actualRoot, actual) || !(await stat(actual)).isFile()) throw new Error('depth input must stay inside project root');
  const extension = `.${relativePath.split('.').at(-1)?.toLowerCase() ?? ''}`;
  if (!depthExtensions(mediaKind).includes(extension)) throw new Error(`depth input extension is not supported for ${mediaKind}`);
  return actual;
}

async function candidatesFromDirectory(root, relativeDirectory, mediaKind) {
  const directory = projectRelative(root, relativeDirectory, 'depth input directory');
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error('depth input directory must be a real project directory, not a symlink');
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (outside(actualRoot, actualDirectory)) throw new Error('depth input directory must stay inside project root');
  const allowed = new Set(depthExtensions(mediaKind));
  return (await readdir(actualDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && allowed.has(`.${entry.name.split('.').at(-1)?.toLowerCase() ?? ''}`))
    .map(entry => relative(root, join(actualDirectory, entry.name)).split(sep).join('/'));
}

function parseFrameRate(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(value)) throw new Error('ffprobe returned an invalid frame rate');
  const [numerator, denominator = '1'] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) throw new Error('ffprobe returned an invalid frame rate');
  return value;
}

async function probeInput(path, mediaKind, root, runner) {
  const result = await runner('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate:format=duration', '-of', 'json', path
  ], { cwd: root, shell: false });
  if (result.code !== 0) throw new Error(`ffprobe could not inspect the unique depth input: ${result.stderr ?? ''}`.trim());
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('ffprobe returned invalid JSON for the unique depth input'); }
  const stream = value.streams?.find(item => item.codec_type === 'video') ?? value.streams?.[0];
  if (!Number.isInteger(stream?.width) || stream.width <= 0 || !Number.isInteger(stream?.height) || stream.height <= 0) {
    throw new Error('depth input has no valid image dimensions');
  }
  const metadata = { width: stream.width, height: stream.height };
  if (mediaKind === 'video') {
    const durationSec = Number(value.format?.duration);
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('depth video input has no valid duration');
    metadata.durationSec = durationSec;
    metadata.frameRate = parseFrameRate(stream.avg_frame_rate);
  }
  return metadata;
}

async function ensureSafeParent(root, target) {
  if (outside(root, target)) throw new Error('depth plan output must stay inside project root');
  const relativeParent = relative(root, dirname(target));
  let current = root;
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, part);
    const metadata = await lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (metadata?.isSymbolicLink()) throw new Error('depth plan output directory must not contain symlinks');
    if (metadata && !metadata.isDirectory()) throw new Error('depth plan output parent must be a directory');
    if (!metadata) await mkdir(current);
  }
  const [actualRoot, actualParent] = await Promise.all([realpath(root), realpath(dirname(target))]);
  if (outside(actualRoot, actualParent)) throw new Error('depth plan output directory escapes project root');
}

async function requireOutputsAbsent(root, plan) {
  const paths = plan.mediaKind === 'video'
    ? plan.output.segments.map(item => item.outputPath)
    : [plan.output.outputPath];
  for (const value of paths) {
    const path = projectRelative(root, value, 'depth output');
    const exists = await lstat(path).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
    if (exists) {
      const error = new Error(`depth output already exists and will not be overwritten: ${value}`);
      error.code = 'DEPTH_OUTPUT_EXISTS';
      throw error;
    }
  }
}

export async function runDepthPlan(args, dependencies = {}) {
  const root = resolve(option(args, 'project'));
  const mediaKind = option(args, 'kind');
  const explicitInput = option(args, 'input', { required: false });
  const inputDirectory = option(args, 'input-dir', { required: false });
  if ((explicitInput ? 1 : 0) + (inputDirectory ? 1 : 0) !== 1) {
    throw new Error('provide exactly one of --input or --input-dir');
  }
  const actualRoot = await realpath(root);
  const state = await readJson(join(actualRoot, 'project-state.json'));
  const candidates = explicitInput ? [explicitInput] : await candidatesFromDirectory(actualRoot, inputDirectory, mediaKind);
  const inputPath = resolveUniqueDepthInput(candidates, mediaKind);
  const actualInput = await verifiedInput(actualRoot, inputPath, mediaKind);
  const inputSha256 = await sha256File(actualInput);
  const metadata = await probeInput(actualInput, mediaKind, actualRoot, dependencies.runner ?? runProcess);
  const template = await readJson(fileURLToPath(new URL('../../knowledge/capabilities/monocular-depth-templates.json', import.meta.url)));
  const planId = `depth-${mediaKind}-${inputSha256.slice(0, 16)}-v1`;
  const instructionPath = `prompts/depth/${planId}.txt`;
  const { plan, instructionText } = buildDepthConversionPlan({
    projectId: state.projectId,
    mediaKind,
    input: { path: inputPath, sha256: inputSha256 },
    metadata,
    template,
    instructionPath,
    outputRoot: option(args, 'output-root', { required: false }) ?? 'outputs/depth'
  });
  await requireOutputsAbsent(actualRoot, plan);
  const planPath = `runs/depth-conversion-plans/${plan.id}.json`;
  const absolutePlanPath = projectRelative(actualRoot, planPath, 'depth plan');
  const absoluteInstructionPath = projectRelative(actualRoot, instructionPath, 'depth instruction');
  await ensureSafeParent(actualRoot, absolutePlanPath);
  await ensureSafeParent(actualRoot, absoluteInstructionPath);
  const existingPlan = await readJson(absolutePlanPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingPlan && existingPlan.planFingerprint !== plan.planFingerprint) {
    throw new Error(`depth plan ${plan.id} already exists with a different fingerprint`);
  }
  const existingInstruction = await readFile(absoluteInstructionPath, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingInstruction !== null && existingInstruction !== instructionText) {
    throw new Error(`depth instruction ${instructionPath} already exists with different content`);
  }
  if (existingInstruction === null) await writeTextAtomic(absoluteInstructionPath, instructionText);
  if (!existingPlan) await writeJsonAtomic(absolutePlanPath, plan);
  return { ...plan, path: planPath };
}
