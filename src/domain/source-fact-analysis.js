import { createHash } from 'node:crypto';
import { assertProjectId } from './project-id.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAMPLE_CLASSES = new Set(['normal', 'strong_action']);
const MODALITIES = new Set(['visual', 'audible']);
const FACT_POLICY = Object.freeze({
  observedFactsRequireSourceEvidence: true,
  interpretationIsNonAuthoritative: true,
  uncertaintiesMustRemainExplicit: true
});
const EPSILON = 0.001;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function id(value, field) {
  const normalized = text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(normalized)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return normalized;
}

function positive(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive finite number`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function time(value, field) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a non-negative finite number`);
  return value;
}

function stringList(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function normalizedReferenceVideo(value) {
  object(value, 'referenceVideo');
  const artifactSha256 = text(value.artifactSha256, 'referenceVideo.artifactSha256');
  if (!SHA256.test(artifactSha256)) throw new TypeError('referenceVideo.artifactSha256 must be a lowercase SHA-256');
  return {
    artifactId: id(value.artifactId, 'referenceVideo.artifactId'),
    artifactRevision: positiveInteger(value.artifactRevision, 'referenceVideo.artifactRevision'),
    artifactSha256
  };
}

function normalizedSamplingStrategy(value) {
  object(value, 'samplingStrategy');
  if (value.version !== 'adaptive-source-sampling-v1') {
    throw new TypeError('samplingStrategy.version must be adaptive-source-sampling-v1');
  }
  object(value.normal, 'samplingStrategy.normal');
  object(value.strongAction, 'samplingStrategy.strongAction');
  if (value.normal.mode !== 'uniform_low_frequency') {
    throw new TypeError('samplingStrategy.normal.mode must be uniform_low_frequency');
  }
  if (value.strongAction.mode !== 'dense_action_sampling') {
    throw new TypeError('samplingStrategy.strongAction.mode must be dense_action_sampling');
  }
  const normalFps = positive(value.normal.targetFps, 'samplingStrategy.normal.targetFps');
  if (normalFps > 2) throw new TypeError('samplingStrategy.normal.targetFps must be at most 2');
  const strongActionFps = positive(value.strongAction.targetFps, 'samplingStrategy.strongAction.targetFps');
  if (strongActionFps < 4 || strongActionFps > 8) {
    throw new TypeError('samplingStrategy.strongAction.targetFps must be between 4 and 8');
  }
  return {
    version: value.version,
    normal: { mode: value.normal.mode, targetFps: normalFps },
    strongAction: { mode: value.strongAction.mode, targetFps: strongActionFps }
  };
}

function normalizedSamples(value, row, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  const samples = value.map((sample, index) => time(sample, `${field}[${index}]`));
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample < row.startSec - EPSILON || sample >= row.endSec - EPSILON) {
      throw new TypeError(`${field}[${index}] must fall inside the half-open row interval`);
    }
    if (index > 0 && sample <= samples[index - 1]) throw new TypeError(`${field} must be strictly increasing`);
  }
  const maximumGap = 1 / row.targetFps;
  const coveragePoints = [row.startSec, ...samples, row.endSec];
  for (let index = 1; index < coveragePoints.length; index += 1) {
    if (coveragePoints[index] - coveragePoints[index - 1] > maximumGap + EPSILON) {
      throw new TypeError(`${field} does not meet the target sampling density`);
    }
  }
  return samples;
}

function evidenceTime(value, row, field) {
  const normalized = time(value, field);
  if (normalized < row.startSec - EPSILON || normalized >= row.endSec - EPSILON) {
    throw new TypeError(`${field} must fall inside its timeline row`);
  }
  return normalized;
}

function normalizedObservedFacts(value, row, sampleTimesSec, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((fact, index) => {
    const prefix = `${field}[${index}]`;
    object(fact, prefix);
    if (!MODALITIES.has(fact.modality)) throw new TypeError(`${prefix}.modality must be visual or audible`);
    if (!Array.isArray(fact.evidenceTimesSec) || fact.evidenceTimesSec.length === 0) {
      throw new TypeError(`${prefix}.evidenceTimesSec must be a non-empty array`);
    }
    const evidenceTimesSec = fact.evidenceTimesSec.map((entry, evidenceIndex) => evidenceTime(
      entry,
      row,
      `${prefix}.evidenceTimesSec[${evidenceIndex}]`
    ));
    if (fact.modality === 'visual' && evidenceTimesSec.some(entry => !sampleTimesSec.some(sample => Math.abs(sample - entry) <= EPSILON))) {
      throw new TypeError(`${prefix}.evidenceTimesSec must reference sampleTimesSec for a visual fact`);
    }
    return {
      statement: text(fact.statement, `${prefix}.statement`),
      modality: fact.modality,
      evidenceTimesSec
    };
  });
}

