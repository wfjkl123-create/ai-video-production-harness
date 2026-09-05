import { dirname, isAbsolute, relative, resolve, join, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { access, link, mkdir, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { sha256File } from '../storage/checksum.js';
import { runProcess } from '../adapters/process-runner.js';
import { PROJECT_ASSET_TYPES, SEGMENT_ASSET_TYPES, canonicalAssetType } from '../services/asset-service.js';
import { option } from './args.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { workflowProfileIdOf } from '../domain/workflow-profile.js';

const DEFAULT_MODEL = 'Seedream 4.5';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIBTV_PROJECT_UUID = /^[a-f0-9]{32}$/i;
const AUDIO_ASSET_TYPES = new Set(['dialogue_audio_reference', 'timing_audio_reference']);

function isAudioAsset(item) {
  return item.mediaKind === 'audio' || AUDIO_ASSET_TYPES.has(item.type);
}

function outside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function verifiedProjectFile(root, recordedPath, label) {
  if (typeof recordedPath !== 'string' || isAbsolute(recordedPath) || outside(root, resolve(root, recordedPath))) {
    throw new Error(`${label} must stay inside project root`);
  }
  const actualRoot = await realpath(root);
  let actual;
  let metadata;
  try {
    actual = await realpath(resolve(root, recordedPath));
    if (outside(actualRoot, actual)) throw new Error('escape');
    metadata = await stat(actual);
    await access(actual, constants.R_OK);
  } catch {
    throw new Error(`${label} must be a readable regular project file`);
  }
  if (!metadata.isFile()) throw new Error(`${label} must be a readable regular project file`);
  return actual;
}

async function validateReviewedManifest(root, manifest, manifestPath, { prepareOutputs = false } = {}) {
  if (!SAFE_ID.test(manifest.id ?? '') || !SAFE_ID.test(manifest.segmentId ?? '')) throw new Error('manifest and segment IDs must be safe CLI identifiers');
  const state = await readJson(join(root, 'project-state.json'));
  const acceptsDelegatedSimpleRemakeReview = (review) => review?.actor === 'human'
    || (workflowProfileIdOf(state) === 'simple_remake'
      && review?.actor === 'system' && review?.machineReviewed === true && review?.delegatedByProfile === 'simple_remake');
  const review = await readJson(join(root, 'reviews', `${encodeURIComponent(manifest.lockedByReviewId)}.json`)).catch(() => null);
  if (!review || review.artifactKind !== 'asset_manifest' || review.artifactId !== manifest.id
    || review.segmentId !== manifest.segmentId || !acceptsDelegatedSimpleRemakeReview(review) || review.decision !== 'approved'
    || review.manifestSha256 !== await sha256File(manifestPath)) {
    throw new Error('locked asset manifest review evidence does not match');
  }
  const actualRoot = await realpath(root);
  let actualOutputRoot;
  if (prepareOutputs) {
    const outputRoot = join(root, 'outputs');
    await mkdir(outputRoot, { recursive: true });
    actualOutputRoot = await realpath(outputRoot);
    if (outside(actualRoot, actualOutputRoot)) throw new Error('LibTV output root escapes project root');
  }
  for (const item of manifest.items) {
    if (!SAFE_ID.test(item.id ?? '')) throw new Error(`unsafe LibTV asset id: ${item.id ?? ''}`);
    const allowed = item.scope === 'project' ? PROJECT_ASSET_TYPES : item.scope === 'segment' ? SEGMENT_ASSET_TYPES : [];
    if (!allowed.includes(item.type)) throw new Error(`invalid ${item.scope ?? ''} asset type: ${item.type ?? ''}`);
    if (item.path) {
      const artifactType = item.scope === 'project' ? 'project_asset' : 'segment_asset';
      const source = state.artifacts.find(artifact => artifact.id === item.id && artifact.type === artifactType);
      if (!source || source.status !== 'locked' || canonicalAssetType(source.assetType) !== item.type || source.path !== item.path
        || source.sha256 !== item.sha256 || source.lockedByReviewId !== item.lockedByReviewId) {
        throw new Error(`locked input ${item.id} does not match project state`);
      }
      const sourceReview = await readJson(join(root, 'reviews', `${encodeURIComponent(source.lockedByReviewId)}.json`)).catch(() => null);
      if (!sourceReview || !acceptsDelegatedSimpleRemakeReview(sourceReview)
        || sourceReview.decision !== 'approved' || sourceReview.artifactId !== source.id) {
        throw new Error(`locked input review evidence does not match for ${item.id}`);
      }
      const actual = await verifiedProjectFile(root, item.path, `input ${item.id}`);
      if (await sha256File(actual) !== item.sha256) throw new Error(`input checksum changed for ${item.id}`);
    } else if (item.scope !== 'segment' || item.status !== 'awaiting_review') {
      throw new Error(`output target ${item.id} must be a pending segment asset`);
    } else {
      if (isAudioAsset(item)) throw new Error(`audio asset ${item.id} must be prepared and locked before image generation planning`);
      const prompt = await verifiedProjectFile(root, `prompts/${item.id}.txt`, `prompt for ${item.id}`);
      if (await sha256File(prompt) !== review.promptSha256?.[item.id]) throw new Error(`prompt checksum changed for ${item.id}`);
      if (prepareOutputs) {
        const expectedDirectory = join(actualOutputRoot, item.id);
        const expectedFile = join(actualOutputRoot, `${item.id}.png`);
        if (outside(actualOutputRoot, expectedDirectory) || outside(actualOutputRoot, expectedFile)) throw new Error(`output path escapes project root for ${item.id}`);
        await mkdir(expectedDirectory, { recursive: true });
        if (outside(actualOutputRoot, await realpath(expectedDirectory))) throw new Error(`output directory symlink escapes project root for ${item.id}`);
      }
    }
  }
}

function requireLockedManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.status !== 'locked') {
    throw new Error('asset manifest must be locked');
  }
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    throw new Error('locked asset manifest must contain items');
  }
  for (const item of manifest.items) {
    const pendingTarget = item.scope === 'segment' && !item.path && item.status === 'awaiting_review'
      && typeof manifest.lockedByReviewId === 'string' && manifest.lockedByReviewId.trim() !== '';
    if (item.status !== 'locked' && !pendingTarget) throw new Error(`asset input ${item.id ?? ''} is not locked`);
  }
}

