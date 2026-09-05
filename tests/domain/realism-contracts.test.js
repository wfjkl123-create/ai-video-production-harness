import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRequiredBindings,
  assertRequiredBindingsSatisfied,
  notApplicableBinding,
  realismContractsVersionOf,
  requiredBinding
} from '../../src/domain/realism-contracts.js';

const locked = {
  id: 'identity-pack-a-v2',
  status: 'locked',
  sha256: 'a'.repeat(64)
};

test('legacy projects dual-read as realism contracts v1', () => {
  assert.equal(realismContractsVersionOf({}), 1);
  assert.equal(realismContractsVersionOf({ realismContractsVersion: 2 }), 2);
  assert.throws(() => realismContractsVersionOf({ realismContractsVersion: 3 }), /must be 1 or 2/);
});

test('required bindings fail closed on stale, unlocked or missing authorities', () => {
  const contract = assertRequiredBindings({
    version: 1,
    entries: [
      requiredBinding('character_identity_pack_v2', locked, '当前 Shot 可见正面和侧面。', 'segment-001'),
      notApplicableBinding('scene_geometry_v2', '单人紧近景，不需要主空间锚。', 'segment-001')
    ]
  });
  assert.equal(assertRequiredBindingsSatisfied(contract, [locked]), contract);
  assert.throws(() => assertRequiredBindingsSatisfied(contract, []), /required binding is missing/);
  assert.throws(() => assertRequiredBindingsSatisfied(contract, [{ ...locked, status: 'rework' }]), /stale or unlocked/);
  assert.throws(() => assertRequiredBindingsSatisfied(contract, [{ ...locked, sha256: 'b'.repeat(64) }]), /stale or unlocked/);
});

test('not-applicable bindings require an explicit reason and cannot smuggle an artifact', () => {
  assert.throws(() => assertRequiredBindings({
    version: 1,
    entries: [{ bindingType: 'scene_geometry_v2', scopeKey: 'segment-001', applicability: 'not_applicable', reason: '' }]
  }), /reason/);
  assert.throws(() => assertRequiredBindings({
    version: 1,
    entries: [{
      bindingType: 'scene_geometry_v2', scopeKey: 'segment-001', applicability: 'not_applicable',
      reason: '不需要', artifactId: 'hidden', sha256: 'a'.repeat(64)
    }]
  }), /must not bind an artifact/);
});
