import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { sha256Text } from '../storage/checksum.js';
import { assertProjectState } from '../domain/project-state.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { loadCanonicalSegments } from '../commands/assets.js';
import { verifyLockedArtifact } from './artifact-file-service.js';
import { inspectVideoPackage } from './video-generation-service.js';
import { currentLockedSegmentVideos } from './current-segment-video-service.js';
import { currentArtifactOf } from '../domain/current-artifact.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';
import { deriveExecutionObservationBestEffort } from './authoritative-trace-observation-service.js';

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

async function generationRuns(root) {
  const entries = await readdir(join(root, 'runs'), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('._')) continue;
    const value = await readJson(join(root, 'runs', entry.name));
    if (value?.kind === 'runninghub_video' || value?.kind === 'libtv_video') runs.push(value);
  }
  return runs;
}

async function verifyApprovedQualityReview(root, project, artifact) {
  if (!artifact.lockedByReviewId) throw new Error(`${artifact.type} must be locked by a Gate 5 quality review`);
  const review = await readJson(join(root, 'reviews', `${artifact.lockedByReviewId}.json`));
  if (review.kind !== 'quality_review' || review.actor !== 'human' || review.decision !== 'approved'
    || review.artifactId !== artifact.id || review.artifactSha256 !== artifact.sha256) {
    throw new Error(`${artifact.type} locked review must be an approved human quality review bound to the exact artifact SHA`);
  }
  const rubricArtifact = project.artifacts.find(item => item.id === review.rubricId
    && item.type === 'quality_rubric' && item.status === 'locked');
  if (!rubricArtifact || rubricArtifact.sha256 !== review.rubricSha256) {
    throw new Error(`${artifact.type} quality review must bind the current locked rubric SHA`);
  }
  await verifyLockedArtifact(root, rubricArtifact);
  return review;
}

async function verifySegment(root, project, segment, runs) {
  const reasons = [];
  if (project.blockedReason !== null) reasons.push(`project blocked: ${project.blockedReason}`);
  if (segment.status !== 'locked' || typeof segment.lockedByReviewId !== 'string') reasons.push('canonical segment is not human-locked');
  const videos = await currentLockedSegmentVideos(root, project, segment.id);
  if (videos.length !== 1) reasons.push(`expected exactly one current locked video artifact, found ${videos.length}`);
  const video = videos[0];
  if (video) {
    try {
      await verifyLockedArtifact(root, video);
      await verifyApprovedQualityReview(root, project, video);
    } catch (error) {
      reasons.push(error.message);
    }
  }
  const successfulRuns = runs.filter(run => run.segmentId === segment.id && run.status === 'SUCCESS');
  const matches = [];
  for (const run of successfulRuns) {
    const contract = run.fingerprint?.generationContract;
    const inspectOptions = run.kind === 'libtv_video' ? {
      executor: 'libtv',
      libtvProjectUuid: run.projectUuid ?? contract?.projectUuid,
      nodeName: run.nodeName ?? contract?.nodeName
    } : { executor: 'runninghub' };
    try {
      const inspected = await inspectVideoPackage(root, segment.id, inspectOptions);
      if (video && run.fingerprint?.sha256 === inspected.fingerprint.sha256
        && SAFE_TASK_ID.test(run.taskId ?? '')
        && Array.isArray(run.outputs)
        && run.outputs.some(output => output.path === video.path && output.sha256 === video.sha256)) {
        matches.push({ run, inspected });
      }
    } catch (error) {
      reasons.push(error.message);
    }
  }
  if (successfulRuns.length === 0) {
    try { await inspectVideoPackage(root, segment.id); } catch (error) { reasons.push(error.message); }
  }
  if (matches.length !== 1) reasons.push(`expected exactly one bound SUCCESS generation run, found ${matches.length}`);
  if (reasons.length > 0) return { blocked: { segmentId: segment.id, reasons } };
  const { run, inspected } = matches[0];
  return {
    deliverable: {
      segmentId: segment.id,
      videoArtifactId: video.id,
      path: video.path,
      sha256: video.sha256,
      runId: run.id,
      taskId: run.taskId,
      provider: run.kind === 'libtv_video' ? 'libtv-cli' : 'runninghub',
      packageFingerprint: inspected.fingerprint.sha256
    }
  };
}

