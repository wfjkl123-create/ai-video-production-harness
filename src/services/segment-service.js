const MAX_SEGMENT_DURATION = 15;
const CONTINUITY_STRATEGIES = new Set(['canonical_open', 'editorial_cut', 'continuous_proxy_handoff']);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function requireUniqueTextArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  value.forEach((item, index) => requireText(item, `${field}[${index}]`));
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates`);
}

function requireFinitePositive(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive finite number`);
}

function validateBeats(totalDuration, beats) {
  if (!Array.isArray(beats) || beats.length < 2 || beats.some((beat) => !Number.isFinite(beat))) {
    throw new TypeError('beats must be an array of at least two finite numbers');
  }
  if (beats[0] !== 0) throw new Error('beats must start at 0');
  if (beats.at(-1) !== totalDuration) throw new Error('beats must end at totalDuration');
  for (let index = 1; index < beats.length; index += 1) {
    if (beats[index] <= beats[index - 1]) throw new Error('beats must be strictly increasing');
  }
}

function boundariesFor(totalDuration, beats) {
  const boundaries = [0];
  for (let index = 1; index < beats.length; index += 1) {
    const target = beats[index];
    while (target - boundaries.at(-1) > MAX_SEGMENT_DURATION) {
      boundaries.push(boundaries.at(-1) + MAX_SEGMENT_DURATION);
    }
    if (target !== boundaries.at(-1)) boundaries.push(target);
  }
  if (boundaries.at(-1) !== totalDuration) boundaries.push(totalDuration);
  return boundaries;
}

export function proposeSegments({ totalDuration, beats }) {
  requireFinitePositive(totalDuration, 'totalDuration');
  validateBeats(totalDuration, beats);
  const boundaries = boundariesFor(totalDuration, beats);
  const segments = boundaries.slice(0, -1).map((start, index) => ({
    id: `segment-${String(index + 1).padStart(3, '0')}`,
    duration: boundaries[index + 1] - start,
    narrativeTask: `Cover story beats from ${start}s to ${boundaries[index + 1]}s`,
    startState: { at: start },
    actionNodes: beats.filter((beat) => beat > start && beat < boundaries[index + 1]),
    endState: { at: boundaries[index + 1] },
    projectAssetIds: [],
    segmentAssetRequirements: [],
    continuityStrategy: index === 0 ? 'canonical_open' : 'continuous_proxy_handoff',
    previousSegmentId: index === 0 ? null : `segment-${String(index).padStart(3, '0')}`,
    nextSegmentId: index === boundaries.length - 2 ? null : `segment-${String(index + 2).padStart(3, '0')}`,
    status: 'awaiting_review'
  }));
  return segments;
}

export function validateSegmentPlan(value) {
  const segments = Array.isArray(value) ? value : value?.segments;
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('segment spec must contain a non-empty segments array');
  const copy = structuredClone(segments);
  for (const [index, segment] of copy.entries()) {
    requireObject(segment, `segments[${index}]`);
    const expectedId = `segment-${String(index + 1).padStart(3, '0')}`;
    if (segment.id !== expectedId) throw new Error(`segments[${index}].id must be ${expectedId}`);
    requireFinitePositive(segment.duration, `${segment.id}.duration`);
    if (segment.duration > MAX_SEGMENT_DURATION) throw new Error(`${segment.id}.duration must be at most ${MAX_SEGMENT_DURATION} seconds`);
    requireText(segment.narrativeTask, `${segment.id}.narrativeTask`);
    requireObject(segment.startState, `${segment.id}.startState`);
    requireObject(segment.endState, `${segment.id}.endState`);
    if (!Array.isArray(segment.actionNodes)) throw new TypeError(`${segment.id}.actionNodes must be an array`);
    requireUniqueTextArray(segment.projectAssetIds, `${segment.id}.projectAssetIds`);
    requireUniqueTextArray(segment.segmentAssetRequirements, `${segment.id}.segmentAssetRequirements`);
    const expectedPrevious = index === 0 ? null : copy[index - 1].id;
    const expectedNext = index === copy.length - 1 ? null : `segment-${String(index + 2).padStart(3, '0')}`;
    if (segment.previousSegmentId !== expectedPrevious) throw new Error(`${segment.id}.previousSegmentId must be ${expectedPrevious ?? 'null'}`);
    if (segment.nextSegmentId !== expectedNext) throw new Error(`${segment.id}.nextSegmentId must be ${expectedNext ?? 'null'}`);
    if (segment.status !== 'awaiting_review') throw new Error(`${segment.id}.status must be awaiting_review`);
    if (segment.continuityStrategy !== undefined && !CONTINUITY_STRATEGIES.has(segment.continuityStrategy)) {
      throw new Error(`${segment.id}.continuityStrategy must be canonical_open, editorial_cut, or continuous_proxy_handoff`);
    }
  }
  return copy;
}

export function storyboardGridFor(segment) {
  const shots = Number(segment?.shots ?? 0);
  const people = Number(segment?.people ?? 0);
  if (shots >= 4 || people > 3 || segment?.complexBlocking) return 12;
  if (shots >= 3 || segment?.largeMotion || people >= 2) return 9;
  return 6;
}
