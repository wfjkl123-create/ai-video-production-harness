import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import {
  assessStudioOperationalReadiness,
  STUDIO_ACTION_COVERAGE
} from '../../src/services/studio-operational-readiness-service.js';

async function projectFixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-readiness-'));
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'STUDIO-READINESS-1',
    workflowVersion: 2,
    ingressPolicyVersion: 'ingress-route-v1',
    phase: 'intake',
    activeSegmentId: null,
    blockedReason: null,
    artifacts: [],
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides
  });
  return root;
}

const dependencies = {
  ffmpeg: { label: 'FFmpeg', required: false, available: true, evidence: 'ffmpeg version test' },
  ffprobe: { label: 'FFprobe', required: false, available: true, evidence: 'ffprobe version test' },
  libtv: { label: 'LibTV CLI', required: false, available: false, evidence: 'not configured' }
};

test('readiness distinguishes the executable current action from incomplete full-web coverage', async () => {
  const root = await projectFixture();
  const report = await assessStudioOperationalReadiness(root, {
    dependencies,
    directorConfiguration: { available: false, reason: 'not needed at Gate 0' }
  });

  assert.equal(report.currentAction, 'capture_intake_route');
  assert.equal(report.currentActionCoverage.supported, true);
  assert.equal(report.executionReadiness, 'PASS');
  assert.equal(report.allWebCoverage, 'PARTIAL');
  assert.ok(report.stages.some(stage => stage.id === 'gate3' && stage.executable === false));
  assert.ok(report.warnings.some(message => message.includes('图片提示词计划')));
});

test('a missing dependency blocks only when it is required by the current action', async () => {
  const root = await projectFixture();
  const report = await assessStudioOperationalReadiness(root, {
    dependencies: {
      ...dependencies,
      ffmpeg: { label: 'FFmpeg', required: true, available: false, evidence: 'ENOENT' }
    },
    directorConfiguration: { available: true }
  });

  assert.equal(report.executionReadiness, 'BLOCKED');
  assert.ok(report.blockers.includes('FFmpeg 不可用'));
});

test('a saved Director result is recoverable, while an uncertain call only permits manual fallback', async () => {
  const root = await projectFixture();
  const runPath = join(root, 'runs', 'director-gate1-test-11111111-1111-4111-8111-111111111111.json');
  await writeJsonAtomic(runPath, {
    id: 'director-gate1-test-11111111-1111-4111-8111-111111111111',
    kind: 'director_gate1',
    status: 'MODEL_SUCCEEDED_UNCOMMITTED',
    paidModelCallCompleted: true
  });
  let report = await assessStudioOperationalReadiness(root, {
    dependencies,
    directorConfiguration: { available: false }
  });
  assert.equal(report.currentAction, 'resolve_director_run');
  assert.equal(report.executionReadiness, 'PASS');
  assert.equal(report.currentActionCoverage.mode, 'commit_saved_result_without_model_call');

  const run = await readFile(runPath, 'utf8').then(JSON.parse);
  run.status = 'UNCERTAIN';
  run.paidModelCallCompleted = null;
  await writeJsonAtomic(runPath, run);
  report = await assessStudioOperationalReadiness(root, {
    dependencies,
    directorConfiguration: { available: true }
  });
  assert.equal(report.executionReadiness, 'PASS');
  assert.equal(report.currentActionCoverage.mode, 'manual_fallback_without_model_retry');
  assert.ok(report.warnings.some(message => message.includes('转手工编辑')));
});

test('every deterministic next-action id has an explicit Studio coverage contract', async () => {
  const source = await readFile(new URL('../../src/services/next-action-service.js', import.meta.url), 'utf8');
  const ids = [...source.matchAll(/id: '([a-z0-9_]+)'/g)].map(match => match[1]);
  const missing = [...new Set(ids)].filter(id => !(id in STUDIO_ACTION_COVERAGE));
  assert.deepEqual(missing, []);
  assert.equal(STUDIO_ACTION_COVERAGE.recover_transactions.supported, true);
  assert.equal(STUDIO_ACTION_COVERAGE.reconcile_video_submit.supported, false);
  assert.equal(STUDIO_ACTION_COVERAGE.repair_project_evidence.supported, false);
  assert.equal(STUDIO_ACTION_COVERAGE.prepare_mechanical_asset_prompt_package.supported, true,
    'mechanical slicing and prompt compilation are exposed through an executable Studio endpoint');
  assert.equal(STUDIO_ACTION_COVERAGE.prepare_mechanical_libtv_canvas.supported, true);
  assert.equal(STUDIO_ACTION_COVERAGE.mechanical_canvas_ready.supported, true);
  assert.equal(STUDIO_ACTION_COVERAGE.machine_review_story_plan.supported, true);
});
