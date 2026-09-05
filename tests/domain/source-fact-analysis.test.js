import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSourceFactAnalysis,
  buildSourceFactAnalysis,
  sourceFactInputFingerprint
} from '../../src/domain/source-fact-analysis.js';

const digest = value => value.repeat(64).slice(0, 64);

function validInput(overrides = {}) {
  return {
    projectId: 'SOURCE-FACT-1',
    referenceVideo: {
      artifactId: 'reference-video-001',
      artifactRevision: 3,
      artifactSha256: digest('a')
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
        observedFacts: [
          { statement: '人物位于画面中央', modality: 'visual', evidenceTimesSec: [0] },
          { statement: '出现一段可听见的人声', modality: 'audible', evidenceTimesSec: [0.4] }
        ],
        interpretation: ['说话者可能在介绍产品，但语义仍需转写核验'],
        uncertainties: ['遮挡区域中的手部状态不可见']
      },
      {
        rowId: 'row-002', startSec: 2, endSec: 3, samplingClass: 'strong_action',
        samplingReason: '双手快速拉伸产品并改变接触位置', targetFps: 4,
        sampleTimesSec: [2, 2.25, 2.5, 2.75],
        observedFacts: [
          { statement: '双手分别接触产品两侧', modality: 'visual', evidenceTimesSec: [2.25, 2.5] }
        ],
        interpretation: ['动作意图可能是展示弹性'],
        uncertainties: ['2.50 秒附近右手指尖被产品遮挡']
      },
      {
        rowId: 'row-003', startSec: 3, endSec: 4, samplingClass: 'normal',
        samplingReason: '动作完成后姿态保持稳定', targetFps: 1, sampleTimesSec: [3],
        observedFacts: [
          { statement: '产品在双手之间保持展开', modality: 'visual', evidenceTimesSec: [3] }
        ],
        interpretation: [],
        uncertainties: []
      }
    ],
    ...overrides
  };
}

test('builds a fingerprinted adaptive source analysis bound to the exact reference artifact', () => {
  const analysis = buildSourceFactAnalysis(validInput(), {
    revision: 1,
    createdAt: '2026-08-08T01:00:00.000Z'
  });

  assert.equal(assertSourceFactAnalysis(analysis), analysis);
  assert.equal(analysis.kind, 'adaptive_source_analysis');
  assert.equal(analysis.analysisMode, 'adaptive_source_analysis');
  assert.deepEqual(analysis.referenceVideo, validInput().referenceVideo);
  assert.match(analysis.contentFingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal(analysis.timeline[1].samplingClass, 'strong_action');
  assert.deepEqual(analysis.factPolicy, {
    observedFactsRequireSourceEvidence: true,
    interpretationIsNonAuthoritative: true,
    uncertaintiesMustRemainExplicit: true
  });
});

test('the input fingerprint is stable across object-key order and excludes output version metadata', () => {
  const input = validInput();
  const reordered = {
    timeline: input.timeline,
    samplingStrategy: input.samplingStrategy,
    durationSec: input.durationSec,
    referenceVideo: {
      artifactSha256: input.referenceVideo.artifactSha256,
      artifactRevision: input.referenceVideo.artifactRevision,
      artifactId: input.referenceVideo.artifactId
    },
    projectId: input.projectId
  };
  assert.equal(sourceFactInputFingerprint(input), sourceFactInputFingerprint(reordered));
  assert.equal(
    buildSourceFactAnalysis(input, { revision: 1, createdAt: '2026-08-08T01:00:00Z' }).contentFingerprintSha256,
    buildSourceFactAnalysis(input, { revision: 9, createdAt: '2027-01-01T00:00:00Z' }).contentFingerprintSha256
  );
});

test('requires a seamless [0,T] timeline without gaps, overlap, or a truncated ending', () => {
  const input = validInput();
  const gap = structuredClone(input);
  gap.timeline[1].startSec = 2.1;
  gap.timeline[1].sampleTimesSec = [2.1, 2.35, 2.6, 2.85];
  assert.throws(() => sourceFactInputFingerprint(gap), /contiguously/);

  const overlap = structuredClone(input);
  overlap.timeline[1].startSec = 1.9;
  overlap.timeline[1].sampleTimesSec = [1.9, 2.15, 2.4, 2.65, 2.9];
  assert.throws(() => sourceFactInputFingerprint(overlap), /contiguously/);

  const truncated = structuredClone(input);
  truncated.timeline.at(-1).endSec = 3.9;
  assert.throws(() => sourceFactInputFingerprint(truncated), /durationSec/);
});

test('enforces low-frequency normal sampling and 4-8fps strong-action sampling', () => {
  const weakStrongPolicy = validInput({
    samplingStrategy: {
      version: 'adaptive-source-sampling-v1',
      normal: { mode: 'uniform_low_frequency', targetFps: 1 },
      strongAction: { mode: 'dense_action_sampling', targetFps: 3 }
    }
  });
  assert.throws(() => sourceFactInputFingerprint(weakStrongPolicy), /4 and 8/);

  const denseNormalPolicy = validInput({
    samplingStrategy: {
      version: 'adaptive-source-sampling-v1',
      normal: { mode: 'uniform_low_frequency', targetFps: 4 },
      strongAction: { mode: 'dense_action_sampling', targetFps: 4 }
    }
  });
  assert.throws(() => sourceFactInputFingerprint(denseNormalPolicy), /at most 2/);

  const sparseSamples = structuredClone(validInput());
  sparseSamples.timeline[1].sampleTimesSec = [2, 2.5];
  assert.throws(() => sourceFactInputFingerprint(sparseSamples), /target sampling density/);
});

test('observed visual facts require sampled evidence while inference stays separately labeled', () => {
  const unsampledEvidence = structuredClone(validInput());
  unsampledEvidence.timeline[1].observedFacts[0].evidenceTimesSec = [2.1];
  assert.throws(() => sourceFactInputFingerprint(unsampledEvidence), /sampleTimesSec/);

  const noEvidence = structuredClone(validInput());
  noEvidence.timeline[0].observedFacts[0].evidenceTimesSec = [];
  assert.throws(() => sourceFactInputFingerprint(noEvidence), /non-empty array/);

  const missingUncertaintyChannel = structuredClone(validInput());
  delete missingUncertaintyChannel.timeline[0].uncertainties;
  assert.throws(() => sourceFactInputFingerprint(missingUncertaintyChannel), /uncertainties/);
});

export { validInput };
