// Project IDs are also used as on-disk directory names and URL path segments.
// Keep the existing separator rules while allowing Unicode letters/numbers (for
// example, Chinese names) without permitting path separators or whitespace.
export const PROJECT_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,95}$/u;
export const PROJECT_SLUG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,191}$/u;

export function isProjectId(value) {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value);
}

export function isProjectSlug(value) {
  return typeof value === 'string' && PROJECT_SLUG_PATTERN.test(value);
}

export function assertProjectId(value, field = 'projectId') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens`);
  }
  return normalized;
}
