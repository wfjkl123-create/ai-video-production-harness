import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject } from '../../src/services/project-service.js';
import { appendExecutionEvent, executionLedgerHeadPath, readExecutionLedgerStatus } from '../../src/services/execution-ledger-service.js';
import {
  readExecutionLedgerPortfolio,
  summarizeExecutionLedgerPortfolio
} from '../../src/services/execution-ledger-portfolio-service.js';

function executionEvent(type, sequenceKey, overrides = {}) {
  return {
    type,
    occurredAt: `2026-08-24T10:0${sequenceKey}:00.000Z`,
    actor: { kind: 'system', id: null },
    segmentId: 'segment-001',
    correlationId: 'run-001',
    causationId: null,
    idempotencyKey: `${type}:run-001:${sequenceKey}`,
    references: [],
    facts: { runId: 'run-001' },
    ...overrides
  };
}

function observationEvent(id, observation) {
  return executionEvent('execution_observation.recorded', id, {
    occurredAt: `2026-08-24T11:0${id}:00.000Z`,
    idempotencyKey: `execution_observation.recorded:portfolio-${id}`,
    references: [{
      kind: 'measurement_evidence', id: `measurement-${id}`,
      path: `traces/measurement-${id}.json`, sha256: String(id).repeat(64)
    }],
    facts: { observationId: `portfolio-${id}` },
    observation: { subjectId: `measurement-${id}`, ...observation }
  });
}

test('portfolio summary keeps uncovered and unreadable projects out of observed outcome counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-portfolio-summary-'));
  const observedRoot = join(root, 'observed');
  const uncoveredRoot = join(root, 'uncovered');
  await initializeProject(observedRoot, { projectId: 'PORTFOLIO-OBSERVED' });
  await initializeProject(uncoveredRoot, { projectId: 'PORTFOLIO-UNCOVERED' });
  await appendExecutionEvent(observedRoot, executionEvent('generation.succeeded', 1));
  const observed = await readExecutionLedgerStatus(observedRoot);
  const uncovered = await readExecutionLedgerStatus(uncoveredRoot);
  const portfolio = summarizeExecutionLedgerPortfolio([
    { slug: 'observed', ledger: observed },
    { slug: 'uncovered', ledger: uncovered },
    { slug: 'broken', errorCode: 'project_state_invalid' }
  ]);
  assert.equal(portfolio.observation, 'attention_required');
  assert.deepEqual(portfolio.scope, {
    totalProjects: 3, readableProjects: 2, unreadableProjects: 1,
    initializedProjects: 1, aggregateEligibleProjects: 1,
    projectsWithV2Observations: 0, projectsWithAutomaticObservations: 0, projectsWithTimingObservations: 0,
    projectsWithGenerationTimingObservations: 0,
    projectsWithCostObservations: 0, projectsWithFinalDurationObservations: 0,
    uncoveredProjects: 1, ledgerCoveragePercent: 50
  });
  assert.equal(portfolio.counts.successes, 1);
  assert.equal(portfolio.counts.failures, 0);
  assert.equal(portfolio.funnel.find(stage => stage.id === 'generation_output').observedProjects, 1);
  assert.equal(portfolio.funnel.find(stage => stage.id === 'generation_output').notObservedProjects, 0);
});

test('portfolio excludes initialized but inconsistent ledgers from every aggregate outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-portfolio-inconsistent-'));
  const consistentRoot = join(root, 'consistent');
  const inconsistentRoot = join(root, 'inconsistent');
  await initializeProject(consistentRoot, { projectId: 'PORTFOLIO-CONSISTENT' });
  await initializeProject(inconsistentRoot, { projectId: 'PORTFOLIO-INCONSISTENT' });
  await appendExecutionEvent(consistentRoot, executionEvent('generation.succeeded', 1));
  await appendExecutionEvent(inconsistentRoot, executionEvent('generation.failed', 1));
  await writeFile(executionLedgerHeadPath(inconsistentRoot), JSON.stringify({ schemaVersion: 1, lastSequence: 99, lastEventId: 'forged' }));
  const consistent = await readExecutionLedgerStatus(consistentRoot);
  const inconsistent = await readExecutionLedgerStatus(inconsistentRoot);
  assert.equal(inconsistent.consistency, 'inconsistent');

  const portfolio = summarizeExecutionLedgerPortfolio([
    { slug: 'consistent', ledger: consistent },
    { slug: 'inconsistent', ledger: inconsistent }
  ]);
  assert.equal(portfolio.scope.initializedProjects, 2);
  assert.equal(portfolio.scope.aggregateEligibleProjects, 1);
  assert.equal(portfolio.counts.successes, 1);
  assert.equal(portfolio.counts.failures, 0);
  assert.equal(portfolio.funnel.find(stage => stage.id === 'generation_output').observedProjects, 1);
  assert.equal(portfolio.consistency.inconsistent, 1);
});

