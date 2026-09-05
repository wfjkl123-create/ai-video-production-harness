import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { assertProjectState } from '../domain/project-state.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { assessStoryPlanExecutability } from '../domain/production-readiness.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { sha256File } from '../storage/checksum.js';
import { inspectOpenGate5FailureReturns } from './gate5-failure-return-service.js';
import { inspectGate5ReworkWorkOrder } from './gate5-rework-work-order-service.js';

const NONCANONICAL_VIDEO_DECISIONS = new Set(['rejected_evidence', 'archive_only', 'duplicate']);

async function walkVideoFiles(root, directory) {
  const base = join(root, directory);
  const files = [];
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('._')) continue;
      const target = join(path, entry.name);
      const relativeTarget = relative(root, target).split('\\').join('/');
      // Depth/control media and deterministic LibTV transport staging are
      // generation inputs, not candidate generated videos awaiting Gate 5.
      if (entry.isDirectory() && ['outputs/depth', 'outputs/libtv-staging'].includes(relativeTarget)) continue;
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && /\.(mp4|mov)$/i.test(entry.name)) files.push(relative(root, target).split('\\').join('/'));
    }
  }
  await walk(base);
  return files;
}

function derivedPhase(current, unregisteredVideoCandidates) {
  if (current.some(item => item.type === 'creative_brief' && ['draft', 'awaiting_review'].includes(item.status))) return 'creative_review';
  if (current.some(item => item.type === 'story_plan' && ['draft', 'awaiting_review'].includes(item.status))) return 'story_plan_review';
  if (current.some(item => ['video_segment', 'final_edit'].includes(item.type) && item.status === 'awaiting_review')) return 'video_review';
  if (current.some(item => ['video_segment', 'final_edit'].includes(item.type) && item.status === 'locked')) return 'delivery_preparation';
  if (current.some(item => ['video_segment', 'final_edit'].includes(item.type) && ['draft', 'rework'].includes(item.status))) return 'video_review';
  if (current.some(item => ['video_segment', 'final_edit'].includes(item.type) && item.status === 'rejected')) return 'generation_rework';
  if (unregisteredVideoCandidates.length > 0) return 'generation_unregistered';
  if (current.some(item => ['project_asset', 'segment_asset'].includes(item.type)
    && ['draft', 'rework', 'awaiting_review', 'blocked', 'rejected'].includes(item.status))) return 'asset_production';
  if (current.some(item => item.type === 'seedance_prompt' && item.status === 'locked')) return 'generation_preflight';
  if (current.some(item => ['project_asset', 'segment_asset'].includes(item.type))) return 'asset_production';
  if (current.some(item => item.type === 'story_plan' && item.status === 'locked')) return 'asset_planning';
  if (current.some(item => item.type === 'creative_brief' && item.status === 'locked')) return 'story_planning';
  return 'intake';
}

function auditFinding(id, severity, message, remedy) {
  return { id, severity, message, remedy };
}

async function videoDispositionRegistry(root) {
  const directory = join(root, 'reviews', 'readiness');
  const names = await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const registry = new Map();
  const conflicts = [];
  for (const name of names.filter(value => /^unregistered-video-candidates-.*\.json$/.test(value)).sort()) {
    const inventoryPath = `reviews/readiness/${name}`;
    const inventory = await readJson(join(root, inventoryPath));
    if (inventory.kind !== 'unregistered_video_candidate_inventory' || !Array.isArray(inventory.candidates)) continue;
    for (const candidate of inventory.candidates) {
      if (!NONCANONICAL_VIDEO_DECISIONS.has(candidate.humanDecision)) continue;
      if (typeof candidate.relativePath !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256 ?? '')) continue;
      const entry = { path: candidate.relativePath, sha256: candidate.sha256, decision: candidate.humanDecision, inventoryPath };
      const prior = registry.get(entry.path);
      if (prior && (prior.sha256 !== entry.sha256 || prior.decision !== entry.decision)) {
        conflicts.push({ path: entry.path, inventories: [prior.inventoryPath, entry.inventoryPath] });
        registry.delete(entry.path);
      } else if (!conflicts.some(item => item.path === entry.path)) {
        registry.set(entry.path, entry);
      }
    }
  }
  return { registry, conflicts };
}