function projectArgs(projectUuid) {
  return projectUuid ? ['-p', projectUuid] : [];
}

function commandForUpload(item, root, projectUuid) {
  if (!item.path || isAudioAsset(item)) return [];
  return [['upload', `${item.id}-input`, ...projectArgs(projectUuid), '-t', 'image', '--resource', resolve(root, item.path)]];
}

export function buildAssetGenerationPlan(manifest, { root, model = DEFAULT_MODEL, outputRoot, projectUuid } = {}) {
  requireLockedManifest(manifest);
  if (projectUuid !== undefined && !LIBTV_PROJECT_UUID.test(projectUuid)) throw new Error('LibTV project UUID must be 32 hexadecimal characters');
  const projectRoot = resolve(root);
  const generatedOutputRoot = resolve(outputRoot ?? join(projectRoot, 'outputs'));
  const pending = manifest.items.filter(item => item.scope === 'segment' && item.status === 'awaiting_review' && !item.path);
  const pendingAudio = pending.find(isAudioAsset);
  if (pendingAudio) throw new Error(`audio asset ${pendingAudio.id} must be prepared and locked before image generation planning`);
  const targets = pending.length > 0 ? pending : manifest.items.filter(item => !isAudioAsset(item));
  const sharedSources = pending.length > 0
    ? manifest.items.filter(item => item.status === 'locked' && item.path && !isAudioAsset(item))
    : [];
  return {
    manifestId: manifest.id,
    segmentId: manifest.segmentId,
    mutatesLibTv: false,
    uploadCommands: sharedSources.flatMap(source => commandForUpload(source, projectRoot, projectUuid)),
    assets: targets.map((item) => {
      const promptPath = join(projectRoot, 'prompts', `${item.id}.txt`);
      const prompt = readFileSync(promptPath, 'utf8').trim();
      const expectedOutputDirectory = join(generatedOutputRoot, item.id);
      const normalizedOutputPath = join(generatedOutputRoot, `${item.id}.png`);
      const sources = sharedSources.length > 0 ? sharedSources : item.path ? [item] : [];
      const inputPaths = sources.map(source => resolve(projectRoot, source.path));
      const uploadCommands = sharedSources.length > 0 ? [] : sources.flatMap(source => commandForUpload(source, projectRoot, projectUuid));
      const left = sources.flatMap(source => ['--left', `${source.id}-input`]);
      const modeType = sources.length > 0 ? ['-s', 'modeType=image2image'] : [];
      return {
        assetId: item.id,
        nodeResponsibility: item.responsibility,
        inputPaths,
        promptPath,
        expectedOutputDirectory,
        normalizedOutputPath,
        normalization: {
          kind: 'single-file-move',
          sourceDirectory: expectedOutputDirectory,
          requireSingleFile: true,
          destinationPath: normalizedOutputPath
        },
        commands: [...uploadCommands, [
          'node', ...projectArgs(projectUuid), 'create', item.id, '-t', 'image',
          '-s', `model=${model}`, '-s', 'ratio=9:16', '-s', 'quality=2K',
          ...modeType,
          '--prompt', prompt
        ], [
          'node', item.id, ...projectArgs(projectUuid), ...left
        ], [
          'node', item.id, ...projectArgs(projectUuid), '--run'
        ], ['download', ...projectArgs(projectUuid), '--node', item.id, '--out', expectedOutputDirectory]]
      };
    })
  };
}

