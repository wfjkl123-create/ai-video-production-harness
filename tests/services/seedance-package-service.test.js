import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileSeedancePackage } from '../../src/services/seedance-package-service.js';
import { runCompileSeedance } from '../../src/commands/compile-seedance.js';
import { loadCanonicalSegments } from '../../src/commands/assets.js';
import { createVideoResolutionContract } from '../../src/domain/video-model-profile.js';

const mediaRoot = await mkdtemp(join(tmpdir(), 'seedance-media-'));
await mkdir(join(mediaRoot, 'assets'));

function mediaFixture(id) {
  const contents = `locked fixture media for ${id}\n`;
  const path = `assets/${id}.png`;
  writeFileSync(join(mediaRoot, path), contents);
  return { contents, path, sha256: createHash('sha256').update(contents).digest('hex') };
}

// 讲戏门 fixture：一份 locked 讲戏本文件 + 其 SHA，供 seedance_prompt 绑定。
const narrationContents = JSON.stringify({
  id: 'narration-001', segmentId: 'segment-001', sourceSegmentId: 'segment-001', revision: 1, status: 'locked',
  shots: [{
    shotId: 'shot-002', physicalActions: ['她揉了揉太阳穴，抬手把碗放到桌上'],
    cameraMove: '缓慢推近', lightSources: ['左前方暖光'], emotionThroughAction: '嘴角牵起一个疲惫的半笑'
  }]
}, null, 2) + '\n';
const narrationSha256 = createHash('sha256').update(narrationContents).digest('hex');
await mkdir(join(mediaRoot, 'prompts'), { recursive: true });
await writeFile(join(mediaRoot, 'prompts', 'segment-001-narration.json'), narrationContents);

const segment = {
  id: 'segment-001',
  duration: 12,
  status: 'locked',
  lockedByReviewId: 'review-segment-001',
  shotIds: ['shot-002'],
  projectAssetIds: ['character-001'],
  segmentAssetRequirements: ['camera_blocking', 'storyboard']
};

const item = (id, type, scope, extra = {}) => {
  const media = mediaFixture(id);
  return {
    id,
    type,
    scope,
    segmentId: scope === 'segment' ? 'segment-001' : undefined,
    status: 'locked',
    revision: 1,
    lockedByReviewId: `review-${id}`,
    sha256: media.sha256,
    path: media.path,
    responsibility: type === 'storyboard' ? 'framing and action path' : `${type} responsibility`,
    mustNotControl: ['unrelated domains'],
    ...(type === 'character_board' ? {
      characterId: 'character-a', visualContractVersion: 1, visualAuditId: 'visual-audit-character-001'
    } : {}),
    ...extra
  };
};

function project(overrides = {}) {
  return {
    root: mediaRoot,
    segments: [segment],
    artifacts: [{
      id: 'narration-001', type: 'shot_narration', segmentId: 'segment-001', revision: 1,
      status: 'locked', lockedByReviewId: 'review-narration-001', path: 'prompts/segment-001-narration.json'
    }],
    assetManifest: {
      id: 'segment-001-assets',
      segmentId: 'segment-001',
      status: 'locked',
      lockedByReviewId: 'review-segment-001-assets',
      items: [
        item('character-001', 'character_board', 'project'),
        item('scene-001', 'scene_multiview', 'project'),
        item('product-001', 'product_reference', 'project'),
        item('camera-001', 'camera_blocking', 'segment'),
        item('storyboard-001', 'storyboard', 'segment')
      ]
    },
    prompt: {
      id: 'prompt-001', type: 'seedance_prompt', segmentId: 'segment-001',
      revision: 1, status: 'locked', lockedByReviewId: 'review-prompt-001', path: 'prompts/segment-001.txt',
      narrationSourceId: 'narration-001', narrationSha256
    },
    ...overrides
  };
}

