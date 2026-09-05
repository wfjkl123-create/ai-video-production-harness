import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExecutionControlContract, executionControlFingerprint } from '../../src/domain/execution-control-contract.js';

const capability = {
  surface: 'LibTV Seedance node', profileId: 'seedance-2-libtv-v1', parameter: 'multi_shots',
  exposed: false, enabled: false, evidence: 'current node schema readback'
};

test('multi-shot prompts cannot substitute for unavailable platform control', () => {
  assert.throws(() => assertExecutionControlContract({
    version: 1, plannedShotCount: 12, generatedUnitShotCount: 12,
    executionUnitStrategy: 'platform_multi_shot', requiresIndependentShotControl: true,
    platformCapability: capability
  }), /exposed and enabled/);
});

test('twelve-shot stories remain executable when each paid unit generates one shot for editorial assembly', () => {
  const value = assertExecutionControlContract({
    version: 1, plannedShotCount: 12, generatedUnitShotCount: 1,
    executionUnitStrategy: 'segmented_editorial', requiresIndependentShotControl: false,
    platformCapability: capability
  });
  assert.match(executionControlFingerprint(value), /^[a-f0-9]{64}$/);
});

test('verified platform multi-shot requires exact exposed and enabled readback', () => {
  const value = assertExecutionControlContract({
    version: 1, plannedShotCount: 12, generatedUnitShotCount: 12,
    executionUnitStrategy: 'platform_multi_shot', requiresIndependentShotControl: true,
    platformCapability: {
      ...capability, exposed: true, enabled: true, evidence: 'node schema and settings readback',
      verificationMode: 'libtv_canvas_node_readback'
    }
  });
  assert.equal(value.executionUnitStrategy, 'platform_multi_shot');
});
