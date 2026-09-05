import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSceneAuthority, extractSceneTerms } from '../../src/services/scene-authority-check.js';

test('extracts Chinese and English scene terms from prompt text', () => {
  assert.deepEqual(extractSceneTerms('四名女性在客厅里接龙喊话'), ['客厅']);
  assert.deepEqual(extractSceneTerms('on the beach, bright sunlight'), ['沙滩']);
  assert.deepEqual(extractSceneTerms(''), []);
  assert.deepEqual(extractSceneTerms(null), []);
});

test('english aliases require word boundaries', () => {
  assert.deepEqual(extractSceneTerms('first_frame_beach_v2.png'), ['沙滩']);
  assert.deepEqual(extractSceneTerms('a care package arrives'), []);
});

test('warns when a scene-controlling medium declares a different scene than the prompt', () => {
  const result = checkSceneAuthority({
    prompt: '客厅场景，四名女性接龙喊话，同一明亮客厅。',
    media: [
      { id: 'first-frame-beach-v2', kind: 'image', path: '/x/first_frame_beach_v2.png', controls: ['人物身份', '场景结构', '光线方向'] },
      { id: 'depth-first12', kind: 'video', path: '/x/depth-first12/segment-001.mp4', controls: ['空间前后关系', '站位调度'] }
    ]
  });
  assert.deepEqual(result.promptScenes, ['客厅']);
  assert.equal(result.sceneControllingMedia.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /first-frame-beach-v2/);
  assert.match(result.warnings[0], /沙滩/);
  assert.match(result.warnings[0], /客厅/);
});

test('no warning when scene hints agree with the prompt', () => {
  const result = checkSceneAuthority({
    prompt: '沙滩场景，四名女性接龙喊话。',
    media: [
      { id: 'first-frame-beach-v2', kind: 'image', path: '/x/first_frame_beach_v2.png', controls: ['场景结构'] }
    ]
  });
  assert.equal(result.warnings.length, 0);
});

test('no warning when a scene-controlling medium carries no detectable scene hint', () => {
  const result = checkSceneAuthority({
    prompt: '客厅场景。',
    media: [
      { id: 'depth-first12', kind: 'video', path: '/x/depth-first12/segment-001.mp4', controls: ['空间前后关系'] }
    ]
  });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.mediaDeclarations[0].controlsScene, true);
  assert.deepEqual(result.mediaDeclarations[0].sceneHints, []);
});

test('media without scene control responsibility never warns', () => {
  const result = checkSceneAuthority({
    prompt: '客厅场景。',
    media: [
      { id: 'audio-beach-take', kind: 'audio', path: '/x/audio_beach.mp3', controls: ['说话节奏', '情绪力度'] }
    ]
  });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.mediaDeclarations[0].controlsScene, false);
});
