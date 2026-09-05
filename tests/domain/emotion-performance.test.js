import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPromptContainsEmotionPerformanceContinuity,
  assertPromptExcludesEmotionPerformanceCapsule,
  assertShotPerformanceRouting,
  lintEmotionPerformancePlan,
  renderEmotionPerformanceCapsule,
  renderEmotionPerformanceContinuity
} from '../../src/domain/emotion-performance.js';

const plan = () => ({
  dlcId: 'emotion-performance-v1',
  templateSource: 'knowledge/capabilities/dlc/emotion-performance.md',
  skillsApplied: ['seedance2-prompt', 'seedance-characters'],
  focusedCharacter: 'Character A',
  objective: '不让对方看出自己舍不得',
  subtext: '嘴上赶人，身体仍在挽留',
  trigger: 'Character B 转身时，衣料发出轻微摩擦声',
  performanceRegister: 'restrained_realism',
  intensity: 'restrained',
  dominantTrack: 'eyes',
  startBehavior: '视线先追向 Character B 的背影，又立即落到地面',
  primaryAction: '右手抬起一半后停在两人之间，指尖慢慢收回',
  supportingCues: ['呼吸停半拍后变轻', '肩膀轻微内收'],
  voiceBreath: '先用鼻腔短吸气，再压低声音说完台词，尾音收住',
  endBehavior: '右手落回身侧，视线仍停在 Character B 离开的方向',
  continuityCarry: ['眼眶保持湿润但不落泪', '人物仍站在原位置'],
  backgroundCharacters: [{ characterTag: 'Character B', persistentMicroMotion: '保持向门口转身的动作，只让衣摆随惯性轻摆' }]
});

const shot = () => ({ shotId: 'shot-001', performanceMode: 'emotion_dlc', performancePlan: plan() });

const planV2 = () => ({
  ...plan(),
  actingControlVersion: 2,
  hasDialogue: true,
  obstacle: 'Character B 已经把钥匙推到桌面中央，人物不能假装没有看见',
  tactic: '先维持低头核对票据，再用停住的手拒绝接钥匙',
  beatPlan: [
    { tactic: '维持平静', visibleChange: '拇指继续压着票据边缘，视线没有提前抬起' },
    { tactic: '拒绝接物', visibleChange: '右手伸到钥匙旁后停住，吞咽后短呼气' }
  ],
  performanceArc: {
    protectiveStrategy: '继续低头核对票据，假装这只是一次普通交接',
    fractureTrigger: 'Character B 说出“还给你”并把钥匙推到桌面中央',
    exposedState: '右手伸出后停住，眉间短暂收紧，呼吸卡住半拍',
    chosenAction: 'Character A 把右手掌翻向上但不接钥匙，视线重新看向 Character B',
    externalFeedback: 'Character B 看见钥匙未被接走后收回手指，身体重心退回椅背',
    recoveryState: '眉间松开，手掌翻向上但不接钥匙，视线重新停在 Character B 眼睛位置'
  },
  dialoguePerformance: [{
    speaker: 'Character B',
    respondingCharacter: 'Character A',
    lineText: '钥匙还给你',
    triggerCue: '把钥匙推到桌面中央并说出“还给你”',
    stressPhrase: '还给你',
    preSpeechState: 'Character A 仍低头看票据，右手停在自己一侧',
    visibleResponse: '听到“还给你”后视线先抬起，右手随后伸出又停住',
    voiceBreathPause: 'Character B 在重音前停半拍，Character A 听完后短吸气',
    postSpeechState: 'Character A 没有接钥匙，手掌翻向上并保持对视'
  }],
  performanceEnvelope: {
    onset: '听到重音后眉间开始收紧，下眼睑随视线抬起而绷住',
    apex: '右手停在钥匙旁时眉间最紧，呼吸同时停住半拍',
    offset: '手掌翻向上时眉间松开，压力转移到压低的声线'
  },
  facialCalibration: {
    observableAction: '眉间逐渐收紧，下眼睑短暂绷住，随后在开口前松开',
    facsAuHints: ['AU4', 'AU7']
  },
  prohibitedEarlyReactions: [{
    respondingCharacter: 'Character A',
    reaction: 'Character A 不抬眼、不伸手、不收紧眉间',
    stressPhrase: '还给你',
    untilCue: 'Character B 说出“还给你”'
  }]
});

