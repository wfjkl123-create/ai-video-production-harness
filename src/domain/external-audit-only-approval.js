import { assertNonGptAuditModel } from '../adapters/opencodex-audit-adapter.js';
import { assertExternalAuditCreditsExecutionPolicy, assertExternalAuditExecutionPolicy } from './external-audit-execution-policy.js';

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function sha(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

function fileBinding(value, field, { requireId = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  if (requireId) text(value.id, `${field}.id`);
  text(value.path, `${field}.path`);
  sha(value.sha256, `${field}.sha256`);
}

function mediaBindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('binding.inputMedia must be an object');
  for (const kind of ['images', 'videos', 'audio']) {
    if (!Array.isArray(value[kind])) throw new TypeError(`binding.inputMedia.${kind} must be an array`);
    value[kind].forEach((item, index) => fileBinding(item, `binding.inputMedia.${kind}[${index}]`, { requireId: true }));
  }
}

export function assertExternalAuditOnlyApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('external audit-only approval must be an object');
  text(value.id, 'id');
  if (value.kind !== 'external_audit_only_approval') throw new TypeError('kind must be external_audit_only_approval');
  if (value.actor !== 'human' || value.decision !== 'approved') throw new Error('external audit-only approval requires explicit human approval');
  text(value.projectId, 'projectId');
  text(value.segmentId, 'segmentId');
  assertNonGptAuditModel(value.model);
  if (value.maxCalls !== 1) throw new Error('external audit-only approval must authorize exactly one call');
  if (!value.budget || !['USD', 'CREDITS'].includes(value.budget.unit)) throw new TypeError('budget.unit must be USD or CREDITS');
  for (const field of ['perCallLimit', 'totalLimit']) {
    if (!Number.isFinite(value.budget[field]) || value.budget[field] <= 0) throw new TypeError(`budget.${field} must be positive`);
  }
  if (value.budget.perCallLimit > value.budget.totalLimit) throw new Error('per-call limit cannot exceed total limit');
  if (value.budget.unit === 'USD') assertExternalAuditExecutionPolicy(value.executionPolicy, value.budget.perCallLimit);
  else assertExternalAuditCreditsExecutionPolicy(value.executionPolicy, value.budget.perCallLimit);
  if (value.permissions?.readOnly !== true) throw new Error('audit-only approval must be read-only');
  for (const field of ['automaticRetries', 'imageGeneration', 'videoGeneration', 'externalMessages']) {
    if (value.permissions?.[field] !== false) throw new Error(`permissions.${field} must be false`);
  }
  if (!value.binding || typeof value.binding !== 'object' || Array.isArray(value.binding)) throw new TypeError('binding must be an object');
  fileBinding(value.binding.auditBrief, 'binding.auditBrief');
  fileBinding(value.binding.prompt, 'binding.prompt', { requireId: true });
  fileBinding(value.binding.package, 'binding.package');
  mediaBindings(value.binding.inputMedia);
  text(value.approvedAt, 'approvedAt');
  if (Number.isNaN(Date.parse(value.approvedAt))) throw new TypeError('approvedAt must be a date-time');
  return value;
}
