import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { sha256File } from '../storage/checksum.js';
import { prepareLibTvVideoCanvas } from './libtv-video-generation-service.js';

const PROJECT_UUID = /^[a-f0-9]{32}$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function inside(root, path, label) {
  const actual = resolve(root, path);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error(`${label} must stay inside the project`);
  return actual;
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

function assertReviews(value, segmentId) {
  const reviews = value.reviews ?? {};
  for (const key of ['sourceFidelity', 'performanceLiveness', 'deliveryCompleteness']) {
    if (reviews[key]?.status !== 'PASS') throw new Error(`${segmentId} requires independent ${key} PASS evidence`);
  }
}

async function exactMedia(root, item, label) {
  const path = inside(root, item?.path ?? '', `${label}.path`);
  await access(path, constants.R_OK);
  if (await sha256File(path) !== item?.sha256) throw new Error(`${label} SHA mismatch`);
  return { path, sha256: item.sha256 };
}

export async function buildKocCanvasBatchPlan(root, input) {
  root = resolve(root);
  if (!input || input.schemaVersion !== 1 || input.kind !== 'koc_canvas_batch_job') throw new Error('invalid KOC canvas batch job');
  const plan = input.plan;
  if (!plan || plan.kind !== 'koc_remake_plan' || plan.preparationBarrier?.status !== 'PASS') throw new Error('KOC canvas batch requires a preparation-barrier PASS plan');
  if (!PROJECT_UUID.test(input.projectUuid ?? '')) throw new Error('LibTV project UUID must be 32 lowercase hexadecimal characters');
  if (!Array.isArray(input.packages) || input.packages.length !== plan.execution.lanes.length) throw new Error('canvas packages must cover every KOC lane exactly once');
  const packages = new Map(input.packages.map(item => [item.segmentId, item]));
  if (packages.size !== input.packages.length) throw new Error('canvas packages contain duplicate segment IDs');
  const lanes = [];
  for (const lane of plan.execution.lanes) {
    const item = packages.get(lane.segmentId);
    if (!item) throw new Error(`${lane.segmentId} has no reviewed canvas package`);
    if (!SAFE_NAME.test(item.nodeName ?? '')) throw new Error(`${lane.segmentId} nodeName must use safe identifiers`);
    const packagePath = inside(root, item.path ?? '', `${lane.segmentId} package path`);
    await access(packagePath, constants.R_OK);
    if (await sha256File(packagePath) !== item.sha256) throw new Error(`${lane.segmentId} reviewed package SHA mismatch`);
    const inspected = JSON.parse(await readFile(packagePath, 'utf8'));
    const contract = inspected.fingerprint?.generationContract;
    if (inspected.segmentId !== lane.segmentId || contract?.provider !== 'libtv' || contract?.transport !== 'official_cli'
      || contract.projectUuid !== input.projectUuid || contract.nodeName !== item.nodeName || contract.model !== 'Seedance 2.0 VIP'
      || contract.request?.resolution !== '480p' || contract.request?.enableSound !== true) {
      throw new Error(`${lane.segmentId} reviewed package is not the exact 480p sound-enabled LibTV node contract`);
    }
    if (inspected.input?.resolution !== '480p' || inspected.input?.generateAudio === false
      || !Array.isArray(inspected.input?.audioInputs) || inspected.input.audioInputs.length !== 0) {
      throw new Error(`${lane.segmentId} must use embedded control-video audio with no detached audio binding`);
    }
    const duration = Number(contract.request?.duration);
    const sourceDuration = lane.sourceRange.endSec - lane.sourceRange.startSec;
    if (!Number.isFinite(duration) || duration + 0.01 < sourceDuration || duration > 15) throw new Error(`${lane.segmentId} node duration must cover the complete A-roll and stay within 15 seconds`);
    assertReviews(inspected, lane.segmentId);
    const images = await Promise.all((inspected.fingerprint.inputMedia?.image ?? []).map((media, index) => exactMedia(root, media, `${lane.segmentId} image[${index}]`)));
    const videos = await Promise.all((inspected.fingerprint.inputMedia?.video ?? []).map((media, index) => exactMedia(root, media, `${lane.segmentId} video[${index}]`)));
    if (JSON.stringify(inspected.input.imageInputs) !== JSON.stringify(images.map(media => media.path))
      || JSON.stringify(inspected.input.videoInputs) !== JSON.stringify(videos.map(media => media.path))) {
      throw new Error(`${lane.segmentId} runtime media paths differ from the SHA-audited package`);
    }
    const expectedImages = lane.mediaBindings.filter(media => media.mediaKind === 'image').map(media => media.sha256).sort();
    const expectedVideos = lane.mediaBindings.filter(media => media.mediaKind === 'video').map(media => media.sha256).sort();
    if (JSON.stringify(images.map(media => media.sha256).sort()) !== JSON.stringify(expectedImages)
      || JSON.stringify(videos.map(media => media.sha256).sort()) !== JSON.stringify(expectedVideos)) {
      throw new Error(`${lane.segmentId} reviewed package media do not match the KOC plan bindings`);
    }
    lanes.push({ laneId: lane.laneId, segmentId: lane.segmentId, nodeName: item.nodeName, packagePath, packageSha256: item.sha256, inspected });
  }
  return {
    schemaVersion: 1, kind: 'koc_canvas_batch_plan', projectId: plan.projectId, projectUuid: input.projectUuid,
    model: 'Seedance 2.0 VIP', resolution: '480p', concurrency: Math.min(4, lanes.length), lanes,
    action: 'prepare_canvas_nodes_only', assistantMaySubmitPaidGeneration: false, paidGenerationTriggered: false
  };
}

export async function executeKocCanvasBatch(root, input, options = {}) {
  const batch = await buildKocCanvasBatchPlan(root, input);
  const prepare = options.prepare ?? prepareLibTvVideoCanvas;
  const results = await boundedMap(batch.lanes, batch.concurrency, async lane => {
    const result = await prepare(resolve(root), {
      segmentId: lane.segmentId, projectUuid: batch.projectUuid, nodeName: lane.nodeName, model: batch.model
    }, { ...options, inspect: async () => lane.inspected });
    if (result?.paidGenerationTriggered !== false || result?.requiresUserCanvasGeneration !== true) {
      throw new Error(`${lane.segmentId} canvas preparation crossed the paid-generation boundary or lacks user action`);
    }
    return { segmentId: lane.segmentId, nodeName: lane.nodeName, status: result.run?.status ?? 'READY_FOR_USER_CANVAS_GENERATION', nodeKey: result.run?.nodeKey ?? null };
  });
  return { ...batch, status: 'READY_FOR_USER_CANVAS_GENERATION', results, paidGenerationTriggered: false };
}
