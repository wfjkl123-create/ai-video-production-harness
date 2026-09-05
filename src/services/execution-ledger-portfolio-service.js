import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { combineExecutionObservationSummaries } from '../domain/execution-ledger.js';
import { readExecutionLedgerStatus } from './execution-ledger-service.js';

const FUNNEL_STAGES = Object.freeze([
  Object.freeze({ id: 'preflight', label: '生成前检查' }),
  Object.freeze({ id: 'paid_approval', label: '付费授权' }),
  Object.freeze({ id: 'submission', label: '生成提交' }),
  Object.freeze({ id: 'generation_output', label: '生成结果' }),
  Object.freeze({ id: 'quality_review', label: '成片审核' }),
  Object.freeze({ id: 'delivery', label: '最终交付' })
]);

const COUNT_FIELDS = Object.freeze([
  'events', 'paidClaims', 'successes', 'failures', 'uncertainSubmissions',
  'qualityAccepted', 'qualityRejected', 'outputFailures', 'remediations', 'deliveries'
]);

function emptyCounts() {
  return Object.fromEntries(COUNT_FIELDS.map(field => [field, 0]));
}

function percent(numerator, denominator) {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

function consistencyCounts(entries) {
  const counts = { consistent: 0, notInitialized: 0, pendingRecovery: 0, inconsistent: 0, unreadable: 0 };
  for (const entry of entries) {
    if (entry.errorCode) counts.unreadable += 1;
    else if (entry.ledger.consistency === 'consistent') counts.consistent += 1;
    else if (entry.ledger.consistency === 'not_initialized') counts.notInitialized += 1;
    else if (entry.ledger.consistency === 'pending_recovery') counts.pendingRecovery += 1;
    else counts.inconsistent += 1;
  }
  return counts;
}

function aggregateFunnel(ledgers) {
  const initialized = ledgers.filter(ledger => ledger.initialized);
  return FUNNEL_STAGES.map(definition => {
    const stages = initialized.map(ledger => ledger.funnel.find(stage => stage.id === definition.id))
      .filter(Boolean);
    return {
      id: definition.id,
      label: definition.label,
      observedProjects: stages.filter(stage => ['observed', 'finalized'].includes(stage.status)).length,
      inProgressProjects: stages.filter(stage => stage.status === 'in_progress').length,
      blockedProjects: stages.filter(stage => stage.status === 'blocked').length,
      notObservedProjects: initialized.length - stages.filter(stage => stage.status !== 'not_observed').length,
      observedEventCount: stages.reduce((sum, stage) => sum + stage.observedEventCount, 0),
      blockedEventCount: stages.reduce((sum, stage) => sum + stage.blockedEventCount, 0)
    };
  });
}

function distribution(ledgers, selector, values) {
  return Object.fromEntries(values.map(value => [value, ledgers.filter(ledger => selector(ledger) === value).length]));
}

function failureGovernanceDistribution(ledgers) {
  const result = { clear: 0, awaitingHumanReview: 0, terminated: 0, remediated: 0, other: 0 };
  for (const ledger of ledgers) {
    const status = ledger.failureGovernance.status;
    if (status === 'clear') result.clear += 1;
    else if (status === 'remediated') result.remediated += 1;
    else if (String(status).startsWith('AWAITING_HUMAN_REVIEW')) result.awaitingHumanReview += 1;
    else if (String(status).startsWith('TERMINATED_')) result.terminated += 1;
    else result.other += 1;
  }
  return result;
}

function rounded(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function observationEfficiency(ledgers) {
  const byUnit = {};
  let observedPaidRetryCount = 0;
  let paidRetryDurationMs = 0;
  let paidRetryProjectCount = 0;
  for (const ledger of ledgers) {
    const summary = ledger.observations;
    const finalDurationMs = summary.media.byKind.final_delivery.totalDurationMs;
    if (finalDurationMs <= 0) continue;
    for (const [unit, cost] of Object.entries(summary.cost.byUnit)) {
      if (cost.actual.eventCount === 0) continue;
      const target = byUnit[unit] ?? { projectCount: 0, actualAmount: 0, finalDurationMs: 0 };
      target.projectCount += 1;
      target.actualAmount += cost.actual.amount;
      target.finalDurationMs += finalDurationMs;
      byUnit[unit] = target;
    }
    if (summary.cost.paidRetryObservationCount > 0) {
      paidRetryProjectCount += 1;
      observedPaidRetryCount += summary.cost.paidRetryObservationCount;
      paidRetryDurationMs += finalDurationMs;
    }
  }
  for (const value of Object.values(byUnit)) {
    value.finalDurationMinutes = rounded(value.finalDurationMs / 60_000, 6);
    value.actualCostPerFinalMinute = value.finalDurationMs === 0
      ? null : rounded(value.actualAmount / (value.finalDurationMs / 60_000), 6);
    delete value.finalDurationMs;
  }
  return {
    actualCostPerFinalMinuteByUnit: byUnit,
    observedPaidRetry: {
      projectCount: paidRetryProjectCount,
      count: observedPaidRetryCount,
      finalDurationMinutes: rounded(paidRetryDurationMs / 60_000, 6),
      perFinalMinute: paidRetryDurationMs === 0
        ? null : rounded(observedPaidRetryCount / (paidRetryDurationMs / 60_000), 6)
    }
  };
}

export function summarizeExecutionLedgerPortfolio(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const readable = entries.filter(entry => !entry.errorCode && entry.ledger);
  const ledgers = readable.map(entry => entry.ledger);
  const initialized = ledgers.filter(ledger => ledger.initialized);
  const aggregateEligible = initialized.filter(ledger => ledger.consistency === 'consistent');
  const observations = combineExecutionObservationSummaries(aggregateEligible.map(ledger => ledger.observations));
  const consistency = consistencyCounts(entries);
  const counts = emptyCounts();
  for (const ledger of aggregateEligible) {
    for (const field of COUNT_FIELDS) counts[field] += Number(ledger.counts?.[field] ?? 0);
  }
  const attentionProjectCount = consistency.pendingRecovery + consistency.inconsistent + consistency.unreadable;
  const observation = initialized.length === 0
    ? 'unavailable'
    : attentionProjectCount > 0 ? 'attention_required'
      : initialized.length < readable.length ? 'partial' : 'observed';
  const projects = entries.map(entry => entry.errorCode ? {
    slug: entry.slug,
    projectId: null,
    initialized: false,
    consistency: 'unreadable',
    eventCount: 0,
    currentStage: null,
    gate5Status: null,
    deliveryStatus: null,
    issueCodes: [entry.errorCode]
  } : {
    slug: entry.slug,
    projectId: entry.ledger.projectId,
    initialized: entry.ledger.initialized,
    consistency: entry.ledger.consistency,
    eventCount: entry.ledger.counts.events,
    currentStage: entry.ledger.currentStage,
    gate5Status: entry.ledger.gate5.status,
    deliveryStatus: entry.ledger.delivery.status,
    issueCodes: [...entry.ledger.issueCodes]
  }).sort((left, right) => right.eventCount - left.eventCount || left.slug.localeCompare(right.slug));
  return {
    schemaVersion: 1,
    kind: 'execution_ledger_portfolio',
    observation,
    scope: {
      totalProjects: entries.length,
      readableProjects: readable.length,
      unreadableProjects: consistency.unreadable,
      initializedProjects: initialized.length,
      aggregateEligibleProjects: aggregateEligible.length,
      projectsWithV2Observations: aggregateEligible.filter(ledger => ledger.observations.eventCount > 0).length,
      projectsWithAutomaticObservations: aggregateEligible
        .filter(ledger => ledger.observations.derivation.automaticEventCount > 0).length,
      projectsWithTimingObservations: aggregateEligible.filter(ledger => Object.values(ledger.observations.timing)
        .some(metric => metric.sampleCount > 0)).length,
      projectsWithGenerationTimingObservations: aggregateEligible.filter(ledger => Object.values(
        ledger.observations.timingByStage.generation ?? {}
      ).some(metric => metric.sampleCount > 0)).length,
      projectsWithCostObservations: aggregateEligible.filter(ledger => ledger.observations.cost.observationCount > 0).length,
      projectsWithFinalDurationObservations: aggregateEligible.filter(ledger => ledger.observations.media.byKind.final_delivery.sampleCount > 0).length,
      uncoveredProjects: readable.length - initialized.length,
      ledgerCoveragePercent: percent(initialized.length, readable.length)
    },
    consistency,
    counts,
    observations,
    efficiency: observationEfficiency(aggregateEligible),
    funnel: aggregateFunnel(aggregateEligible),
    gate5: distribution(aggregateEligible, ledger => ledger.gate5.status, [
      'not_reviewed', 'partially_accepted', 'rejected', 'delivery_finalized'
    ]),
    failureGovernance: failureGovernanceDistribution(aggregateEligible),
    projects,
    limitations: [
      'historical_before_bootstrap_unknown',
      'uncovered_projects_are_not_failures',
      'event_counts_are_not_success_rates',
      'v1_events_have_no_observation_metrics',
      'missing_v2_observations_remain_unknown',
      'cost_units_and_evidence_levels_are_not_mixed',
      'observed_cost_is_not_complete_project_cost'
    ]
  };
}

export async function readExecutionLedgerPortfolio(projectsRoot) {
  const root = resolve(projectsRoot);
  const directoryEntries = await readdir(root, { withFileTypes: true })
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const entries = [];
  for (const directoryEntry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!directoryEntry.isDirectory() || directoryEntry.name.startsWith('.')) continue;
    const projectRoot = join(root, directoryEntry.name);
    try {
      await access(join(projectRoot, 'project-state.json'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      entries.push({ slug: directoryEntry.name, errorCode: 'project_state_unreadable' });
      continue;
    }
    try {
      entries.push({ slug: directoryEntry.name, ledger: await readExecutionLedgerStatus(projectRoot) });
    } catch {
      entries.push({ slug: directoryEntry.name, errorCode: 'project_state_invalid' });
    }
  }
  return summarizeExecutionLedgerPortfolio(entries);
}
