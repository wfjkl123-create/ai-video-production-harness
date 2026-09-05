import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { sha256File } from '../storage/checksum.js';
import { writeJsonAtomic } from '../storage/json-store.js';

const EPSILON = 0.002;

function inside(root, path, label) {
  const actual = resolve(root, path);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error(`${label} must stay inside the project`);
  return actual;
}

function defaultRunner(executable, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolveResult({ stdout, stderr })
      : reject(new Error(`${executable} failed: ${(stderr || stdout).trim()}`)));
  });
}

async function boundedMap(items, limit, worker) {
  const values = new Array(items.length);
  let cursor = 0;
  let failure = null;
  async function consume() {
    while (!failure) {
      const index = cursor++;
      if (index >= items.length) return;
      try { values[index] = await worker(items[index], index); } catch (error) { failure = error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  if (failure) throw failure;
  return values;
}

function rate(value) {
  const [top, bottom] = String(value ?? '0/0').split('/').map(Number);
  return bottom > 0 ? top / bottom : 0;
}

function validateInventory(input) {
  const ledger = input.ledger;
  if (!ledger || ledger.kind !== 'koc_source_ledger' || ledger.inventoryAudit?.status !== 'PASS'
    || ledger.inventoryAudit?.fullTimelineCovered !== true || ledger.inventoryAudit?.allArollRangesAccountedFor !== true
    || ledger.inventoryAudit?.brollRangesExcluded !== true || !Array.isArray(ledger.arollSegments)) {
    throw new Error('reinsertion requires the complete audited KOC source ledger');
  }
  return ledger;
}

function flattenParts(input, ledger, root) {
  if (!Array.isArray(input.replacements)) throw new Error('replacements must be an array');
  const bySegment = new Map();
  for (const entry of input.replacements) {
    if (!entry || typeof entry.segmentId !== 'string' || bySegment.has(entry.segmentId)) throw new Error('replacement segment IDs must be unique');
    bySegment.set(entry.segmentId, entry);
  }
  const known = new Set(ledger.arollSegments.map(segment => segment.id));
  for (const id of bySegment.keys()) if (!known.has(id)) throw new Error(`replacement targets unknown A-roll segment ${id}`);
  const parts = [];
  for (const segment of ledger.arollSegments) {
    const entry = bySegment.get(segment.id);
    if (!entry || entry.finalDisposition !== 'accepted_for_reinsertion' || !Array.isArray(entry.parts) || entry.parts.length === 0) {
      throw new Error(`${segment.id} has no accepted generated coverage`);
    }
    const ordered = [...entry.parts].sort((left, right) => left.sourceStartSec - right.sourceStartSec);
    let cursor = segment.startSec;
    for (const [index, part] of ordered.entries()) {
      if (Math.abs(part.sourceStartSec - cursor) > EPSILON || part.sourceEndSec <= part.sourceStartSec
        || part.sourceEndSec > segment.endSec + EPSILON) throw new Error(`${segment.id} replacement parts do not cover the source range without gaps`);
      if (!Number.isFinite(part.generatedStartSec) || !Number.isFinite(part.generatedEndSec)
        || part.generatedStartSec < 0 || part.generatedEndSec <= part.generatedStartSec) throw new Error(`${segment.id} has an invalid generated subrange`);
      const sourceDuration = part.sourceEndSec - part.sourceStartSec;
      const generatedDuration = part.generatedEndSec - part.generatedStartSec;
      if (generatedDuration + EPSILON < sourceDuration) throw new Error(`${segment.id} generated subrange is shorter than its source coverage`);
      parts.push({
        kind: 'replacement', id: `${segment.id}-P${String(index + 1).padStart(2, '0')}`, segmentId: segment.id,
        startSec: part.sourceStartSec, endSec: part.sourceEndSec,
        generatedStartSec: part.generatedStartSec, generatedEndSec: part.generatedEndSec,
        inputPath: inside(root, part.path ?? '', `${segment.id} generated path`), expectedSha256: part.sha256
      });
      cursor = part.sourceEndSec;
    }
    if (Math.abs(cursor - segment.endSec) > EPSILON) throw new Error(`${segment.id} replacement coverage is incomplete`);
  }
  return parts.sort((left, right) => left.startSec - right.startSec);
}

function timelinePieces(parts, durationSec) {
  const pieces = [];
  let cursor = 0;
  let gapIndex = 0;
  for (const part of parts) {
    if (part.startSec < cursor - EPSILON) throw new Error('replacement source ranges overlap');
    if (part.startSec > cursor + EPSILON) pieces.push({ kind: 'source', id: `SOURCE-GAP-${String(++gapIndex).padStart(3, '0')}`, startSec: cursor, endSec: part.startSec });
    pieces.push(part);
    cursor = part.endSec;
  }
  if (cursor < durationSec - EPSILON) pieces.push({ kind: 'source', id: `SOURCE-GAP-${String(++gapIndex).padStart(3, '0')}`, startSec: cursor, endSec: durationSec });
  if (cursor > durationSec + EPSILON) throw new Error('replacement range exceeds source duration');
  return pieces;
}

export async function buildKocReinsertionPlan(root, input, options = {}) {
  root = resolve(root);
  if (!input || input.schemaVersion !== 1 || input.kind !== 'koc_reinsertion_job') throw new Error('invalid KOC reinsertion job');
  const ledger = validateInventory(input);
  if (input.projectId !== ledger.projectId) throw new Error('reinsertion projectId does not match the ledger');
  const sourcePath = inside(root, input.sourceVideo?.path ?? '', 'sourceVideo.path');
  await access(sourcePath, constants.R_OK);
  const sourceSha256 = await sha256File(sourcePath);
  if (sourceSha256 !== input.sourceVideo.sha256 || sourceSha256 !== ledger.sourceVideo.sha256) throw new Error('reinsertion source SHA mismatch');
  const runner = options.runner ?? defaultRunner;
  const probe = JSON.parse((await runner('ffprobe', [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', sourcePath
  ], { cwd: root })).stdout);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audios = probe.streams?.filter(stream => stream.codec_type === 'audio') ?? [];
  const fps = rate(video?.avg_frame_rate);
  const durationSec = Number(probe.format?.duration);
  if (!video || audios.length < 1 || fps <= 0 || durationSec <= 0) throw new Error('source must contain valid video and original audio');
  if (Math.abs(durationSec - ledger.sourceVideo.durationSec) > Math.max(0.05, 1 / fps)) throw new Error('source duration differs from the audited ledger');
  const parts = flattenParts(input, ledger, root);
  for (const part of parts) {
    await access(part.inputPath, constants.R_OK);
    if (await sha256File(part.inputPath) !== part.expectedSha256) throw new Error(`${part.id} generated SHA mismatch`);
  }
  const pieces = timelinePieces(parts, durationSec);
  const vertical = Number(video.height) >= Number(video.width);
  const target = vertical ? { width: 480, height: 854 } : { width: 854, height: 480 };
  const workDirectory = inside(root, input.workDirectory ?? 'work/koc-reinsertion', 'workDirectory');
  const outputPath = inside(root, input.outputPath ?? 'deliverables/koc-remake-final-480p.mp4', 'outputPath');
  if (outputPath === sourcePath) throw new Error('reinsertion output must not overwrite the locked source video');
  const normalized = pieces.map((piece, index) => {
    const startFrame = Math.round(piece.startSec * fps);
    const endFrame = Math.round(piece.endSec * fps);
    const frameCount = endFrame - startFrame;
    if (frameCount < 1) throw new Error(`${piece.id} resolves to no source-timeline frames`);
    const path = join(workDirectory, `${String(index + 1).padStart(3, '0')}-${piece.id}.mp4`);
    const inputPath = piece.kind === 'source' ? sourcePath : piece.inputPath;
    const inputStartSec = piece.kind === 'source' ? piece.startSec : piece.generatedStartSec;
    return {
      ...piece, frameCount, normalizedPath: path,
      command: ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ss', String(inputStartSec), '-i', inputPath,
        '-an', '-frames:v', String(frameCount), '-vf', `fps=${fps},scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height},setsar=1`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', path]
    };
  });
  if (normalized.reduce((sum, piece) => sum + piece.frameCount, 0) !== Math.round(durationSec * fps)) {
    throw new Error('reinsertion piece frame allocation does not cover the complete source timeline');
  }
  return {
    schemaVersion: 1, kind: 'koc_reinsertion_plan', projectId: input.projectId,
    sourceVideo: { path: sourcePath, sha256: sourceSha256, durationSec },
    inventoryAudit: ledger.inventoryAudit,
    target: { ...target, fps, totalFrames: Math.round(durationSec * fps), resolution: '480p' },
    workDirectory, outputPath, pieces: normalized,
    coverage: { requiredArollSegments: ledger.arollSegments.length, acceptedArollSegments: input.replacements.length, complete: true },
    audioPolicy: 'copy_full_original_source_track',
    paidGenerationTriggered: false
  };
}

async function audioHash(runner, root, path) {
  const result = await runner('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { cwd: root });
  const match = `${result.stdout}\n${result.stderr}`.match(/SHA256=([a-f0-9]{64})/i);
  if (!match) throw new Error(`could not hash audio stream for ${path}`);
  return match[1].toLowerCase();
}

async function videoFrameHash(runner, root, path, { startSec = 0, frameCount }) {
  const result = await runner('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path,
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    '-map', '0:v:0', '-frames:v', String(frameCount), '-an', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-f', 'hash', '-hash', 'sha256', '-'
  ], { cwd: root });
  const match = `${result.stdout}\n${result.stderr}`.match(/SHA256=([a-f0-9]{64})/i);
  if (!match) throw new Error(`could not hash decoded video frames for ${path}`);
  return match[1].toLowerCase();
}

export async function executeKocReinsertion(root, input, options = {}) {
  root = resolve(root);
  const plan = await buildKocReinsertionPlan(root, input, options);
  const runner = options.runner ?? defaultRunner;
  for (const target of [plan.outputPath, join(plan.workDirectory, 'timeline.ffconcat'), join(plan.workDirectory, 'reinsertion-audit.json')]) {
    await access(target, constants.F_OK).then(() => { throw new Error(`refusing to overwrite ${target}`); }).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await Promise.all([mkdir(plan.workDirectory, { recursive: true }), mkdir(dirname(plan.outputPath), { recursive: true })]);
  await boundedMap(plan.pieces, Math.min(4, plan.pieces.length), async piece => {
    await runner(piece.command[0], piece.command.slice(1), { cwd: root });
  });
  const concatPath = join(plan.workDirectory, 'timeline.ffconcat');
  const concat = plan.pieces.map(piece => `file '${basename(piece.normalizedPath).replaceAll("'", "'\\''")}'`).join('\n');
  await writeFile(concatPath, `${concat}\n`, 'utf8');
  await runner('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-i', plan.sourceVideo.path, '-map', '0:v:0', '-map', '1:a:0', '-frames:v', String(plan.target.totalFrames),
    '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', plan.outputPath
  ], { cwd: root });
  const finalProbe = JSON.parse((await runner('ffprobe', [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', plan.outputPath
  ], { cwd: root })).stdout);
  const finalVideo = finalProbe.streams?.find(stream => stream.codec_type === 'video');
  const finalAudios = finalProbe.streams?.filter(stream => stream.codec_type === 'audio') ?? [];
  const finalFrames = Number(finalVideo?.nb_read_frames ?? finalVideo?.nb_frames);
  if (finalFrames !== plan.target.totalFrames || finalAudios.length < 1
    || Number(finalVideo?.width) !== plan.target.width || Number(finalVideo?.height) !== plan.target.height) {
    throw new Error('final KOC film failed frame, resolution, or audio verification');
  }
  const [sourceAudioSha256, finalAudioSha256, outputSha256] = await Promise.all([
    audioHash(runner, root, plan.sourceVideo.path), audioHash(runner, root, plan.outputPath), sha256File(plan.outputPath)
  ]);
  if (sourceAudioSha256 !== finalAudioSha256) throw new Error('final KOC film does not preserve the original full audio stream');
  const sourceGapAudits = await boundedMap(
    plan.pieces.filter(piece => piece.kind === 'source'),
    Math.min(4, plan.pieces.filter(piece => piece.kind === 'source').length),
    async piece => {
      const [normalizedFrameSha256, finalFrameSha256] = await Promise.all([
        videoFrameHash(runner, root, piece.normalizedPath, { frameCount: piece.frameCount }),
        videoFrameHash(runner, root, plan.outputPath, { startSec: piece.startSec, frameCount: piece.frameCount })
      ]);
      if (normalizedFrameSha256 !== finalFrameSha256) throw new Error(`${piece.id} source-preservation frame hash mismatch`);
      return { id: piece.id, startSec: piece.startSec, endSec: piece.endSec, normalizedFrameSha256, finalFrameSha256, status: 'PASS' };
    }
  );
  const audit = {
    schemaVersion: 1, kind: 'koc_reinsertion_audit', status: 'PASS', projectId: plan.projectId,
    sourceVideoSha256: plan.sourceVideo.sha256, outputPath: relative(root, plan.outputPath), outputSha256,
    frameCount: finalFrames, resolution: `${plan.target.width}x${plan.target.height}`, fps: plan.target.fps,
    sourceAudioSha256, finalAudioSha256, audioIntegrity: 'PASS',
    arollCoverage: { ...plan.coverage, status: 'PASS' },
    brollPolicy: {
      status: 'PASS',
      evidence: 'every non-replacement timeline range was derived from the locked source video and matched against the assembled film by decoded-frame SHA256',
      sourceGapAudits
    },
    pieces: plan.pieces.map(piece => ({ id: piece.id, kind: piece.kind, startSec: piece.startSec, endSec: piece.endSec, frameCount: piece.frameCount }))
  };
  const auditPath = join(plan.workDirectory, 'reinsertion-audit.json');
  await writeJsonAtomic(auditPath, audit);
  return { status: 'ASSEMBLED_AND_AUDITED', outputPath: plan.outputPath, outputSha256, auditPath, audit, paidGenerationTriggered: false };
}
