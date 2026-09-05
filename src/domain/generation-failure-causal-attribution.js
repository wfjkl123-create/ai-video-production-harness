import { assertRegisteredGenerationRootCause } from './generation-root-cause-registry.js';

const CONFIDENCE = new Set(['low', 'medium', 'high']);
const COST_CLASS = new Set(['free', 'paid_with_fresh_authorization']);
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function key(value, field) {
  text(value, field);
  if (!SAFE_KEY.test(value)) throw new TypeError(`${field} must be a safe key`);
}

function textList(value, field, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) throw new TypeError(`${field} must contain at least ${min} items`);
  value.forEach((item, index) => text(item, `${field}[${index}]`));
}

function hypothesis(value, field) {
  object(value, field);
  for (const name of ['key', 'stage', 'hypothesis', 'falsifier']) text(value[name], `${field}.${name}`);
  key(value.key, `${field}.key`);
  if (!CONFIDENCE.has(value.confidence)) throw new TypeError(`${field}.confidence is invalid`);
  textList(value.evidence, `${field}.evidence`, { min: 1 });
}

export function assertGenerationFailureCausalAttribution(value, { rootCauseKey, requireRegisteredRootCause = false } = {}) {
  object(value, 'causalAttribution');
  if (value.kind !== 'generation_failure_causal_attribution_v1' || value.version !== 1) {
    throw new TypeError('generation failure causal attribution v1 is required');
  }
  key(value.rootCauseKey, 'causalAttribution.rootCauseKey');
  if (rootCauseKey !== undefined && value.rootCauseKey !== rootCauseKey) {
    throw new Error('causalAttribution.rootCauseKey must match the failure rootCauseKey');
  }
  hypothesis(value.primary, 'causalAttribution.primary');
  if (value.primary.key !== value.rootCauseKey) throw new Error('causalAttribution.primary.key must equal rootCauseKey');
  if (requireRegisteredRootCause) assertRegisteredGenerationRootCause(value.rootCauseKey, { stage: value.primary.stage });
  if (!Array.isArray(value.contributors)) throw new TypeError('causalAttribution.contributors must be an array');
  value.contributors.forEach((item, index) => hypothesis(item, `causalAttribution.contributors[${index}]`));
  const keys = [value.primary.key, ...value.contributors.map(item => item.key)];
  if (new Set(keys).size !== keys.length) throw new TypeError('causal attribution hypothesis keys must be unique');
  textList(value.counterEvidence, 'causalAttribution.counterEvidence');
  textList(value.unknowns, 'causalAttribution.unknowns');
  object(value.nextMinimalCheck, 'causalAttribution.nextMinimalCheck');
  for (const field of ['variable', 'action', 'expectedObservation']) text(value.nextMinimalCheck[field], `causalAttribution.nextMinimalCheck.${field}`);
  if (value.nextMinimalCheck.changesOnePrimaryVariable !== true) throw new TypeError('nextMinimalCheck.changesOnePrimaryVariable must be true');
  if (!COST_CLASS.has(value.nextMinimalCheck.costClass)) throw new TypeError('nextMinimalCheck.costClass is invalid');
  if (value.promptOnlyRetryAllowed !== false) throw new TypeError('promptOnlyRetryAllowed must remain false');
  if (value.controlRouteChangeRequired !== true) throw new TypeError('controlRouteChangeRequired must remain true');
  return value;
}
