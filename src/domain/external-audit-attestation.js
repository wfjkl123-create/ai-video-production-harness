const PROVIDERS = new Set(['anthropic', 'kimi', 'qwen']);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function sha(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

export function assertExternalAuditAttestation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('external audit attestation must be an object');
  text(value.id, 'id');
  if (value.kind !== 'external_audit_attestation') throw new TypeError('kind must be external_audit_attestation');
  text(value.segmentId, 'segmentId');
  if (!['pre_generation', 'post_generation'].includes(value.auditStage)) throw new TypeError('auditStage must be pre_generation or post_generation');
  if (!PROVIDERS.has(value.provider)) throw new TypeError('provider must be anthropic, kimi, or qwen');
  text(value.model, 'model');
  if (/gpt|openai/i.test(value.model)) throw new Error('GPT/OpenAI models cannot provide the required independent audit');
  text(value.providerTaskId, 'providerTaskId');
  text(value.auditRunId, 'auditRunId');
  if (value.cleanZeroContext !== true) throw new Error('cleanZeroContext must be true');
  if (!['PASS', 'FAIL'].includes(value.decision)) throw new TypeError('decision must be PASS or FAIL');
  sha(value.fingerprintSha256, 'fingerprintSha256');
  sha(value.reportSha256, 'reportSha256');
  text(value.reviewedAt, 'reviewedAt');
  if (Number.isNaN(Date.parse(value.reviewedAt))) throw new TypeError('reviewedAt must be a date-time');
  return value;
}