export function assertFinalEditContract(artifact, segmentDeliverables) {
  if (!artifact || artifact.type !== 'final_edit') throw new Error('a final_edit artifact is required for a multi-segment delivery');
  const expected = segmentDeliverables.map(item => item.videoArtifactId).sort();
  const actual = Array.isArray(artifact.sourceVideoArtifactIds) ? [...artifact.sourceVideoArtifactIds].sort() : [];
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error('final_edit must bind every current canonical segment video exactly once');
  }
  const contract = artifact.editContract;
  for (const field of ['pictureLock', 'soundMix', 'colorContinuity', 'continuityReview']) {
    if (contract?.[field] !== true) throw new Error(`final_edit editContract.${field} must be true`);
  }
  return artifact;
}

async function verifyFinalEdit(root, project, segmentDeliverables, segmentCount) {
  if (segmentCount <= 1) return { finalEdit: null, blocked: null };
  if (segmentDeliverables.length !== segmentCount) return {
    finalEdit: null,
    blocked: { scope: 'final_edit', reasons: ['final_edit cannot be verified until every canonical segment is deliverable'] }
  };
  let artifact;
  try {
    artifact = currentArtifactOf(project.artifacts ?? [], item => item.type === 'final_edit');
  } catch (error) {
    return { finalEdit: null, blocked: { scope: 'final_edit', reasons: [error.message] } };
  }
  const reasons = [];
  if (!artifact || artifact.status !== 'locked') reasons.push('multi-segment delivery requires one current locked final_edit artifact');
  if (artifact) {
    try {
      await verifyLockedArtifact(root, artifact);
      assertFinalEditContract(artifact, segmentDeliverables);
      await verifyApprovedQualityReview(root, project, artifact);
    } catch (error) {
      reasons.push(error.message);
    }
  }
  if (reasons.length > 0) return { finalEdit: null, blocked: { scope: 'final_edit', reasons } };
  return { finalEdit: { artifactId: artifact.id, path: artifact.path, sha256: artifact.sha256 }, blocked: null };
}

export async function verifyDelivery(root) {
  const projectRoot = resolve(root);
  const project = await readJson(join(projectRoot, 'project-state.json'));
  const segments = await loadCanonicalSegments(projectRoot, project, { requireLockedSegmentation: true });
  const runs = await generationRuns(projectRoot);
  const checked = await Promise.all(segments.map(segment => verifySegment(projectRoot, project, segment, runs)));
  const segmentDeliverables = checked.flatMap(item => item.deliverable ? [item.deliverable] : []);
  const final = await verifyFinalEdit(projectRoot, project, segmentDeliverables, segments.length);
  return {
    totalCanonicalSegments: segments.length,
    deliverable: segmentDeliverables,
    finalEdit: final.finalEdit,
    blocked: [...checked.flatMap(item => item.blocked ? [item.blocked] : []), ...(final.blocked ? [final.blocked] : [])]
  };
}

function requiredReflection(value, field) {
  if (typeof value !== 'string' || value.trim().length < 4 || value.trim().length > 4000) {
    throw new TypeError(`${field} must contain 4 to 4000 characters`);
  }
  return value.trim();
}

function deliveryFingerprint(report) {
  return sha256Text(`${JSON.stringify({
    deliverable: [...report.deliverable].sort((left, right) => left.segmentId.localeCompare(right.segmentId)),
    finalEdit: report.finalEdit
  })}\n`);
}

function deliveryExecutionEvent(receipt) {
  const references = [
    { kind: 'final_delivery_receipt', id: receipt.id, path: 'deliveries/final-delivery-receipt.json' },
    { kind: 'project_retrospective', id: receipt.retrospectiveId, path: receipt.retrospectivePath }
  ];
  for (const deliverable of receipt.deliverable) {
    references.push({
      kind: 'delivered_video', id: deliverable.videoArtifactId,
      path: deliverable.path, sha256: deliverable.sha256
    });
  }
  if (receipt.finalEdit) {
    references.push({
      kind: 'final_edit', id: receipt.finalEdit.artifactId,
      path: receipt.finalEdit.path, sha256: receipt.finalEdit.sha256
    });
  }
  return {
    type: 'delivery.finalized', occurredAt: receipt.completedAt,
    actor: { kind: 'human', id: null }, segmentId: null,
    correlationId: receipt.id, causationId: receipt.retrospectiveId,
    idempotencyKey: `delivery.finalized:${receipt.id}`,
    references,
    facts: {
      receiptId: receipt.id, receiptStatus: receipt.status,
      deliveryFingerprint: receipt.deliveryFingerprint,
      segmentCount: receipt.deliverable.length,
      finalEditArtifactId: receipt.finalEdit?.artifactId ?? null,
      gate5EvidenceVerified: true
    }
  };
}

