import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { persistSourceComparatorAudit, requirePassingSourceComparatorAudit, sourceComparatorAuditDirectory } from '../../src/services/source-comparator-audit-service.js';
import { runSourceComparatorAudit } from '../../src/commands/source-comparator-audit.js';
import { buildSourceFactAnalysis } from '../../src/domain/source-fact-analysis.js';

const digest = character => character.repeat(64);

function fixture() {
  const sourceAnalysis = buildSourceFactAnalysis({
    projectId: 'compare-1', referenceVideo: { artifactId: 'video-1', artifactRevision: 1, artifactSha256: digest('a') }, durationSec: 2,
    samplingStrategy: { version: 'adaptive-source-sampling-v1', normal: { mode: 'uniform_low_frequency', targetFps: 1 }, strongAction: { mode: 'dense_action_sampling', targetFps: 4 } },
    timeline: [
      { rowId: 'r1', startSec: 0, endSec: 1, samplingClass: 'normal', samplingReason: 'steady', targetFps: 1, sampleTimesSec: [0], observedFacts: [{ statement: '人物居中', modality: 'visual', evidenceTimesSec: [0] }], interpretation: ['人物可能紧张'], uncertainties: ['手部被遮挡'] },
      { rowId: 'r2', startSec: 1, endSec: 2, samplingClass: 'normal', samplingReason: 'steady', targetFps: 1, sampleTimesSec: [1], observedFacts: [{ statement: '听见一句人声', modality: 'audible', evidenceTimesSec: [1.2] }], interpretation: [], uncertainties: [] }
    ]
  }, { revision: 2, createdAt: '2026-08-08T00:00:00Z' });
  const storyPlan = {
    schemaVersion: 1, id: 'story-1', projectId: 'compare-1', creativeBriefId: 'brief-1', targetDurationSec: 2,
    creativeDecision: { storyDirection: 'test', successDefinition: 'test', segmentationStrategy: 'single_clip', segmentationRationale: 'test', executionMode: 'sequential', assetExecutionMode: 'sequential', videoExecutionMode: 'sequential', parallelPlan: ['one local lane'], estimatedAssetCombination: ['one prop'], referenceWorkflow: { referenceIntent: 'faithful_remake', sourceVideoIds: ['video-1'] } },
    sourceFactContract: { analysisMode: 'adaptive_source_analysis', sourceVideoIds: ['video-1'], sourceRange: { startSec: 0, endSec: 2 }, dialoguePolicy: 'verbatim', visualEvidence: ['人物居中'], dialogueEvidence: ['听见一句人声'], preserveFacts: ['人物居中', '听见一句人声'], replaceFacts: [], uncertainties: ['手部被遮挡'], actionLedger: [{ startSec: 0, endSec: 1, observedAction: '人物居中', emotionBeat: '中性', spokenLine: null }, { startSec: 1, endSec: 2, observedAction: '听见一句人声', emotionBeat: '中性', spokenLine: '台词' }] },
    story: { logline: 'x', storyPromise: 'x', initialCondition: 'x', objective: 'x', centralConflict: 'x', turn: 'x', climax: 'x', finalOutcome: 'x', tone: 'x' },
    characters: [{ characterId: 'c1', tag: 'x', role: 'x', background: 'x', personality: 'x', stance: 'x', objective: 'x', obstacle: 'x', appearance: 'x', wardrobeLock: 'x', relationshipMap: 'x', arc: 'x' }],
    script: { scenes: [{ sceneId: 's1', location: 'x', timeOfDay: 'x', sceneFunction: 'x', pov: 'x', powerShift: 'x', subtext: 'x', beats: ['x'], dialogue: [] }] },
    videoSegments: [{ segmentId: 'seg1', startSec: 0, endSec: 2, storyBeat: 'x', splitReason: 'single complete beat', sceneIds: ['s1'] }],
    shotPlanning: { mode: 'shotlist', shots: [{ shotId: 'sh1', segmentId: 'seg1', sceneId: 's1', durationSec: 2, purpose: 'x', subjectAction: 'x', shotContract: 'x', blocking: 'x', startState: 'x', endState: 'x', audio: 'x', continuityAnchors: ['x'], risks: ['x'] }], continuousTakePlan: null, roughStoryboardPreview: null },
    assetPlan: [{ assetType: 'story_prop', decision: 'required', reason: 'x', assetIds: ['x'] }]
  };
  return { sourceAnalysis, storyPlan, sourceAnalysisBinding: { artifactId: sourceAnalysis.id, artifactRevision: 2, artifactSha256: digest('b') }, storyPlanBinding: { artifactId: 'story-1', artifactRevision: 3, artifactSha256: digest('c') } };
}

