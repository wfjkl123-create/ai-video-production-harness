import { createHash } from 'node:crypto';

const EPSILON = 0.001;
const MAX_DURATION_SEC = 15;
const SHOT_CLASSES = new Set(['aroll_speaking_lead', 'broll_preserve_source']);

function sha256Json(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function number(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function normalizedRow(row, index, durationSec) {
  if (!row || typeof row !== 'object') throw new TypeError(`timeline[${index}] must be an object`);
  const id = text(row.id, `timeline[${index}].id`);
  const startSec = number(row.startSec, `${id}.startSec`);
  const endSec = number(row.endSec, `${id}.endSec`);
  if (startSec < 0 || endSec <= startSec || endSec > durationSec + EPSILON) {
    throw new TypeError(`${id} must be a positive range inside the source duration`);
  }
  if (!SHOT_CLASSES.has(row.shotClass)) throw new TypeError(`${id}.shotClass is invalid`);
  if (row.shotClass === 'broll_preserve_source') {
    return { id, startSec, endSec, shotClass: row.shotClass, spokenLine: '', continuousTakeId: null, safeSplitPointsSec: [] };
  }
  const safeSplitPointsSec = Array.isArray(row.safeSplitPointsSec) ? row.safeSplitPointsSec.map((value, splitIndex) => {
    const point = number(value, `${id}.safeSplitPointsSec[${splitIndex}]`);
    if (point <= startSec + EPSILON || point >= endSec - EPSILON) throw new TypeError(`${id} safe split point must be inside the range`);
    return point;
  }).sort((left, right) => left - right) : [];
  if (new Set(safeSplitPointsSec).size !== safeSplitPointsSec.length) throw new TypeError(`${id} safe split points must be unique`);
  const expectedFaceCount = row.expectedFaceCount ?? 1;
  if (!Number.isInteger(expectedFaceCount) || expectedFaceCount < 1 || expectedFaceCount > 4) {
    throw new TypeError(`${id}.expectedFaceCount must be an integer between 1 and 4`);
  }
  return {
    id, startSec, endSec, shotClass: row.shotClass,
    spokenLine: text(row.spokenLine, `${id}.spokenLine`),
    continuousTakeId: text(row.continuousTakeId, `${id}.continuousTakeId`),
    safeSplitPointsSec,
    expectedFaceCount
  };
}

function splitArollRow(row) {
  if (row.endSec - row.startSec <= MAX_DURATION_SEC + EPSILON) return [{
    startSec: row.startSec, endSec: row.endSec, sourceRowIds: [row.id], spokenLines: [row.spokenLine],
    continuousTakeId: row.continuousTakeId, expectedFaceCount: row.expectedFaceCount, boundaryEvidence: 'complete_source_row'
  }];
  const packages = [];
  let cursor = row.startSec;
  while (row.endSec - cursor > MAX_DURATION_SEC + EPSILON) {
    const candidates = row.safeSplitPointsSec.filter(point => point > cursor + EPSILON && point <= cursor + MAX_DURATION_SEC + EPSILON);
    const split = candidates.at(-1);
    if (!split) throw new TypeError(`${row.id} exceeds 15 seconds and has no approved natural split point inside the next generation window`);
    packages.push({
      startSec: cursor, endSec: split, sourceRowIds: [row.id], spokenLines: [row.spokenLine],
      continuousTakeId: row.continuousTakeId, expectedFaceCount: row.expectedFaceCount, boundaryEvidence: 'approved_natural_split'
    });
    cursor = split;
  }
  packages.push({
    startSec: cursor, endSec: row.endSec, sourceRowIds: [row.id], spokenLines: [row.spokenLine],
    continuousTakeId: row.continuousTakeId, expectedFaceCount: row.expectedFaceCount, boundaryEvidence: 'complete_source_row_tail'
  });
  return packages;
}

function mergeCompatible(packages) {
  const merged = [];
  for (const current of packages) {
    const previous = merged.at(-1);
    const combinedDuration = previous ? current.endSec - previous.startSec : Infinity;
    if (previous
      && Math.abs(previous.endSec - current.startSec) <= EPSILON
      && previous.continuousTakeId === current.continuousTakeId
      && previous.expectedFaceCount === current.expectedFaceCount
      && combinedDuration <= MAX_DURATION_SEC + EPSILON
      && previous.boundaryEvidence !== 'approved_natural_split') {
      previous.endSec = current.endSec;
      previous.sourceRowIds.push(...current.sourceRowIds);
      previous.spokenLines.push(...current.spokenLines);
      previous.boundaryEvidence = 'merged_contiguous_source_rows';
    } else {
      merged.push(structuredClone(current));
    }
  }
  return merged;
}

export function compileKocSourceLedger({ projectId, sourceVideo, timeline } = {}) {
  const normalizedProjectId = text(projectId, 'projectId');
  if (!sourceVideo || typeof sourceVideo !== 'object') throw new TypeError('sourceVideo must be an object');
  const source = {
    id: text(sourceVideo.id, 'sourceVideo.id'),
    sha256: text(sourceVideo.sha256, 'sourceVideo.sha256'),
    durationSec: number(sourceVideo.durationSec, 'sourceVideo.durationSec')
  };
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || source.durationSec <= 0) throw new TypeError('sourceVideo must have a valid SHA and positive duration');
  if (!Array.isArray(timeline) || timeline.length === 0) throw new TypeError('timeline must cover the complete source');
  const rows = timeline.map((row, index) => normalizedRow(row, index, source.durationSec));
  const ids = new Set();
  let cursor = 0;
  for (const row of rows) {
    if (ids.has(row.id)) throw new TypeError(`duplicate timeline row id: ${row.id}`);
    ids.add(row.id);
    if (Math.abs(row.startSec - cursor) > EPSILON) throw new TypeError(`timeline is not gapless at ${cursor} seconds`);
    cursor = row.endSec;
  }
  if (Math.abs(cursor - source.durationSec) > EPSILON) throw new TypeError('timeline does not cover the full source duration');

  const rawPackages = rows.filter(row => row.shotClass === 'aroll_speaking_lead').flatMap(splitArollRow);
  if (rawPackages.length === 0) throw new TypeError('timeline contains no speaking-lead A-roll');
  const packages = mergeCompatible(rawPackages).map((item, index) => ({
    id: `AR${String(index + 1).padStart(3, '0')}`,
    startSec: item.startSec,
    endSec: item.endSec,
    durationSec: Math.round((item.endSec - item.startSec) * 1000) / 1000,
    contentClass: 'aroll',
    containsBroll: false,
    continuousTakeId: item.continuousTakeId,
    continuousTakeComplete: true,
    transcript: item.spokenLines.join(' ').replace(/\s+/g, ' ').trim(),
    expectedFaceCount: item.expectedFaceCount,
    sourceRowIds: item.sourceRowIds,
    boundaryEvidence: item.boundaryEvidence
  }));
  const ledger = {
    schemaVersion: 1,
    kind: 'koc_source_ledger',
    projectId: normalizedProjectId,
    sourceVideo: source,
    timeline: rows,
    arollSegments: packages,
    inventoryAudit: {
      status: 'PASS',
      sourceVideoSha256: source.sha256,
      fullTimelineCovered: true,
      allArollRangesAccountedFor: true,
      brollRangesExcluded: true,
      totalTimelineRows: rows.length,
      arollPackageCount: packages.length
    }
  };
  const auditSha256 = sha256Json(ledger);
  return { ...ledger, inventoryAudit: { ...ledger.inventoryAudit, auditSha256 }, fingerprintSha256: sha256Json({ ...ledger, auditSha256 }) };
}
