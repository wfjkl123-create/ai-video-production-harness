import { createHash } from 'node:crypto';

export const CANONICAL_PROMPT_SOURCE_KIND = 'canonical_prompt_source_v1';
export const CANONICAL_PROMPT_SKILL_ID = 'seedance2-prompt';
export const CANONICAL_PROMPT_SKILL_ROOT = process.env.HARNESS_CANONICAL_PROMPT_SKILL_ROOT ?? '';

export function canonicalPromptSkillRoot() {
  if (!CANONICAL_PROMPT_SKILL_ROOT) {
    throw new Error('HARNESS_CANONICAL_PROMPT_SKILL_ROOT must point to the approved prompt Skill directory');
  }
  return CANONICAL_PROMPT_SKILL_ROOT;
}

const SHA256 = /^[a-f0-9]{64}$/;

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function sha(value, field) {
  if (!SHA256.test(value ?? '')) throw new TypeError(`${field} must be a lowercase SHA-256`);
  return value;
}

function binding(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  text(value.id, `${field}.id`);
  sha(value.sha256, `${field}.sha256`);
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError(`${field}.revision must be a positive integer`);
  return value;
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertCanonicalPromptSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('canonical prompt source must be an object');
  if (value.kind !== CANONICAL_PROMPT_SOURCE_KIND) throw new TypeError(`kind must be ${CANONICAL_PROMPT_SOURCE_KIND}`);
  text(value.id, 'id');
  text(value.projectId, 'projectId');
  text(value.segmentId, 'segmentId');
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError('revision must be a positive integer');
  if (value.skillId !== CANONICAL_PROMPT_SKILL_ID) throw new TypeError(`skillId must be ${CANONICAL_PROMPT_SKILL_ID}`);
  if (value.skillRoot !== canonicalPromptSkillRoot()) throw new TypeError('skillRoot must be the configured canonical Seedance prompt Skill');
  sha(value.skillTreeSha256, 'skillTreeSha256');
  binding(value.sourcePrompt, 'sourcePrompt');
  if (!Array.isArray(value.inputIrBindings) || value.inputIrBindings.length === 0) throw new TypeError('inputIrBindings must be non-empty');
  value.inputIrBindings.forEach((item, index) => binding(item, `inputIrBindings[${index}]`));
  if (!Array.isArray(value.lockedAssetBindings)) throw new TypeError('lockedAssetBindings must be an array');
  value.lockedAssetBindings.forEach((item, index) => binding(item, `lockedAssetBindings[${index}]`));
  if (!Array.isArray(value.loadedReferences) || value.loadedReferences.length === 0) throw new TypeError('loadedReferences must be non-empty');
  for (const [index, reference] of value.loadedReferences.entries()) {
    text(reference.path, `loadedReferences[${index}].path`);
    sha(reference.sha256, `loadedReferences[${index}].sha256`);
  }
  if (!value.authorEvent || typeof value.authorEvent !== 'object' || Array.isArray(value.authorEvent)) throw new TypeError('authorEvent must be an object');
  text(value.authorEvent.id, 'authorEvent.id');
  if (value.authorEvent.route !== 'canonical_skill_author_service') throw new TypeError('authorEvent.route must be canonical_skill_author_service');
  if (value.authorEvent.skillId !== CANONICAL_PROMPT_SKILL_ID) throw new TypeError(`authorEvent.skillId must be ${CANONICAL_PROMPT_SKILL_ID}`);
  if (value.authorEvent.proofLevel !== 'system_route_and_byte_integrity') throw new TypeError('authorEvent.proofLevel must disclose system_route_and_byte_integrity');
  if (typeof value.authorEvent.occurredAt !== 'string' || Number.isNaN(Date.parse(value.authorEvent.occurredAt))) throw new TypeError('authorEvent.occurredAt must be a date-time');
  if (!value.authorEvent.executionEvidence || typeof value.authorEvent.executionEvidence !== 'object' || Array.isArray(value.authorEvent.executionEvidence)) {
    throw new TypeError('authorEvent.executionEvidence must be an object');
  }
  text(value.authorEvent.executionEvidence.taskId, 'authorEvent.executionEvidence.taskId');
  text(value.authorEvent.executionEvidence.outputId, 'authorEvent.executionEvidence.outputId');
  if (typeof value.authorEvent.executionEvidence.completedAt !== 'string'
    || Number.isNaN(Date.parse(value.authorEvent.executionEvidence.completedAt))) {
    throw new TypeError('authorEvent.executionEvidence.completedAt must be a date-time');
  }
  text(value.sourceBody, 'sourceBody');
  if (value.sourceBodyOrigin !== 'caller_supplied_unverified') {
    throw new TypeError('sourceBodyOrigin must disclose caller_supplied_unverified until a trusted author runner is available');
  }
  sha(value.sourceBodySha256, 'sourceBodySha256');
  if (sha256Bytes(value.sourceBody) !== value.sourceBodySha256) throw new Error('sourceBodySha256 does not match sourceBody bytes');
  sha(value.authorRequestFingerprint, 'authorRequestFingerprint');
  sha(value.provenanceFingerprint, 'provenanceFingerprint');
  return value;
}
