import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { assertAssetVisualAudit } from '../domain/asset-visual-audit.js';
import { registerArtifact } from '../services/intake-service.js';
import { option } from './args.js';
import { autoLockArtifact } from '../services/review-service.js';
import { readJson as readProjectJson } from '../storage/json-store.js';
import { join } from 'node:path';
import { hasPreciseVerifiedDirectorRoute } from '../domain/director-route-state.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runAssetVisualAudit(args) {
  const root = resolve(option(args, 'project'));
  const input = resolve(option(args, 'input'));
  if (outside(root, input)) throw new Error('asset visual audit input must stay inside project root');
  const audit = assertAssetVisualAudit(await readJson(input));
  const artifact = await registerArtifact(root, {
    id: audit.id,
    type: 'asset_visual_audit',
    revision: audit.assetRevision,
    status: 'draft',
    path: relative(root, input).split(sep).join('/'),
    assetId: audit.assetId,
    assetType: audit.assetType,
    assetRevision: audit.assetRevision,
    assetSha256: audit.assetSha256,
    decision: audit.decision,
    inspectionMode: audit.inspectionMode,
    inspectorContextMode: audit.inspectorContextMode,
    inspectorTaskId: audit.inspectorTaskId,
    ...(audit.characterMedium ? { characterMedium: audit.characterMedium } : {}),
    observedIdentityCount: audit.observedIdentityCount,
    blockerCount: audit.blockerCount,
    checkIds: audit.checks.filter(check => check.result === 'PASS').map(check => check.id),
    failedCheckIds: audit.checks.filter(check => check.result === 'FAIL').map(check => check.id)
  });
  const state = await readProjectJson(join(root, 'project-state.json'));
  if (audit.decision === 'PASS' && hasPreciseVerifiedDirectorRoute(state)) {
    const review = await autoLockArtifact(root, artifact.id, 'auto-locked: clean-zero-context multimodal pixel audit passed for the exact asset revision and SHA');
    const refreshed = await readProjectJson(join(root, 'project-state.json'));
    const auditedAsset = refreshed.artifacts.find(candidate => candidate.id === audit.assetId
      && candidate.type === 'storyboard_panel'
      && candidate.assetType === audit.assetType
      && candidate.revision === audit.assetRevision
      && candidate.sha256 === audit.assetSha256
      && candidate.visualAuditId === audit.id);
    // Atomic storyboard intermediates and panel-only support controls never
    // wait for a separate human click. Both remain internal and are excluded
    // from the canonical Gate 4 media manifest; the canonical sheet remains
    // the only storyboard asset presented at Gate 3.
    const assetReview = auditedAsset
      ? await autoLockArtifact(root, auditedAsset.id, 'auto-locked: exact atomic storyboard panel has a locked clean-zero-context multimodal pixel PASS')
      : null;
    return {
      artifact: { ...artifact, status: 'locked', lockedByReviewId: review.id },
      review,
      ...(assetReview ? { auditedStoryboardPanelReview: assetReview } : {})
    };
  }
  return { artifact, review: null };
}
