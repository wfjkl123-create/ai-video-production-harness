import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSourceFactAnalysis } from '../../src/commands/source-fact-analysis.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { autoLockArtifact } from '../../src/services/review-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import {
  persistSourceFactAnalysis,
  sourceFactAnalysisDirectory
} from '../../src/services/source-fact-analysis-service.js';

function validInput() {
  return {
    projectId: 'SOURCE-FACT-1',
    referenceVideo: {
      artifactId: 'reference-video-001',
      artifactRevision: 3,
      artifactSha256: 'a'.repeat(64)
    },
    durationSec: 4,
    samplingStrategy: {
      version: 'adaptive-source-sampling-v1',
      normal: { mode: 'uniform_low_frequency', targetFps: 1 },
      strongAction: { mode: 'dense_action_sampling', targetFps: 4 }
    },
    timeline: [
      {
        rowId: 'row-001', startSec: 0, endSec: 2, samplingClass: 'normal',
        samplingReason: '人物站立并说话，身体位移缓慢', targetFps: 1, sampleTimesSec: [0, 1],
        observedFacts: [{ statement: '人物位于画面中央', modality: 'visual', evidenceTimesSec: [0] }],
        interpretation: ['人物可能在介绍产品'], uncertainties: ['手部被遮挡']
      },
      {
        rowId: 'row-002', startSec: 2, endSec: 3, samplingClass: 'strong_action',
        samplingReason: '双手快速拉伸产品', targetFps: 4, sampleTimesSec: [2, 2.25, 2.5, 2.75],
        observedFacts: [{ statement: '双手接触产品两侧', modality: 'visual', evidenceTimesSec: [2.25] }],
        interpretation: ['可能是在展示弹性'], uncertainties: []
      },
      {
        rowId: 'row-003', startSec: 3, endSec: 4, samplingClass: 'normal',
        samplingReason: '动作完成后姿态稳定', targetFps: 1, sampleTimesSec: [3],
        observedFacts: [{ statement: '产品保持展开', modality: 'visual', evidenceTimesSec: [3] }],
        interpretation: [], uncertainties: []
      }
    ]
  };
}

test('persists one source-fact version and concurrently reuses the same content fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-facts-idempotent-'));
  const options = {
    now: () => new Date('2026-08-08T01:00:00.000Z'),
    requireProjectBinding: false,
    publishArtifact: false
  };
  const [first, second] = await Promise.all([
    persistSourceFactAnalysis(root, validInput(), options),
    persistSourceFactAnalysis(root, validInput(), options)
  ]);

  assert.equal(first.analysis.contentFingerprintSha256, second.analysis.contentFingerprintSha256);
  assert.deepEqual(new Set([first.reused, second.reused]), new Set([false, true]));
  assert.equal(first.analysis.revision, 1);
  assert.match(first.path, /^planning\/source-facts\/source-facts-v1-[a-f0-9]{12}\.json$/);
  assert.equal((await readJson(join(root, first.path))).id, first.analysis.id);
  assert.equal((await readdir(sourceFactAnalysisDirectory(root))).length, 1);
});

test('AppleDouble metadata files are ignored when source fact analyses are scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-facts-appledouble-'));
  const offline = { requireProjectBinding: false, publishArtifact: false };
  const first = await persistSourceFactAnalysis(root, validInput(), offline);
  await writeJsonAtomic(join(sourceFactAnalysisDirectory(root), '._metadata.json'), { not: 'a source fact analysis' });
  const second = await persistSourceFactAnalysis(root, validInput(), offline);
  assert.equal(second.reused, true);
  assert.equal(second.analysis.id, first.analysis.id);
});

