import { isAbsolute, relative, resolve, sep } from 'node:path';

export function resolveProjectInput(root, value) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) throw new Error('input path must stay inside project root');
  const candidate = resolve(root, value);
  const path = relative(resolve(root), candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('input path must stay inside project root');
  return candidate;
}
