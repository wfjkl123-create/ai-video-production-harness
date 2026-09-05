import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function acquireStudioServerLease(root, options = {}) {
  const directory = resolve(root);
  const path = join(directory, '.studio-server-lease.sqlite');
  const pid = options.pid ?? process.pid;
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS lease_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    database.close();
    if (String(error?.code ?? '').includes('BUSY') || /locked/i.test(error?.message ?? '')) {
      throw new Error('another Harness Studio server is already using this team state');
    }
    throw error;
  }
  database.prepare('INSERT OR REPLACE INTO lease_metadata (key, value) VALUES (?, ?)').run('owner', JSON.stringify({ pid, createdAt: new Date().toISOString() }));
  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      try { database.exec('ROLLBACK'); }
      finally { database.close(); }
    }
  };
}
