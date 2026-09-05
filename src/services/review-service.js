import { createHash, randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { transitionArtifact } from '../domain/artifact.js';
import { assertProjectState } from '../domain/project-state.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { inspectArtifactFile, verifyArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { isAutoLockType } from '../domain/review-policy.js';
import { requireMatchingAssetVisualAudit } from '../domain/asset-visual-audit.js';
import { hasPreciseVerifiedDirectorRoute } from '../domain/director-route-state.js';
import { generateSegmentSummary } from './segment-summary-service.js';
import { assertStoryPlan } from '../domain/story-plan.js';
import { requirePassingSourceComparatorAudit } from './source-comparator-audit-service.js';
import { isSourceFactMachineDelegated } from '../domain/reference-workflow.js';
import { workflowProfileIdOf } from '../domain/workflow-profile.js';

function jsonSha256(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function statePath(root) {
  return join(root, 'project-state.json');
}

// Transaction journals store paths relative to their project root.  Public
// review entrypoints therefore normalize a caller-supplied relative root once,
// before they compose any write target with that root.  Without this, a path
// such as "projects/example" can be joined twice and commit a valid journal
// below a nested projects/example/projects/example directory.
function normalizeProjectRoot(root) {
  return resolve(root);
}

function findArtifact(state, artifactId) {
  const index = state.artifacts.findIndex(({ id }) => id === artifactId);
  if (index === -1) throw new Error(`artifact not found: ${artifactId}`);
  return index;
}

export async function requireCurrentCreativeBinding(root, state, artifact, plan = null) {
  if (artifact?.type !== 'story_plan') return null;
  const latestCreative = state.artifacts
    .filter(item => item.type === 'creative_brief' && item.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0];
  if (!latestCreative) throw new Error('story plan review requires a locked creative brief');
  await verifyLockedArtifact(root, latestCreative);
  if (!plan) {
    const inspected = await verifyArtifactFile(root, artifact);
    plan = assertStoryPlan(await readJson(inspected.path));
  }
  if (plan.creativeBriefId !== latestCreative.id || plan.creativeBriefSha256 !== latestCreative.sha256) {
    throw new Error(`story plan ${artifact.id} is bound to a stale creative brief; rebuild Gate 2 from ${latestCreative.id}`);
  }
  return latestCreative;
}

async function transition(root, artifactId, status, reviewId) {
  const path = statePath(root);
  const state = assertProjectState(await readJson(path));
  const index = findArtifact(state, artifactId);
  const artifact = state.artifacts[index];
  const inspected = status === 'awaiting_review'
    ? await inspectArtifactFile(root, artifact.path)
    : await verifyArtifactFile(root, artifact);
  state.artifacts[index] = transitionArtifact({ ...artifact, sha256: inspected.sha256 }, status, reviewId);
  state.updatedAt = new Date().toISOString();
  assertProjectState(state);
  await writeJsonAtomic(path, state);
  return state.artifacts[index];
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

async function decide(root, artifactId, decision, note, correction, options = {}) {
  requireText(note, 'note');
  if (decision === 'rejected') requireText(correction, 'correction');
  const actor = options.reviewFields?.actor ?? 'human';
  if (!['human', 'system'].includes(actor)) throw new Error('artifact review actor must be human or system');
  if (actor === 'system' && decision !== 'rejected') throw new Error('system artifact decisions may only reject; approval requires the normal human or auto-lock path');
  const path = statePath(root);
  const state = assertProjectState(await readJson(path));
  const preDecisionState = structuredClone(state);
  const index = findArtifact(state, artifactId);
  if (state.artifacts[index].status !== 'awaiting_review') {
    throw new Error(`artifact ${artifactId} is not awaiting review`);
  }

  const id = `review-${randomUUID()}`;
  const review = {
    ...(options.reviewFields ?? {}),
    id,
    artifactId,
    decision,
    note,
    correction: correction ?? null,
    createdAt: new Date().toISOString(),
    actor
  };
  const reviewedArtifact = state.artifacts[index];
  const inspected = await verifyArtifactFile(root, reviewedArtifact);
  if (decision === 'approved' && reviewedArtifact.type === 'story_plan') {
    await requireCurrentCreativeBinding(root, state, reviewedArtifact);
  }
  review.submittedArtifactSha256 = inspected.sha256;
  const status = decision === 'approved' ? 'locked' : 'rejected';
  state.artifacts[index] = transitionArtifact(
    state.artifacts[index],
    status,
    id
  );
  state.updatedAt = new Date().toISOString();
  assertProjectState(state);

  const writes = [];
  if (decision === 'approved') {
    // Only snapshot for human reviews; auto-lock (system) reviews skip the
    // full-state snapshot to save disk and reduce token cost on large projects.
    if ((options.reviewFields?.actor ?? 'human') !== 'system') {
      writes.push({ path: join(root, 'versions', `project-state.${id}.json`), value: preDecisionState });
    }
    if (reviewedArtifact.type === 'segmentation') {
      const segmentationPath = join(root, reviewedArtifact.path);
      const canonical = await readJson(segmentationPath);
      if (!Array.isArray(canonical?.segments) || canonical.segments.length === 0) {
        throw new Error('approved segmentation must contain a non-empty segments array');
      }
      if (canonical.segments.some(segment => segment.status !== 'awaiting_review')) {
        throw new Error('every segment must be awaiting_review before segmentation approval');
      }
      writes.push({ path: join(root, 'versions', `segmentation.${id}.json`), value: canonical });
      const lockedPath = join(root, 'versions', `segmentation.${id}.locked.json`);
      const lockedCanonical = {
        ...canonical,
        segments: canonical.segments.map(segment => ({ ...segment, status: 'locked', lockedByReviewId: id }))
      };
      const lockedSha256 = jsonSha256(lockedCanonical);
      state.artifacts[index] = {
        ...state.artifacts[index],
        path: relative(root, lockedPath).split(sep).join('/'),
        sha256: lockedSha256
      };
      review.artifactSha256 = lockedSha256;
      writes.push({ path: lockedPath, value: lockedCanonical });
    }
  }
  review.artifactSha256 ??= inspected.sha256;
  writes.push(
    { path: join(root, 'reviews', `${id}.json`), value: review },
    { path, value: state }
  );
  if (options.transactionWritesFactory) {
    const additionalWrites = await options.transactionWritesFactory({
      review: structuredClone(review),
      reviewedArtifact: structuredClone(reviewedArtifact),
      nextArtifact: structuredClone(state.artifacts[index]),
      nextState: structuredClone(state)
    });
    if (!Array.isArray(additionalWrites)) throw new TypeError('transactionWritesFactory must return an array of transaction writes');
    writes.push(...additionalWrites);
  }
  await commitJsonTransaction(root, `artifact-review-${id}`, writes, options.transactionOptions);
  return review;
}

export async function decideArtifactWithEvidence(root, input) {
  root = normalizeProjectRoot(root);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const state = assertProjectState(await readJson(statePath(root)));
    const reviewFields = await input.evidenceFactory(state);
    return decide(root, input.artifactId, input.decision, input.note, input.correction, {
      reviewFields,
      transactionOptions: input.transactionOptions,
      transactionWritesFactory: input.transactionWritesFactory
    });
  });
}

export async function submitForReview(root, artifactId, options = {}) {
  root = normalizeProjectRoot(root);
  return withProjectLock(root, async () => {
    const state = assertProjectState(await readJson(statePath(root)));
    const artifact = state.artifacts.find(({ id }) => id === artifactId);
    if (artifact?.type === 'shot_narration') {
      throw new Error('shot_narration must pass machine review via narration-lint before human review; use `narration-lint` instead of `submit-review`');
    }
    if (hasPreciseVerifiedDirectorRoute(state) && artifact?.mediaKind !== 'audio' && ['project_asset', 'segment_asset'].includes(artifact.type)) {
      requireMatchingAssetVisualAudit(state, artifact);
    }
    if (artifact?.type === 'story_plan') {
      const inspected = await verifyArtifactFile(root, artifact);
      const plan = assertStoryPlan(await readJson(inspected.path));
      await requireCurrentCreativeBinding(root, state, artifact, plan);
      if ((plan.creativeDecision.referenceWorkflow?.requiresSourceFactWorkflow === true
        || plan.creativeDecision.referenceWorkflow?.workflowRoute === 'source_fact')
        && !isSourceFactMachineDelegated(plan.creativeDecision.referenceWorkflow, plan.creativeDecision, plan.sourceFactDelegation?.workflowProfileId ?? null)) {
        await (options.requirePassingSourceComparatorAudit ?? requirePassingSourceComparatorAudit)(root, artifact);
      }
    }
    return transition(root, artifactId, 'awaiting_review');
  });
}

export async function approveArtifact(root, artifactId, note, options = {}) {
  root = normalizeProjectRoot(root);
  let approvedArtifact = null;
  const review = await withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const state = assertProjectState(await readJson(statePath(root)));
    const artifact = state.artifacts.find(({ id }) => id === artifactId);
    approvedArtifact = artifact ?? null;
    if (artifact?.status === 'locked' && artifact.lockedByReviewId) {
      return readJson(join(root, 'reviews', `${encodeURIComponent(artifact.lockedByReviewId)}.json`));
    }
    return decide(root, artifactId, 'approved', note, null, options);
  });
  if (approvedArtifact?.type === 'video_segment' && approvedArtifact.segmentId) {
    try {
      await generateSegmentSummary(root, approvedArtifact.segmentId);
    } catch (error) {
      try {
        await options.onSummaryError?.(error);
      } catch {
        // Context-card telemetry is fail-open and cannot invalidate a completed Gate 5 review.
      }
    }
  }
  return review;
}

