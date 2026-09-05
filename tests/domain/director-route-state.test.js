import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPreciseVerifiedDirectorRoute } from '../../src/domain/director-route-state.js';

test('does not trust the state version flag without an explicit-v2 capability artifact', () => {
  const base = {
    directorRoutingVersion: 1,
    verifiedCapabilityManifestId: 'capability-v1',
    artifacts: [{ id: 'capability-v1', type: 'capability_manifest', status: 'locked' }]
  };
  assert.equal(hasPreciseVerifiedDirectorRoute(base), false);
  assert.equal(hasPreciseVerifiedDirectorRoute({
    ...base,
    artifacts: [{ ...base.artifacts[0], routePrecision: 'explicit_v2', storyPlanSchemaVersion: 2 }]
  }), true);
  assert.equal(hasPreciseVerifiedDirectorRoute({
    ...base,
    artifacts: [{
      ...base.artifacts[0],
      routePrecision: 'explicit_v2',
      storyPlanSchemaVersion: 2,
      invalidatedByScopeRevisionId: 'direction-revision-2'
    }]
  }), false);
});