export async function finalizeDelivery(root, reflection, options = {}) {
  const projectRoot = resolve(root);
  const result = await withProjectLock(projectRoot, async () => {
    await recoverJsonTransactions(projectRoot);
    const report = await verifyDelivery(projectRoot);
    if (report.blocked.length > 0) {
      throw new Error(`delivery cannot be finalized: ${report.blocked.flatMap(item => item.reasons ?? []).join('; ')}`);
    }
    const statePath = join(projectRoot, 'project-state.json');
    const state = assertProjectState(await readJson(statePath));
    const fingerprint = deliveryFingerprint(report);
    const receiptPath = join(projectRoot, 'deliveries', 'final-delivery-receipt.json');
    const existing = await readJson(receiptPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      if (existing.deliveryFingerprint !== fingerprint || state.phase !== 'archived') {
        throw new Error('existing delivery receipt no longer matches the current deliverable state');
      }
      const retrospective = await readJson(join(projectRoot, existing.retrospectivePath));
      const ledger = await prepareExecutionLedgerAppend(projectRoot, deliveryExecutionEvent(existing));
      if (!ledger.reused) {
        await commitJsonTransaction(projectRoot, `delivery-ledger-backfill-${existing.id}`, ledger.writes, options.transactionOptions);
      }
      return { receipt: existing, retrospective, reused: true };
    }
    if (state.phase === 'archived') throw new Error('archived project is missing its final delivery receipt');

    const completedAt = options.now ?? new Date().toISOString();
    const retrospectiveId = `project-retrospective-${options.id ?? randomUUID()}`;
    const retrospectivePath = `reviews/${retrospectiveId}.json`;
    const ruleCandidates = Array.isArray(reflection?.ruleCandidates)
      ? reflection.ruleCandidates.map((value, index) => requiredReflection(value, `ruleCandidates[${index}]`)).slice(0, 5)
      : [];
    const retrospective = {
      schemaVersion: 1,
      id: retrospectiveId,
      kind: 'project_retrospective',
      actor: 'human',
      projectId: state.projectId,
      deliveryFingerprint: fingerprint,
      outcome: requiredReflection(reflection?.outcome, 'outcome'),
      whatWorked: requiredReflection(reflection?.whatWorked, 'whatWorked'),
      whatFailed: requiredReflection(reflection?.whatFailed, 'whatFailed'),
      nextProjectChange: requiredReflection(reflection?.nextProjectChange, 'nextProjectChange'),
      ruleCandidates,
      promotionPolicy: 'candidate_only_until_verified_repair_review',
      createdAt: completedAt
    };
    const receipt = {
      schemaVersion: 1,
      id: `final-delivery-${fingerprint.slice(0, 16)}`,
      kind: 'final_delivery_receipt',
      status: 'COMPLETE',
      projectId: state.projectId,
      deliveryFingerprint: fingerprint,
      deliverable: report.deliverable,
      finalEdit: report.finalEdit,
      retrospectiveId,
      retrospectivePath,
      completedAt
    };
    const nextState = { ...state, phase: 'archived', activeSegmentId: null, blockedReason: null, updatedAt: completedAt };
    assertProjectState(nextState);
    const ledger = await prepareExecutionLedgerAppend(projectRoot, deliveryExecutionEvent(receipt));
    await commitJsonTransaction(projectRoot, `finalize-delivery-${fingerprint.slice(0, 16)}`, [
      { path: join(projectRoot, retrospectivePath), value: retrospective },
      { path: receiptPath, value: receipt },
      { path: statePath, value: nextState },
      ...ledger.writes
    ], options.transactionOptions);
    return { receipt, retrospective, reused: false };
  });
  await deriveExecutionObservationBestEffort(projectRoot, {
    schemaVersion: 1,
    kind: 'execution_observation_derivation',
    sourceType: 'final_delivery_media'
  }, {
    deriveExecutionObservation: options.deriveExecutionObservation,
    derivationOptions: options.observationDerivationOptions,
    onError: options.onObservationError
  });
  return result;
}
