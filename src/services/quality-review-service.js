import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { assertQualityReview, assertQualityRubric, evaluateQualityRubric } from '../domain/quality-review.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile, verifyArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { decideArtifactWithEvidence } from './review-service.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';
import { assertExecutionObservation } from '../domain/execution-ledger.js';
import { deriveExecutionObservationBestEffort } from './authoritative-trace-observation-service.js';
import { assertProjectState } from '../domain/project-state.js';
import { withProjectLock } from '../storage/project-lock.js';
import { recoverJsonTransactions } from '../storage/transaction-journal.js';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

async function rejectionReviewForArtifact(root, artifact) {
  const expectedId = artifact.rejectedByReviewId ?? null;
  const names = expectedId
    ? [`${encodeURIComponent(expectedId)}.json`]
    : (await readdir(join(root, 'reviews'))).filter(name => name.endsWith('.json'));
  const matches = [];
  for (const name of names) {
    const path = `reviews/${name}`;
    const candidate = await readJson(join(root, path)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (candidate?.kind === 'quality_review' && candidate.actor === 'human'
      && candidate.decision === 'rejected' && candidate.artifactId === artifact.id) {
      matches.push({ candidate: assertQualityReview(candidate), path });
    }
  }
  if (matches.length !== 1) {
    throw new Error(`rejected predecessor ${artifact.id} must bind exactly one Gate 5 rejection review; found ${matches.length}`);
  }
  const match = matches[0];
  if (expectedId && match.candidate.id !== expectedId) throw new Error('rejected predecessor review binding changed');
  if (match.candidate.artifactSha256 !== artifact.sha256) {
    throw new Error('rejected predecessor review does not bind the predecessor artifact SHA');
  }
  const inspected = await inspectArtifactFile(root, match.path);
  return {
    reviewId: match.candidate.id,
    artifactId: artifact.id,
    artifactSha256: match.candidate.artifactSha256,
    reviewPath: match.path,
    reviewSha256: inspected.sha256
  };
}

export async function requiredGate5Resolution(root, state, artifact) {
  if (!artifact?.supersedesArtifactId) return null;
  const predecessor = state.artifacts.find(item => item.id === artifact.supersedesArtifactId);
  if (!predecessor) throw new Error(`superseded Gate 5 artifact does not exist: ${artifact.supersedesArtifactId}`);
  if (predecessor.type !== artifact.type || predecessor.segmentId !== artifact.segmentId) {
    throw new Error('Gate 5 rework must supersede the same artifact type and segment scope');
  }
  if (predecessor.status !== 'rejected') return null;
  if (artifact.revision <= predecessor.revision) throw new Error('Gate 5 rework revision must advance the rejected predecessor');
  return rejectionReviewForArtifact(root, predecessor);
}

function normalizeFailureObservation(input, reviewId, required) {
  if (input.failureObservation === undefined) {
    if (required) throw new TypeError('failureObservation is required for a strict Gate 5 rejection');
    return null;
  }
  const observation = assertExecutionObservation({
    subjectId: reviewId,
    scope: 'segment',
    stage: 'gate5',
    failure: input.failureObservation
  });
  if (observation.failure.retryKind !== 'none') {
    throw new TypeError('a Gate 5 rejection must use retryKind none until rework actually occurs');
  }
  return observation.failure;
}

async function deriveRejectionBestEffort(root, review, input) {
  if (review.decision !== 'rejected' || !review.failureObservation) return;
  await deriveExecutionObservationBestEffort(root, {
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'gate5_rejection',
    reviewId: review.id
  }, {
    deriveExecutionObservation: input.deriveExecutionObservation,
    derivationOptions: input.observationDerivationOptions,
    onError: input.onObservationError
  });
}

function reviewMatchesInput(review, input) {
  return review.artifactId === input.artifactId
    && review.rubricId === input.rubricId
    && review.decision === input.decision
    && review.note === input.note
    && review.correction === (input.correction ?? null)
    && review.overrideReason === (input.overrideReason ?? null)
    && isDeepStrictEqual(review.scores, input.scores)
    && isDeepStrictEqual(review.evidenceByDimension, input.evidenceByDimension)
    && isDeepStrictEqual(review.triggeredVetoIds, input.triggeredVetoIds)
    && isDeepStrictEqual(review.failureObservation, input.failureObservation)
    && (review.resolvedRejection?.reviewId ?? null) === (input.resolvesReviewId ?? null);
}

async function recoveredQualityDecision(root, input) {
  const projectRoot = resolve(root);
  return withProjectLock(projectRoot, async () => {
    await recoverJsonTransactions(projectRoot);
    const state = assertProjectState(await readJson(join(projectRoot, 'project-state.json')));
    const artifact = state.artifacts.find(item => item.id === input.artifactId);
    const reviewId = artifact?.status === 'locked'
      ? artifact.lockedByReviewId
      : artifact?.status === 'rejected' ? artifact.rejectedByReviewId : null;
    if (!reviewId) return null;
    const review = await readJson(join(projectRoot, 'reviews', `${encodeURIComponent(reviewId)}.json`));
    if (review?.kind !== 'quality_review') {
      throw new Error(`artifact ${input.artifactId} was finalized by a non-quality review`);
    }
    assertQualityReview(review);
    if (!reviewMatchesInput(review, input)) {
      throw new Error(`artifact ${input.artifactId} already has a different Gate 5 decision`);
    }
    return review;
  });
}

export async function recordQualityReview(root, input) {
  requireText(input?.artifactId, 'artifactId');
  requireText(input?.rubricId, 'rubricId');
  const recovered = await recoveredQualityDecision(root, input);
  if (recovered) {
    await deriveRejectionBestEffort(root, recovered, input);
    return recovered;
  }
  let review;
  try {
    review = await decideArtifactWithEvidence(root, {
    artifactId: input.artifactId,
    decision: input.decision,
    note: input.note,
    correction: input.correction ?? null,
    transactionOptions: input.transactionOptions,
    transactionWritesFactory: async ({ review, reviewedArtifact }) => {
      const accepted = review.decision === 'approved';
      const eventType = accepted ? 'quality_review.accepted' : 'quality_review.rejected';
      const ledger = await prepareExecutionLedgerAppend(root, {
        type: eventType, occurredAt: review.createdAt,
        actor: { kind: 'human', id: null }, segmentId: reviewedArtifact.segmentId ?? null,
        correlationId: review.id, causationId: reviewedArtifact.id,
        idempotencyKey: `${eventType}:${review.id}`,
        references: [
          { kind: 'quality_review', id: review.id, path: `reviews/${encodeURIComponent(review.id)}.json` },
          { kind: 'reviewed_artifact', id: reviewedArtifact.id, path: reviewedArtifact.path, sha256: review.artifactSha256 },
          { kind: 'quality_rubric', id: review.rubricId, sha256: review.rubricSha256 },
          ...(review.resolvedRejection ? [{
            kind: 'resolved_quality_review', id: review.resolvedRejection.reviewId,
            path: review.resolvedRejection.reviewPath, sha256: review.resolvedRejection.reviewSha256
          }] : [])
        ],
        facts: {
          reviewId: review.id, artifactId: reviewedArtifact.id, artifactType: reviewedArtifact.type,
          decision: accepted ? 'accepted' : 'rejected', qualityDecision: accepted ? 'accepted' : 'rejected',
          artifactSha256: review.artifactSha256, rubricId: review.rubricId,
          rubricSha256: review.rubricSha256, overall: review.overall, qualifies: review.qualifies,
          triggeredVetoCount: review.triggeredVetoIds.length,
          ...(review.failureObservation ? {
            failureCategory: review.failureObservation.category,
            rootCauseKey: review.failureObservation.rootCauseKey,
            responsibilityStage: review.failureObservation.responsibilityStage,
            returnStage: review.failureObservation.returnStage,
            retryKind: review.failureObservation.retryKind
          } : {}),
          ...(review.resolvedRejection ? { resolvesReviewId: review.resolvedRejection.reviewId } : {})
        }
      });
      return ledger.writes;
    },
    evidenceFactory: async state => {
      const artifact = state.artifacts.find(({ id }) => id === input.artifactId);
      if (!artifact || !['video_segment', 'final_edit'].includes(artifact.type)) {
        throw new Error('quality review target must be a video_segment or final_edit');
      }
      if (artifact.status !== 'awaiting_review') throw new Error('quality review target must be awaiting_review');
      const rubricArtifact = state.artifacts.find(({ id }) => id === input.rubricId);
      if (!rubricArtifact || rubricArtifact.type !== 'quality_rubric' || rubricArtifact.status !== 'locked') {
        throw new Error('a locked rubric artifact is required');
      }
      const rubricInspected = await verifyLockedArtifact(root, rubricArtifact);
      const rubric = assertQualityRubric(await readJson(join(root, rubricArtifact.path)));
      if (rubric.id !== rubricArtifact.id) throw new Error('rubric file id must match rubric artifact id');
      if (rubric.version >= 2) {
        const current = new Map(resolveCurrentArtifacts(state.artifacts).current.map(item => [item.id, item]));
        for (const dimension of rubric.dimensions) {
          for (const anchorId of dimension.canonicalAnchorIds) {
            const anchor = current.get(anchorId);
            if (!anchor || anchor.status !== 'locked') throw new Error(`canonical quality anchor must be a current locked artifact: ${anchorId}`);
            const inspected = await verifyLockedArtifact(root, anchor);
            if (inspected.sha256 !== dimension.canonicalAnchorSha256ById[anchorId]) {
              throw new Error(`canonical quality anchor checksum changed: ${anchorId}`);
            }
          }
        }
      }
      const evaluated = evaluateQualityRubric(rubric, input);
      const artifactInspected = await verifyArtifactFile(root, artifact);
      const strict = state.videoGovernanceVersion === 2;
      const failureObservation = input.decision === 'rejected'
        ? normalizeFailureObservation(input, 'pending-review-id', strict)
        : null;
      const requiredResolution = input.decision === 'approved'
        ? await requiredGate5Resolution(root, state, artifact)
        : null;
      if (input.decision === 'approved' && requiredResolution) {
        requireText(input.resolvesReviewId, 'resolvesReviewId');
        if (input.resolvesReviewId !== requiredResolution.reviewId) {
          throw new Error('resolvesReviewId must identify the exact rejected predecessor review');
        }
      } else if (input.resolvesReviewId !== undefined && input.resolvesReviewId !== null) {
        throw new Error('resolvesReviewId is only valid when approving a direct Gate 5 rework successor');
      }
      const reviewFields = {
        kind: 'quality_review',
        rubricId: rubric.id,
        rubricSha256: rubricInspected.sha256,
        rubricVersion: rubric.version,
        scores: { ...input.scores },
        ...(rubric.version >= 2 ? { evidenceByDimension: structuredClone(input.evidenceByDimension) } : {}),
        triggeredVetoIds: [...input.triggeredVetoIds],
        overall: evaluated.overall,
        qualifies: evaluated.qualifies,
        failures: evaluated.failures,
        overrideReason: input.overrideReason ?? null,
        ...(failureObservation ? { failureObservation } : {}),
        ...(requiredResolution ? { resolvedRejection: requiredResolution } : {})
      };
      assertQualityReview({
        ...reviewFields,
        id: 'pending-review-id', actor: 'human', artifactId: artifact.id,
        artifactSha256: artifactInspected.sha256,
        decision: input.decision, note: input.note, correction: input.correction ?? null,
        createdAt: new Date().toISOString()
      });
      return reviewFields;
    }
    });
  } catch (error) {
    try {
      const committed = await recoveredQualityDecision(root, input);
      if (committed) await deriveRejectionBestEffort(root, committed, input);
    } catch {
      // Preserve the original transaction error. A later identical call can
      // still recover the journal and verify the exact persisted decision.
    }
    throw error;
  }
  await deriveRejectionBestEffort(root, review, input);
  return review;
}
