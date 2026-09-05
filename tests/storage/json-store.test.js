import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';

test('writeJsonAtomic persists parseable JSON and readJson restores it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-store-'));
  const file = join(dir, 'state.json');
  await writeJsonAtomic(file, { status: 'draft', revision: 1 });
  assert.deepEqual(await readJson(file), { status: 'draft', revision: 1 });
  assert.match(await readFile(file, 'utf8'), /"revision": 1/);
});

test('writeJsonAtomic supports concurrent writes to the same path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-concurrent-store-'));
  const file = join(dir, 'state.json');
  const values = Array.from({ length: 20 }, (_, revision) => ({ revision }));
  await Promise.all(values.map(value => writeJsonAtomic(file, value)));
  const stored = await readJson(file);
  assert.ok(values.some(value => value.revision === stored.revision));
});

test('sha256File returns SHA-256 evidence for a local file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-checksum-'));
  const file = join(dir, 'evidence.txt');
  await writeFile(file, 'harness');
  assert.equal(await sha256File(file), '49f756463ad9dcfb9b6ade54d7d6f15476e7214f46a65b4b0c55d46845b12f70');
});