async function normalizeOutput(asset) {
  const entries = (await readdir(asset.expectedOutputDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.startsWith('._'));
  if (entries.length !== 1) throw new Error(`LibTV output for ${asset.assetId} must contain exactly one file`);
  const source = join(asset.expectedOutputDirectory, entries[0].name);
  await mkdir(dirname(asset.normalizedOutputPath), { recursive: true });
  await link(source, asset.normalizedOutputPath);
  await unlink(source);
  return { assetId: asset.assetId, path: asset.normalizedOutputPath, sha256: await sha256File(asset.normalizedOutputPath) };
}

export async function executeAssetGenerationPlan(plan, {
  root,
  runner = runProcess,
  runId = `libtv-${randomUUID()}`,
  maxConcurrency = 1
} = {}) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 2) {
    throw new TypeError('image generation maxConcurrency must be 1 or 2');
  }
  const sharedCommands = [];
  for (const args of plan.uploadCommands ?? []) {
    const result = await runner('libtv', args, { cwd: root, shell: false });
    sharedCommands.push({ executable: 'libtv', args: [...args], exitCode: result.code });
    if (result.code !== 0) {
      const error = new Error(`LibTV ${args[0] ?? 'command'} failed with exit code ${Number.isInteger(result.code) ? result.code : 'unknown'}`);
      error.code = 'LIBTV_CLI_FAILED';
      error.commands = sharedCommands;
      throw error;
    }
  }

  const results = new Array(plan.assets.length);
  let cursor = 0;
  let stopped = false;
  async function executeNext() {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= plan.assets.length) return;
      const asset = plan.assets[index];
      const commands = [];
      try {
        for (const args of asset.commands) {
          const result = await runner('libtv', args, { cwd: root, shell: false });
          commands.push({ executable: 'libtv', args: [...args], exitCode: result.code });
          if (result.code !== 0) {
            const error = new Error(`LibTV ${args[0] ?? 'command'} failed with exit code ${Number.isInteger(result.code) ? result.code : 'unknown'}`);
            error.code = 'LIBTV_CLI_FAILED';
            error.commands = [...sharedCommands, ...commands];
            throw error;
          }
        }
        results[index] = { commands, output: await normalizeOutput(asset) };
      } catch (error) {
        stopped = true;
        results[index] = { commands, error };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(maxConcurrency, plan.assets.length) },
    () => executeNext()
  ));
  const failed = results.find(result => result?.error);
  if (failed) throw failed.error;
  const completed = results.filter(Boolean);
  return {
    ...plan,
    mutatesLibTv: true,
    runId,
    maxConcurrency,
    commands: [...sharedCommands, ...completed.flatMap(result => result.commands)],
    outputs: completed.map(result => ({
      ...result.output,
      path: relative(root, result.output.path)
    }))
  };
}

