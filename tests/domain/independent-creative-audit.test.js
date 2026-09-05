import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIndependentCreativeAudit } from '../../src/domain/independent-creative-audit.js';

const sha = 'a'.repeat(64);
const valid = {
  id: 'independent-audit-segment-001-v1',
  kind: 'independent_creative_audit',
  segmentId: 'segment-001',
  revision: 1,
  decision: 'PASS',
  agentContextMode: 'clean_zero_context',
  agentTaskId: '/root/segment001-clean-audit',
  sourceRange: '00:00-00:14',
  reportPath: 'reviews/segment-001-clean-audit.md',
  reportSha256: sha,
  promptSha256: sha,
  packageSha256: sha,
  inputMedia: { images: [], videos: [], audio: [] },
  blockerCount: 0,
  importantCount: 0,
  reviewedAt: '2026-07-24T00:00:00.000Z'
};

test('accepts clean zero-context PASS evidence with exact SHA bindings', () => {
  assert.equal(assertIndependentCreativeAudit(valid), valid);
});

test('rejects contextual, malformed, or unbound audit evidence', () => {
  assert.throws(() => assertIndependentCreativeAudit({ ...valid, agentContextMode: 'inherited' }), /clean_zero_context/);
  assert.throws(() => assertIndependentCreativeAudit({ ...valid, promptSha256: 'not-a-sha' }), /SHA-256/);
  assert.throws(() => assertIndependentCreativeAudit({ ...valid, inputMedia: { images: [{ id: 'x' }], videos: [], audio: [] } }), /path/);
});