export async function auditProjectReadiness(root) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  let lineage;
  try {
    lineage = resolveCurrentArtifacts(state.artifacts);
  } catch (error) {
    return {
      schemaVersion: 1,
      projectId: state.projectId,
      storedPhase: state.phase,
      derivedPhase: null,
      totals: { artifacts: state.artifacts.length, currentArtifacts: null, supersededArtifacts: null },
      currentArtifactIds: [],
      supersededArtifactIds: [],
      cataloguedNoncanonicalVideoCandidates: [],
      unregisteredVideoCandidates: [],
      gate5FailureReturns: null,
      gate5ReworkWorkOrders: null,
      storyExecutability: null,
      findings: [auditFinding('ARTIFACT_LINEAGE_AMBIGUOUS', 'error', error.message,
        'Declare the one canonical successor with supersedesArtifactId, then rerun the audit.')],
      status: 'BLOCKED'
    };
  }
  const current = lineage.current;
  const videoCandidates = unique(await Promise.all([
    walkVideoFiles(root, 'outputs'), walkVideoFiles(root, 'output'), walkVideoFiles(root, 'review')
  ]).then(groups => groups.flat())).sort();
  const registeredPaths = new Set(state.artifacts.map(item => item.path).filter(path => typeof path === 'string' && path !== ''));
  const registeredVideoPaths = new Set(current.filter(item => item.type === 'video_segment').map(item => item.path));
  const rawUnregisteredVideoCandidates = videoCandidates.filter(path => !registeredPaths.has(path));
  const dispositions = await videoDispositionRegistry(root);
  const dispositionFindings = dispositions.conflicts.map(conflict => auditFinding(
    'VIDEO_DISPOSITION_CONFLICT', 'error',
    `Non-canonical video disposition conflicts for ${conflict.path}.`,
    `Resolve the conflicting inventory records: ${conflict.inventories.join(', ')}.`
  ));
  const cataloguedNoncanonicalVideoCandidates = [];
  for (const path of rawUnregisteredVideoCandidates) {
    const disposition = dispositions.registry.get(path);
    if (!disposition) continue;
    const actualSha256 = await sha256File(join(root, path));
    if (actualSha256 !== disposition.sha256) {
      dispositionFindings.push(auditFinding(
        'VIDEO_DISPOSITION_SHA_MISMATCH', 'error',
        `Catalogued non-canonical video changed after classification: ${path}.`,
        'Rebuild the candidate inventory from the current bytes and classify it again.'
      ));
      continue;
    }
    cataloguedNoncanonicalVideoCandidates.push(disposition);
  }
  const cataloguedPaths = new Set(cataloguedNoncanonicalVideoCandidates.map(item => item.path));
  const unregisteredVideoCandidates = rawUnregisteredVideoCandidates.filter(path => !cataloguedPaths.has(path));
  const phase = state.phase === 'archived' ? 'archived' : derivedPhase(current, unregisteredVideoCandidates);
  const findings = [...dispositionFindings];
  let gate5FailureReturns = { open: [], unclassified: [] };
  let gate5ReworkWorkOrders = [];
  try {
    gate5FailureReturns = await inspectOpenGate5FailureReturns(root, state, current);
    for (const failureReturn of gate5FailureReturns.open) {
      findings.push(auditFinding(
        'GATE5_FAILURE_RETURN_OPEN', 'warning',
        `Gate 5 rejection ${failureReturn.rejection.reviewId} must resume from ${failureReturn.routing.returnStage}; earlier locked evidence remains frozen.`,
        'Create a direct successor for the rejected artifact, re-authorize any paid generation, and return the successor to Gate 5.'
      ));
      try {
        const workOrder = await inspectGate5ReworkWorkOrder(root, state, current, failureReturn);
        if (workOrder) {
          gate5ReworkWorkOrders.push(workOrder);
          findings.push(auditFinding(
            'GATE5_REWORK_ORDER_OPEN', 'warning',
            `Resumable Gate 5 work order ${workOrder.id} freezes ${workOrder.frozenEvidence.artifacts.length} upstream artifact(s).`,
            'Continue only within allowedMutationStages; the replacement must supersede the rejected artifact and return to Gate 5.'
          ));
        } else {
          findings.push(auditFinding(
            'GATE5_REWORK_ORDER_NOT_PREPARED', 'warning',
            `Gate 5 failure return ${failureReturn.id} has no persisted rework work order yet.`,
            'Prepare the local work order before changing any artifact in the rework path.'
          ));
        }
      } catch (error) {
        findings.push(auditFinding(
          'GATE5_REWORK_ORDER_INVALID', 'error', error.message,
          'Repair or reconcile the exact work-order and frozen evidence binding before continuing rework.'
        ));
      }
    }
    if (gate5FailureReturns.unclassified.length > 0) findings.push(auditFinding(
      'GATE5_REJECTION_UNCLASSIFIED', 'error',
      `${gate5FailureReturns.unclassified.length} current Gate 5 rejection(s) lack an explicit root cause and minimum return stage.`,
      'Record category, rootCauseKey, responsibilityStage, returnStage and retryKind none; do not infer the route or restart the chain.'
    ));
  } catch (error) {
    findings.push(auditFinding(
      'GATE5_FAILURE_RETURN_INVALID', 'error', error.message,
      'Repair the exact rejection review, artifact SHA binding and lineage before any rework or delivery.'
    ));
    gate5FailureReturns = null;
    gate5ReworkWorkOrders = null;
  }

  if (state.phase !== phase) findings.push(auditFinding(
    'PHASE_DRIFT', 'error',
    `Stored phase is ${state.phase}, while current artifacts and outputs imply ${phase}.`,
    'Reconcile the canonical artifact set and record the actual gate/output event before further generation.')
  );
  if (unregisteredVideoCandidates.length > 0) findings.push(auditFinding(
    'UNREGISTERED_VIDEO_OUTPUTS', registeredVideoPaths.size === 0 ? 'error' : 'warning',
    `${unregisteredVideoCandidates.length} generated video file(s) are outside the canonical artifact state.`,
    'Select the accepted take, register it as video_segment, and leave rejected takes as non-canonical evidence.')
  );
  const stalePending = state.artifacts.filter(item => item.status === 'awaiting_review' && lineage.supersededIds.includes(item.id));
  if (stalePending.length > 0) findings.push(auditFinding(
    'STALE_PENDING_REVIEW', 'warning',
    `${stalePending.length} older awaiting-review artifact(s) were superseded by a newer revision.`,
    'Do not show or block on stale pending work; preserve it only as history.')
  );
  if (state.artifacts.length >= 100 && current.length / state.artifacts.length < 0.75) findings.push(auditFinding(
    'ARTIFACT_HISTORY_DOMINATES_CURRENT_STATE', 'warning',
    `${state.artifacts.length} total artifacts contain only ${current.length} current artifacts.`,
    'Default all routing, review and context assembly to current artifacts; load history only for audit or rollback.')
  );

  let storyExecutability = null;
  const story = current.find(item => item.type === 'story_plan' && item.status === 'locked');
  if (story) {
    try {
      storyExecutability = assessStoryPlanExecutability(await readJson(join(root, story.path)));
      if (storyExecutability.status === 'BLOCKED') findings.push(auditFinding(
        'STORY_PLAN_NOT_GENERATION_EXECUTABLE', 'error',
        'The current story plan is approved but its generation units are not model-executable.',
        'Restructure generation coverage before preparing more assets or prompts; do not append more prompt prose.')
      );
    } catch (error) {
      findings.push(auditFinding('STORY_PLAN_EXECUTABILITY_UNREADABLE', 'error', error.message, 'Repair the current story plan evidence and rerun the audit.'));
    }
  }

  return {
    schemaVersion: 1,
    projectId: state.projectId,
    storedPhase: state.phase,
    derivedPhase: phase,
    totals: { artifacts: state.artifacts.length, currentArtifacts: current.length, supersededArtifacts: lineage.supersededIds.length },
    currentArtifactIds: current.map(item => item.id),
    supersededArtifactIds: lineage.supersededIds,
    cataloguedNoncanonicalVideoCandidates,
    unregisteredVideoCandidates,
    gate5FailureReturns,
    gate5ReworkWorkOrders,
    storyExecutability,
    findings,
    status: findings.some(item => item.severity === 'error') ? 'BLOCKED' : findings.length ? 'WARN' : 'PASS'
  };
}