async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function libtvPaths(root, runId, fingerprint) {
  return {
    run: join(root, 'runs', `${runId}.json`),
    owner: join(root, 'runs', 'libtv-owner.json'),
    fingerprint: join(root, 'runs', 'libtv-fingerprints', `${fingerprint}.json`)
  };
}

async function claimLibTvRun(root, runId, fingerprint, manifest) {
  const paths = libtvPaths(root, runId, fingerprint);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    if (await readOptionalJson(paths.run)) throw new Error(`LibTV run ${runId} already exists`);
    const owner = await readOptionalJson(paths.owner);
    if (owner && ['ACTIVE', 'UNCERTAIN'].includes(owner.status)) {
      throw new Error(`LibTV project already has an active or uncertain owner: ${owner.runId}`);
    }
    const prior = await readOptionalJson(paths.fingerprint);
    if (prior && ['ACTIVE', 'UNCERTAIN', 'SUCCESS'].includes(prior.status)) {
      throw new Error(`LibTV manifest fingerprint is already claimed by ${prior.runId}`);
    }
    const createdAt = new Date().toISOString();
    const run = {
      id: runId, tool: 'libtv', status: 'SUBMITTING', manifestId: manifest.id,
      segmentId: manifest.segmentId, manifestFingerprint: fingerprint, createdAt
    };
    const ownerRecord = { status: 'ACTIVE', runId, manifestFingerprint: fingerprint, claimedAt: createdAt };
    const fingerprintRecord = { status: 'ACTIVE', runId, manifestId: manifest.id, manifestFingerprint: fingerprint, claimedAt: createdAt };
    await commitJsonTransaction(root, `libtv-claim-${runId}`, [
      { path: paths.run, value: run },
      { path: paths.owner, value: ownerRecord },
      { path: paths.fingerprint, value: fingerprintRecord }
    ]);
    return paths;
  });
}

async function publishLibTvSuccess(root, paths, runId, fingerprint, execution) {
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const owner = await readJson(paths.owner);
    if (owner.status !== 'ACTIVE' || owner.runId !== runId || owner.manifestFingerprint !== fingerprint) {
      throw new Error('LibTV publish owner no longer matches this run');
    }
    const outputs = [];
    for (const output of execution.outputs) {
      const source = resolve(root, output.path);
      const destination = join(root, 'outputs', `${output.assetId}.png`);
      await mkdir(dirname(destination), { recursive: true });
      await link(source, destination);
      outputs.push({ assetId: output.assetId, path: relative(root, destination).split(sep).join('/'), sha256: output.sha256 });
    }
    const completedAt = new Date().toISOString();
    const run = {
      id: runId, tool: 'libtv', status: 'SUCCESS', manifestId: execution.manifestId,
      segmentId: execution.segmentId, manifestFingerprint: fingerprint,
      commands: execution.commands, outputs, createdAt: (await readJson(paths.run)).createdAt, completedAt
    };
    await commitJsonTransaction(root, `libtv-success-${runId}`, [
      { path: paths.run, value: run },
      { path: paths.owner, value: { status: 'RELEASED', runId, manifestFingerprint: fingerprint, releasedAt: completedAt } },
      { path: paths.fingerprint, value: { status: 'SUCCESS', runId, manifestId: execution.manifestId, manifestFingerprint: fingerprint, completedAt } }
    ]);
    return { ...execution, outputs };
  });
}