export async function rejectArtifact(root, artifactId, note, correction) {
  root = normalizeProjectRoot(root);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    return decide(root, artifactId, 'rejected', note, correction);
  });
}

export async function rejectArtifactBySystem(root, artifactId, note, correction, evidence = {}) {
  root = normalizeProjectRoot(root);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    return decide(root, artifactId, 'rejected', note, correction, {
      reviewFields: { ...structuredClone(evidence), actor: 'system', machineRejected: true }
    });
  });
}

/**
 * Auto-lock an artifact that passed machine validation.
 * Performs draft → awaiting_review → locked atomically in one lock acquisition.
 * Only works for artifact types classified as auto-lock in review-policy.
 * Returns the review record (actor: 'system').
 */
export async function autoLockArtifact(root, artifactId, note, options = {}) {
  root = normalizeProjectRoot(root);
  requireText(note, 'note');
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = statePath(root);
    const state = assertProjectState(await readJson(path));
    const index = findArtifact(state, artifactId);
    const artifact = state.artifacts[index];

    const delegatedSimpleRemakeAsset = ['project_asset', 'segment_asset'].includes(artifact.type)
      && workflowProfileIdOf(state) === 'simple_remake'
      && options.delegatedByProfile === 'simple_remake';
    const delegatedMechanicalAsset = artifact.type === 'project_asset'
      && state.routeDecision?.executionClass === 'mechanical_asset_prompt'
      && options.delegatedByExecutionClass === 'mechanical_asset_prompt';
    const delegatedSimpleRemakeStory = artifact.type === 'story_plan'
      && workflowProfileIdOf(state) === 'simple_remake'
      && options.delegatedByProfile === 'simple_remake';
    if (!isAutoLockType(artifact.type) && !delegatedSimpleRemakeAsset && !delegatedMechanicalAsset && !delegatedSimpleRemakeStory) {
      throw new Error(`artifact type ${artifact.type} requires human review; cannot auto-lock`);
    }

    // Atomic storyboard frames are never assumed valid merely because their
    // image file exists.  A clean-zero-context visual audit for the exact
    // revision/SHA must already be locked before this invisible intermediate
    // can feed the native contact-sheet compositor.
    if (artifact.type === 'storyboard_panel') {
      requireMatchingAssetVisualAudit(state, artifact);
    }

    // Already locked? Return existing review.
    if (artifact.status === 'locked' && artifact.lockedByReviewId) {
      return readJson(join(root, 'reviews', `${encodeURIComponent(artifact.lockedByReviewId)}.json`));
    }

    if (!['draft', 'rework', 'awaiting_review'].includes(artifact.status)) {
      throw new Error(`auto-lock requires draft, rework, or awaiting_review status, found ${artifact.status}`);
    }

    const inspected = await inspectArtifactFile(root, artifact.path);
    if (delegatedSimpleRemakeStory) {
      const plan = assertStoryPlan(await readJson(inspected.path));
      await requireCurrentCreativeBinding(root, state, artifact, plan);
    }
    const id = `review-${randomUUID()}`;
    const review = {
      id,
      artifactId,
      decision: 'approved',
      note,
      correction: null,
      createdAt: new Date().toISOString(),
      actor: 'system',
      autoLocked: true,
      ...(delegatedSimpleRemakeAsset || delegatedSimpleRemakeStory || delegatedMechanicalAsset ? {
        machineReviewed: true,
        ...(delegatedMechanicalAsset
          ? { delegatedByExecutionClass: 'mechanical_asset_prompt' }
          : { delegatedByProfile: 'simple_remake' }),
        machineEvidence: structuredClone(options.machineEvidence ?? {})
      } : {}),
      submittedArtifactSha256: inspected.sha256,
      artifactSha256: inspected.sha256
    };

    // Atomic: draft/rework → awaiting_review → locked, or finish an artifact
    // already placed in awaiting_review by a machine-validation publisher.
    let transitioned = { ...artifact, sha256: inspected.sha256 };
    if (artifact.status !== 'awaiting_review') transitioned = transitionArtifact(transitioned, 'awaiting_review');
    transitioned = transitionArtifact(transitioned, 'locked', id);
    const artifactWrites = [];
    if (artifact.type === 'segmentation') {
      const canonical = await readJson(join(root, artifact.path));
      if (!Array.isArray(canonical?.segments) || canonical.segments.length === 0) {
        throw new Error('auto-locked segmentation must contain a non-empty segments array');
      }
      if (canonical.segments.some(segment => segment.status !== 'awaiting_review')) {
        throw new Error('every segment must be awaiting_review before segmentation auto-lock');
      }
      const lockedCanonical = {
        ...canonical,
        segments: canonical.segments.map(segment => ({ ...segment, status: 'locked', lockedByReviewId: id }))
      };
      const lockedPath = join(root, 'versions', `segmentation.${id}.locked.json`);
      const lockedSha256 = jsonSha256(lockedCanonical);
      transitioned = {
        ...transitioned,
        path: relative(root, lockedPath).split(sep).join('/'),
        sha256: lockedSha256
      };
      review.artifactSha256 = lockedSha256;
      artifactWrites.push(
        { path: join(root, 'versions', `segmentation.${id}.json`), value: canonical },
        { path: lockedPath, value: lockedCanonical }
      );
    }
    state.artifacts[index] = transitioned;
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);

    const writes = [
      ...artifactWrites,
      { path: join(root, 'reviews', `${id}.json`), value: review },
      { path, value: state }
    ];
    await commitJsonTransaction(root, `artifact-auto-lock-${id}`, writes);
    return review;
  });
}

