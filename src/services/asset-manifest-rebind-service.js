import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { compileProjectAssetManifest } from '../commands/assets.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function jsonSha256(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function fingerprint(manifest) {
  return JSON.stringify({
    sourceArtifactIds: manifest.sourceArtifactIds,
    observedHandoffId: manifest.observedHandoffId,
    canonicalHdRestorationHandoffId: manifest.canonicalHdRestorationHandoffId,
    items: manifest.items.map(item => ({
      id: item.id,
      type: item.type,
      scope: item.scope,
      status: item.status,
      path: item.path,
      sha256: item.sha256,
      lockedByReviewId: item.lockedByReviewId,
      responsibility: item.responsibility,
      mustNotControl: item.mustNotControl,
      stateRole: item.stateRole,
      ownerScope: item.ownerScope
    }))
  });
}

/**
 * Rebuild a reviewed segment's asset manifest from current locked assets.
 * The old locked manifest is preserved verbatim and the rebuilt manifest is
 * deliberately left awaiting human review.  This is the only supported path
 * for replacing a locked manifest's inputs without editing it in place.
 */
export async function rebindAssetManifest(root, segmentId, note, options = {}) {
  root = resolve(root);
  if (!SAFE_ID.test(segmentId ?? '')) throw new Error('segment ID must be a safe CLI identifier');
  requireText(note, 'note');
  const compileManifest = options.compileManifest ?? compileProjectAssetManifest;

  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const manifestPath = join(root, 'assets', `${segmentId}-asset-manifest.json`);
    const previous = await readJson(manifestPath);
    if (previous.id !== `${segmentId}-asset-manifest` || previous.segmentId !== segmentId
      || previous.status !== 'locked' || typeof previous.lockedByReviewId !== 'string' || previous.lockedByReviewId.trim() === '') {
      throw new Error('only a locked manifest for the requested segment can be rebound');
    }

    const next = await compileManifest(root, segmentId);
    if (next.id !== previous.id || next.segmentId !== segmentId || next.status !== 'awaiting_review') {
      throw new Error('rebuilt asset manifest must match the requested segment and await human review');
    }
    if (!Array.isArray(next.items) || next.items.length === 0 || next.items.some(item => item.status !== 'locked')) {
      throw new Error('rebound manifest may contain only currently locked input assets');
    }
    if (fingerprint(previous) === fingerprint(next)) {
      throw new Error('rebuilt asset manifest has no input change; rebind is unnecessary');
    }

    const id = `asset-manifest-rebind-${randomUUID()}`;
    const snapshotPath = join(root, 'versions', `${segmentId}-asset-manifest.${previous.lockedByReviewId}.pre-${id}.locked.json`);
    const evidencePath = join(root, 'evidence', 'asset-manifest-rebinds', `${id}.json`);
    const evidence = {
      id,
      kind: 'asset_manifest_rebind',
      segmentId,
      actor: 'human_approved_workflow',
      note,
      createdAt: new Date().toISOString(),
      previousManifestLockedByReviewId: previous.lockedByReviewId,
      previousManifestSha256: jsonSha256(previous),
      nextManifestSha256: jsonSha256(next),
      previousItemIds: previous.items.map(item => item.id),
      nextItemIds: next.items.map(item => item.id),
      previousSnapshotPath: snapshotPath.replace(`${root}/`, '')
    };
    await commitJsonTransaction(root, id, [
      { path: snapshotPath, value: previous },
      { path: manifestPath, value: next },
      { path: evidencePath, value: evidence }
    ]);
    return evidence;
  });
}