export async function reconcileProjectPhase(root) {
  root = resolve(root);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const report = await auditProjectReadiness(root);
    if (report.derivedPhase === null) throw new Error('project phase cannot be reconciled while artifact lineage is ambiguous');
    const statePath = join(root, 'project-state.json');
    const state = assertProjectState(await readJson(statePath));
    if (state.phase === report.derivedPhase) return { changed: false, phase: state.phase, recordPath: null, report };

    const previousPhase = state.phase;
    state.phase = report.derivedPhase;
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);
    const id = `readiness-reconciliation-${randomUUID()}`;
    const recordPath = `reviews/${id}.json`;
    const record = {
      schemaVersion: 1,
      id,
      kind: 'project_phase_reconciliation',
      actor: 'system',
      projectId: state.projectId,
      previousPhase,
      reconciledPhase: state.phase,
      currentArtifactIds: report.currentArtifactIds,
      unresolvedFindingIds: report.findings.filter(item => item.id !== 'PHASE_DRIFT').map(item => item.id),
      automaticAction: 'phase_only',
      createdAt: state.updatedAt
    };
    await commitJsonTransaction(root, id, [
      { path: join(root, recordPath), value: record },
      { path: statePath, value: state }
    ]);
    return { changed: true, phase: state.phase, recordPath, report };
  });
}

function unique(values) {
  return [...new Set(values)];
}
