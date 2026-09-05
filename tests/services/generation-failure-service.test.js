import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import {
  assertGenerationFailureGate,
  recordGeneratedOutputFailure,
  recordGenerationRemediation
} from '../../src/services/generation-failure-service.js';
import { executionControlFingerprint } from '../../src/domain/execution-control-contract.js';
import { initializeProject } from '../../src/services/project-service.js';
import {
  executionLedgerProjectionPath,
  readExecutionEvents,
  readExecutionLedgerStatus
} from '../../src/services/execution-ledger-service.js';
import { readJson } from '../../src/storage/json-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'failure-policy-'));
  await initializeProject(root, { projectId: 'p1' });
  await writeJsonAtomic(join(root, 'reviews', 'remake-v2-generation-policy.json'), {
    kind: 'project_generation_policy', decision: 'approved', projectId: 'p1',
    qualityFailurePolicy: { maxFailedGeneratedOutputs: 4 }
  });
  return root;
}

function failure(index) {
  return {
    outputId: `output-${index}`, outputSha256: String(index).padStart(64, '0'), failureType: 'third_party_video_audit_fail',
    exactTimestampsOrRegions: [`00:0${index}`], observableProblem: 'visible artifact', expectedLockedRequirement: 'no artifact',
    mostLikelyCause: 'motion overload', freeRevisionCompleted: 'split action and revised prompt'
  };
}

function causalAttribution(rootCauseKey, evidence = 'observable evidence isolates the suspected control variable') {
  return {
    kind: 'generation_failure_causal_attribution_v1', version: 1, rootCauseKey,
    primary: {
      key: rootCauseKey, stage: 'generation', hypothesis: 'the active control route cannot independently hold every planned action',
      confidence: 'medium', evidence: [evidence],
      falsifier: 'the same route holds the action after one isolated free control check'
    },
    contributors: [], counterEvidence: [], unknowns: ['model-internal attention is not directly observable'],
    nextMinimalCheck: {
      variable: 'execution unit split', action: 'isolate the failed action without changing identity or scene inputs',
      expectedObservation: 'the action appears while all locked anchors remain unchanged',
      changesOnePrimaryVariable: true, costClass: 'free'
    },
    promptOnlyRetryAllowed: false, controlRouteChangeRequired: true
  };
}

test('the first three failures stop for human review and the fourth terminates before a fifth can occur', async () => {
  const root = await fixture();
  for (let index = 1; index <= 3; index += 1) {
    const event = await recordGeneratedOutputFailure(root, failure(index), { id: `failure-${index}` });
    assert.equal(event.workflowStatus, 'AWAITING_HUMAN_REVIEW_AFTER_REWORK');
    assert.equal(event.remainingFailureTolerance, 4 - index);
  }
  const fourth = await recordGeneratedOutputFailure(root, failure(4), { id: 'failure-4' });
  assert.equal(fourth.workflowStatus, 'TERMINATED_FAILURE_LIMIT_EXCEEDED');
  assert.equal(fourth.remainingFailureTolerance, 0);
  assert.equal((await readExecutionEvents(root)).filter(event => event.type === 'generation_output_failure.recorded').length, 4);
  const projection = await readJson(executionLedgerProjectionPath(root));
  assert.equal(projection.counts.outputFailures, 4);
  assert.equal(projection.failureGovernance.status, 'TERMINATED_FAILURE_LIMIT_EXCEEDED');
});

test('the same failed output cannot be counted twice', async () => {
  const root = await fixture();
  await recordGeneratedOutputFailure(root, failure(1));
  await assert.rejects(recordGeneratedOutputFailure(root, failure(1)), /already counted/);
});