const shotV2 = () => ({ shotId: 'shot-002', performanceMode: 'emotion_dlc', performancePlan: planV2() });

test('emotion DLC requires a compact traceable performance plan', () => {
  const value = shot();
  assert.equal(assertShotPerformanceRouting(value), value);
  assert.throws(() => assertShotPerformanceRouting({ shotId: 'shot-001', performanceMode: 'emotion_dlc' }), /performancePlan/);
  assert.throws(() => assertShotPerformanceRouting({ ...shot(), performancePlan: { ...plan(), supportingCues: ['一', '二', '三'] } }), /1-2/);
});

test('emotion performance lint rejects abstract-only acting cues', () => {
  assert.equal(lintEmotionPerformancePlan(plan()).passed, true);
  const result = lintEmotionPerformancePlan({ ...plan(), primaryAction: '她非常难过' });
  assert.equal(result.passed, false);
  assert.match(result.errors[0], /abstract emotion/);
  const disguised = lintEmotionPerformancePlan({ ...plan(), primaryAction: '她非常悲伤，眼睛很难过' });
  assert.equal(disguised.passed, false);
});

test('v2 acting control requires a causal arc, dialogue clock and early-reaction guard', () => {
  const value = shotV2();
  assert.equal(assertShotPerformanceRouting(value), value);
  assert.equal(lintEmotionPerformancePlan(value.performancePlan).passed, true);
  assert.throws(
    () => assertShotPerformanceRouting({ ...value, performancePlan: { ...planV2(), actingControlVersion: undefined } }),
    /v2 fields require actingControlVersion 2/
  );
  const withoutDialogue = planV2();
  delete withoutDialogue.dialoguePerformance;
  assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: withoutDialogue }), /hasDialogue is true/);
  const withoutGuard = planV2();
  delete withoutGuard.prohibitedEarlyReactions;
  assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: withoutGuard }), /prohibitedEarlyReactions/);
  const abstractGuard = planV2();
  abstractGuard.prohibitedEarlyReactions[0].reaction = 'Character A 不要提前悲伤';
  assert.equal(lintEmotionPerformancePlan(abstractGuard).passed, false);
  assert.ok(lintEmotionPerformancePlan(abstractGuard).errors.some(item => item.includes('prohibitedEarlyReactions[0].reaction')));

  const silent = planV2();
  silent.hasDialogue = false;
  silent.voiceBreath = '无台词，仅保留一次短吸气和环境声';
  delete silent.dialoguePerformance;
  assert.doesNotThrow(() => assertShotPerformanceRouting({ ...value, performancePlan: silent }));

  const hiddenDialogue = planV2();
  hiddenDialogue.hasDialogue = false;
  hiddenDialogue.voiceBreath = '无台词，但她压低声线念出“别走”，尾音收住';
  delete hiddenDialogue.dialoguePerformance;
  assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: hiddenDialogue }), /hasDialogue cannot be false/);

  for (const voiceBreath of ['无台词，但她轻声说“别走”，随后呼气', '她说：“别走”，尾音收住', '她轻声讲“别走”，尾音收住', 'Character A says “Do not leave.” then exhales']) {
    const quotedDialogue = planV2();
    quotedDialogue.hasDialogue = false;
    quotedDialogue.voiceBreath = voiceBreath;
    delete quotedDialogue.dialoguePerformance;
    assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: quotedDialogue }), /hasDialogue cannot be false/);
  }

  const badLine = planV2();
  badLine.dialoguePerformance[0].stressPhrase = '别走';
  assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: badLine }), /stressPhrase must occur in lineText/);

  const selfReaction = planV2();
  selfReaction.dialoguePerformance[0].respondingCharacter = 'Character B';
  assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: selfReaction }), /must differ from speaker/);

  const unboundGuard = planV2();
  unboundGuard.prohibitedEarlyReactions[0].stressPhrase = '还';
  assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: unboundGuard }), /guard bound to respondingCharacter and stressPhrase/);

  const wrongResponder = planV2();
  wrongResponder.prohibitedEarlyReactions[0].respondingCharacter = 'Character B';
  assert.throws(() => assertShotPerformanceRouting({ ...value, performancePlan: wrongResponder }), /respondingCharacter and stressPhrase/);
});