test('compiles locked current-segment inputs with isolated reference responsibilities', async () => {
  const applicableHardRules = [{
    id: 'rule-hard', status: 'hard', verificationReviewId: 'review-rule-hard', evidence: ['run-001']
  }];
  const result = await compileSeedancePackage(project({ rules: [{ id: 'ignored', status: 'hard' }] }), 'segment-001', { applicableHardRules });
  assert.equal(result.promptPath, 'prompts/segment-001.txt');
  assert.equal(result.duration, 12);
  assert.equal(result.ratio, '9:16');
  assert.equal(result.resolution, '480p');
  assert.equal(result.generateAudio, true);
  assert.deepEqual(result.imageInputs.map(({ id }) => id), ['character-001', 'scene-001', 'product-001', 'camera-001', 'storyboard-001']);
  assert.equal(new Set(result.imageInputs.map(({ sha256 }) => sha256)).size, result.imageInputs.length);
  assert.ok(result.imageInputs.every(({ reason }) => typeof reason === 'string' && reason.length > 0));
  assert.deepEqual(result.responsibilityMap['character-001'].controls, ['identity', 'wardrobe']);
  assert.deepEqual(result.responsibilityMap['product-001'].controls, [
    'product_structure', 'product_color', 'product_material', 'product_surface'
  ]);
  assert.deepEqual(result.responsibilityMap['storyboard-001'].controls, ['framing', 'action_nodes']);
  assert.deepEqual(result.responsibilityMap.text.controls, [
    'time', 'causality', 'camera', 'physics', 'sound', 'end_state', 'negative_constraints'
  ]);
  assert.deepEqual(result.hardRuleIds, ['rule-hard']);
});

test('keeps generated audio as the legacy default but allows an explicit execution-plan override', async () => {
  assert.equal((await compileSeedancePackage(project(), 'segment-001')).generateAudio, true);
  assert.equal((await compileSeedancePackage(project(), 'segment-001', { generateAudio: false })).generateAudio, false);
});

test('blocks video uploads by default and only allows them with an explicit opt-in', async () => {
  const sourceVideo = item('source-video-001', 'reference_video', 'segment', {
    mediaKind: 'video',
    responsibility: 'camera path and action timing'
  });
  const withVideo = project({
    assetManifest: {
      ...project().assetManifest,
      items: [...project().assetManifest.items, sourceVideo]
    }
  });
  await assert.rejects(
    () => compileSeedancePackage(withVideo, 'segment-001'),
    /video inputs are disabled by default.*source-video-001/
  );
  const optedIn = await compileSeedancePackage(withVideo, 'segment-001', { allowVideoInputs: true });
  assert.deepEqual(optedIn.videoInputs.map(({ id }) => id), ['source-video-001']);
});

test('supports legacy 480p/720p and requires a verified model profile for 1080p/4k', async () => {
  const result = await compileSeedancePackage(project(), 'segment-001', { resolution: '480p' });
  assert.equal(result.resolution, '480p');
  await assert.rejects(
    compileSeedancePackage(project(), 'segment-001', { resolution: '1080p' }),
    /requires a verified video resolution contract/
  );
  const resolutionContract = createVideoResolutionContract({
    profileId: 'seedance-2-vip-libtv-v1', requestedResolution: '1080p'
  });
  const highResolution = await compileSeedancePackage(project(), 'segment-001', { resolutionContract });
  assert.equal(highResolution.resolution, '1080p');
  assert.equal(highResolution.videoModelProfileId, 'seedance-2-vip-libtv-v1');
});

test('routes dialogue audio references into Seedance audio slots with bounded responsibilities', async () => {
  const input = project();
  input.assetManifest.items.push(item('dialogue-audio-001', 'dialogue_audio_reference', 'segment', {
    mediaKind: 'audio', responsibility: 'speaker order, vocal tone, pauses, cadence, and mouth-timing clock only; written prompt text supplies dialogue words'
  }));
  const result = await compileSeedancePackage(input, 'segment-001');
  assert.deepEqual(result.audioInputs.map(({ id }) => id), ['dialogue-audio-001']);
  assert.deepEqual(result.responsibilityMap['dialogue-audio-001'].controls, [
    'dialogue_timing', 'voice_tone', 'speaker_timing'
  ]);
});