test('strict governance blocks prompt-only retry until a human-approved control route change exists', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'p1', workflowVersion: 2, videoGovernanceVersion: 2,
    phase: 'generation_rework', activeSegmentId: null, blockedReason: null, artifacts: [],
    updatedAt: '2026-08-24T00:00:00.000Z'
  });
  const failedControl = {
    version: 1, plannedShotCount: 12, generatedUnitShotCount: 1,
    executionUnitStrategy: 'segmented_editorial', requiresIndependentShotControl: false,
    platformCapability: {
      surface: 'LibTV current node', profileId: 'seedance-2-libtv-v1', parameter: 'multi_shots',
      exposed: false, enabled: false, evidence: 'schema readback'
    }
  };
  const replacementControl = {
    ...failedControl,
    executionUnitStrategy: 'platform_multi_shot', generatedUnitShotCount: 12, requiresIndependentShotControl: true,
    platformCapability: {
      ...failedControl.platformCapability, exposed: true, enabled: true, evidence: 'new node readback',
      verificationMode: 'libtv_canvas_node_readback'
    }
  };
  await recordGeneratedOutputFailure(root, {
    ...failure(1), rootCauseKey: 'multi-shot-control-mismatch',
    causalAttribution: causalAttribution('multi-shot-control-mismatch', '12 planned shots collapsed into one long push'),
    segmentId: 'segment-001',
    failureObservation: {
      category: 'missing_shot', responsibilityStage: 'generation',
      returnStage: 'generation', retryKind: 'none'
    },
    controlRouteFingerprint: executionControlFingerprint(failedControl),
    observedEvidence: ['12 个规划镜头被生成为一个长推镜']
  });
  const failureLedger = await readJson(join(root, 'runs', 'generation-failure-ledger.json'));
  const failureRecord = await readJson(join(root, 'runs', 'generation-failures',
    `${encodeURIComponent(failureLedger.events[0].id)}.json`));
  assert.equal(failureRecord.kind, 'generation_failure_record');
  assert.equal(failureRecord.observation.failure.category, 'missing_shot');
  assert.equal((await readExecutionLedgerStatus(root)).observations.failures.byCategory.missing_shot, 1);
  await assert.rejects(
    assertGenerationFailureGate(root, { executionControlContract: failedControl }),
    /human-approved control-route change/
  );
  await recordGenerationRemediation(root, {
    rootCauseKey: 'multi-shot-control-mismatch',
    failedControlRouteFingerprint: executionControlFingerprint(failedControl),
    replacementControlRouteFingerprint: executionControlFingerprint(replacementControl),
    note: '已改用画布读回确认开启的 multi_shots 控制面'
  });
  assert.deepEqual((await readExecutionEvents(root)).map(event => event.type), [
    'ledger.bootstrap', 'generation_output_failure.recorded',
    'execution_observation.recorded', 'generation_remediation.approved'
  ]);
  assert.equal((await readJson(executionLedgerProjectionPath(root))).failureGovernance.status, 'remediated');
  await assertGenerationFailureGate(root, { executionControlContract: replacementControl });
  await assert.rejects(
    recordGenerationRemediation(root, {
      rootCauseKey: 'multi-shot-control-mismatch',
      failedControlRouteFingerprint: executionControlFingerprint(failedControl),
      replacementControlRouteFingerprint: executionControlFingerprint(failedControl),
      note: '只改提示词'
    }),
    /must change the control route/
  );
});

test('failure ledger crash recovery preserves one counted output and one execution event', async () => {
  const root = await fixture();
  await assert.rejects(recordGeneratedOutputFailure(root, failure(1), {
    id: 'failure-crash',
    transactionOptions: { afterWrite: index => { if (index === 0) throw new Error('failure-ledger-crash'); } }
  }), /failure-ledger-crash/);
  await assert.rejects(recordGeneratedOutputFailure(root, failure(1)), /already counted/);
  assert.equal((await readExecutionEvents(root)).filter(event => event.type === 'generation_output_failure.recorded').length, 1);
});

test('strict failure recovery derives one immutable root-cause observation after transaction replay', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'p1', workflowVersion: 2, videoGovernanceVersion: 2,
    phase: 'generation_rework', activeSegmentId: 'segment-001', blockedReason: null, artifacts: [],
    updatedAt: '2026-08-24T00:00:00.000Z'
  });
  const input = {
    ...failure(2), rootCauseKey: 'recovery-root-cause', segmentId: 'segment-001',
    causalAttribution: causalAttribution('recovery-root-cause'),
    controlRouteFingerprint: 'a'.repeat(64), observedEvidence: ['frame 20 missing the locked action'],
    failureObservation: {
      category: 'missing_shot', responsibilityStage: 'generation',
      returnStage: 'generation', retryKind: 'none'
    }
  };
  await assert.rejects(recordGeneratedOutputFailure(root, input, {
    id: 'failure-recovery-observation',
    transactionOptions: { afterWrite: index => { if (index === 0) throw new Error('strict-failure-crash'); } }
  }), /strict-failure-crash/);
  await assert.rejects(recordGeneratedOutputFailure(root, input, {
    id: 'failure-recovery-observation'
  }), /already counted/);
  const status = await readExecutionLedgerStatus(root);
  assert.equal(status.observations.derivation.bySourceType.generation_failure, 1);
  assert.equal(status.observations.failures.byCategory.missing_shot, 1);
});

test('strict governance rejects an unclassified root cause before mutating the failure ledger', async () => {
  const root = await fixture();
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'p1', workflowVersion: 2, videoGovernanceVersion: 2,
    phase: 'generation_rework', activeSegmentId: 'segment-001', blockedReason: null, artifacts: [],
    updatedAt: '2026-08-24T00:00:00.000Z'
  });
  await assert.rejects(recordGeneratedOutputFailure(root, {
    ...failure(3), rootCauseKey: 'unclassified', segmentId: 'segment-001',
    causalAttribution: causalAttribution('unclassified'),
    controlRouteFingerprint: 'b'.repeat(64), observedEvidence: ['visible mismatch']
  }), /rootCauseKey is not registered/);
  await assert.rejects(readJson(join(root, 'runs', 'generation-failure-ledger.json')), error => error.code === 'ENOENT');
});

test('a remediation cannot be prewritten before a matching unresolved failure exists', async () => {
  const root = await fixture();
  await assert.rejects(recordGenerationRemediation(root, {
    rootCauseKey: 'future-failure',
    failedControlRouteFingerprint: 'a'.repeat(64),
    replacementControlRouteFingerprint: 'b'.repeat(64),
    note: '不允许预先放行未来失败'
  }), /latest unresolved generation failure/);
});
