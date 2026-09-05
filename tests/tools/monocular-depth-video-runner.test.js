import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

const execFile = promisify(execFileCallback);
const runner = resolve('tools/monocular_depth_video_runner.py');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'depth-runner-test-'));
  const model = join(root, 'model');
  await mkdir(model);
  await writeFile(join(model, 'config.json'), '{}\n');
  await writeFile(join(model, 'preprocessor_config.json'), '{}\n');
  await writeFile(join(model, 'model.safetensors'), 'test-only-placeholder\n');
  const input = join(root, 'source.mp4');
  await writeFile(input, 'test-only-placeholder\n');
  return {
    root, model, input,
    output: join(root, 'outputs'),
    metadata: join(root, 'depth-run.json')
  };
}

function validationArgs(value) {
  return [
    runner,
    '--input', value.input,
    '--model-path', value.model,
    '--model-output', 'inverse_depth',
    '--output-dir', value.output,
    '--metadata', value.metadata,
    '--start-frame', '0',
    '--expect-frames', '555',
    '--expect-fps', '30/1',
    '--output-size', '720x1280',
    '--segments', '0:322,322:555',
    '--validate-only'
  ];
}

function pixelSelector() {
  return {
    id: 'source_white_yellow_components_dilate_v1',
    whiteMinChannel: 200,
    whiteMaxChannelSpread: 36,
    yellowMinRed: 190,
    yellowMinGreen: 160,
    yellowMaxBlue: 150,
    yellowHueMin: 20,
    yellowHueMax: 40,
    yellowMinSaturation: 48,
    yellowMinValue: 120,
    minComponentPixelsNative: 2,
    maxComponentPixelsNative: 4096,
    dilateNativePixels: 2,
    maxSelectedFractionOfCandidate: 0.45
  };
}

test('publishes the locked offline two-pass depth-video contract', async () => {
  const { stdout } = await execFile('python3', [runner, '--print-contract']);
  const contract = JSON.parse(stdout);
  assert.equal(contract.runnerId, 'monocular-depth-video-runner-v1');
  assert.equal(contract.modelPolicy.implicitDownloads, false);
  assert.equal(contract.normalization.scope, 'all_frames_all_native_depth_pixels');
  assert.equal(contract.normalization.method, 'exact_linear_percentile_from_disk_memmap');
  assert.equal(contract.depthEncoding.near, 'white');
  assert.equal(contract.depthEncoding.far, 'black');
  assert.equal(contract.temporalStabilization.currentWeightAtLeast, 0.75);
  assert.equal(contract.temporalStabilization.historyWeightAtMost, 0.25);
  assert.equal(contract.overlayExclusion.coordinateSpace, 'native_source_pixels');
  assert.equal(contract.overlayExclusion.frameIndexing, 'absolute_source_frames_half_open');
  assert.deepEqual(contract.overlayExclusion.supportedShapes, ['rect', 'polygon']);
  assert.equal(contract.overlayExclusion.strategy, 'opencv_telea_uint8_v1');
  assert.equal(contract.overlayExclusion.pixelSelector, 'source_white_yellow_components_dilate_v1');
  assert.deepEqual(contract.overlayExclusion.selectorModes, [
    'glyph_components', 'glyph_bbox_telea_v1', 'full_candidate'
  ]);
  assert.deepEqual(contract.overlayExclusion.fillModes, [
    'telea', 'clean_anchor_patch', 'vertical_column_band_v1', 'highpass_suppression_v1'
  ]);
  assert.equal(contract.overlayExclusion.cleanAnchorPatch.anchorFramesMustBeOutsideOwnActiveInterval, true);
  assert.equal(contract.overlayExclusion.cleanAnchorPatch.defaultRingOffsetOutputPixels, 3);
  assert.equal(contract.overlayExclusion.cleanAnchorPatch.defaultFeatherOutputPixels, 2);
  assert.equal(contract.overlayExclusion.verticalColumnBand.selectorMode, 'glyph_components');
  assert.equal(contract.overlayExclusion.verticalColumnBand.shape, 'rect');
  assert.equal(contract.overlayExclusion.verticalColumnBand.defaultBoundarySampleRowsOutput, 3);
  assert.equal(contract.overlayExclusion.verticalColumnBand.defaultFeatherOutputPixels, 2);
  assert.equal(contract.overlayExclusion.verticalColumnBand.unsupportedColumns, 'bit_exact');
  assert.equal(contract.overlayExclusion.highpassSuppression.selectorMode, 'full_candidate');
  assert.equal(contract.overlayExclusion.highpassSuppression.source, 'same_stabilized_frame');
  assert.equal(contract.overlayExclusion.highpassSuppression.maxDeltaDepthCodes, 'explicit_per_mask');
  assert.equal(contract.overlayExclusion.highpassSuppression.overlapPolicy, 'reject_any_concurrent_candidate_overlap');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.selectorMode, 'glyph_bbox_telea_v1');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.fillMode, 'telea');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.componentAttribution, 'independent_per_mask');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.coreColor, 'source_yellow_only');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.componentMinimum, 'pixel_selector_minimum_applied');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.componentMaximum, 'not_applied_bbox_occupancy_is_authoritative');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.defaultPaddingNativePixels, 6);
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.clipping, 'own_candidate_region_only');
  assert.equal(contract.overlayExclusion.glyphBoundingBoxTelea.emptyCore, 'bit_exact');
  assert.equal(contract.overlayExclusion.candidateRegionsOnly, true);
  assert.equal(contract.overlayExclusion.maskCombination, 'order_independent_union');
  assert.equal(contract.overlayExclusion.cleanedDepthContinuesAsTemporalHistory, false);
  assert.equal(contract.overlayExclusion.preflightValidation, 'all_distinct_active_mask_unions_before_inference_or_output_creation');
  assert.equal(contract.overlayExclusion.generative, false);
  assert.equal(contract.output.codec, 'h264');
  assert.equal(contract.output.pixelFormat, 'yuv420p');
  assert.equal(contract.output.audio, false);
  assert.equal(contract.output.defaultSegments, '0:322,322:555');
});

