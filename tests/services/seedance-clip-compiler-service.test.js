import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSeedanceClipPlan, composeClipPrompt } from '../../src/services/seedance-clip-compiler-service.js';

const media = (id, start, end) => ({
  id, mediaKind: 'audio', path: `audio/${id}.wav`, sha256: 'a'.repeat(64), derived: true,
  derivedFromArtifactId: 'audio-parent', derivedFromReviewId: 'review-audio-parent', trim: { start, end },
  controls: ['dialogue words', 'dialogue timing'], mustNotControl: ['visual identity']
});

const clip = (id, start, end) => ({
  id, parentSegmentId: 'segment-001', start, end, generationDuration: Math.ceil(end-start), promptPath: `prompts/${id}.md`, narrationPath: `prompts/${id}.json`,
  outputDirectory: `prompts/${id}`, media: [media(`audio-${id}`, start, end)]
});

test('accepts exactly two contiguous clip contracts under one parent segment', () => {
  const plan = { id: 'plan-1', parentSegmentId: 'segment-001', clips: [clip('segment-001a', 0, 7.083), clip('segment-001b', 7.083, 13.283333)] };
  assert.equal(assertSeedanceClipPlan(plan), plan);
});

test('rejects gaps and audio trims that do not match clip boundaries', () => {
  assert.throws(() => assertSeedanceClipPlan({ id: 'plan-1', parentSegmentId: 'segment-001', clips: [clip('a', 0, 7), clip('b', 7.1, 13)] }), /contiguous/);
  const second = clip('b', 7, 13); second.media[0].trim.end = 12;
  assert.throws(() => assertSeedanceClipPlan({ id: 'plan-1', parentSegmentId: 'segment-001', clips: [clip('a', 0, 7), second] }), /trim must exactly match/);
});

const continuityNarration = {
  id: 'narration-a', segmentId: 'segment-001a', sourceSegmentId: 'segment-001', revision: 1, status: 'draft',
  shots: [{
    shotId: 'P01', physicalActions: ['角色抬眼后把手停在桌边'], cameraMove: '固定中景', lightSources: ['左侧窗光'],
    emotionThroughAction: '角色抬眼并把肩膀收紧', performanceMode: 'emotion_dlc',
    performancePlan: {
      dlcId: 'emotion-performance-v1', templateSource: 'knowledge/capabilities/dlc/emotion-performance.md',
      skillsApplied: ['seedance2-prompt', 'seedance-characters'], focusedCharacter: '角色A', objective: '保持镇定',
      subtext: '不愿暴露紧张', trigger: '角色B把钥匙放到桌面', performanceRegister: 'restrained_realism',
      intensity: 'restrained', dominantTrack: 'hands', startBehavior: '角色A的手停在桌边',
      primaryAction: '角色A抬眼后把手掌压在桌边', supportingCues: ['肩膀轻微收紧'],
      voiceBreath: '角色A闭唇并缓慢呼气', endBehavior: '角色A的手掌停在桌边，视线看向角色B',
      continuityCarry: ['钥匙仍在桌面'], backgroundCharacters: []
    }
  }]
};

const continuityBlock = [
  '【performance-continuity-v1｜P01｜角色A】',
  '结束状态：角色A的手掌停在桌边，视线看向角色B',
  '连续保留：钥匙仍在桌面',
  '【/performance-continuity-v1｜P01】'
].join('\n');

test('preserves an exact shot-local continuity block instead of appending it at the clip tail', () => {
  const source = `P01正文\n\n${continuityBlock}\n\nP02正文`;
  assert.equal(composeClipPrompt(source, continuityNarration), `${source}\n`);
});

test('keeps legacy tail append when the source prompt omits continuity blocks', () => {
  assert.equal(composeClipPrompt('P01正文', continuityNarration), `P01正文\n\n${continuityBlock}\n`);
});
