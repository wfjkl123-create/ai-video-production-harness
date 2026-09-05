import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertShotNarration, lintShotNarration, shotAuthorityBindings } from '../../src/domain/shot-narration.js';

const goodShot = () => ({
  shotId: 'shot-001',
  physicalActions: ['她抬手揉了揉太阳穴，把碗放到桌上'],
  cameraMove: '缓慢推近',
  lightSources: ['左前方暖光'],
  emotionThroughAction: '嘴角牵起一个疲惫的半笑'
});

const narration = (overrides = {}) => ({
  id: 'narration-001', segmentId: 'segment-001', sourceSegmentId: 'segment-001',
  revision: 1, status: 'draft', shots: [goodShot()], ...overrides
});

test('assertShotNarration validates structure and rejects gaps', () => {
  const value = narration();
  assert.equal(assertShotNarration(value), value);
  assert.throws(() => assertShotNarration({ ...narration(), shots: [] }), /shots must be a non-empty array/);
  assert.throws(() => assertShotNarration({ ...narration(), shots: [{ ...goodShot(), physicalActions: [] }] }), /physicalActions/);
  assert.throws(() => assertShotNarration({ ...narration(), shots: [{ ...goodShot(), lightSources: [] }] }), /lightSources/);
  assert.throws(() => assertShotNarration({ ...narration(), shots: [{ ...goodShot(), cameraMove: '' }] }), /cameraMove/);
  assert.throws(() => assertShotNarration({ ...narration(), shots: [goodShot(), goodShot()] }), /duplicate shotId/);
});

test('lint passes a disciplined narration', () => {
  const result = lintShotNarration(narration());
  assert.equal(result.passed, true);
  assert.deepEqual(result.errors, []);
});

test('lint blocks pure-emotion physical actions (从宽: only emotion-only entries)', () => {
  const bad = narration({ shots: [{ ...goodShot(), physicalActions: ['她很难过', '非常疲惫'] }] });
  const result = lintShotNarration(bad);
  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /emotion-only/);
});

test('lint stays lenient: emotion word plus a concrete body action passes', () => {
  const ok = narration({ shots: [{ ...goodShot(), physicalActions: ['她疲惫地垂下肩膀，手扶住桌沿'] }] });
  assert.equal(lintShotNarration(ok).passed, true);
});

test('lint enforces shotId subset when the locked segment declares shotIds', () => {
  const result = lintShotNarration(narration({ shots: [{ ...goodShot(), shotId: 'shot-999' }] }), { segmentShotIds: ['shot-001'] });
  assert.equal(result.passed, false);
  assert.match(result.errors[0], /not in the locked segment shot set/);
});

test('lint warns (not blocks) when a light source lacks a direction word', () => {
  const result = lintShotNarration(narration({ shots: [{ ...goodShot(), lightSources: ['暖光'] }] }));
  assert.equal(result.passed, true);
  assert.ok(result.warnings.some(w => /no explicit direction/.test(w)));
});