test('validates explicit local weights and the exact 322 plus 233 frame partition without inference', async () => {
  const value = await fixture();
  const { stdout } = await execFile('python3', validationArgs(value));
  const contract = JSON.parse(stdout);
  assert.equal(contract.modelPath, await realpath(value.model));
  assert.equal(contract.expectedFrames, 555);
  assert.equal(contract.expectedFps, '30');
  assert.deepEqual(contract.inputWindow, {
    startFrame: 0,
    endFrameExclusive: 555,
    frameCount: 555,
    startSeconds: 0,
    endSecondsExclusive: 18.5
  });
  assert.deepEqual(contract.outputSize, { width: 720, height: 1280 });
  assert.deepEqual(contract.segments.map(segment => [segment.start_frame, segment.end_frame_exclusive, segment.frameCount]), [
    [0, 322, 322],
    [322, 555, 233]
  ]);
  assert.equal(contract.weights.current, 0.8);
  assert.equal(contract.weights.history, 0.2);
  assert.equal(contract.overlayExclusion.enabled, false);
  assert.equal(contract.overlayExclusion.unmaskedPixels, 'bit_exact_outside_selected_overlay_pixels');
  assert.equal(contract.overlayExclusion.cleanedDepthContinuesAsTemporalHistory, false);
  assert.equal(contract.overlayExclusion.preflightValidation, 'all_distinct_active_mask_unions_before_inference_or_output_creation');
  assert.match(contract.contractFingerprint, /^[a-f0-9]{64}$/);
});

