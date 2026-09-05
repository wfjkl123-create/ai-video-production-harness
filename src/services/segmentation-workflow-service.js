import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { assertArtifact } from '../domain/artifact.js';
import { assertProjectState } from '../domain/project-state.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { sha256File } from '../storage/checksum.js';

const SHA256 = /^[a-f0-9]{64}$/;

function validateStoryPlanBinding(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('storyPlanBinding must be an object');
  if (typeof value.storyPlanId !== 'string' || value.storyPlanId.trim() === '') throw new TypeError('storyPlanBinding.storyPlanId must be a non-empty string');
  if (!SHA256.test(value.storyPlanSemanticSha256 ?? '')) throw new TypeError('storyPlanBinding.storyPlanSemanticSha256 must be a lowercase SHA-256');
  return { storyPlanId: value.storyPlanId, storyPlanSemanticSha256: value.storyPlanSemanticSha256 };
}

export function isPathInside(base, candidate, pathApi = { relative, isAbsolute, sep }) {
  const value = pathApi.relative(base, candidate);
  return value !== '..' && !value.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(value);
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('segments must be a non-empty array');
  for (const segment of segments) {
    if (!/^segment-\d{3,}$/.test(segment?.id ?? '')) throw new Error('each segment requires a canonical segment ID');
    if (!Number.isFinite(segment.duration) || segment.duration <= 0 || segment.duration > 15) throw new Error(`${segment.id} duration must be at most 15 seconds`);
    if (segment.status !== 'awaiting_review') throw new Error(`${segment.id} must enter awaiting_review`);
  }
}

export function persistSegmentation(root, input) {
  validateSegments(input?.segments);
  const storyPlanBinding = validateStoryPlanBinding(input?.storyPlanBinding);
  const artifact = assertArtifact({
    id: input.id, type: 'segmentation', revision: input.revision ?? 1,
    status: 'draft', path: input.path
  });
  return withProjectLock(root, async () => {
    const rootPath = resolve(root);
    const output = resolve(rootPath, artifact.path);
    const requestedSegments = join(rootPath, 'segments');
    if (!isPathInside(requestedSegments, output) || output === requestedSegments) {
      throw new Error('segmentation path must stay in the project segments directory');
    }
    const [actualRoot, actualSegments, actualParent] = await Promise.all([
      realpath(rootPath), realpath(requestedSegments), realpath(dirname(output))
    ]);
    if (!isPathInside(actualRoot, actualSegments) || !isPathInside(actualSegments, actualParent)) {
      throw new Error('segmentation path symlink must stay in the project segments directory');
    }
    const statePath = join(rootPath, 'project-state.json');
    const state = assertProjectState(await readJson(statePath));
    if (state.artifacts.some(({ id }) => id === artifact.id)) throw new Error(`artifact already exists: ${artifact.id}`);
    await writeJsonAtomic(output, {
      segments: structuredClone(input.segments),
      ...(storyPlanBinding ? { storyPlanBinding } : {})
    });
    state.artifacts.push({ ...artifact, sha256: await sha256File(output) });
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    return state.artifacts.at(-1);
  });
}