/**
 * Batch-approve all awaiting_review artifacts of the given types.
 * Used at human checkpoints to approve multiple artifacts at once.
 * Returns an array of review records.
 */
export async function batchApproveByTypes(root, types, note, options = {}) {
  root = normalizeProjectRoot(root);
  requireText(note, 'note');
  if (!Array.isArray(types) || types.length === 0) throw new TypeError('types must be a non-empty array');
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const path = statePath(root);
    const state = assertProjectState(await readJson(path));
    const typeSet = new Set(types);
    const pending = state.artifacts.filter(
      a => a.status === 'awaiting_review' && typeSet.has(a.type)
    );
    if (options.requireExactlyOne && pending.length !== 1) {
      throw new Error(`checkpoint requires exactly one awaiting-review artifact, found ${pending.length}`);
    }
    if (pending.length === 0) return [];

    const reviews = [];
    for (const artifact of pending) {
      const index = state.artifacts.findIndex(({ id }) => id === artifact.id);
      const inspected = await verifyArtifactFile(root, state.artifacts[index]);
      if (artifact.type === 'story_plan') {
        const plan = assertStoryPlan(await readJson(inspected.path));
        await requireCurrentCreativeBinding(root, state, artifact, plan);
      }
      if (hasPreciseVerifiedDirectorRoute(state) && artifact.mediaKind !== 'audio'
        && ['project_asset', 'segment_asset'].includes(artifact.type)) {
        requireMatchingAssetVisualAudit(state, state.artifacts[index]);
      }
      const id = `review-${randomUUID()}`;
      const review = {
        id,
        artifactId: artifact.id,
        decision: 'approved',
        note,
        correction: null,
        createdAt: new Date().toISOString(),
        actor: 'human',
        submittedArtifactSha256: inspected.sha256,
        artifactSha256: inspected.sha256
      };
      state.artifacts[index] = transitionArtifact(
        { ...state.artifacts[index], sha256: inspected.sha256 },
        'locked',
        id
      );
      reviews.push(review);
    }
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);

    const writes = reviews.map(r => ({ path: join(root, 'reviews', `${r.id}.json`), value: r }));
    writes.push({ path, value: state });
    await commitJsonTransaction(root, `batch-approve-${randomUUID()}`, writes);
    return reviews;
  });
}