async function markLibTvUncertain(root, paths, runId, fingerprint, manifest, commands = []) {
  await withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const uncertainAt = new Date().toISOString();
    const previous = await readJson(paths.run);
    await commitJsonTransaction(root, `libtv-uncertain-${runId}`, [
      { path: paths.run, value: { ...previous, status: 'UNCERTAIN', commands, failureCode: 'LIBTV_EXECUTION_UNCERTAIN', uncertainAt } },
      { path: paths.owner, value: { status: 'UNCERTAIN', runId, manifestFingerprint: fingerprint, uncertainAt } },
      { path: paths.fingerprint, value: { status: 'UNCERTAIN', runId, manifestId: manifest.id, manifestFingerprint: fingerprint, uncertainAt } }
    ]);
  });
}

export async function runGenerateAssets(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  if (!SAFE_ID.test(segmentId)) throw new Error('segment ID must be a safe CLI identifier');
  const dryRun = args.includes('--dry-run');
  const live = args.includes('--live');
  const projectUuid = option(args, 'libtv-project', { required: false });
  if (projectUuid !== undefined && !LIBTV_PROJECT_UUID.test(projectUuid)) throw new Error('LibTV project UUID must be 32 hexadecimal characters');
  if (dryRun === live) throw new Error('choose exactly one of --dry-run or --live');
  const manifest = await readJson(join(root, 'assets', `${segmentId}-asset-manifest.json`));
  if (manifest.segmentId !== segmentId) throw new Error(`asset manifest does not belong to ${segmentId}`);
  if (dryRun) {
    await validateReviewedManifest(root, manifest, join(root, 'assets', `${segmentId}-asset-manifest.json`));
    return buildAssetGenerationPlan(manifest, { root, model: option(args, 'model', { required: false }) ?? DEFAULT_MODEL, projectUuid });
  }
  if (!manifest.items.some(item => item.scope === 'segment' && item.status === 'awaiting_review' && !item.path)) {
    throw new Error('live LibTV generation has no pending segment assets');
  }
  if (typeof manifest.lockedByReviewId !== 'string' || manifest.lockedByReviewId.trim() === '') {
    throw new Error('live LibTV generation requires a human-reviewed locked asset manifest');
  }
  const manifestPath = join(root, 'assets', `${segmentId}-asset-manifest.json`);
  await validateReviewedManifest(root, manifest, manifestPath, { prepareOutputs: true });
  const runId = options.runId ?? `libtv-${randomUUID()}`;
  if (!SAFE_ID.test(runId)) throw new Error('LibTV run ID must be a safe identifier');
  const fingerprint = await sha256File(manifestPath);
  const paths = await claimLibTvRun(root, runId, fingerprint, manifest);
  await options.afterClaim?.({ runId, fingerprint });
  const stagingRoot = join(root, 'outputs', '.libtv-runs', runId);
  const plan = buildAssetGenerationPlan(manifest, {
    root, model: option(args, 'model', { required: false }) ?? DEFAULT_MODEL, outputRoot: stagingRoot, projectUuid
  });
  try {
    const execution = await executeAssetGenerationPlan(plan, { root, runner: options.runner, runId });
    return await publishLibTvSuccess(root, paths, runId, fingerprint, execution);
  } catch (error) {
    await markLibTvUncertain(root, paths, runId, fingerprint, manifest, error.commands ?? []);
    throw new Error(`LibTV live run ${runId} is uncertain; reconcile it before retrying`);
  }
}
