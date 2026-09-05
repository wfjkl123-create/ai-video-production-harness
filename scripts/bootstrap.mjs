#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repositoryRoot, '.env.example');
const target = resolve(repositoryRoot, '.env.local');
const writeEnv = process.argv.includes('--write-env');

if (!writeEnv) {
  console.log('Bootstrap is intentionally non-interactive and does not install providers or copy credentials.');
  console.log('Run `node scripts/bootstrap.mjs --write-env` to create a safe local .env.local template.');
  console.log('Then complete the provider and canonical-Skill requirements in docs/PRODUCTION-BOOTSTRAP.md.');
  process.exit(0);
}

try {
  await access(target, constants.F_OK);
  throw new Error('.env.local already exists; refusing to overwrite local configuration');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await copyFile(source, target, constants.COPYFILE_EXCL);
console.log('Created .env.local from .env.example without credentials.');
console.log('Set HARNESS_CANONICAL_PROMPT_SKILL_ROOT only after installing the approved Skill and verifying it with doctor-environment.');