test('binds an explicit native-coordinate half-open overlay mask spec into the contract fingerprint', async () => {
  const value = await fixture();
  const maskSpec = join(value.root, 'overlay-mask.json');
  await writeFile(maskSpec, `${JSON.stringify({
    schemaVersion: 1,
    coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
    frameIndexing: 'absolute_source_frames_half_open',
    strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
    masks: [
      {
        id: 'subtitle-rect', startFrame: 10, endFrameExclusive: 20,
        shape: { type: 'rect', x0: 40, y0: 800, x1Exclusive: 536, y1Exclusive: 900 }
      },
      {
        id: 'logo-polygon', startFrame: 30, endFrameExclusive: 31,
        shape: { type: 'polygon', points: [[10, 10], [40, 10], [25, 40]] }
      }
    ]
  })}\n`);
  const args = [...validationArgs(value), '--overlay-mask-spec', maskSpec];
  const { stdout } = await execFile('python3', args);
  const contract = JSON.parse(stdout);
  assert.equal(contract.overlayExclusion.enabled, true);
  assert.equal(contract.overlayExclusion.applicationStage, 'after_temporal_stabilization_before_uint8_encoding');
  assert.equal(contract.overlayExclusion.maskCombination, 'order_independent_union');
  assert.equal(contract.overlayExclusion.generative, false);
  assert.equal(contract.overlayExclusion.specPath, await realpath(maskSpec));
  assert.equal(
    contract.overlayExclusion.specSha256,
    createHash('sha256').update(await readFile(maskSpec)).digest('hex')
  );
  assert.match(contract.overlayExclusion.specFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(contract.overlayExclusion.masks[0].startFrame, 10);
  assert.equal(contract.overlayExclusion.masks[0].endFrameExclusive, 20);
  assert.equal(contract.overlayExclusion.masks[1].shape.type, 'polygon');
  assert.equal(contract.overlayExclusion.strategy.pixelSelector.id, 'source_white_yellow_components_dilate_v1');
  assert.equal(contract.overlayExclusion.strategy.pixelSelector.dilateNativePixels, 2);
  assert.equal(contract.overlayExclusion.masks[0].selectorMode, 'glyph_components');
  assert.equal(contract.overlayExclusion.masks[0].fillMode, 'telea');
  assert.match(contract.contractFingerprint, /^[a-f0-9]{64}$/);
});

test('binds explicit full-candidate clean-anchor masks and keeps anchors outside the half-open text interval', async () => {
  const value = await fixture();
  const maskSpec = join(value.root, 'clean-anchor-overlay-mask.json');
  await writeFile(maskSpec, `${JSON.stringify({
    schemaVersion: 1,
    coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
    frameIndexing: 'absolute_source_frames_half_open',
    strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
    masks: [{
      id: 'static-title-full-candidate',
      startFrame: 10,
      endFrameExclusive: 20,
      selectorMode: 'full_candidate',
      fillMode: 'clean_anchor_patch',
      cleanAnchorFrames: [9, 20, 21],
      anchorRingOffsetOutputPixels: 4,
      featherOutputPixels: 2,
      shape: { type: 'rect', x0: 40, y0: 40, x1Exclusive: 536, y1Exclusive: 180 }
    }]
  })}\n`);
  const { stdout } = await execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]);
  const contract = JSON.parse(stdout);
  const mask = contract.overlayExclusion.masks[0];
  assert.equal(mask.startFrame, 10);
  assert.equal(mask.endFrameExclusive, 20);
  assert.equal(mask.selectorMode, 'full_candidate');
  assert.equal(mask.fillMode, 'clean_anchor_patch');
  assert.deepEqual(mask.cleanAnchorFrames, [9, 20, 21]);
  assert.equal(mask.anchorRingOffsetOutputPixels, 4);
  assert.equal(mask.featherOutputPixels, 2);
});

test('binds independently attributed tight glyph bbox Telea masks with native padding', async () => {
  const value = await fixture();
  const maskSpec = join(value.root, 'glyph-bbox-telea-overlay-mask.json');
  await writeFile(maskSpec, `${JSON.stringify({
    schemaVersion: 1,
    coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
    frameIndexing: 'absolute_source_frames_half_open',
    strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
    masks: [
      {
        id: 'left-label-default-padding',
        startFrame: 100,
        endFrameExclusive: 180,
        selectorMode: 'glyph_bbox_telea_v1',
        fillMode: 'telea',
        shape: { type: 'rect', x0: 10, y0: 200, x1Exclusive: 140, y1Exclusive: 300 }
      },
      {
        id: 'right-label-six-pixel-padding',
        startFrame: 100,
        endFrameExclusive: 180,
        selectorMode: 'glyph_bbox_telea_v1',
        bboxPaddingNativePixels: 6,
        shape: { type: 'rect', x0: 436, y0: 200, x1Exclusive: 566, y1Exclusive: 300 }
      }
    ]
  })}\n`);
  const { stdout } = await execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]);
  const contract = JSON.parse(stdout);
  assert.equal(contract.overlayExclusion.masks[0].selectorMode, 'glyph_bbox_telea_v1');
  assert.equal(contract.overlayExclusion.masks[0].fillMode, 'telea');
  assert.equal(contract.overlayExclusion.masks[0].bboxPaddingNativePixels, 6);
  assert.equal(contract.overlayExclusion.masks[1].bboxPaddingNativePixels, 6);
  assert.deepEqual(contract.overlayExclusion.masks.map(mask => [mask.startFrame, mask.endFrameExclusive]), [
    [100, 180], [100, 180]
  ]);
});

