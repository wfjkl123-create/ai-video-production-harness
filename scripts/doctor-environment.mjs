#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = JSON.parse(await readFile(join(repositoryRoot, 'manifests', 'environment.manifest.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(repositoryRoot, 'manifests', 'skills.lock.json'), 'utf8'));
const checks = [];
const status = (id, value, message) => checks.push({ id, status: value, message });
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
const commandPasses = (command, args) => {
  const result = run(command, args);
  return result.status === 0 && !result.error;
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function skillDigest(root) {
  const rows = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === '.DS_Store' || entry.name === '__pycache__') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      if (entry.isFile()) rows.push({ path: relative(root, path).split(sep).join('/'), sha256: sha256(await readFile(path)) });
    }
  }
  await walk(root);
  return sha256(`${JSON.stringify(rows)}\n`);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const minimumNodeMajor = Number(environment.runtime?.node?.minimumMajor ?? 22);
status('environment_manifest', Number.isInteger(minimumNodeMajor) ? 'PASS' : 'FAIL', Number.isInteger(minimumNodeMajor) ? 'environment manifest is readable' : 'environment manifest has an invalid Node requirement');
status('node', nodeMajor >= minimumNodeMajor ? 'PASS' : 'FAIL', nodeMajor >= minimumNodeMajor ? `Node ${process.versions.node}` : `Node ${minimumNodeMajor} or newer is required`);
try {
  await import('node:sqlite');
  status('node_sqlite', 'PASS', 'node:sqlite is available');
} catch {
  status('node_sqlite', 'FAIL', 'node:sqlite is unavailable');
}

const ffmpegFilters = run('ffmpeg', ['-hide_banner', '-filters']);
const ffmpegEncoders = run('ffmpeg', ['-hide_banner', '-encoders']);
const ffmpegMuxers = run('ffmpeg', ['-hide_banner', '-muxers']);
const ffmpegAvailable = ffmpegFilters.status === 0 && !ffmpegFilters.error;
status('ffmpeg', ffmpegAvailable ? 'PASS' : 'FAIL', ffmpegAvailable ? 'ffmpeg is available' : 'ffmpeg is unavailable');
for (const [id, output, capability] of [
  ['ffmpeg_filter_xstack', ffmpegFilters.stdout, 'xstack'],
  ['ffmpeg_filter_signalstats', ffmpegFilters.stdout, 'signalstats'],
  ['ffmpeg_encoder_libx264', ffmpegEncoders.stdout, 'libx264'],
  ['ffmpeg_encoder_aac', ffmpegEncoders.stdout, 'aac'],
  ['ffmpeg_muxer_framemd5', ffmpegMuxers.stdout, 'framemd5']
]) {
  const available = String(output ?? '').includes(capability);
  status(id, available ? 'PASS' : 'FAIL', available ? `${capability} is available` : `${capability} is unavailable`);
}
status('ffprobe', commandPasses(process.env.HARNESS_FFPROBE_EXECUTABLE ?? 'ffprobe', ['-version']) ? 'PASS' : 'FAIL', 'ffprobe availability checked');

const libtv = process.env.HARNESS_LIBTV_EXECUTABLE ?? 'libtv';
const libtvSpec = manifest.skills.find(skill => skill.id === 'libtv-cli');
const libtvResult = run(libtv, ['--version']);
const libtvVersion = libtvResult.status === 0 && !libtvResult.error;
const libtvMatches = libtvVersion && (!libtvSpec?.expectedVersion || String(libtvResult.stdout ?? '').trim() === libtvSpec.expectedVersion);
status('libtv_cli', libtvMatches ? 'PASS' : 'FAIL', !libtvVersion ? 'official libtv CLI is unavailable' : libtvMatches ? `official libtv CLI ${String(libtvResult.stdout).trim()} is available` : `libtv version does not match required ${libtvSpec.expectedVersion}`);
if (libtvVersion) status('libtv_account', commandPasses(libtv, ['account', 'info']) ? 'PASS' : 'FAIL', 'account authentication checked without displaying account data');

const ocxAvailable = commandPasses('ocx', ['--version']);
status('opencodex', ocxAvailable ? 'PASS' : 'WARN', ocxAvailable ? 'ocx is available; configure an approved audit/director route separately' : 'ocx unavailable; director and independent-audit routes are disabled');
status('runninghub_key', process.env.RUNNINGHUB_API_KEY ? 'CONFIGURED' : 'OPTIONAL', process.env.RUNNINGHUB_API_KEY ? 'key is configured without displaying it' : 'optional RunningHub route is not configured');

for (const skill of manifest.skills) {
  if (skill.status === 'bundled' || skill.status === 'bundled_author_owned_license_required') {
    const root = resolve(repositoryRoot, skill.path);
    try {
      for (const file of skill.requiredFiles ?? ['SKILL.md']) await access(join(root, file), constants.R_OK);
      const digest = await skillDigest(root);
      const valid = typeof skill.treeSha256 === 'string' && digest === skill.treeSha256;
      const licensed = skill.status !== 'bundled_author_owned_license_required';
      status(`skill_${skill.id}`, valid && licensed ? 'PASS' : 'FAIL', !valid ? `${skill.id} does not match its locked tree` : licensed ? `${skill.id} matches locked tree ${digest.slice(0, 12)}` : `${skill.id} is bundled but has no public reuse license`);
    } catch {
      status(`skill_${skill.id}`, 'FAIL', `${skill.id} is missing or unreadable`);
    }
  } else if (skill.status === 'required_not_bundled') {
    const configured = skill.id === 'seedance2-prompt' ? process.env.HARNESS_CANONICAL_PROMPT_SKILL_ROOT : null;
    if (configured) {
      try {
        for (const file of skill.requiredFiles ?? ['SKILL.md']) await access(join(resolve(configured), file), constants.R_OK);
        const digest = await skillDigest(resolve(configured));
        const valid = typeof skill.treeSha256 === 'string' && digest === skill.treeSha256;
        status(`skill_${skill.id}`, valid ? 'PASS' : 'FAIL', valid ? `${skill.id} matches locked tree ${digest.slice(0, 12)}` : `${skill.id} does not match its locked tree`);
      } catch {
        status(`skill_${skill.id}`, 'FAIL', `${skill.id} path is configured but invalid`);
      }
    } else status(`skill_${skill.id}`, 'FAIL', `${skill.id} is required but not bundled: ${skill.reason}`);
  } else if (skill.status === 'provider_cli_external' && skill.id === 'libtv-cli') {
    status(`provider_${skill.id}`, libtvMatches ? 'PASS' : 'FAIL', libtvMatches ? `provider CLI satisfies ${skill.expectedVersion}` : `${skill.id}: ${skill.reason}`);
  } else status(`skill_${skill.id}`, 'FAIL', `${skill.id}: ${skill.reason}`);
}

console.table(checks);
const failed = checks.filter(item => item.status === 'FAIL');
console.log(JSON.stringify({ status: failed.length ? 'FAIL' : 'PASS', failed: failed.map(item => item.id) }, null, 2));
process.exitCode = failed.length ? 1 : 0;
