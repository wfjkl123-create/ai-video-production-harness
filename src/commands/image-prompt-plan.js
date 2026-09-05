import { isAbsolute, relative, resolve, join, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { option } from './args.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { buildImagePromptPlan } from '../services/image-profile-router-service.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { loadVerifiedCapabilityManifest } from '../services/director-route-service.js';
import { requireMatchingAssetVisualAudit } from '../domain/asset-visual-audit.js';
import { canonicalAssetType } from '../services/asset-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function inside(root, value, label) {
  const path = resolve(root, value);
  if (outside(root, path)) throw new Error(`${label} must stay inside project root`);
  return path;
}

async function projectJson(root, value, label) {
  if (isAbsolute(value)) throw new Error(`${label} must be project-relative`);
  const inspected = await inspectArtifactFile(root, value);
  return readJson(inspected.path);
}

async function safeOutput(root, path) {
  const relativeDirectory = relative(root, dirname(path));
  if (outside(root, dirname(path))) throw new Error('image prompt plan output directory escapes project root');
  let current = root;
  for (const part of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('image prompt plan output directory must not contain symlinks');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  const [actualRoot, actualParent] = await Promise.all([realpath(root), realpath(dirname(path))]);
  if (outside(actualRoot, actualParent)) throw new Error('image prompt plan output directory escapes project root');
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('image prompt plan output must not be a symlink');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function planningSatisfiedAssetTypes(state) {
  if (!state) return [];
  return (state.artifacts ?? [])
    .filter(item => ['project_asset', 'segment_asset'].includes(item.type))
    .filter(item => {
      if (item.status === 'locked') return true;
      if (!['draft', 'rework', 'awaiting_review'].includes(item.status)) return false;
      // Image planning must not invent an image task for a prepared audio
      // reference. Audio has no pixel-audit contract; its exact file still
      // remains pending for the normal Gate 3 human review and lock.
      if (item.mediaKind === 'audio') return true;
      try {
        requireMatchingAssetVisualAudit(state, item);
        return true;
      } catch {
        return false;
      }
    })
    // Profile-specific asset types satisfy the same canonical requirements
    // used by the director route and manifest compiler.
    .map(item => canonicalAssetType(item.assetType));
}

export function validateRemainingAssetLifecycle(plan, state) {
  const pending = plan?.remainingAssetLifecycle?.existingAssetsPendingGate3Lock ?? [];
  if (pending.length === 0) return;
  if (!state) throw new Error('remaining asset lifecycle requires project state');
  for (const expected of pending) {
    const artifact = (state.artifacts ?? []).find(item => item.id === expected.assetId);
    if (!artifact) throw new Error(`remaining asset lifecycle references unknown artifact ${expected.assetId}`);
    if (artifact.assetType !== expected.assetType || artifact.sha256 !== expected.sha256) {
      throw new Error(`remaining asset lifecycle does not match artifact ${expected.assetId}`);
    }
    if (artifact.status === 'locked') {
      throw new Error(`remaining asset lifecycle incorrectly marks locked artifact ${expected.assetId} as pending Gate 3 lock`);
    }
  }
}

export async function runImagePromptPlan(args) {
  const root = resolve(option(args, 'project'));
  const inputValue = option(args, 'input');
  const input = await projectJson(root, inputValue, 'image prompt plan input');
  const requestedProfile = option(args, 'model-profile', { required: false });
  const modelProfile = requestedProfile
    ? await projectJson(root, requestedProfile, 'model profile')
    : await readJson(fileURLToPath(new URL('../../knowledge/image-profiles/model-profiles/codex-image-gen-generic-v1.json', import.meta.url)));
  const state = await readJson(join(root, 'project-state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const routed = state ? await loadVerifiedCapabilityManifest(root, state) : null;
  // Prompt planning is non-generating. A draft asset may satisfy the planning
  // route when an exact-SHA clean-zero-context visual audit is already locked;
  // the asset itself still remains pending for the normal Gate 3 human review.
  const satisfiedAssetTypes = planningSatisfiedAssetTypes(state);
  const plan = buildImagePromptPlan(input, modelProfile, {
    capabilityManifest: routed?.manifest ?? null,
    satisfiedAssetTypes
  });
  validateRemainingAssetLifecycle(plan, state);
  const requestedOutput = option(args, 'out', { required: false });
  const outputPath = inside(root, requestedOutput ?? join('runs', 'image-prompt-plans', `${plan.id}.json`), 'image prompt plan output');
  await safeOutput(root, outputPath);
  const existing = await readJson(outputPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && existing.planFingerprint !== plan.planFingerprint) throw new Error(`image prompt plan ${plan.id} already exists with a different fingerprint`);
  if (!existing) await writeJsonAtomic(outputPath, plan);
  return { ...plan, path: relative(root, outputPath).split(sep).join('/') };
}