test('rejects illegal glyph bbox Telea selector combinations before inference', async () => {
  const value = await fixture();
  const baseMask = {
    id: 'invalid-glyph-bbox',
    startFrame: 100,
    endFrameExclusive: 180,
    selectorMode: 'glyph_bbox_telea_v1',
    fillMode: 'telea',
    bboxPaddingNativePixels: 4,
    shape: { type: 'rect', x0: 10, y0: 200, x1Exclusive: 140, y1Exclusive: 300 }
  };
  const invalidMasks = [
    { ...baseMask, bboxPaddingNativePixels: -1 },
    { ...baseMask, bboxPaddingNativePixels: 65 },
    { ...baseMask, bboxPaddingNativePixels: 4.5 },
    { ...baseMask, fillMode: 'clean_anchor_patch', cleanAnchorFrames: [99] },
    { ...baseMask, selectorMode: 'glyph_components' },
    { ...baseMask, selectorMode: 'full_candidate' }
  ];
  for (const [index, invalidMask] of invalidMasks.entries()) {
    const maskSpec = join(value.root, `invalid-glyph-bbox-${index}.json`);
    await writeFile(maskSpec, `${JSON.stringify({
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [invalidMask]
    })}\n`);
    await assert.rejects(
      execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]),
      error => /bboxPaddingNativePixels.*(between 0 and 64|integer|supported only)|requires fillMode telea/.test(error.stderr)
    );
    await assert.rejects(realpath(value.output));
  }
});

test('binds a glyph-selected rectangular vertical column band with output-space boundary sampling', async () => {
  const value = await fixture();
  const maskSpec = join(value.root, 'vertical-column-band-overlay-mask.json');
  await writeFile(maskSpec, `${JSON.stringify({
    schemaVersion: 1,
    coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
    frameIndexing: 'absolute_source_frames_half_open',
    strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
    masks: [{
      id: 'bottom-white-subtitle-column-band',
      startFrame: 322,
      endFrameExclusive: 395,
      selectorMode: 'glyph_components',
      fillMode: 'vertical_column_band_v1',
      boundarySampleRowsOutput: 4,
      featherOutputPixels: 2,
      shape: { type: 'rect', x0: 101, y0: 778, x1Exclusive: 476, y1Exclusive: 820 }
    }]
  })}\n`);
  const { stdout } = await execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]);
  const contract = JSON.parse(stdout);
  const mask = contract.overlayExclusion.masks[0];
  assert.equal(mask.startFrame, 322);
  assert.equal(mask.endFrameExclusive, 395);
  assert.equal(mask.selectorMode, 'glyph_components');
  assert.equal(mask.fillMode, 'vertical_column_band_v1');
  assert.equal(mask.boundarySampleRowsOutput, 4);
  assert.equal(mask.featherOutputPixels, 2);
  assert.deepEqual(mask.cleanAnchorFrames, []);
  assert.equal(mask.anchorRingOffsetOutputPixels, 0);
});

test('rejects illegal vertical-column-band combinations before inference or output creation', async () => {
  const value = await fixture();
  const baseMask = {
    id: 'invalid-vertical-band',
    startFrame: 10,
    endFrameExclusive: 20,
    selectorMode: 'glyph_components',
    fillMode: 'vertical_column_band_v1',
    boundarySampleRowsOutput: 3,
    featherOutputPixels: 2,
    shape: { type: 'rect', x0: 40, y0: 80, x1Exclusive: 536, y1Exclusive: 180 }
  };
  const invalidMasks = [
    { ...baseMask, selectorMode: 'full_candidate' },
    { ...baseMask, shape: { type: 'polygon', points: [[40, 80], [536, 80], [40, 180]] } },
    { ...baseMask, cleanAnchorFrames: [9] },
    { ...baseMask, boundarySampleRowsOutput: 0 },
    { ...baseMask, featherOutputPixels: 17 },
    {
      ...baseMask,
      fillMode: 'telea',
      boundarySampleRowsOutput: 3,
      featherOutputPixels: undefined
    },
    {
      ...baseMask,
      boundarySampleRowsOutput: 4,
      shape: { type: 'rect', x0: 40, y0: 0, x1Exclusive: 536, y1Exclusive: 100 }
    }
  ];
  for (const [index, invalidMask] of invalidMasks.entries()) {
    const mask = Object.fromEntries(
      Object.entries(invalidMask).filter(([, fieldValue]) => fieldValue !== undefined)
    );
    const maskSpec = join(value.root, `invalid-vertical-column-band-${index}.json`);
    await writeFile(maskSpec, `${JSON.stringify({
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [mask]
    })}\n`);
    await assert.rejects(
      execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]),
      error => /requires selectorMode glyph_components|requires a rect shape|cleanAnchorFrames|between 1 and 64|between 0 and 16|not supported when fillMode is telea|complete boundary sample rows/.test(error.stderr)
    );
    await assert.rejects(realpath(value.output));
  }
});