test('routes non-dialogue timing audio without granting dialogue or visual control', async () => {
  const input = project();
  input.assetManifest.items.push(item('timing-audio-001', 'timing_audio_reference', 'segment', {
    mediaKind: 'audio', responsibility: 'new AI timing performance for dialogue entry timing, cadence, pauses, stress, speaker handoff, action clock, and trim window only'
  }));
  const result = await compileSeedancePackage(input, 'segment-001');
  assert.deepEqual(result.audioInputs.map(({ id }) => id), ['timing-audio-001']);
  assert.deepEqual(result.responsibilityMap['timing-audio-001'].controls, [
    'dialogue_timing', 'cadence', 'pauses', 'stress', 'speaker_timing', 'action_clock', 'trim_window'
  ]);
});

test('routes one source audio candidate without duplicating dialogue and timing roles', async () => {
  const input = project();
  input.assetManifest.items.push(item('source-audio-a1-001', 'source_audio_candidate', 'segment', {
    mediaKind: 'audio', responsibility: 'exact approved source waveform, original dialogue, timbre, cadence, ambience, action clock, and final-mux candidate'
  }));
  const result = await compileSeedancePackage(input, 'segment-001');
  assert.deepEqual(result.audioInputs.map(({ id }) => id), ['source-audio-a1-001']);
  assert.deepEqual(result.responsibilityMap['source-audio-a1-001'].controls, [
    'source_audio_waveform', 'dialogue_words', 'original_speaker_timbre', 'dialogue_timing',
    'ambient_sound', 'dialogue_lipsync_clock', 'trim_window', 'final_mux_candidate'
  ]);
});

test('an explicit wardrobe board takes wardrobe control from the character board', async () => {
  const input = project();
  input.assetManifest.items.push(item('wardrobe-001', 'wardrobe_board', 'project'));
  const result = await compileSeedancePackage(input, 'segment-001');
  assert.deepEqual(result.responsibilityMap['character-001'].controls, ['identity']);
  assert.deepEqual(result.responsibilityMap['wardrobe-001'].controls, ['wardrobe']);
});

test('narration gate: prompt without a bound shot_narration is rejected', async () => {
  const unbound = project();
  delete unbound.prompt.narrationSourceId;
  delete unbound.prompt.narrationSha256;
  await assert.rejects(() => compileSeedancePackage(unbound, 'segment-001'), /must bind a locked shot_narration/);
});

test('narration gate: stale binding (narration changed after approval) is rejected', async () => {
  const stale = project();
  stale.prompt.narrationSha256 = 'f'.repeat(64);
  await assert.rejects(() => compileSeedancePackage(stale, 'segment-001'), /stale|changed since the prompt/);
});

test('narration gate: an unlocked shot_narration cannot be a prompt source', async () => {
  const unlocked = project();
  unlocked.artifacts = unlocked.artifacts.map(a => a.id === 'narration-001' ? { ...a, status: 'awaiting_review' } : a);
  await assert.rejects(() => compileSeedancePackage(unlocked, 'segment-001'), /must be locked by human review/);
});

test('rejects unlocked assets and a missing current-segment camera-blocking asset', async () => {
  const unlocked = project();
  unlocked.assetManifest.items[0].status = 'awaiting_review';
  await assert.rejects(() => compileSeedancePackage(unlocked, 'segment-001'), /character-001.*not locked/);

  const missing = project();
  missing.assetManifest.items = missing.assetManifest.items.filter(({ type }) => type !== 'camera_blocking');
  await assert.rejects(() => compileSeedancePackage(missing, 'segment-001'), /required current-segment asset.*camera_blocking/);

  const foreign = project();
  foreign.assetManifest.items.push(item('foreign-expression', 'expression_board', 'segment', {
    segmentId: 'segment-002', required: false
  }));
  await assert.rejects(() => compileSeedancePackage(foreign, 'segment-001'), /segment asset.*does not belong to segment-001/);
});

