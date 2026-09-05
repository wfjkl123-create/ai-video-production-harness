import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJson, writeJsonAtomic } from './json-store.js';

function safeTarget(root, path) {
  const target = resolve(root, path);
  const value = relative(resolve(root), target);
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error('transaction target escapes project root');
  return target;
}

export async function recoverJsonTransactions(root) {
  const directory = join(root, '.transactions');
  const entries = await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of entries.filter(value => value.endsWith('.json') && !value.startsWith('._')).sort()) {
    const path = join(directory, name);
    const journal = await readJson(path);
    if (journal.status !== 'PENDING') continue;
    for (const write of journal.writes) await writeJsonAtomic(safeTarget(root, write.path), write.value);
    await writeJsonAtomic(path, { ...journal, status: 'COMPLETE', recoveredAt: new Date().toISOString() });
  }
}

export async function commitJsonTransaction(root, id, writes, options = {}) {
  const path = join(root, '.transactions', `${encodeURIComponent(id)}.json`);
  try {
    await readJson(path);
    throw new Error(`transaction already exists: ${id}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const normalized = writes.map(write => ({
    path: relative(resolve(root), safeTarget(root, write.path)).split(sep).join('/'),
    value: write.value
  }));
  const journal = { id, status: 'PENDING', writes: normalized, createdAt: new Date().toISOString() };
  await writeJsonAtomic(path, journal);
  for (const [index, write] of normalized.entries()) {
    await writeJsonAtomic(safeTarget(root, write.path), write.value);
    await options.afterWrite?.(index, write);
  }
  await writeJsonAtomic(path, { ...journal, status: 'COMPLETE', completedAt: new Date().toISOString() });
  return journal;
}