test('binds explicit full-candidate highpass suppression beside a non-overlapping subtitle band', async () => {
  const value = await fixture();
  const maskSpec = join(value.root, 'highpass-suppression-overlay-mask.json');
  await writeFile(maskSpec, `${JSON.stringify({
    schemaVersion: 1,
    coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
    frameIndexing: 'absolute_source_frames_half_open',
    strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
    masks: [
      {
        id: 'f322-garment-interior',
        startFrame: 322,
        endFrameExclusive: 323,
        selectorMode: 'full_candidate',
        fillMode: 'highpass_suppression_v1',
        sigmaOutputPixels: 5,
        maxDeltaDepthCodes: 4,
        featherOutputPixels: 8,
        shape: { type: 'polygon', points: [[220, 340], [356, 340], [370, 560], [210, 560]] }
      },
      {
        id: 'bottom-subtitle',
        startFrame: 322,
        endFrameExclusive: 395,
        selectorMode: 'glyph_components',
        fillMode: 'vertical_column_band_v1',
        boundarySampleRowsOutput: 3,
        featherOutputPixels: 2,
        shape: { type: 'rect', x0: 91, y0: 774, x1Exclusive: 486, y1Exclusive: 824 }
      }
    ]
  })}\n`);
  const { stdout } = await execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]);
  const contract = JSON.parse(stdout);
  const mask = contract.overlayExclusion.masks.find(item => item.id === 'f322-garment-interior');
  assert.equal(mask.startFrame, 322);
  assert.equal(mask.endFrameExclusive, 323);
  assert.equal(mask.selectorMode, 'full_candidate');
  assert.equal(mask.fillMode, 'highpass_suppression_v1');
  assert.equal(mask.sigmaOutputPixels, 5);
  assert.equal(mask.maxDeltaDepthCodes, 4);
  assert.equal(mask.featherOutputPixels, 8);
});

test('rejects unsafe highpass suppression parameters and concurrent mask overlaps before inference', async () => {
  const value = await fixture();
  const baseMask = {
    id: 'f322-garment-interior',
    startFrame: 322,
    endFrameExclusive: 323,
    selectorMode: 'full_candidate',
    fillMode: 'highpass_suppression_v1',
    sigmaOutputPixels: 5,
    maxDeltaDepthCodes: 4,
    featherOutputPixels: 8,
    shape: { type: 'rect', x0: 180, y0: 300, x1Exclusive: 390, y1Exclusive: 700 }
  };
  const invalidMasks = [
    { ...baseMask, selectorMode: 'glyph_components' },
    { ...baseMask, sigmaOutputPixels: undefined },
    { ...baseMask, sigmaOutputPixels: 0.4 },
    { ...baseMask, sigmaOutputPixels: 65 },
    { ...baseMask, maxDeltaDepthCodes: undefined },
    { ...baseMask, maxDeltaDepthCodes: 0 },
    { ...baseMask, maxDeltaDepthCodes: 65 },
    { ...baseMask, featherOutputPixels: undefined },
    { ...baseMask, featherOutputPixels: 65 },
    { ...baseMask, cleanAnchorFrames: [321] }
  ];
  for (const [index, invalidMask] of invalidMasks.entries()) {
    const mask = Object.fromEntries(
      Object.entries(invalidMask).filter(([, fieldValue]) => fieldValue !== undefined)
    );
    const maskSpec = join(value.root, `invalid-highpass-suppression-${index}.json`);
    await writeFile(maskSpec, `${JSON.stringify({
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [mask]
    })}\n`);
    await assert.rejects(
      execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]),
      error => /requires selectorMode full_candidate|sigmaOutputPixels|maxDeltaDepthCodes|featherOutputPixels|cleanAnchorFrames/.test(error.stderr)
    );
  }

  const overlapSpec = join(value.root, 'overlapping-highpass-suppression.json');
  await writeFile(overlapSpec, `${JSON.stringify({
    schemaVersion: 1,
    coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
    frameIndexing: 'absolute_source_frames_half_open',
    strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
    masks: [
      baseMask,
      {
        id: 'overlapping-subtitle',
        startFrame: 322,
        endFrameExclusive: 323,
        selectorMode: 'glyph_components',
        fillMode: 'vertical_column_band_v1',
        boundarySampleRowsOutput: 3,
        featherOutputPixels: 2,
        shape: { type: 'rect', x0: 200, y0: 650, x1Exclusive: 500, y1Exclusive: 720 }
      }
    ]
  })}\n`);
  await assert.rejects(
    execFile('python3', [...validationArgs(value), '--overlay-mask-spec', overlapSpec]),
    error => /highpass-suppression preflight overlap/.test(error.stderr)
  );
});