test('uses the exact checksum-reviewed asset manifest instead of stale predecessor IDs and superseded blocking requirements', async () => {
  const input = project({
    verifiedAssetManifestEvidence: {
      id: 'segment-001-assets',
      sha256: 'f'.repeat(64),
      reviewId: 'review-segment-001-assets'
    }
  });
  input.segments = [{
    ...segment,
    projectAssetIds: ['character-predecessor-v1'],
    segmentAssetRequirements: ['initial_blocking', 'camera_blocking', 'storyboard']
  }];
  const result = await compileSeedancePackage(input, 'segment-001');
  assert.equal(result.imageInputs.some(({ id }) => id === 'character-001'), true);
  assert.equal(result.imageInputs.some(({ id }) => id === 'character-predecessor-v1'), false);
});

test('requires review and checksum evidence on the manifest and every locked media source', async () => {
  const manifestWithoutReview = project();
  delete manifestWithoutReview.assetManifest.lockedByReviewId;
  await assert.rejects(() => compileSeedancePackage(manifestWithoutReview, 'segment-001'), /manifest.*lockedByReviewId/);

  const sourceWithoutReview = project();
  delete sourceWithoutReview.assetManifest.items[0].lockedByReviewId;
  await assert.rejects(() => compileSeedancePackage(sourceWithoutReview, 'segment-001'), /lockedByReviewId/);

  const sourceWithoutChecksum = project();
  delete sourceWithoutChecksum.assetManifest.items[0].sha256;
  await assert.rejects(() => compileSeedancePackage(sourceWithoutChecksum, 'segment-001'), /sha256/);
});

test('verifies selected media exists under the project root and matches its recorded checksum', async () => {
  const missing = project();
  missing.assetManifest.items[0].path = 'assets/missing.png';
  await assert.rejects(() => compileSeedancePackage(missing, 'segment-001'), /character-001.*readable regular file/);

  const tamperedRoot = await mkdtemp(join(tmpdir(), 'seedance-tampered-'));
  await mkdir(join(tamperedRoot, 'assets'));
  for (const media of project().assetManifest.items) await writeFile(join(tamperedRoot, media.path), 'tampered media\n');
  await mkdir(join(tamperedRoot, 'prompts'), { recursive: true });
  await writeFile(join(tamperedRoot, 'prompts', 'segment-001-narration.json'), narrationContents);
  await assert.rejects(() => compileSeedancePackage(project({ root: tamperedRoot }), 'segment-001'), /checksum mismatch/);

  const traversal = project();
  traversal.assetManifest.items[0].path = '../outside.png';
  await assert.rejects(() => compileSeedancePackage(traversal, 'segment-001'), /must stay inside project root/);
});

test('rejects a selected media symlink that escapes the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seedance-symlink-'));
  const outside = join(await mkdtemp(join(tmpdir(), 'seedance-outside-')), 'outside.png');
  await mkdir(join(root, 'assets'));
  await writeFile(outside, mediaFixture('character-001').contents);
  await symlink(outside, join(root, 'assets', 'character-001.png'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'segment-001-narration.json'), narrationContents);
  await assert.rejects(() => compileSeedancePackage(project({ root }), 'segment-001'), /symlink.*escapes project root/);
});

test('accepts only explicitly supplied applicable hard rules with verification evidence', async () => {
  assert.deepEqual((await compileSeedancePackage(project({ rules: [{ id: 'ignored', status: 'hard' }] }), 'segment-001')).hardRuleIds, []);
  await assert.rejects(() => compileSeedancePackage(project(), 'segment-001', {
    applicableHardRules: [{ id: 'candidate', status: 'candidate', verificationReviewId: 'review-1', evidence: ['run-1'] }]
  }), /applicable rule.*hard/);
  await assert.rejects(() => compileSeedancePackage(project(), 'segment-001', {
    applicableHardRules: [{ id: 'unverified', status: 'hard', evidence: [] }]
  }), /verification evidence/);
});

