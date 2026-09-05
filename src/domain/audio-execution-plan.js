export const AUDIO_STRATEGIES = Object.freeze([
  'preserve_source_audio_exact',
  'native_generate',
  'reference_guided',
  'external_remux',
  'silent_visual_test'
]);

const SHA256 = /^[a-f0-9]{64}$/;

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

export function assertApprovedSourceAudio(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('approvedSourceAudio must be an object');
  for (const field of ['artifactId', 'sha256', 'elementaryStreamSha256', 'codec', 'timeBase']) text(value[field], `approvedSourceAudio.${field}`);
  if (!SHA256.test(value.sha256) || !SHA256.test(value.elementaryStreamSha256)) throw new TypeError('approvedSourceAudio hashes must be lowercase SHA-256');
  if (!Number.isFinite(value.startPts) || !Number.isFinite(value.durationSec) || value.durationSec <= 0) throw new TypeError('approvedSourceAudio requires numeric startPts and positive durationSec');
  return value;
}

export function assertAudioExecutionPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('audio execution plan must be an object');
  if (value.kind !== 'audio_execution_plan_v1' || value.version !== 1) throw new TypeError('audio execution plan v1 is required');
  if (!AUDIO_STRATEGIES.includes(value.strategy)) throw new TypeError('unsupported audio strategy');
  if (typeof value.generateAudio !== 'boolean' || typeof value.enableSound !== 'boolean') throw new TypeError('audio execution plan must declare generateAudio and enableSound');
  if (value.generateAudio !== value.enableSound) throw new Error('generateAudio and enableSound must resolve to the same node behavior');
  text(value.syncAuthority, 'syncAuthority');
  text(value.rationale, 'rationale');
  if (!value.promptPolicy || !Array.isArray(value.promptPolicy.allowedAudibleFacts) || !Array.isArray(value.promptPolicy.prohibitedClaims)) throw new TypeError('promptPolicy arrays are required');
  if (!value.remux || typeof value.remux.required !== 'boolean') throw new TypeError('remux contract is required');
  if (value.remux.required) text(value.remux.mode, 'remux.mode');
  if (['preserve_source_audio_exact', 'reference_guided', 'external_remux'].includes(value.strategy)) assertApprovedSourceAudio(value.approvedSourceAudio);
  if (value.strategy === 'native_generate' && !value.generateAudio) throw new Error('native_generate requires generated audio');
  if (value.strategy !== 'native_generate' && value.generateAudio) throw new Error(`${value.strategy} must disable generated audio`);
  if (value.strategy === 'preserve_source_audio_exact' && value.remux.required && value.remux.mode !== 'stream_copy') throw new Error('exact source audio remux must use stream_copy');
  return value;
}