test('realism v2 requires scene-adapted authority instead of pasting an abstract emotion', () => {
  const realismPlan = {
    focusedCharacter: 'character-a', motivatedAction: '她看向杯沿并把拇指压在杯壁上', physicalEndpoint: '视线停在杯沿，手指保持压住杯壁',
    naturalVariation: '呼吸幅度随台词压力自然变浅', persistentMicroMotions: [],
    forbiddenGenericActions: ['禁止无动机挥手', '禁止呆滞凝视', '禁止标准笑容', '禁止机械重复']
  };
  const withoutAuthority = narration({ shots: [{ ...goodShot(), realismPlan }] });
  assert.equal(lintShotNarration(withoutAuthority, { requireRealismAuthorityV2: true }).passed, false);
  const authorityAdaptation = {
    version: 1,
    characters: [{
      characterId: 'character-a', actingMasterBinding: { id: 'acting-a-v1', revision: 1, sha256: 'a'.repeat(64) },
      identityPackBinding: { id: 'identity-a-v2', revision: 1, sha256: 'b'.repeat(64) },
      selectedMasterCues: [{ masterCueId: 'difficult-family-subject', masterCue: 'difficult family subject', triggerInShot: 'partner names her mother', cameraVisibleAction: 'breath pauses, gaze drops to cup rim, thumb presses the ceramic', }],
      activeStillness: 'shoulders stay held while only breathing and fingertip pressure change', gazeTarget: 'cup rim until the reply begins',
      breathVoice: 'one shallow nasal inhale before the first word', endCarry: 'gaze remains below the partner at the cut'
    }],
    sceneGeometry: { applicability: 'not_applicable', reason: 'single close-up has no reusable room geography or reverse axis' },
    audioStrategy: { strategy: 'native_generate', generateAudio: true }
  };
  const withAuthority = narration({ shots: [{ ...goodShot(), realismPlan, authorityAdaptation }] });
  assert.equal(lintShotNarration(withAuthority, { requireRealismAuthorityV2: true }).passed, true);
  assert.deepEqual(shotAuthorityBindings(withAuthority).map(item => item.expectedType), ['project_asset', 'character_acting_master']);
  const timer = structuredClone(withAuthority);
  timer.shots[0].authorityAdaptation.characters[0].selectedMasterCues[0].triggerInShot = '每隔 3 秒';
  assert.throws(() => assertShotNarration(timer), /fixed-frequency/);
});

test('emotion_dlc narration validates and lints its visible performance contract', () => {
  const performancePlan = {
    dlcId: 'emotion-performance-v1', templateSource: 'knowledge/capabilities/dlc/emotion-performance.md',
    skillsApplied: ['seedance2-prompt', 'seedance-characters'], focusedCharacter: 'Character A',
    objective: '压住不舍', subtext: '嘴上拒绝但手没有真正推开', trigger: '对方把钥匙放到桌面，发出轻响',
    performanceRegister: 'restrained_realism', intensity: 'restrained', dominantTrack: 'hands',
    startBehavior: '视线先落到钥匙，手指停在桌边', primaryAction: '手掌伸到一半后停住，再缓慢翻转向上',
    supportingCues: ['吞咽一次后呼吸变轻'], voiceBreath: '先短吸气，再压低声音说出台词',
    endBehavior: '手掌仍停在钥匙旁，视线重新看向对方', continuityCarry: ['钥匙仍在桌面中央'],
    backgroundCharacters: [{ characterTag: 'Character B', persistentMicroMotion: '保持轻微呼吸，手指仍压在钥匙边缘' }]
  };
  const value = narration({ shots: [{ ...goodShot(), performanceMode: 'emotion_dlc', performancePlan }] });
  assert.equal(lintShotNarration(value).passed, true);
  assert.ok(lintShotNarration(value).warnings.some(message => /legacy emotion-performance-v1/.test(message)));
  const currentWrite = lintShotNarration(value, { requireActingControlV2: true });
  assert.equal(currentWrite.passed, false);
  assert.ok(currentWrite.errors.some(message => /actingControlVersion 2/.test(message)));
});

test('shot narration schema requires both canonical performance skills', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/shot-narration.schema.json', import.meta.url), 'utf8'));
  const skillsApplied = schema.properties.shots.items.properties.performancePlan.properties.skillsApplied;
  assert.deepEqual(skillsApplied.allOf, [
    { contains: { const: 'seedance2-prompt' } },
    { contains: { const: 'seedance-characters' } }
  ]);
  const requiredBySchema = skillsApplied.allOf.map(rule => rule.contains.const);
  assert.equal(requiredBySchema.includes('seedance-characters'), true);
  assert.equal(requiredBySchema.every(skill => ['seedance2-prompt', 'arbitrary-skill'].includes(skill)), false);
  assert.ok(schema.properties.shots.items.properties.authorityAdaptation);
});
