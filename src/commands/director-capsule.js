import { join, resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { assertShotNarration } from '../domain/shot-narration.js';
import { assertCapabilityManifest } from '../domain/director-capability.js';
import { renderDirectorCapabilityCapsules, renderDirectorScreenConstraints } from '../domain/director-narration.js';
import { assertProjectState } from '../domain/project-state.js';
import { loadCanonicalSegments } from './assets.js';
import { reconcileCapabilityManifestSegmentIds } from '../services/director-route-service.js';

export async function runDirectorCapsule(args) {
  const root = resolve(option(args, 'project'));
  const narrationFile = await inspectArtifactFile(root, option(args, 'narration'));
  const manifestFile = await inspectArtifactFile(root, option(args, 'manifest'));
  const narration = assertShotNarration(await readJson(narrationFile.path));
  // Match compile-seedance's runtime-only reconciliation. This never writes the
  // reviewed story plan, the capability manifest, or the locked segmentation.
  const persistedManifest = assertCapabilityManifest(await readJson(manifestFile.path), { allowLegacyMissingProjectRequiredAssets: true });
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const canonicalSegments = await loadCanonicalSegments(root, state, { requireLockedSegmentation: false });
  const { manifest, segmentIdentityMap } = reconcileCapabilityManifestSegmentIds(persistedManifest, canonicalSegments);
  return {
    narrationId: narration.id,
    capabilityManifestId: manifest.id,
    ...(segmentIdentityMap ? { segmentIdentityReconciliation: segmentIdentityMap } : {}),
    promptBlock: renderDirectorScreenConstraints(narration, manifest, manifestFile.sha256),
    archivedCapsule: renderDirectorCapabilityCapsules(narration, manifest, manifestFile.sha256),
    usage: 'promptBlock 进入提示词正文；archivedCapsule 只作为审计留档，禁止粘贴进提示词'
  };
}