test('rejects missing, in-interval, or out-of-window clean anchor frames before inference', async () => {
  const value = await fixture();
  const invalidAnchors = [undefined, [10], [19], [-1], [555], [9, 9]];
  for (const [index, cleanAnchorFrames] of invalidAnchors.entries()) {
    const mask = {
      id: `invalid-anchor-${index}`,
      startFrame: 10,
      endFrameExclusive: 20,
      selectorMode: 'full_candidate',
      fillMode: 'clean_anchor_patch',
      shape: { type: 'rect', x0: 40, y0: 40, x1Exclusive: 536, y1Exclusive: 180 }
    };
    if (cleanAnchorFrames !== undefined) mask.cleanAnchorFrames = cleanAnchorFrames;
    const maskSpec = join(value.root, `invalid-clean-anchor-${index}.json`);
    await writeFile(maskSpec, `${JSON.stringify({
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [mask]
    })}\n`);
    await assert.rejects(
      execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]),
      error => /cleanAnchorFrames.*(at least one|outside|contained|unique)|active text interval/.test(error.stderr)
    );
    await assert.rejects(realpath(value.output));
  }
});

test('rejects invalid overlay frame ranges and native coordinates before inference', async () => {
  const value = await fixture();
  const invalidSpecs = [
    {
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [{
        id: 'empty-range', startFrame: 20, endFrameExclusive: 20,
        shape: { type: 'rect', x0: 40, y0: 800, x1Exclusive: 536, y1Exclusive: 900 }
      }]
    },
    {
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [{
        id: 'outside-source', startFrame: 20, endFrameExclusive: 21,
        shape: { type: 'rect', x0: 40, y0: 800, x1Exclusive: 600, y1Exclusive: 900 }
      }]
    },
    {
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [{
        id: 'self-intersecting', startFrame: 20, endFrameExclusive: 21,
        shape: { type: 'polygon', points: [[10, 10], [60, 50], [10, 50], [50, 10]] }
      }]
    },
    {
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [{
        id: 'full-frame', startFrame: 20, endFrameExclusive: 21,
        shape: { type: 'rect', x0: 0, y0: 0, x1Exclusive: 576, y1Exclusive: 1024 }
      }]
    },
    {
      schemaVersion: 1,
      coordinateSpace: { kind: 'native_source_pixels', width: 576, height: 1024 },
      frameIndexing: 'absolute_source_frames_half_open',
      strategy: { id: 'opencv_telea_uint8_v1', radiusOutputPixels: 3, pixelSelector: pixelSelector() },
      masks: [
        {
          id: 'left-half', startFrame: 20, endFrameExclusive: 22,
          shape: { type: 'rect', x0: 0, y0: 0, x1Exclusive: 288, y1Exclusive: 1024 }
        },
        {
          id: 'right-half', startFrame: 21, endFrameExclusive: 23,
          shape: { type: 'rect', x0: 288, y0: 0, x1Exclusive: 576, y1Exclusive: 1024 }
        }
      ]
    }
  ];
  for (const [index, spec] of invalidSpecs.entries()) {
    const maskSpec = join(value.root, `invalid-overlay-mask-${index}.json`);
    await writeFile(maskSpec, `${JSON.stringify(spec)}\n`);
    await assert.rejects(
      execFile('python3', [...validationArgs(value), '--overlay-mask-spec', maskSpec]),
      error => /half-open|rect must satisfy|non-zero area|self-intersect|preflight failed.*entire depth frame/.test(error.stderr)
    );
    await assert.rejects(realpath(value.output));
  }
});

