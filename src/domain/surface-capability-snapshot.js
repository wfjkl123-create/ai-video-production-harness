const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITIES = Object.freeze([
  'generatedAudio', 'disableGeneratedAudio', 'audioReference',
  'sourceAudioPreservation', 'streamCopyRemux', 'multiShots'
]);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function timestamp(value, field) {
  text(value, field);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be a date-time`);
  return value;
}

export function assertSurfaceCapabilitySnapshot(value, { now = Date.now(), requireFresh = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('surface capability snapshot must be an object');
  if (value.kind !== 'surface_capability_snapshot_v1' || value.version !== 1) throw new TypeError('surface capability snapshot v1 is required');
  for (const field of ['id', 'surface', 'model', 'operation']) text(value[field], field);
  timestamp(value.capturedAt, 'capturedAt');
  timestamp(value.expiresAt, 'expiresAt');
  if (Date.parse(value.expiresAt) <= Date.parse(value.capturedAt)) throw new TypeError('expiresAt must be after capturedAt');
  if (requireFresh && Date.parse(value.expiresAt) <= Number(now)) {
    const error = new Error('surface capability snapshot is stale; refresh the actual control-surface readback');
    error.code = 'STALE_SURFACE_CAPABILITY_SNAPSHOT';
    throw error;
  }
  if (!value.capabilities || typeof value.capabilities !== 'object' || Array.isArray(value.capabilities)) throw new TypeError('capabilities must be an object');
  for (const capability of CAPABILITIES) {
    if (typeof value.capabilities[capability] !== 'boolean') throw new TypeError(`capabilities.${capability} must be boolean`);
  }
  if (!value.rawReadback || typeof value.rawReadback !== 'object' || Array.isArray(value.rawReadback)) throw new TypeError('rawReadback must be an object');
  text(value.rawReadback.artifactId, 'rawReadback.artifactId');
  if (!SHA256.test(value.rawReadback.sha256 ?? '')) throw new TypeError('rawReadback.sha256 must be a lowercase SHA-256');
  text(value.rawReadback.observedFields, 'rawReadback.observedFields');
  return value;
}

export function assertCapabilitySnapshotBinding(binding, snapshot) {
  if (!binding || typeof binding !== 'object') throw new TypeError('surface capability snapshot binding must be an object');
  if (binding.id !== snapshot.id || binding.sha256 !== snapshot.sha256) throw new Error('surface capability snapshot binding is stale');
  return binding;
}