test('allows distinct character identity owners and rejects duplicate character IDs', async () => {
  const ensemble = project();
  ensemble.assetManifest.items.push(item('character-002', 'character_board', 'project', { characterId: 'character-b', visualAuditId: 'visual-audit-character-002' }));
  const compiled = await compileSeedancePackage(ensemble, 'segment-001');
  assert.ok(compiled.imageInputs.some(({ id }) => id === 'character-002'));

  const duplicate = project();
  duplicate.assetManifest.items.push(item('character-002', 'character_board', 'project', { characterId: 'character-a', visualAuditId: 'visual-audit-character-002' }));
  await assert.rejects(() => compileSeedancePackage(duplicate, 'segment-001'), /each character must use exactly one independent character_board/);

  const polluted = project();
  polluted.assetManifest.items.find(({ type }) => type === 'storyboard').responsibility = 'framing and identity';
  await assert.rejects(() => compileSeedancePackage(polluted, 'segment-001'), /storyboard.*identity/);
});

test('allows distinct product references to own their own structures', async () => {
  const input = project();
  input.assetManifest.items.push(item('product-002', 'product_reference', 'project'));
  const result = await compileSeedancePackage(input, 'segment-001');
  assert.ok(result.imageInputs.some(({ id }) => id === 'product-002'));
});

test('rejects duplicate bytes registered under multiple selected media roles', async () => {
  const input = project();
  const storyboard = input.assetManifest.items.find(({ id }) => id === 'storyboard-001');
  input.assetManifest.items.push(item('duplicate-story-prop', 'story_prop', 'project', {
    path: storyboard.path,
    sha256: storyboard.sha256,
    responsibility: 'duplicate bytes pretending to be a separate prop role'
  }));
  await assert.rejects(
    () => compileSeedancePackage(input, 'segment-001'),
    /duplicate selected media bytes.*one canonical asset/
  );
});

test('keeps contract-forbidden gate evidence out of generation inputs and responsibilities', async () => {
  const input = project();
  const product = input.assetManifest.items.find(({ id }) => id === 'product-001');
  product.required = false;
  product.excludeFromGeneration = true;
  const result = await compileSeedancePackage(input, 'segment-001');
  assert.ok(!result.imageInputs.some(({ id }) => id === 'product-001'));
  assert.equal(result.responsibilityMap['product-001'], undefined);
  assert.deepEqual(result.excludedInputs, [{
    id: 'product-001',
    reason: 'excluded: locked gate evidence that the current segment contract forbids from controlling generated pixels'
  }]);
});

test('rejects unlocked segments, prompts for another segment, and durations over 15 seconds', async () => {
  await assert.rejects(() => compileSeedancePackage(project({ segments: [{ ...segment, status: 'awaiting_review' }] }), 'segment-001'), /segment.*locked/);
  await assert.rejects(() => compileSeedancePackage(project({ prompt: { ...project().prompt, segmentId: 'segment-002' } }), 'segment-001'), /locked Seedance prompt.*segment-001/);
  await assert.rejects(() => compileSeedancePackage(project({ segments: [{ ...segment, duration: 15.1 }] }), 'segment-001'), /duration.*15/);
});

test('selects optional inputs by current-shot relevance and reports every exclusion', async () => {
  const input = project();
  input.assetManifest.items.push(
    item('expression-relevant', 'expression_board', 'segment', { required: false, shotIds: ['shot-002'] }),
    item('wardrobe-irrelevant', 'wardrobe_board', 'segment', { required: false, shotIds: ['shot-999'] })
  );
  const result = await compileSeedancePackage(input, 'segment-001', { imageSlots: 6 });
  assert.ok(result.imageInputs.some(({ id }) => id === 'expression-relevant'));
  assert.deepEqual(result.excludedInputs, [{
    id: 'wardrobe-irrelevant',
    reason: 'excluded: lower relevance after all 6 image slots were filled'
  }]);
});