test('input or sampling strategy changes create a new version; exact repeats do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-facts-versioning-'));
  const offline = { requireProjectBinding: false, publishArtifact: false };
  const first = await persistSourceFactAnalysis(root, validInput(), offline);

  const denser = structuredClone(validInput());
  denser.samplingStrategy.normal.targetFps = 2;
  denser.timeline[0].targetFps = 2;
  denser.timeline[0].sampleTimesSec = [0, 0.5, 1, 1.5];
  denser.timeline[2].targetFps = 2;
  denser.timeline[2].sampleTimesSec = [3, 3.5];
  const second = await persistSourceFactAnalysis(root, denser, offline);

  const replacedSourceRevision = structuredClone(denser);
  replacedSourceRevision.referenceVideo.artifactRevision = 4;
  replacedSourceRevision.referenceVideo.artifactSha256 = 'b'.repeat(64);
  const third = await persistSourceFactAnalysis(root, replacedSourceRevision, offline);
  const repeated = await persistSourceFactAnalysis(root, replacedSourceRevision, offline);

  assert.deepEqual([first.analysis.revision, second.analysis.revision, third.analysis.revision], [1, 2, 3]);
  assert.notEqual(first.analysis.contentFingerprintSha256, second.analysis.contentFingerprintSha256);
  assert.notEqual(second.analysis.contentFingerprintSha256, third.analysis.contentFingerprintSha256);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.analysis.id, third.analysis.id);
  assert.equal((await readdir(sourceFactAnalysisDirectory(root))).length, 3);
});

test('source-fact-analysis command reads an input file and delegates persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-facts-command-'));
  const inputPath = join(root, 'source-fact-input.json');
  await writeJsonAtomic(inputPath, validInput());
  const calls = [];

  const result = await runSourceFactAnalysis(
    ['--project', root, '--input', 'source-fact-input.json'],
    {
      persistSourceFactAnalysis: async (projectRoot, input) => {
        calls.push({ projectRoot, input });
        return { reused: false, path: 'planning/source-facts/source-facts-v1.json' };
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectRoot, root);
  assert.equal(calls[0].input.referenceVideo.artifactId, 'reference-video-001');
  assert.equal(result.reused, false);
});

test('production persistence verifies and auto-locks the exact project reference binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-facts-bound-'));
  await initializeProject(root, { projectId: 'SOURCE-FACT-1', workflowVersion: 2 });
  await writeFile(join(root, 'brief', 'reference.mp4'), 'bound-reference-video');
  const reference = await registerArtifact(root, {
    id: 'reference-video-001', type: 'reference_video', revision: 1,
    status: 'draft', path: 'brief/reference.mp4'
  });
  await autoLockArtifact(root, reference.id, 'validated test reference');

  const input = validInput();
  input.referenceVideo.artifactRevision = 1;
  input.referenceVideo.artifactSha256 = await sha256File(join(root, 'brief', 'reference.mp4'));
  const result = await persistSourceFactAnalysis(root, input);
  assert.equal(result.artifact.type, 'source_fact_analysis');
  assert.equal(result.artifact.status, 'locked');
  assert.equal(result.artifact.sourceVideoId, reference.id);
});

test('an invalidated identical source analysis creates a new current revision instead of reusing stale evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-facts-scope-revision-'));
  await initializeProject(root, { projectId: 'SOURCE-FACT-1', workflowVersion: 2 });
  await writeFile(join(root, 'brief', 'reference.mp4'), 'bound-reference-video');
  const reference = await registerArtifact(root, {
    id: 'reference-video-001', type: 'reference_video', revision: 1,
    status: 'draft', path: 'brief/reference.mp4'
  });
  await autoLockArtifact(root, reference.id, 'validated test reference');

  const input = validInput();
  input.referenceVideo.artifactRevision = 1;
  input.referenceVideo.artifactSha256 = await sha256File(join(root, 'brief', 'reference.mp4'));
  const first = await persistSourceFactAnalysis(root, input);
  const state = await readJson(join(root, 'project-state.json'));
  const stale = state.artifacts.find(item => item.id === first.artifact.id);
  stale.invalidatedByScopeRevisionId = 'direction-revision-2';
  stale.invalidationReason = 'test scope revision';
  await writeJsonAtomic(join(root, 'project-state.json'), state);

  const second = await persistSourceFactAnalysis(root, input);
  assert.equal(second.reused, false);
  assert.equal(second.analysis.revision, first.analysis.revision + 1);
  assert.equal(second.analysis.contentFingerprintSha256, first.analysis.contentFingerprintSha256);
  assert.notEqual(second.artifact.id, first.artifact.id);
  assert.equal(second.artifact.invalidatedByScopeRevisionId, undefined);
  assert.equal(second.artifact.status, 'locked');
});
