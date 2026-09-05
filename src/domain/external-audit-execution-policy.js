const REQUIRED_CAPABILITIES = ['max_output_tokens', 'max_turns'];

function positive(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive finite number`);
}

export function computeWorstCaseAuditUsd(policy) {
  return policy.maxTurns * (
    (policy.maxInputTokensPerTurn * policy.pricing.inputUsdPerMillion)
    + (policy.maxOutputTokensPerTurn * policy.pricing.outputUsdPerMillion)
  ) / 1_000_000;
}

export function computeWorstCaseAuditCredits(policy) {
  return policy.maxTurns * (
    (policy.maxInputTokensPerTurn * policy.pricing.inputCreditsPerMillion)
    + (policy.maxOutputTokensPerTurn * policy.pricing.outputCreditsPerMillion)
  ) / 1_000_000;
}

export function computeUsageDerivedAuditCredits(usage, policy) {
  const inputTokens = Number(usage?.input_tokens);
  const outputTokens = Number(usage?.output_tokens);
  if (!Number.isFinite(inputTokens) || inputTokens < 0 || !Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new TypeError('usage must include non-negative input_tokens and output_tokens');
  }
  return (
    (inputTokens * policy.pricing.inputCreditsPerMillion)
    + (outputTokens * policy.pricing.outputCreditsPerMillion)
  ) / 1_000_000;
}

export function assertExternalAuditExecutionPolicy(value, approvedLimitUsd) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('executionPolicy must be an object');
  if (value.costEvidenceRequired !== 'actual_billed_usd') throw new Error('executionPolicy must require actual_billed_usd evidence');
  for (const field of ['maxTurns', 'maxInputTokensPerTurn', 'maxOutputTokensPerTurn']) {
    if (!Number.isInteger(value[field]) || value[field] < 1) throw new TypeError(`executionPolicy.${field} must be a positive integer`);
  }
  if (!Array.isArray(value.requiredExecutorCapabilities)
    || JSON.stringify([...value.requiredExecutorCapabilities].sort()) !== JSON.stringify(REQUIRED_CAPABILITIES)) {
    throw new Error(`executionPolicy.requiredExecutorCapabilities must be exactly ${REQUIRED_CAPABILITIES.join(', ')}`);
  }
  if (!value.pricing || typeof value.pricing !== 'object' || Array.isArray(value.pricing)) throw new TypeError('executionPolicy.pricing must be an object');
  positive(value.pricing.inputUsdPerMillion, 'executionPolicy.pricing.inputUsdPerMillion');
  positive(value.pricing.outputUsdPerMillion, 'executionPolicy.pricing.outputUsdPerMillion');
  if (value.pricing.unit !== 'USD_per_million_tokens') throw new Error('executionPolicy.pricing.unit must be USD_per_million_tokens');
  if (typeof value.pricing.source !== 'string' || value.pricing.source.trim() === '') throw new TypeError('executionPolicy.pricing.source must be a non-empty string');
  if (typeof value.pricing.verifiedAt !== 'string' || Number.isNaN(Date.parse(value.pricing.verifiedAt))) throw new TypeError('executionPolicy.pricing.verifiedAt must be a date-time');
  positive(value.worstCaseUsd, 'executionPolicy.worstCaseUsd');
  const computed = computeWorstCaseAuditUsd(value);
  if (Math.abs(computed - value.worstCaseUsd) > 1e-9) throw new Error('executionPolicy.worstCaseUsd does not match the machine calculation');
  if (!Number.isFinite(approvedLimitUsd) || computed > approvedLimitUsd) throw new Error('executionPolicy worst-case USD exposure exceeds the approved per-call limit');
  return value;
}

export function assertExternalAuditCreditsExecutionPolicy(value, approvedLimitCredits) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('executionPolicy must be an object');
  if (!['actual_consumed_credits', 'usage_derived_consumed_credits'].includes(value.costEvidenceRequired)) {
    throw new Error('CREDITS executionPolicy must require actual_consumed_credits or usage_derived_consumed_credits evidence');
  }
  for (const field of ['maxTurns', 'maxInputTokensPerTurn', 'maxOutputTokensPerTurn']) {
    if (!Number.isInteger(value[field]) || value[field] < 1) throw new TypeError(`executionPolicy.${field} must be a positive integer`);
  }
  if (!Array.isArray(value.requiredExecutorCapabilities)
    || JSON.stringify([...value.requiredExecutorCapabilities].sort()) !== JSON.stringify(REQUIRED_CAPABILITIES)) {
    throw new Error(`executionPolicy.requiredExecutorCapabilities must be exactly ${REQUIRED_CAPABILITIES.join(', ')}`);
  }
  if (!value.pricing || typeof value.pricing !== 'object' || Array.isArray(value.pricing)) throw new TypeError('executionPolicy.pricing must be an object');
  positive(value.pricing.inputCreditsPerMillion, 'executionPolicy.pricing.inputCreditsPerMillion');
  positive(value.pricing.outputCreditsPerMillion, 'executionPolicy.pricing.outputCreditsPerMillion');
  if (value.pricing.unit !== 'CREDITS_per_million_tokens') throw new Error('CREDITS executionPolicy.pricing.unit must be CREDITS_per_million_tokens');
  if (typeof value.pricing.source !== 'string' || value.pricing.source.trim() === '') throw new TypeError('executionPolicy.pricing.source must be a non-empty string');
  if (typeof value.pricing.verifiedAt !== 'string' || Number.isNaN(Date.parse(value.pricing.verifiedAt))) throw new TypeError('executionPolicy.pricing.verifiedAt must be a date-time');
  positive(value.worstCaseCredits, 'executionPolicy.worstCaseCredits');
  const computed = computeWorstCaseAuditCredits(value);
  if (Math.abs(computed - value.worstCaseCredits) > 1e-9) throw new Error('executionPolicy.worstCaseCredits does not match the machine calculation');
  if (!Number.isFinite(approvedLimitCredits) || computed > approvedLimitCredits) throw new Error('executionPolicy worst-case Credits exposure exceeds the approved per-call limit');
  return value;
}
