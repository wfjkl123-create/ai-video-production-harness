import { createHash } from 'node:crypto';

const STRATEGIES = new Set(['single_take', 'platform_multi_shot', 'segmented_editorial']);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function count(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 40) throw new TypeError(`${field} must be an integer between 1 and 40`);
  return value;
}

export function assertExecutionControlContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new TypeError('executionControlContract version 1 is required');
  }
  count(value.plannedShotCount, 'executionControlContract.plannedShotCount');
  count(value.generatedUnitShotCount, 'executionControlContract.generatedUnitShotCount');
  if (value.generatedUnitShotCount > value.plannedShotCount) throw new Error('generatedUnitShotCount cannot exceed plannedShotCount');
  if (!STRATEGIES.has(value.executionUnitStrategy)) throw new TypeError('executionControlContract.executionUnitStrategy is invalid');
  if (typeof value.requiresIndependentShotControl !== 'boolean') throw new TypeError('requiresIndependentShotControl must be boolean');
  const capability = value.platformCapability;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) throw new TypeError('executionControlContract.platformCapability is required');
  for (const field of ['surface', 'profileId', 'parameter', 'evidence']) text(capability[field], `platformCapability.${field}`);
  if (typeof capability.exposed !== 'boolean' || typeof capability.enabled !== 'boolean') {
    throw new TypeError('platformCapability.exposed and enabled must be boolean');
  }

  if (value.executionUnitStrategy === 'single_take') {
    if (value.plannedShotCount !== 1 || value.generatedUnitShotCount !== 1 || value.requiresIndependentShotControl) {
      throw new Error('single_take can cover exactly one planned shot and cannot claim independent multi-shot control');
    }
  }
  if (value.executionUnitStrategy === 'segmented_editorial' && value.generatedUnitShotCount !== 1) {
    throw new Error('segmented_editorial must generate one shot per paid execution unit and join shots in editing');
  }
  if (value.executionUnitStrategy === 'platform_multi_shot') {
    if (value.generatedUnitShotCount < 2 || !value.requiresIndependentShotControl) {
      throw new Error('platform_multi_shot requires at least two independently controlled shots');
    }
    if (capability.parameter !== 'multi_shots' || capability.exposed !== true || capability.enabled !== true) {
      throw new Error('platform_multi_shot requires exact readback that multi_shots is exposed and enabled');
    }
    if (capability.verificationMode !== 'libtv_canvas_node_readback') {
      throw new Error('platform_multi_shot requires LibTV canvas-node write/readback verification');
    }
  }
  if (value.generatedUnitShotCount > 1 && value.executionUnitStrategy !== 'platform_multi_shot') {
    throw new Error('a paid generation unit containing multiple planned shots requires verified platform_multi_shot control');
  }
  return value;
}

export function executionControlFingerprint(value) {
  const contract = assertExecutionControlContract(value);
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}
