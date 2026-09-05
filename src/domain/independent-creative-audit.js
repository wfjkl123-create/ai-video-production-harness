function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function requireSha(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

function assertMediaList(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`${field}[${index}] must be an object`);
    requireText(item.id, `${field}[${index}].id`);
    requireText(item.path, `${field}[${index}].path`);
    requireSha(item.sha256, `${field}[${index}].sha256`);
  }
}

export function assertIndependentCreativeAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('independent creative audit must be an object');
  requireText(value.id, 'id');
  if (value.kind !== 'independent_creative_audit') throw new TypeError('kind must be independent_creative_audit');
  requireText(value.segmentId, 'segmentId');
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError('revision must be a positive integer');
  if (!['PASS', 'FAIL'].includes(value.decision)) throw new TypeError('decision must be PASS or FAIL');
  if (value.agentContextMode !== 'clean_zero_context') throw new TypeError('agentContextMode must be clean_zero_context');
  requireText(value.agentTaskId, 'agentTaskId');
  requireText(value.sourceRange, 'sourceRange');
  requireText(value.reportPath, 'reportPath');
  requireSha(value.reportSha256, 'reportSha256');
  requireSha(value.promptSha256, 'promptSha256');
  requireSha(value.packageSha256, 'packageSha256');
  if (!value.inputMedia || typeof value.inputMedia !== 'object' || Array.isArray(value.inputMedia)) throw new TypeError('inputMedia must be an object');
  assertMediaList(value.inputMedia.images, 'inputMedia.images');
  assertMediaList(value.inputMedia.videos, 'inputMedia.videos');
  assertMediaList(value.inputMedia.audio, 'inputMedia.audio');
  for (const field of ['blockerCount', 'importantCount']) {
    if (!Number.isInteger(value[field]) || value[field] < 0) throw new TypeError(`${field} must be a non-negative integer`);
  }
  requireText(value.reviewedAt, 'reviewedAt');
  if (Number.isNaN(Date.parse(value.reviewedAt))) throw new TypeError('reviewedAt must be a date-time');
  return value;
}