function normalizedTimeline(value, durationSec, strategy) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('timeline must be a non-empty array');
  const rowIds = new Set();
  let cursor = 0;
  const rows = value.map((input, index) => {
    const prefix = `timeline[${index}]`;
    object(input, prefix);
    const rowId = id(input.rowId, `${prefix}.rowId`);
    if (rowIds.has(rowId)) throw new TypeError('timeline row IDs must be unique');
    rowIds.add(rowId);
    const startSec = time(input.startSec, `${prefix}.startSec`);
    const endSec = time(input.endSec, `${prefix}.endSec`);
    if (Math.abs(startSec - cursor) > EPSILON || endSec <= startSec) {
      throw new TypeError('timeline must cover [0,T] contiguously without gaps or overlap');
    }
    if (!SAMPLE_CLASSES.has(input.samplingClass)) throw new TypeError(`${prefix}.samplingClass is invalid`);
    const policy = input.samplingClass === 'strong_action' ? strategy.strongAction : strategy.normal;
    const targetFps = positive(input.targetFps, `${prefix}.targetFps`);
    if (Math.abs(targetFps - policy.targetFps) > EPSILON) {
      throw new TypeError(`${prefix}.targetFps must match its sampling strategy`);
    }
    const base = {
      rowId,
      startSec,
      endSec,
      samplingClass: input.samplingClass,
      samplingReason: text(input.samplingReason, `${prefix}.samplingReason`),
      targetFps
    };
    const sampleTimesSec = normalizedSamples(input.sampleTimesSec, base, `${prefix}.sampleTimesSec`);
    const observedFacts = normalizedObservedFacts(input.observedFacts, base, sampleTimesSec, `${prefix}.observedFacts`);
    const interpretation = stringList(input.interpretation, `${prefix}.interpretation`);
    const uncertainties = stringList(input.uncertainties, `${prefix}.uncertainties`);
    if (observedFacts.length === 0 && uncertainties.length === 0) {
      throw new TypeError(`${prefix} must record observedFacts or explicit uncertainties`);
    }
    cursor = endSec;
    return { ...base, sampleTimesSec, observedFacts, interpretation, uncertainties };
  });
  if (Math.abs(cursor - durationSec) > EPSILON) {
    throw new TypeError('timeline must end at durationSec and cover [0,T]');
  }
  return rows;
}

function normalizeInput(input) {
  object(input, 'source fact analysis input');
  const projectId = assertProjectId(input.projectId);
  const referenceVideo = normalizedReferenceVideo(input.referenceVideo);
  const durationSec = positive(input.durationSec, 'durationSec');
  const samplingStrategy = normalizedSamplingStrategy(input.samplingStrategy);
  const timeline = normalizedTimeline(input.timeline, durationSec, samplingStrategy);
  return {
    projectId,
    referenceVideo,
    sourceRange: { startSec: 0, endSec: durationSec },
    durationSec,
    samplingStrategy,
    timeline
  };
}

export function sourceFactInputFingerprint(input) {
  return fingerprint(normalizeInput(input));
}

export function buildSourceFactAnalysis(input, { revision, createdAt }) {
  const normalized = normalizeInput(input);
  positiveInteger(revision, 'revision');
  const created = text(createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(created))) throw new TypeError('createdAt must be a date-time');
  const contentFingerprintSha256 = fingerprint(normalized);
  return {
    schemaVersion: 1,
    id: `source-facts-v${revision}-${contentFingerprintSha256.slice(0, 12)}`,
    kind: 'adaptive_source_analysis',
    analysisMode: 'adaptive_source_analysis',
    status: 'draft',
    revision,
    ...normalized,
    factPolicy: { ...FACT_POLICY },
    contentFingerprintSha256,
    createdAt: created
  };
}

export function assertSourceFactAnalysis(value) {
  object(value, 'source fact analysis');
  if (value.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1');
  if (value.kind !== 'adaptive_source_analysis' || value.analysisMode !== 'adaptive_source_analysis') {
    throw new TypeError('kind and analysisMode must be adaptive_source_analysis');
  }
  if (value.status !== 'draft') throw new TypeError('status must be draft');
  const rebuilt = buildSourceFactAnalysis({
    projectId: value.projectId,
    referenceVideo: value.referenceVideo,
    durationSec: value.durationSec,
    samplingStrategy: value.samplingStrategy,
    timeline: value.timeline
  }, { revision: value.revision, createdAt: value.createdAt });
  if (value.id !== rebuilt.id) throw new TypeError('id does not match revision and content fingerprint');
  if (value.contentFingerprintSha256 !== rebuilt.contentFingerprintSha256) {
    throw new TypeError('contentFingerprintSha256 does not match normalized analysis input');
  }
  if (value.sourceRange?.startSec !== 0 || value.sourceRange?.endSec !== value.durationSec) {
    throw new TypeError('sourceRange must cover [0,T]');
  }
  object(value.factPolicy, 'factPolicy');
  if (Object.keys(value.factPolicy).length !== Object.keys(FACT_POLICY).length
    || Object.entries(FACT_POLICY).some(([field, expected]) => value.factPolicy[field] !== expected)) {
    throw new TypeError('factPolicy must preserve observed, interpreted, and uncertain evidence boundaries');
  }
  return value;
}

export const sourceFactAnalysisFactPolicy = FACT_POLICY;