test('slot selection is semantic and invariant to manifest permutation', async () => {
  const input = project();
  input.assetManifest.items.push(
    item('z-optional', 'expression_board', 'segment', { required: false, shotIds: ['shot-002'] }),
    item('a-optional', 'color_board', 'segment', { required: false, shotIds: ['shot-002'] })
  );
  const first = await compileSeedancePackage(input, 'segment-001', { imageSlots: 6 });
  input.assetManifest.items.reverse();
  const second = await compileSeedancePackage(input, 'segment-001', { imageSlots: 6 });
  assert.deepEqual(first.imageInputs.map(({ id }) => id), second.imageInputs.map(({ id }) => id));
  assert.deepEqual(first.excludedInputs, second.excludedInputs);
  assert.ok(first.imageInputs.some(({ id }) => id === 'a-optional'));
  assert.ok(first.excludedInputs.some(({ id }) => id === 'z-optional'));
});

test('fails instead of silently dropping required assets when media slots are exhausted', async () => {
  const input = project();
  for (let index = 0; index < 7; index += 1) {
    input.assetManifest.items.push(item(`prop-${index}`, 'story_prop', 'project', {
      responsibility: `prop ${index} appearance`
    }));
  }
  await assert.rejects(() => compileSeedancePackage(input, 'segment-001'), /required image inputs exceed 9 slots/);
});

test('uses the verified Seedance 2.5 media limits instead of the Seedance 2.0 nine-image limit', async () => {
  const input = project();
  for (let index = 0; index < 7; index += 1) {
    input.assetManifest.items.push(item(`seedance25-prop-${index}`, 'story_prop', 'project', {
      responsibility: `seedance 2.5 prop ${index} appearance`
    }));
  }
  const resolutionContract = createVideoResolutionContract({
    profileId: 'seedance-2-5-libtv-v1',
    requestedResolution: '1080p'
  });
  const result = await compileSeedancePackage(input, 'segment-001', { resolutionContract });
  assert.equal(result.imageInputs.length, 12);
  assert.equal(result.videoModel, 'Seedance 2.5');
  assert.equal(result.resolution, '1080p');
});

test('supports deterministic identity pair boards for Seedance 2.0 slot compression', async () => {
  const input = project();
  const pair = (number, left, right) => item(`identity-pair-${number}`, 'identity_pair_board', 'segment', {
    responsibility: `two mapped identities ${left} and ${right} only`,
    mustNotControl: ['scene', 'story action', 'camera', 'product appearance', 'reference-board layout'],
    mediaKind: 'image', required: true,
    sourceAssetIds: [left, right],
    identitySlotBindings: [
      { side: 'left', identityAssetId: left },
      { side: 'right', identityAssetId: right }
    ],
    compositionMethod: 'deterministic_center_crop_and_horizontal_stack_no_generation'
  });
  input.assetManifest.items = [
    ...input.assetManifest.items.filter(asset => asset.type !== 'character_board'),
    pair('001', 'mother-01', 'mother-02'),
    pair('002', 'mother-03', 'mother-04'),
    pair('003', 'mother-05', 'mother-06'),
    pair('004', 'mother-07', 'mother-08')
  ];
  input.verifiedAssetManifestEvidence = {
    id: input.assetManifest.id,
    sha256: 'a'.repeat(64),
    reviewId: input.assetManifest.lockedByReviewId
  };
  const result = await compileSeedancePackage(input, 'segment-001', { allowVideoInputs: true });
  assert.equal(result.imageInputs.filter(asset => asset.id.startsWith('identity-pair-')).length, 4);
  assert.deepEqual(result.responsibilityMap['identity-pair-001'].controls, ['identity', 'body_shape', 'body_proportion', 'wardrobe']);
  assert.ok(result.responsibilityMap['identity-pair-001'].mustNotControl.includes('reference-board layout'));
  input.assetManifest.items.find(asset => asset.id === 'identity-pair-004').sourceAssetIds[0] = 'mother-01';
  input.assetManifest.items.find(asset => asset.id === 'identity-pair-004').identitySlotBindings[0].identityAssetId = 'mother-01';
  await assert.rejects(
    () => compileSeedancePackage(input, 'segment-001', { allowVideoInputs: true }),
    /responsibility conflict: identity for mother-01/
  );
});

