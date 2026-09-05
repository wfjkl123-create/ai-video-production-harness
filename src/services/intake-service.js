import { join } from 'node:path';
import { assertArtifact } from '../domain/artifact.js';
import { assertProjectState } from '../domain/project-state.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { assertAssetVisualAudit, assertCharacterBoardDescriptor } from '../domain/asset-visual-audit.js';

export async function registerArtifact(root, descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new TypeError('artifact descriptor must be an object');
  if (!['draft', 'rework'].includes(descriptor.status)) throw new Error('new artifacts must enter as draft or rework');
  const inspected = await inspectArtifactFile(root, descriptor.path);
  const artifact = {
    ...structuredClone(descriptor),
    sha256: inspected.sha256
  };
  assertCharacterBoardDescriptor(artifact);
  if (artifact.type === 'asset_visual_audit') {
    const audit = assertAssetVisualAudit(await readJson(inspected.path));
    for (const field of ['id', 'assetId', 'assetType', 'assetRevision', 'assetSha256', 'decision', 'inspectionMode', 'inspectorContextMode', 'inspectorTaskId', 'observedIdentityCount', 'blockerCount']) {
      if (artifact[field] !== audit[field]) throw new Error(`asset_visual_audit descriptor ${field} does not match its file`);
    }
  }
  assertArtifact(artifact);
  return withProjectLock(root, async () => {
    const statePath = join(root, 'project-state.json');
    const state = assertProjectState(await readJson(statePath));
    if (state.artifacts.some(({ id }) => id === artifact.id)) throw new Error(`artifact already exists: ${artifact.id}`);
    state.artifacts.push(artifact);
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);
    await writeJsonAtomic(statePath, state);
    return artifact;
  });
}
