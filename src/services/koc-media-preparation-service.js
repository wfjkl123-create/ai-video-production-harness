import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { sha256File } from '../storage/checksum.js';
import { writeJsonAtomic } from '../storage/json-store.js';

const SHA256 = /^[a-f0-9]{64}$/;
const FIRST_FRAME_POLICIES = new Set(['none', 'all_segments', 'selected_segments']);

function inside(root, path, label) {
  const actual = resolve(root, path);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error(`${label} must stay inside the project`);
  return actual;
}

async function readable(path, label) {
  await access(path, constants.R_OK).catch(() => { throw new Error(`${label} is not readable`); });
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
  const results = new Array(items.length);
  let cursor = 0;
  let failed = null;
  async function consume() {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); } catch (error) { failed = error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  if (failed) throw failed;
  return results;
}

function verifyLedger(input) {
  const ledger = input.ledger;
  if (!ledger || ledger.kind !== 'koc_source_ledger' || ledger.inventoryAudit?.status !== 'PASS'
    || ledger.inventoryAudit?.fullTimelineCovered !== true
    || ledger.inventoryAudit?.allArollRangesAccountedFor !== true
    || ledger.inventoryAudit?.brollRangesExcluded !== true
    || !SHA256.test(ledger.inventoryAudit?.auditSha256 ?? '')) {
    throw new Error('media preparation requires a complete, SHA-audited KOC source ledger');
  }
  if (!Array.isArray(ledger.arollSegments) || ledger.arollSegments.length === 0) throw new Error('KOC source ledger has no A-roll packages');
  return ledger;
}

function firstFrameMap(input, ledger) {
  if (!FIRST_FRAME_POLICIES.has(input.firstFramePolicy)) throw new Error('invalid firstFramePolicy');
  const values = Array.isArray(input.firstFrames) ? input.firstFrames : [];
  const map = new Map(values.map(item => [item.segmentId, item]));
  if (map.size !== values.length) throw new Error('firstFrames contains duplicate segment IDs');
  const ids = new Set(ledger.arollSegments.map(segment => segment.id));
  for (const id of map.keys()) if (!ids.has(id)) throw new Error(`firstFrames contains unknown segment ${id}`);
  if (input.firstFramePolicy === 'none' && map.size > 0) throw new Error('firstFramePolicy none forbids first-frame assets');
  if (input.firstFramePolicy === 'all_segments' && map.size !== ids.size) throw new Error('all_segments requires one first frame per A-roll package');
  if (input.firstFramePolicy === 'selected_segments' && map.size === 0) throw new Error('selected_segments requires at least one first frame');
  return map;
}

export async function buildKocMediaPreparationPlan(root, input, options = {}) {
  root = resolve(root);
  if (!input || input.kind !== 'koc_media_preparation_job' || input.schemaVersion !== 1) throw new Error('invalid KOC media preparation job');
  const ledger = verifyLedger(input);
  if (input.projectId !== ledger.projectId) throw new Error('media job projectId does not match source ledger');
  const sourcePath = inside(root, input.sourceVideo?.path ?? '', 'sourceVideo.path');
  const identityPath = inside(root, input.identityReference?.path ?? '', 'identityReference.path');
  const modelPath = inside(root, input.detectorModelPath ?? '', 'detectorModelPath');
  await Promise.all([readable(sourcePath, 'source video'), readable(identityPath, 'identity reference'), readable(modelPath, 'face detector model')]);
  const [sourceSha256, identitySha256] = await Promise.all([sha256File(sourcePath), sha256File(identityPath)]);
  if (sourceSha256 !== input.sourceVideo.sha256 || sourceSha256 !== ledger.sourceVideo.sha256) throw new Error('source video SHA does not match the locked ledger');
  if (identitySha256 !== input.identityReference.sha256) throw new Error('identity reference SHA mismatch');
  const frameMap = firstFrameMap(input, ledger);
  for (const [segmentId, item] of frameMap) {
    const path = inside(root, item.path ?? '', `${segmentId} first frame`);
    await readable(path, `${segmentId} first frame`);
    if (await sha256File(path) !== item.sha256) throw new Error(`${segmentId} first-frame SHA mismatch`);
    item.absolutePath = path;
  }
  const outputDirectory = inside(root, input.outputDirectory ?? 'work/koc-media', 'outputDirectory');
  const runner = options.runner ?? defaultRunner;
  const probe = JSON.parse((await runner('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'json', sourcePath
  ], { cwd: root })).stdout);
  const rate = String(probe.streams?.[0]?.avg_frame_rate ?? '0/0').split('/').map(Number);
  const fps = rate.length === 2 && rate[1] > 0 ? rate[0] / rate[1] : 0;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('source video has no valid frame rate');
  const scrubScript = inside(root, 'scripts/derive-multiface-full-head-scrub-v1.py', 'head scrub script');
  await readable(scrubScript, 'head scrub script');
  const lanes = ledger.arollSegments.map(segment => {
    const frameCount = Math.max(1, Math.round((segment.endSec - segment.startSec) * fps));
    const sourceClip = join(outputDirectory, `${segment.id}-source.mp4`);
    const controlVideo = join(outputDirectory, `${segment.id}-head-anonymized.mp4`);
    const stats = join(outputDirectory, `${segment.id}-head-anonymized-stats.json`);
    return {
      segment,
      frameCount,
      sourceClip,
      controlVideo,
      stats,
      firstFrame: frameMap.get(segment.id) ?? null,
      cutCommand: ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', sourcePath,
        '-ss', String(segment.startSec), '-t', String(segment.endSec - segment.startSec),
        '-frames:v', String(frameCount), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0', '-shortest', '-movflags', '+faststart', sourceClip],
      scrubCommand: ['python3', scrubScript, sourceClip, modelPath, controlVideo, stats,
        '--expected-counts', `0:${frameCount}:${segment.expectedFaceCount}`, '--mosaic-cell-size', '24', '--blur-sigma', '56', '--mosaic-weight', '0.96']
    };
  });
  return {
    schemaVersion: 1,
    kind: 'koc_media_preparation_plan',
    projectId: input.projectId,
    sourceVideo: { id: ledger.sourceVideo.id, path: sourcePath, sha256: sourceSha256, durationSec: ledger.sourceVideo.durationSec },
    identityReference: { id: input.identityReference.id, path: identityPath, sha256: identitySha256, mediaKind: 'image' },
    firstFramePolicy: input.firstFramePolicy,
    firstFrameSegmentIds: [...frameMap.keys()],
    outputDirectory,
    fps,
    concurrency: Math.min(4, lanes.length),
    inventoryAudit: ledger.inventoryAudit,
    lanes
  };
}

