import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGenerationFailureCausalAttribution } from '../../src/domain/generation-failure-causal-attribution.js';
import { assertRegisteredGenerationRootCause } from '../../src/domain/generation-root-cause-registry.js';

function attribution(overrides = {}) {
  return {
    kind: 'generation_failure_causal_attribution_v1', version: 1,
    rootCauseKey: 'motion-control-overload',
    primary: {
      key: 'motion-control-overload', stage: 'generation control',
      hypothesis: 'one unit carries more independent motion than the active control route can hold',
      confidence: 'medium', evidence: ['the missed action begins where three controls overlap'],
      falsifier: 'the same control route succeeds after the action is split without changing any other variable'
    },
    contributors: [{
      key: 'weak-end-state-anchor', stage: 'handoff', hypothesis: 'the end-state anchor leaves the motion phase ambiguous',
      confidence: 'low', evidence: ['two adjacent frames support different motion phases'],
      falsifier: 'a denser free frame inspection proves one unambiguous phase'
    }],
    counterEvidence: ['identity and scene anchors remain stable before the overlap'],
    unknowns: ['current node internal attention allocation is not observable'],
    nextMinimalCheck: {
      variable: 'generated unit shot count', action: 'split only the overloaded action into its own unit',
      expectedObservation: 'the missing action becomes visible while identity and scene remain unchanged',
      changesOnePrimaryVariable: true, costClass: 'free'
    },
    promptOnlyRetryAllowed: false, controlRouteChangeRequired: true,
    ...overrides
  };
}

test('accepts an evidence-bounded primary cause, contributors, counter-evidence and one-variable check', () => {
  const value = attribution();
  assert.equal(assertGenerationFailureCausalAttribution(value, { rootCauseKey: value.rootCauseKey }), value);
});

test('rejects single-label certainty without falsifier or evidence', () => {
  const missingFalsifier = attribution();
  delete missingFalsifier.primary.falsifier;
  assert.throws(() => assertGenerationFailureCausalAttribution(missingFalsifier), /falsifier/);
  assert.throws(() => assertGenerationFailureCausalAttribution(attribution({ primary: { ...attribution().primary, evidence: [] } })), /evidence/);
});

test('blocks prompt-only retries and mismatched stable root-cause keys', () => {
  assert.throws(() => assertGenerationFailureCausalAttribution(attribution({ promptOnlyRetryAllowed: true })), /must remain false/);
  assert.throws(() => assertGenerationFailureCausalAttribution(attribution(), { rootCauseKey: 'different-root' }), /must match/);
});

test('strict failures use a stable owner and return-stage registry', () => {
  assert.deepEqual(assertRegisteredGenerationRootCause('VOICE_STATE_MISMATCH'), {
    key: 'VOICE_STATE_MISMATCH', ownerLayer: 'voice', returnStage: 'gate2'
  });
  assert.throws(() => assertRegisteredGenerationRootCause('invented-root-cause'), /not registered/);
});
