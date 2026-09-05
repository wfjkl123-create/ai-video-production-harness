import { CORE_IMAGE_PROFILE_IDS, IMAGE_PROMPT_OPERATIONS } from './image-prompt-ir.js';

const RATIO_POLICIES = new Set(['native', 'prompt_only', 'verify_before_use']);
const EVIDENCE_STATUSES = new Set(['verified', 'unverified']);

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function stringList(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError(`${field} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  value.forEach((entry, index) => string(entry, `${field}[${index}]`));
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must contain unique values`);
}

export function assertImageModelProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('image model profile must be an object');
  string(value.id, 'id');
  string(value.executionSurface, 'executionSurface');
  stringList(value.supportedOperations, 'supportedOperations');
  if (value.supportedOperations.some(operation => !IMAGE_PROMPT_OPERATIONS.includes(operation))) throw new TypeError('supportedOperations contains an unknown operation');
  stringList(value.supportedProfileIds, 'supportedProfileIds');
  if (value.supportedProfileIds.some(id => id !== '*' && !CORE_IMAGE_PROFILE_IDS.includes(id))) throw new TypeError('supportedProfileIds contains an unknown profile');
  stringList(value.supportedAspectRatios, 'supportedAspectRatios', { allowEmpty: true });
  stringList(value.qualityOptions, 'qualityOptions', { allowEmpty: true });
  if (!Number.isInteger(value.maxInputImages) || value.maxInputImages < 0) throw new TypeError('maxInputImages must be a non-negative integer');
  if (!RATIO_POLICIES.has(value.ratioPolicy)) throw new TypeError('ratioPolicy must be native, prompt_only, or verify_before_use');
  if (!EVIDENCE_STATUSES.has(value.evidenceStatus)) throw new TypeError('evidenceStatus must be verified or unverified');
  if (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)) throw new TypeError('evidence must be an object');
  string(value.evidence.source, 'evidence.source');
  string(value.evidence.scope, 'evidence.scope');
  string(value.evidence.notes, 'evidence.notes');
  string(value.updatedAt, 'updatedAt');
  if (Number.isNaN(Date.parse(value.updatedAt))) throw new TypeError('updatedAt must be a date-time');
  return value;
}

export function assertModelSupportsImagePrompt(profile, ir) {
  assertImageModelProfile(profile);
  if (!profile.supportedOperations.includes(ir.operation)) throw new Error(`model profile ${profile.id} does not support operation ${ir.operation}`);
  if (!profile.supportedProfileIds.includes('*') && !profile.supportedProfileIds.includes(ir.profileId)) throw new Error(`model profile ${profile.id} does not support profile ${ir.profileId}`);
  if (ir.inputBindings.length > profile.maxInputImages) throw new Error(`model profile ${profile.id} supports at most ${profile.maxInputImages} input images`);
  const ratio = ir.outputSpec.aspectRatio;
  if (ratio && !profile.supportedAspectRatios.includes(ratio) && profile.ratioPolicy !== 'prompt_only') throw new Error(`aspect ratio ${ratio} is not verified for model profile ${profile.id}`);
  const quality = ir.outputSpec.quality;
  if (quality && !profile.qualityOptions.includes(quality)) throw new Error(`quality ${quality} is not supported by model profile ${profile.id}`);
  if (profile.evidenceStatus !== 'verified') throw new Error(`model profile ${profile.id} is unverified and cannot be used for generation planning`);
  return true;
}