test('schema publishes the package boundary and fixture CLI performs a network-free dry run', async (t) => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/seedance-package.schema.json', import.meta.url)));
  assert.deepEqual(schema.required, [
    'sourcePromptPath', 'promptPath', 'duration', 'ratio', 'resolution', 'generateAudio', 'videoModelProfileId', 'videoExecutor',
    'videoModel', 'sourceResolutionBaseline', 'imageInputs', 'videoInputs', 'audioInputs',
    'mediaBindingContractVersion', 'mediaBindings', 'responsibilityMap', 'excludedInputs', 'hardRuleIds', 'governanceBindings'
  ]);
  assert.deepEqual(schema.properties.ratio, { const: '9:16' });
  assert.equal(schema.properties.duration.maximum, 15);
  assert.equal(schema.properties.imageInputs.maxItems, 30);
  assert.equal(schema.properties.videoInputs.maxItems, 10);
  assert.equal(schema.properties.audioInputs.maxItems, 10);
  assert.deepEqual(schema.$defs.inputs.items.required, ['id', 'path', 'sha256', 'status', 'reason']);
  assert.deepEqual(schema.properties.excludedInputs.items.required, ['id', 'reason']);
  assert.deepEqual(schema.properties.responsibilityMap.additionalProperties.required, ['controls', 'mustNotControl']);

  const result = await runCompileSeedance([
    '--project', 'tests/fixtures/project-ready', '--segment', 'segment-001',
    '--rule-context', 'tests/fixtures/context-segment-001.json'
  ]);
  t.after(() => rm(dirname(result.path), { recursive: true, force: true }));
  assert.equal(result.summary.ratio, '9:16');
  assert.equal(result.summary.duration, 12);
  assert.equal(result.summary.imageInputCount, 5);
  assert.equal(result.summary.hardRuleCount, 1);
  const packageJson = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(packageJson.sourcePromptPath, 'prompts/segment-001.txt');
  assert.equal(packageJson.promptPath, 'prompts/segment-001/execution-prompt.txt');
  assert.equal(packageJson.mediaBindings.length, 5);
  assert.equal(packageJson.videoModelProfileId, 'seedance-2-vip-libtv-v1');
  assert.equal(packageJson.videoExecutor, 'libtv');
  assert.equal(packageJson.videoModel, 'Seedance 2.0 VIP');
  assert.equal(packageJson.generateAudio, true);
  assert.equal(packageJson.sourceResolutionBaseline, null);
  const executionPrompt = await readFile(join('tests/fixtures/project-ready', packageJson.promptPath), 'utf8');
  assert.match(executionPrompt, /@图5 controls only the shot sequence/u);
  assert.doesNotMatch(executionPrompt, /@图1=segment-001-storyboard|【参考素材｜本次实际上传】/u);
  assert.equal(packageJson.governanceBindings.segmentContract.status, 'locked');
  assert.equal(packageJson.governanceBindings.shotNarration.id, 'narration-segment-001');
  assert.equal(packageJson.governanceBindings.seedancePrompt.status, 'locked');
  assert.equal(packageJson.governanceBindings.assetManifest.status, 'locked');
  const persisted = JSON.parse(await readFile(result.path, 'utf8'));
  assert.ok(persisted.imageInputs.every(({ status }) => status === 'locked'));
  assert.deepEqual(persisted.hardRuleIds, ['rule-verified']);

  const mutedResult = await runCompileSeedance([
    '--project', 'tests/fixtures/project-ready', '--segment', 'segment-001', '--disable-audio'
  ]);
  const mutedPackage = JSON.parse(await readFile(mutedResult.path, 'utf8'));
  assert.equal(mutedPackage.generateAudio, false);
});