export async function executeKocMediaPreparation(root, input, options = {}) {
  const plan = await buildKocMediaPreparationPlan(root, input, options);
  const runner = options.runner ?? defaultRunner;
  await mkdir(plan.outputDirectory, { recursive: true });
  const records = await boundedMap(plan.lanes, plan.concurrency, async lane => {
    for (const path of [lane.sourceClip, lane.controlVideo, lane.stats]) {
      await access(path, constants.F_OK).then(() => { throw new Error(`refusing to overwrite ${path}`); }).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await runner(lane.cutCommand[0], lane.cutCommand.slice(1), { cwd: root });
    await runner(lane.scrubCommand[0], lane.scrubCommand.slice(1), { cwd: root });
    const stats = JSON.parse(await readFile(lane.stats, 'utf8'));
    const expectedDuration = lane.segment.endSec - lane.segment.startSec;
    if (stats.output?.frameCount !== lane.frameCount || stats.output?.audioStreams < 1
      || Math.abs(Number(stats.output?.durationSec) - expectedDuration) > Math.max(0.05, 1 / plan.fps)
      || stats.detectedFaceCounts?.length !== lane.frameCount
      || stats.residualFaceCounts?.length !== lane.frameCount || stats.residualFaceCounts.some(count => count !== 0)
      || stats.maskAudit?.geometryStatus !== 'PASS' || stats.maskAudit?.residualFaceDetectionStatus !== 'PASS'
      || stats.audioIntegrity?.status !== 'PASS' || stats.audioIntegrity.sourceSha256 !== stats.audioIntegrity.outputSha256) {
      throw new Error(`${lane.segment.id} anonymized control failed frame/audio/detection verification`);
    }
    const [sourceRangeSha256, controlSha256, auditSha256] = await Promise.all([
      sha256File(lane.sourceClip), sha256File(lane.controlVideo), sha256File(lane.stats)
    ]);
    return {
      id: lane.segment.id,
      startSec: lane.segment.startSec,
      endSec: lane.segment.endSec,
      contentClass: 'aroll',
      containsBroll: false,
      continuousTakeId: lane.segment.continuousTakeId,
      continuousTakeComplete: true,
      transcript: lane.segment.transcript,
      sourceRangeSha256,
      controlVideo: { id: `${lane.segment.id}-koc-control`, path: relative(root, lane.controlVideo), sha256: controlSha256, mediaKind: 'video' },
      maskAudit: { status: 'PASS', coverage: 'full_head_above_neck', outsideHeadPreserved: true, auditSha256 },
      sourceAudioMode: 'embedded_original_track',
      ...(lane.firstFrame ? { firstFrame: {
        id: lane.firstFrame.id, path: relative(root, lane.firstFrame.absolutePath), sha256: lane.firstFrame.sha256, mediaKind: 'image'
      } } : {})
    };
  });
  const output = {
    schemaVersion: 1,
    kind: 'koc_remake_plan_input',
    projectId: plan.projectId,
    sourceVideo: { id: plan.sourceVideo.id, sha256: plan.sourceVideo.sha256, mediaKind: 'video', durationSec: plan.sourceVideo.durationSec },
    sourceInventoryAudit: {
      status: 'PASS', sourceVideoSha256: plan.sourceVideo.sha256,
      allArollRangesAccountedFor: true, brollRangesExcluded: true, auditSha256: plan.inventoryAudit.auditSha256
    },
    identityReference: { id: plan.identityReference.id, sha256: plan.identityReference.sha256, mediaKind: 'image' },
    arollSegments: records,
    firstFramePolicy: plan.firstFramePolicy,
    firstFrameSegmentIds: plan.firstFrameSegmentIds
  };
  const manifestPath = join(plan.outputDirectory, 'koc-remake-plan-input.json');
  await writeJsonAtomic(manifestPath, output);
  return { status: 'PREPARED', manifestPath, output, preparedSegments: records.length, paidGenerationTriggered: false };
}