test('identical exact bindings are persisted once and reused idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-comparator-'));
  const input = fixture();
  const options = { now: () => new Date('2026-08-08T02:00:00Z'), requireProjectBinding: false };
  const [first, second] = await Promise.all([persistSourceComparatorAudit(root, input, options), persistSourceComparatorAudit(root, input, options)]);
  assert.equal(first.audit.id, second.audit.id);
  assert.deepEqual(new Set([first.reused, second.reused]), new Set([false, true]));
  assert.equal((await readdir(sourceComparatorAuditDirectory(root))).length, 1);
});

test('AppleDouble metadata files are ignored when source comparator audits are scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-comparator-appledouble-'));
  const input = fixture();
  const first = await persistSourceComparatorAudit(root, input, { requireProjectBinding: false });
  await writeJsonAtomic(join(sourceComparatorAuditDirectory(root), '._metadata.json'), { not: 'a comparator audit' });
  const second = await persistSourceComparatorAudit(root, input, { requireProjectBinding: false });
  assert.equal(second.reused, true);
  assert.equal(second.audit.id, first.audit.id);
});

test('a changed story SHA creates a distinct audit fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-comparator-change-'));
  const first = await persistSourceComparatorAudit(root, fixture(), { requireProjectBinding: false });
  const changed = fixture();
  changed.storyPlanBinding.artifactSha256 = 'd'.repeat(64);
  const second = await persistSourceComparatorAudit(root, changed, { requireProjectBinding: false });
  assert.notEqual(first.audit.inputFingerprintSha256, second.audit.inputFingerprintSha256);
  assert.equal((await readdir(sourceComparatorAuditDirectory(root))).length, 2);
});

test('Gate 2 helper rejects stale fingerprints and accepts one PASS bound to the exact locked source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-comparator-gate-'));
  const input = fixture();
  const sourcePath = join(root, 'planning', 'source.json');
  const storyPath = join(root, 'planning', 'story.json');
  await writeJsonAtomic(sourcePath, input.sourceAnalysis);
  await writeJsonAtomic(storyPath, input.storyPlan);
  const { sha256File } = await import('../../src/storage/checksum.js');
  input.sourceAnalysisBinding.artifactSha256 = await sha256File(sourcePath);
  input.storyPlanBinding.artifactSha256 = await sha256File(storyPath);
  const artifact = { id: input.storyPlan.id, type: 'story_plan', revision: input.storyPlanBinding.artifactRevision, status: 'awaiting_review', path: 'planning/story.json', sha256: input.storyPlanBinding.artifactSha256 };
  const sourceArtifact = { id: input.sourceAnalysis.id, type: 'source_fact_analysis', revision: input.sourceAnalysisBinding.artifactRevision, status: 'locked', path: 'planning/source.json', sha256: input.sourceAnalysisBinding.artifactSha256, lockedByReviewId: 'source-review' };
  await writeJsonAtomic(join(root, 'reviews', 'source-review.json'), { id: 'source-review', artifactId: sourceArtifact.id, decision: 'approved', note: 'machine validated', correction: null, createdAt: '2026-08-08T00:00:00Z', actor: 'system', autoLocked: true, artifactSha256: sourceArtifact.sha256, submittedArtifactSha256: sourceArtifact.sha256 });
  await writeJsonAtomic(join(root, 'project-state.json'), { projectId: input.storyPlan.projectId, workflowVersion: 2, phase: 'story_plan_review', activeSegmentId: null, blockedReason: null, executionMode: null, updatedAt: '2026-08-08T00:00:00Z', artifacts: [sourceArtifact, artifact] });
  await persistSourceComparatorAudit(root, input, { requireProjectBinding: false });
  assert.equal((await requirePassingSourceComparatorAudit(root, artifact)).decision, 'PASS');
  await writeJsonAtomic(storyPath, { ...input.storyPlan, id: 'story-mutated' });
  await assert.rejects(requirePassingSourceComparatorAudit(root, artifact), /checksum changed/);
});

test('command passes the selected source analysis and story plan IDs to local persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-comparator-command-'));
  const calls = [];
  await runSourceComparatorAudit(['--project', root, '--source-analysis', 'facts-1', '--story-plan', 'story-1'], {
    persistSourceComparatorAudit: async (projectRoot, request) => { calls.push({ projectRoot, request }); return { reused: false }; }
  });
  assert.deepEqual(calls, [{ projectRoot: root, request: { sourceAnalysisId: 'facts-1', storyPlanId: 'story-1' } }]);
});