test('compile CLI rejects stale or forged manifest evidence and locked items without real reviews', async () => {
  const fixture = new URL('../fixtures/project-ready/', import.meta.url);
  const makeCopy = async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedance-manifest-evidence-'));
    await cp(fixture, root, { recursive: true });
    return root;
  };

  const staleRoot = await makeCopy();
  const stalePath = join(staleRoot, 'assets/segment-001-asset-manifest.json');
  const stale = JSON.parse(await readFile(stalePath, 'utf8'));
  stale.items[0].responsibility = 'forged responsibility after approval';
  await writeFile(stalePath, JSON.stringify(stale, null, 2));
  await assert.rejects(runCompileSeedance([
    '--project', staleRoot, '--segment', 'segment-001'
  ]), /manifest human review checksum binding/);

  const forgedRoot = await makeCopy();
  const reviewPath = join(forgedRoot, 'reviews/review-segment-001-assets.json');
  const forged = JSON.parse(await readFile(reviewPath, 'utf8'));
  await writeFile(reviewPath, JSON.stringify({ ...forged, actor: 'model' }));
  await assert.rejects(runCompileSeedance([
    '--project', forgedRoot, '--segment', 'segment-001'
  ]), /manifest human review checksum binding/);

  const missingItemReviewRoot = await makeCopy();
  await rm(join(missingItemReviewRoot, 'reviews/review-segment-001-storyboard.json'));
  await assert.rejects(runCompileSeedance([
    '--project', missingItemReviewRoot, '--segment', 'segment-001'
  ]), /artifact review checksum binding.*segment-001-storyboard/);
});

test('compile CLI rejects ambiguous highest-revision locked segmentation artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seedance-segmentation-conflict-'));
  await mkdir(join(root, 'segments'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  const segmentation = id => ({
    id, type: 'segmentation', revision: 2, status: 'locked', path: `segments/${id}.json`,
    lockedByReviewId: `review-${id}`
  });
  const prompt = {
    id: 'prompt-001', type: 'seedance_prompt', revision: 1, status: 'locked',
    path: 'prompts/segment-001.txt', lockedByReviewId: 'review-prompt', segmentId: 'segment-001'
  };
  await writeFile(join(root, 'project-state.json'), JSON.stringify({
    artifacts: [segmentation('seg-a'), segmentation('seg-b'), prompt]
  }));
  await writeFile(join(root, 'assets', 'segment-001-asset-manifest.json'), JSON.stringify(project().assetManifest));
  await assert.rejects(runCompileSeedance(['--project', root, '--segment', 'segment-001']), /multiple locked segmentation artifacts.*revision 2/);
});

test('canonical loader can require a locked segmentation artifact and ignores loose directory files when present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seedance-canonical-'));
  await mkdir(join(root, 'segments'));
  await writeFile(join(root, 'segments', 'loose.json'), JSON.stringify({ id: 'loose-segment' }));
  await assert.rejects(
    loadCanonicalSegments(root, { artifacts: [] }, { requireLockedSegmentation: true }),
    /locked segmentation artifact is required/
  );

  const approved = { segments: [segment] };
  const approvedText = JSON.stringify(approved);
  const approvedSha = createHash('sha256').update(approvedText).digest('hex');
  await mkdir(join(root, 'reviews'));
  await writeFile(join(root, 'segments', 'approved.json'), approvedText);
  const artifact = {
    id: 'segmentation-001', type: 'segmentation', revision: 1, status: 'locked',
    path: 'segments/approved.json', lockedByReviewId: 'review-segmentation-001', sha256: approvedSha
  };
  await writeFile(join(root, 'reviews', 'review-segmentation-001.json'), JSON.stringify({
    artifactId: artifact.id, actor: 'human', decision: 'approved', artifactSha256: approvedSha
  }));
  assert.deepEqual(
    await loadCanonicalSegments(root, { artifacts: [artifact] }, { requireLockedSegmentation: true }),
    [segment]
  );
});