test('rejects a remote or unresolved model id before importing a model or creating outputs', async () => {
  const value = await fixture();
  const args = validationArgs(value);
  const index = args.indexOf(value.model);
  args[index] = 'https://huggingface.co/depth-anything/model';
  await assert.rejects(
    execFile('python3', args),
    error => /explicit local directory/.test(error.stderr)
  );
});

test('rejects gaps, duplicate boundaries, and any segment longer than 15 seconds', async () => {
  const value = await fixture();
  for (const segments of ['0:321,322:555', '0:323,322:555', '0:451,451:555']) {
    const args = validationArgs(value);
    args[args.indexOf('0:322,322:555')] = segments;
    await assert.rejects(
      execFile('python3', args),
      error => /contiguous|15-second/.test(error.stderr)
    );
  }
});

test('algorithm self-test checks exact P2/P98, 0.8/0.2 flow blend, and cut reset', async () => {
  const { stdout } = await execFile('python3', [runner, '--algorithm-self-test']);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.percentiles, [1.98, 97.02]);
  assert.equal(result.flowBlend, 'PASS');
  assert.equal(result.sceneCutReset, 'PASS');
  assert.equal(result.longSourceWindow, 'PASS');
  assert.equal(result.overlayHalfOpenRanges, 'PASS');
  assert.equal(result.overlayCoordinateScaling, 'PASS');
  assert.equal(result.overlayOccupancyGuard, 'PASS');
  assert.equal(result.overlaySkinToneRejected, 'PASS');
  assert.equal(result.overlayPerMaskAttribution, 'PASS');
  assert.equal(result.overlayPerMaskOccupancyGuard, 'PASS');
  assert.equal(result.overlayPixelSelectorRoiPreserved, 'PASS');
  assert.equal(result.overlayUnmaskedPixelsUnchanged, 'PASS');
  assert.equal(result.overlayHighPlaneRemoved, 'PASS');
  assert.equal(result.overlayExplicitFullCandidateHalfOpen, 'PASS');
  assert.equal(result.overlayFullCandidateRequiresExplicitMode, 'PASS');
  assert.equal(result.overlayCleanAnchorOutsideUnchanged, 'PASS');
  assert.equal(result.overlayCleanAnchorInvalidFrameRejected, 'PASS');
  assert.equal(result.overlayHighpassSuppressionHalfOpen, 'PASS');
  assert.equal(result.overlayHighpassSuppressionOutsideUnchanged, 'PASS');
  assert.equal(result.overlayHighpassSuppressionBounded, 'PASS');
  assert.equal(result.overlayHighpassSuppressionResidualRemoved, 'PASS');
  assert.equal(result.overlayGlyphBboxYellowOnly, 'PASS');
  assert.equal(result.overlayGlyphBboxLargeYellowComponentRetained, 'PASS');
  assert.equal(result.overlayGlyphBboxHalfOpen, 'PASS');
  assert.equal(result.overlayGlyphBboxPaddingClipped, 'PASS');
  assert.equal(result.overlayGlyphBboxIndependentPerMask, 'PASS');
  assert.equal(result.overlayGlyphBboxWhiteGarmentIgnored, 'PASS');
  assert.equal(result.overlayGlyphBboxOccupancyGuard, 'PASS');
  assert.equal(result.overlayGlyphBboxExteriorUnchanged, 'PASS');
  assert.equal(result.overlayVerticalColumnBandHalfOpen, 'PASS');
  assert.equal(result.overlayVerticalColumnBandOccupancyGuard, 'PASS');
  assert.equal(result.overlayVerticalColumnBandLargeComponentFailClosed, 'PASS');
  assert.equal(result.overlayVerticalColumnBandBeigeRejected, 'PASS');
  assert.equal(result.overlayVerticalColumnBandUnsupportedColumnsUnchanged, 'PASS');
  assert.equal(result.overlayVerticalColumnBandLinearSurface, 'PASS');
  assert.equal(result.overlayVerticalColumnBandSingleColumn, 'PASS');
  assert.equal(result.overlayInvalidMaskRejected, 'PASS');
  assert.equal(result.encoder, 'PASS');
  assert.equal(result.filesystemFallback, 'PASS');
  assert.deepEqual(result.encodedSegments.map(segment => [segment.codec, segment.pixelFormat, segment.frameCount, segment.audioStreamCount]), [
    ['h264', 'yuv420p', 2, 0],
    ['h264', 'yuv420p', 3, 0]
  ]);
});
