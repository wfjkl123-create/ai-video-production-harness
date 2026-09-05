import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lintSeedanceExecutionPrompt,
  lintSeedanceNarrativePerformance,
  requireCleanSeedanceExecutionPrompt,
  requireSeedanceNarrativePerformancePrompt
} from '../../src/services/seedance-prompt-lint-service.js';
import { compileSeedanceMediaBoundPrompt } from '../../src/services/seedance-media-binding-service.js';

test('accepts a self-contained prompt whose indexed media references are bound', () => {
  const result = lintSeedanceExecutionPrompt(
    '@图1只锁人物身份。@图2只锁场景。@音频1只锁对白时钟。生成独立完整的真人短片。',
    { imageCount: 2, videoCount: 0, audioCount: 1 }
  );
  assert.equal(result.decision, 'PASS');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('rejects human audit appendices, hidden context and media indexes that are not bound', () => {
  const text = '按之前的设定生成。@图3负责场景。\n## Skill 自检\n- 已检查';
  const result = lintSeedanceExecutionPrompt(text, { imageCount: 2, videoCount: 0, audioCount: 0 });
  assert.equal(result.decision, 'FAIL');
  assert.deepEqual(result.errors.map(item => item.code), [
    'IMPLICIT_PRIOR_CONTEXT',
    'HUMAN_REVIEW_TEXT_IN_EXECUTION_PROMPT',
    'UNBOUND_MEDIA_REFERENCE'
  ]);
});

test('rejects internal director and continuity contract labels in model-facing text', () => {
  const result = lintSeedanceExecutionPrompt(
    '【story-spine-v1】内部故事字段。\n【performance-continuity-v1｜S01】内部连续性字段。',
    { imageCount: 0, videoCount: 0, audioCount: 0 }
  );
  assert.equal(result.decision, 'FAIL');
  assert.ok(result.errors.some(item => item.code === 'INTERNAL_DIRECTOR_METADATA_IN_EXECUTION_PROMPT'));
});

test('keeps FACS and AU codes in audit metadata while accepting natural-language facial action', () => {
  const coded = lintSeedanceExecutionPrompt('听到关键词后眉间收紧、下眼睑绷住，使用AU4与AU7。');
  assert.equal(coded.decision, 'FAIL');
  assert.ok(coded.errors.some(item => item.code === 'INTERNAL_FACS_METADATA_IN_EXECUTION_PROMPT'));

  const uncoded = lintSeedanceExecutionPrompt('眉间逐渐收紧，内部再用Action Unit与AU校准。');
  assert.equal(uncoded.decision, 'FAIL');
  assert.ok(uncoded.errors.some(item => item.code === 'INTERNAL_FACS_METADATA_IN_EXECUTION_PROMPT'));

  const visible = lintSeedanceExecutionPrompt('听到关键词后眉间逐渐收紧，下眼睑短暂绷住，开口前两处变化都松开。');
  assert.equal(visible.decision, 'PASS');
});

test('rejects original-video language when no video is in the compiled package', () => {
  assert.throws(
    () => requireCleanSeedanceExecutionPrompt('复刻原视频的动作。@图1只锁人物。', {
      imageCount: 1, videoCount: 0, audioCount: 0
    }),
    /UNBOUND_SOURCE_VIDEO_REFERENCE/
  );
  assert.doesNotThrow(() => requireCleanSeedanceExecutionPrompt('参考视频@视频1只控制动作。', {
    imageCount: 0, videoCount: 1, audioCount: 0
  }));
});

test('rejects free aliases and prior-segment language that a zero-context model cannot resolve', () => {
  const result = lintSeedanceExecutionPrompt('@产品图锁产品，外观与上一段完全一致。', {
    imageCount: 1, videoCount: 0, audioCount: 0
  });
  assert.equal(result.decision, 'FAIL');
  assert.ok(result.errors.some(item => item.code === 'IMPLICIT_PRIOR_CONTEXT'));
  assert.ok(result.errors.some(item => item.code === 'UNSUPPORTED_MEDIA_ALIAS'));
  assert.ok(result.errors.some(item => item.code === 'MEDIA_ROLES_NOT_INDEXED'));
});

test('accepts clean compiled text and rejects media-binding audit headers', () => {
  const packageValue = {
    imageInputs: [{ id: 'product-v1', sha256: 'a'.repeat(64) }], videoInputs: [], audioInputs: [],
    responsibilityMap: { 'product-v1': { controls: ['product_structure'], mustNotControl: ['scene'] } }
  };
  const compiled = compileSeedanceMediaBoundPrompt('只展示@素材[product-v1]。', packageValue);
  assert.equal(lintSeedanceExecutionPrompt(compiled.text, { bindings: compiled.bindings }).decision, 'PASS');
  const tampered = `【参考素材｜本次实际上传】\n@图1=product-v1｜R1\nR1｜控:product_structure\n\n【执行提示词正文】\n${compiled.text}`;
  const result = lintSeedanceExecutionPrompt(tampered, { bindings: compiled.bindings });
  assert.equal(result.decision, 'FAIL');
  assert.ok(result.errors.some(item => item.code === 'INTERNAL_MEDIA_BINDING_METADATA_IN_EXECUTION_PROMPT'));
});

test('blocks abstract multi-person dialogue even when ordinary zero-context lint passes', () => {
  const text = '两个人自然聊天。甲说：“你怎么还穿这个？”乙尴尬地回答：“那我穿什么？”不要僵硬，不要假笑，不要字幕，不要文字，不要水印，不要夸张，不要卡顿，不要多余动作，不要塑料皮肤。';
  assert.equal(lintSeedanceExecutionPrompt(text).decision, 'PASS');
  const result = lintSeedanceNarrativePerformance(text);
  assert.equal(result.applicable, true);
  assert.equal(result.decision, 'FAIL');
  assert.ok(result.errors.some(item => item.code === 'MISSING_PERFORMANCE_TIMELINE'));
  assert.ok(result.errors.some(item => item.code === 'ABSTRACT_EMOTION_WITHOUT_CARRIER'));
  assert.ok(result.errors.some(item => item.code === 'NEGATIVE_OVERLOAD'));
  assert.doesNotThrow(() => requireCleanSeedanceExecutionPrompt(text));
  assert.throws(() => requireSeedanceNarrativePerformancePrompt(text), error => error.code === 'SEEDANCE_NARRATIVE_PERFORMANCE_LINT_FAILED');
});

test('accepts timecoded dialogue with visible trigger, body leak, choice, listener response and end state', () => {
  const text = '0-1秒：乙原本捏着包带，甲看到后视线从衣领移到乙脸上。1-3秒：甲下颌轻收，开口说：“这件不合适。”听者乙听见后拇指停住，没有立刻转头。3-5秒：乙眼睛先看向甲，头晚半拍跟过去，选择松开包带，开口问：“那我穿什么？”对方甲肩膀放松一点。5-6秒：收尾末态保持两人原位，远处路人经过，人物没有定格。';
  const result = lintSeedanceNarrativePerformance(text);
  assert.equal(result.applicable, true);
  assert.equal(result.decision, 'PASS');
  assert.doesNotThrow(() => requireCleanSeedanceExecutionPrompt(text));
  assert.doesNotThrow(() => requireSeedanceNarrativePerformancePrompt(text));
});

test('does not count compiler governance labels or emphasis anchors as dialogue negatives', () => {
  const core = '0-1秒：人物看到产品，视线移向手指。1-2秒：人物说到舒服后才靠近，开口说：“真的很舒服。”听者从镜头看见她的呼吸变化，肩膀放松，没有立刻移开视线。2-3秒：她选择继续看向镜头，手指松开布料。3-4秒：最后保持原位，留下呼吸余波。';
  const governance = Array.from({ length: 6 }, (_, index) => `【director-constraints-v1｜S0${index + 1}】\n动作终点：人物保持当前末态。\n禁止动作：机械重复\n【/director-constraints-v1｜S0${index + 1}】\n【performance-continuity-v1｜S0${index + 1}｜person-a】\n禁止提前反应：直到原音频说出“舒服”才进入下一动作。\n结束状态：人物保持当前末态。\n连续保留：身份和位置不变。\n【/performance-continuity-v1｜S0${index + 1}】`).join('\n');
  const result = lintSeedanceNarrativePerformance(`${core}\n${governance}`);
  assert.equal(result.decision, 'PASS');
  assert.ok(!result.errors.some(item => item.code === 'NEGATIVE_OVERLOAD'));
});

test('mismatched governance block types or Shot IDs cannot hide negative prose', () => {
  const core = '0-1秒：人物看到产品，视线移向手指。1-2秒：人物说到舒服后才靠近，开口说：“真的很舒服。”听者从镜头看见她的呼吸变化，肩膀放松，没有立刻移开视线。2-3秒：她选择继续看向镜头，手指松开布料。3-4秒：最后保持原位，留下呼吸余波。';
  const malformed = '【director-constraints-v1｜S01】禁止挥手，不要假笑，不得跳切，不能重置，避免穿模，无字幕，无文字，无水印，不看镜头。【/performance-continuity-v1｜S02】';
  const execution = lintSeedanceExecutionPrompt(`${core}\n${malformed}`);
  assert.equal(execution.decision, 'FAIL');
  assert.ok(execution.errors.some(item => item.code === 'INTERNAL_DIRECTOR_METADATA_IN_EXECUTION_PROMPT'));
  const narrative = lintSeedanceNarrativePerformance(`${core}\n${malformed}`);
  assert.equal(narrative.decision, 'FAIL');
  assert.ok(narrative.errors.some(item => item.code === 'NEGATIVE_OVERLOAD'));
});

test('counts real dialogue longer than 100 characters', () => {
  const longLine = 'This deliberately long spoken sentence contains more than one hundred characters so the validator must keep the whole real dialogue turn instead of silently dropping it.';
  const text = `0-1秒：人物看到产品，视线移向手指。1-2秒：人物说到舒服后才靠近，开口说：“${longLine}”听者从镜头看见她的呼吸变化，肩膀放松，没有立刻移开视线。2-3秒：她选择继续看向镜头，手指松开布料。3-4秒：最后保持原位，留下呼吸余波。`;
  assert.equal(lintSeedanceNarrativePerformance(text).decision, 'PASS');
});

test('treats an explicitly visible body posture as the carrier for natural performance', () => {
  const text = '0-1秒：人物身体自然前倾，看到镜头后的听者后目光保持在镜头中心。1-3秒：她嘴角收住，开口说：“这件会越来越难受。”听者听见后从镜头看见她的呼吸变化，她没有立刻移开视线。3-5秒：她选择继续锁住镜头，肩膀慢慢放松。5-6秒：最后保持原位，留下呼吸余波。';
  const result = lintSeedanceNarrativePerformance(text);
  assert.equal(result.decision, 'PASS');
  assert.ok(!result.errors.some(item => item.code === 'ABSTRACT_EMOTION_WITHOUT_CARRIER'));
});

test('does not impose dialogue timing on non-narrative prompts', () => {
  const result = lintSeedanceNarrativePerformance('产品在白色台面上缓慢旋转，光线扫过材质。');
  assert.equal(result.applicable, false);
  assert.equal(result.decision, 'PASS');
});

test('applies the performance gate to one spoken line and to silent relationship acting', () => {
  const spoken = lintSeedanceNarrativePerformance('人物甲开口说：“你还好吗？”');
  assert.equal(spoken.applicable, true);
  assert.equal(spoken.decision, 'FAIL');
  const silent = lintSeedanceNarrativePerformance('两个人物对视，关系从回避变成接受。');
  assert.equal(silent.applicable, true);
  assert.equal(silent.decision, 'FAIL');
});

test('native source replacement does not invent a second dialogue-performance timeline', () => {
  const prompt = '人物甲开口说：“沿用原片台词。”原片是人物、动作、台词、口型和声音的唯一事实权威；只把原产品替换成目标产品。';
  assert.throws(() => requireSeedanceNarrativePerformancePrompt(prompt), /narrative performance lint failed/);
  const result = requireSeedanceNarrativePerformancePrompt(prompt, { sourceControlledPerformance: true });
  assert.equal(result.applicable, false);
  assert.equal(result.decision, 'PASS');
});

test('applies the performance gate to ordinary quoted speech verbs without role keywords', () => {
  for (const text of ['甲说：“你走吧。”乙沉默。', '甲轻声讲“你走吧。”乙沉默。', 'Character A says “Please leave.” Character B stays silent.']) {
    const result = lintSeedanceNarrativePerformance(text);
    assert.equal(result.applicable, true);
    assert.equal(result.decision, 'FAIL');
    assert.ok(result.errors.some(item => item.code === 'MISSING_PERFORMANCE_TIMELINE'));
  }
});

test('reference-video identity edit uses locked source cuts instead of inventing three performance beats', () => {
  const text = '0–5.7 秒：保持@视频1的第一个完整镜头，人物看到对象后视线和呼吸服从原片。5.7–6.633333 秒：保持第二个完整镜头直到参考结尾。6.633333–7 秒：只保持最后一帧末态。参考视频@视频1是除脸内身份外全部画面、表演和声音时钟的唯一权威；全片唯一允许的变化是面部身份替换。';
  const options = {
    mode: 'reference_video_identity_edit',
    expectedCutTimesSec: [5.7],
    sourceExactSeconds: 6.633333,
    requestedDurationSeconds: 7
  };
  const result = lintSeedanceNarrativePerformance(text, options);
  assert.equal(result.decision, 'PASS');
  assert.doesNotThrow(() => requireCleanSeedanceExecutionPrompt(text, {
    videoCount: 1,
    narrativePerformance: options
  }));
});

test('reference-video identity edit rejects artificial boundaries and internal shot labels', () => {
  const text = '0–2.2 秒：F01保持@视频1。2.2–5.7 秒：保持@视频1。5.7–6.633333 秒：保持@视频1。6.633333–7 秒：保持末态。参考视频@视频1是除脸内身份外全部画面、表演和声音时钟的唯一权威；全片只做一次最小差异换脸。';
  const result = lintSeedanceNarrativePerformance(text, {
    mode: 'reference_video_identity_edit',
    expectedCutTimesSec: [5.7],
    sourceExactSeconds: 6.633333,
    requestedDurationSeconds: 7
  });
  assert.equal(result.decision, 'FAIL');
  assert.ok(result.errors.some(item => item.code === 'REFERENCE_EDIT_TIMELINE_MISMATCH'));
  assert.ok(result.errors.some(item => item.code === 'REFERENCE_EDIT_INTERNAL_LABEL'));
});
