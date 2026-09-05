import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { sha256File } from '../storage/checksum.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { workflowProfileIdOf } from '../domain/workflow-profile.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function outside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export async function runReviewAssetManifest(args, options = {}) {
  const root = resolve(option(args, 'project'));
  const segmentId = option(args, 'segment');
  if (!SAFE_ID.test(segmentId)) throw new Error('segment ID must be a safe CLI identifier');
  const note = option(args, 'note');
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = join(root, 'assets', `${segmentId}-asset-manifest.json`);
    const manifest = await readJson(path);
    if (manifest.segmentId === segmentId && manifest.status === 'locked' && manifest.lockedByReviewId) {
      return readJson(join(root, 'reviews', `${encodeURIComponent(manifest.lockedByReviewId)}.json`));
    }
    if (manifest.segmentId !== segmentId || manifest.status !== 'awaiting_review') {
      throw new Error('asset manifest must belong to the segment and await human review');
    }
    const state = await readJson(join(root, 'project-state.json'));
    const delegatedSimpleRemake = options.delegatedByProfile === 'simple_remake';
    if (delegatedSimpleRemake && workflowProfileIdOf(state) !== 'simple_remake') {
      throw new Error('只有简单复刻路线可以由系统机审资产清单。');
    }
    const actualRoot = await realpath(root);
    const promptSha256 = {};
    for (const item of manifest.items.filter(value => !value.path)) {
      if (!SAFE_ID.test(item.id ?? '')) throw new Error(`unsafe asset id: ${item.id ?? ''}`);
      const prompt = await realpath(join(root, 'prompts', `${item.id}.txt`));
      if (outside(actualRoot, prompt) || !(await stat(prompt)).isFile()) throw new Error(`prompt for ${item.id} must stay inside project root`);
      promptSha256[item.id] = await sha256File(prompt);
    }
    const id = `review-${randomUUID()}`;
    const locked = { ...manifest, status: 'locked', lockedByReviewId: id };
    const manifestSha256 = createHash('sha256').update(`${JSON.stringify(locked, null, 2)}\n`).digest('hex');
    const review = {
      id, artifactId: manifest.id, artifactKind: 'asset_manifest', segmentId,
      decision: 'approved', actor: delegatedSimpleRemake ? 'system' : 'human', note, correction: null,
      ...(delegatedSimpleRemake ? { machineReviewed: true, delegatedByProfile: 'simple_remake' } : {}),
      manifestSha256, promptSha256, createdAt: new Date().toISOString()
    };
    await commitJsonTransaction(root, `asset-manifest-review-${id}`, [
      { path, value: locked },
      { path: join(root, 'reviews', `${id}.json`), value: review }
    ], options.transactionOptions);
    return review;
  });
}