test('portfolio scanner is read-only and reports invalid project state without aborting the baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-portfolio-scan-'));
  const observedRoot = join(root, 'project-a');
  const uncoveredRoot = join(root, 'project-b');
  await initializeProject(observedRoot, { projectId: 'PORTFOLIO-A' });
  await initializeProject(uncoveredRoot, { projectId: 'PORTFOLIO-B' });
  await appendExecutionEvent(observedRoot, executionEvent('generation.failed', 1));
  await mkdir(join(root, 'project-invalid'), { recursive: true });
  await writeFile(join(root, 'project-invalid', 'project-state.json'), '{invalid json');
  await mkdir(join(root, 'not-a-project'), { recursive: true });

  await assert.rejects(access(executionLedgerHeadPath(uncoveredRoot)));
  const portfolio = await readExecutionLedgerPortfolio(root);
  await assert.rejects(access(executionLedgerHeadPath(uncoveredRoot)), undefined, 'portfolio read must not bootstrap an uncovered project');
  assert.equal(portfolio.scope.totalProjects, 3);
  assert.equal(portfolio.scope.initializedProjects, 1);
  assert.equal(portfolio.scope.uncoveredProjects, 1);
  assert.equal(portfolio.scope.unreadableProjects, 1);
  assert.equal(portfolio.counts.failures, 1);
  assert.equal(portfolio.projects.find(project => project.slug === 'project-invalid').consistency, 'unreadable');
});

test('portfolio computes v2 medians and actual cost per final minute without mixing estimates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-portfolio-v2-'));
  const actualRoot = join(root, 'actual');
  const estimatedRoot = join(root, 'estimated');
  const v1OnlyRoot = join(root, 'v1-only');
  await initializeProject(actualRoot, { projectId: 'PORTFOLIO-V2-ACTUAL' });
  await initializeProject(estimatedRoot, { projectId: 'PORTFOLIO-V2-ESTIMATED' });
  await initializeProject(v1OnlyRoot, { projectId: 'PORTFOLIO-V1-ONLY' });
  await appendExecutionEvent(actualRoot, observationEvent(1, {
    scope: 'delivery', stage: 'delivery', timing: { machineExecutionMs: 1_000 },
    cost: { amount: 6, unit: 'CNY', evidenceLevel: 'actual_billed', purpose: 'paid_retry' },
    media: { kind: 'final_delivery', durationMs: 30_000 }
  }));
  await appendExecutionEvent(estimatedRoot, observationEvent(2, {
    scope: 'delivery', stage: 'delivery', timing: { machineExecutionMs: 3_000 },
    cost: { amount: 999, unit: 'CNY', evidenceLevel: 'estimated', purpose: 'initial_generation' },
    media: { kind: 'final_delivery', durationMs: 30_000 }
  }));
  await appendExecutionEvent(actualRoot, observationEvent(3, {
    scope: 'project', stage: 'generation', timing: { machineExecutionMs: 5_000 }
  }));
  await appendExecutionEvent(v1OnlyRoot, executionEvent('generation.succeeded', 3));

  const portfolio = await readExecutionLedgerPortfolio(root);
  assert.equal(portfolio.scope.aggregateEligibleProjects, 3);
  assert.equal(portfolio.scope.projectsWithV2Observations, 2);
  assert.equal(portfolio.scope.projectsWithAutomaticObservations, 0);
  assert.equal(portfolio.scope.projectsWithGenerationTimingObservations, 1);
  assert.equal(portfolio.observations.timing.machineExecutionMs.medianMs, 3_000);
  assert.equal(portfolio.observations.timingByStage.delivery.machineExecutionMs.medianMs, 2_000);
  assert.equal(portfolio.observations.timingByStage.generation.machineExecutionMs.medianMs, 5_000);
  assert.equal(portfolio.observations.cost.byUnit.CNY.actual.amount, 6);
  assert.equal(portfolio.observations.cost.byUnit.CNY.estimated.amount, 999);
  assert.equal(portfolio.efficiency.actualCostPerFinalMinuteByUnit.CNY.projectCount, 1);
  assert.equal(portfolio.efficiency.actualCostPerFinalMinuteByUnit.CNY.actualCostPerFinalMinute, 12);
  assert.equal(portfolio.efficiency.observedPaidRetry.perFinalMinute, 2);
});