test('v2 face-dominant or explosive acting requires onset, apex and offset', () => {
  const withoutEnvelope = planV2();
  delete withoutEnvelope.performanceEnvelope;
  assert.throws(
    () => assertShotPerformanceRouting({ shotId: 'shot-face', performanceMode: 'emotion_dlc', performancePlan: { ...withoutEnvelope, dominantTrack: 'face', intensity: 'clear' } }),
    /performanceEnvelope is required/
  );
  assert.throws(
    () => assertShotPerformanceRouting({ shotId: 'shot-explosive', performanceMode: 'emotion_dlc', performancePlan: { ...withoutEnvelope, intensity: 'explosive' } }),
    /performanceEnvelope is required/
  );
  assert.doesNotThrow(
    () => assertShotPerformanceRouting({ shotId: 'shot-restrained-face', performanceMode: 'emotion_dlc', performancePlan: { ...withoutEnvelope, dominantTrack: 'face', intensity: 'restrained' } })
  );
  const vagueEnvelope = planV2();
  vagueEnvelope.performanceEnvelope = { onset: '进入阶段', apex: '峰值阶段', offset: '退出阶段' };
  const vagueLint = lintEmotionPerformancePlan(vagueEnvelope);
  assert.equal(vagueLint.passed, false);
  assert.ok(vagueLint.errors.some(item => /performanceEnvelope\.onset/.test(item)));
});

test('archived capsule keeps audit detail but never carries the private subtext', () => {
  const capsule = renderEmotionPerformanceCapsule(shot());
  assert.match(capsule, /动作必须由触发引起/);
  assert.doesNotMatch(capsule, /嘴上赶人，身体仍在挽留/);
});

test('archives a bounded pressure-and-response beat plan without placing it in continuity output', () => {
  const enriched = shot();
  enriched.performancePlan.obstacle = '对方已经把钥匙推到桌面中央，人物不能假装没有看见';
  enriched.performancePlan.tactic = '先停住伸出的手，再抬眼逼对方回应';
  enriched.performancePlan.beatPlan = [
    { tactic: '克制停住', visibleChange: '手掌停在钥匙旁，吞咽后短呼气' },
    { tactic: '建立压力', visibleChange: '视线抬向对方眼睛，肩膀保持压低' }
  ];
  const capsule = renderEmotionPerformanceCapsule(enriched);
  const continuity = renderEmotionPerformanceContinuity(enriched);
  assert.match(capsule, /阻碍：对方已经把钥匙推到桌面中央/);
  assert.match(capsule, /可见节拍：1\.克制停住/);
  assert.doesNotMatch(continuity, /阻碍：|可见节拍：/);
});

test('only the continuity contract reaches the model prompt', () => {
  const narration = { shots: [shot()] };
  const block = renderEmotionPerformanceContinuity(shot());
  assert.match(block, /结束状态/);
  assert.match(block, /连续保留/);
  // Audit-only fields must not be re-weighted into the shot.
  assert.doesNotMatch(block, /表演质感/);
  assert.doesNotMatch(block, /动作必须由触发引起/);
  assert.throws(() => assertPromptContainsEmotionPerformanceContinuity('普通视频提示词', narration), /missing the exact/);
  assert.equal(assertPromptContainsEmotionPerformanceContinuity(`普通视频提示词\n${block}`, narration), true);
});

test('v2 archive keeps AU calibration while model-facing continuity contains only the natural-language timing guard', () => {
  const capsule = renderEmotionPerformanceCapsule(shotV2());
  const continuity = renderEmotionPerformanceContinuity(shotV2());
  assert.match(capsule, /保护策略与裂缝/);
  assert.match(capsule, /AU审计线索=AU4、AU7/);
  assert.match(continuity, /禁止提前反应：反应观察者=Character A；画内动作禁令=Character A 不抬眼、不伸手、不收紧眉间（重音=还给你；直到Character B 说出“还给你”）/);
  assert.doesNotMatch(continuity, /FACS|AU4|AU7|保护策略与裂缝/);
});

test('embedding the full performance capsule in the prompt is rejected', () => {
  const capsule = renderEmotionPerformanceCapsule(shot());
  assert.throws(() => assertPromptExcludesEmotionPerformanceCapsule(`镜头正文\n${capsule}`), /must not embed/);
  assert.equal(assertPromptExcludesEmotionPerformanceCapsule('镜头正文'), true);
});
