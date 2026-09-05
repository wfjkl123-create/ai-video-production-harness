import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { requireExecutionControlEvidence } from '../../src/services/execution-control-evidence-service.js';
import { createPaidGenerationApproval } from '../../src/services/video-generation-service.js';

function fingerprint() {
  return {
    sha256: 'a'.repeat(64),
    videoModelProfileId: 'seedance-2-libtv-v1',
    generationContract: {
      provider: 'libtv', projectUuid: 'b'.repeat(32), nodeName: 'segment-001-video',
      request: { multi_shots: true }
    },
    executionControlContract: {
      version: 1, plannedShotCount: 12, generatedUnitShotCount: 12,
      executionUnitStrategy: 'platform_multi_shot', requiresIndependentShotControl: true,
      platformCapability: {
        surface: 'LibTV Seedance node', profileId: 'seedance-2-libtv-v1', parameter: 'multi_shots',
        exposed: true, enabled: true, evidence: 'declared node readback',
        verificationMode: 'libtv_canvas_node_readback'
      }
    }
  };
}

test('self-declared multi_shots is rejected until the exact prepared node reads it back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'control-evidence-'));
  await mkdir(join(root, 'runs'));
  const value = fingerprint();
  await assert.rejects(requireExecutionControlEvidence(root, value), /unverified/);
  await writeJsonAtomic(join(root, 'runs', 'canvas-prep.json'), {
    id: 'canvas-prep', kind: 'libtv_canvas_preparation', status: 'READY_FOR_USER_CANVAS_GENERATION',
    projectUuid: value.generationContract.projectUuid, nodeName: value.generationContract.nodeName,
    nodeKey: 'node-123', fingerprint: { sha256: value.sha256 },
    verification: {
      checkedAt: '2026-08-24T00:00:00.000Z',
      snapshot: { settings: { multi_shots: false } }
    }
  });
  await assert.rejects(requireExecutionControlEvidence(root, value), /unverified/);
  await writeJsonAtomic(join(root, 'runs', 'canvas-prep.json'), {
    id: 'canvas-prep', kind: 'libtv_canvas_preparation', status: 'READY_FOR_USER_CANVAS_GENERATION',
    projectUuid: value.generationContract.projectUuid, nodeName: value.generationContract.nodeName,
    nodeKey: 'node-123', fingerprint: { sha256: value.sha256 },
    verification: {
      checkedAt: '2026-08-24T00:00:00.000Z',
      snapshot: { settings: { multi_shots: true } }
    }
  });
  const evidence = await requireExecutionControlEvidence(root, value);
  assert.equal(evidence.runId, 'canvas-prep');
  assert.equal(evidence.value, true);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
});

test('paid approval refuses a self-declared multi-shot contract without node readback evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'control-evidence-approval-'));
  await mkdir(join(root, 'runs')); await mkdir(join(root, 'reviews'));
  const value = fingerprint();
  await writeJsonAtomic(join(root, 'runs', 'preflight.json'), {
    id: 'preflight', kind: 'video_preflight', status: 'READY', segmentId: 'segment-001', fingerprint: value
  });
  await assert.rejects(createPaidGenerationApproval(root, {
    preflightId: 'preflight', segmentId: 'segment-001', note: '用户仅批准当前指纹'
  }, {
    inspect: async () => ({ fingerprint: value })
  }), /unverified/);
});
