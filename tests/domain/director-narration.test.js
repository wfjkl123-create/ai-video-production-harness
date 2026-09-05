import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNarrationMatchesCapabilityManifest,
  assertPromptContainsDirectorScreenConstraints,
  assertPromptExcludesDirectorCapsuleMetadata,
  renderDirectorCapabilityCapsules,
  renderDirectorScreenConstraints
} from '../../src/domain/director-narration.js';

const manifestSha = 'b'.repeat(64);
const manifest = {
  schemaVersion: 1, id: 'capability-story-v1', kind: 'capability_manifest', routeVersion: 'director-route-v1',
  routePrecision: 'explicit_v2', storyPlanSchemaVersion: 2,
  projectId: 'P1', storyPlanId: 'story-v1', storyPlanSha256: 'a'.repeat(64), projectType: 'narrative',
  directorialVoice: '克制写实', createdAt: '2026-07-30T12:00:00Z',
  projectRequiredAssets: ['character_board', 'scene_multiview'],
  requiredAssetsBySegment: { 'segment-001': ['character_board', 'scene_multiview', 'dialogue_axis_board'] },
  shots: [{
    shotId: 'shot-001', segmentId: 'segment-001', sceneId: 'scene-001', characterIds: ['character-a', 'character-b'], legacyInference: false,
    signals: { hasDialogue: true, emotionalTurn: true, relationshipBeat: true, closePerformance: true, requiresMutualEyeLine: true, complexBlocking: false, complexPhysicalAction: false, viralRemake: false, productInteraction: 'none' },
    resultContract: {
      narrativeFunction: '男主停止回避并回应女主', valueTurn: '男主从看桌面转为看向女主', povCharacter: 'character-b',
      powerShift: '从男主转向女主', subtext: '男主终于承认在意', feltIntent: '观众看见关系松动',
      whyThisShot: '双人中近景轻微推近到对视终点', audienceAttention: '先看女主握紧的手，再看男主抬眼',
      expressiveDetail: '男主先停手，女主后松手',
      intentCarriers: [
        { channel: 'camera', instruction: '双人中近景轻微推近', visibleEvidence: '终点同时看见两人眼睛' },
        { channel: 'performance', instruction: '男主先抬眼，女主后松手', visibleEvidence: '反应有先后' }
      ]
    },
    capabilities: [
      { id: 'director-intent-v1', required: true, reason: '表达', source: 'seedance2-prompt + seedance-camera', skillIds: ['seedance2-prompt', 'seedance-camera'], requiredAssets: [], resultChecks: ['x'] },
      { id: 'character-performance-v1', required: true, reason: '真人', source: 'seedance-characters + seedance-antislop', skillIds: ['seedance2-prompt', 'seedance-characters', 'seedance-antislop'], requiredAssets: ['character_board'], resultChecks: ['x'] },
      { id: 'relationship-eyeline-v1', required: true, reason: '对视', source: 'seedance-characters + seedance-camera', skillIds: ['seedance2-prompt', 'seedance-characters', 'seedance-camera'], requiredAssets: ['dialogue_axis_board'], resultChecks: ['x'] },
      { id: 'emotion-performance-v1', required: true, reason: '情绪', source: 'knowledge/capabilities/dlc/emotion-performance.md', skillIds: ['seedance2-prompt', 'seedance-characters'], requiredAssets: [], resultChecks: ['x'] }
    ],
    requiredSkillIds: ['seedance2-prompt', 'seedance-camera', 'seedance-characters', 'seedance-antislop'],
    requiredAssets: ['character_board', 'scene_multiview', 'dialogue_axis_board'], warnings: []
  }]
};

function performancePlan() {
  return {
    dlcId: 'emotion-performance-v1', templateSource: 'knowledge/capabilities/dlc/emotion-performance.md',
    skillsApplied: ['seedance2-prompt', 'seedance-characters'], focusedCharacter: 'character-a', objective: '正面回应女主',
    subtext: '嘴上平静但不再逃避', trigger: 'character-b要求他看着自己', performanceRegister: 'restrained_realism',
    intensity: 'restrained', dominantTrack: 'eyes', startBehavior: '视线停在桌面，手指压住桌沿',
    primaryAction: '手指先停住，再抬眼看向character-b', supportingCues: ['吞咽一次后短呼气'],
    voiceBreath: '短吸气后压低声音', endBehavior: '视线停在character-b眼睛位置', continuityCarry: ['两人保持对视'],
    backgroundCharacters: [{ characterTag: 'character-b', persistentMicroMotion: '保持呼吸，手指仍握紧后再松开' }]
  };
}

function narration(overrides = {}) {
  return {
    id: 'narration-v1', segmentId: 'segment-001', sourceSegmentId: 'segment-001', revision: 2, status: 'draft',
    capabilityManifestId: manifest.id, capabilityManifestSha256: manifestSha,
    shots: [{
      shotId: 'shot-001', physicalActions: ['character-a停止挥手，手指压住桌沿后抬眼看向character-b'],
      cameraMove: '双人中近景轻微推近到对视终点', lightSources: ['左前方窗光'],
      emotionThroughAction: '先停手，再抬眼，短呼气后才说话',
      skillsApplied: ['seedance2-prompt', 'seedance-camera', 'seedance-characters', 'seedance-antislop'],
      realismPlan: {
        focusedCharacter: 'character-a', motivatedAction: '听到对方要求后，手指先停在桌沿，再抬眼看向character-b',
        physicalEndpoint: '视线停在character-b眼睛位置，手掌仍压住桌沿', naturalVariation: '抬眼前短暂停顿，双肩略不对称',
        persistentMicroMotions: [{ characterId: 'character-b', action: '保持自然呼吸，轻眨一次眼后手指才松开' }],
        forbiddenGenericActions: ['无动机挥手', '呆滞凝视', '标准笑容', '机械重复']
      },
      interactionPlan: {
        participants: ['character-a', 'character-b'], focusedCharacter: 'character-a', partnerCharacter: 'character-b',
        trigger: 'character-b要求他看着自己', gazeTarget: 'character-b的眼睛位置',
        eyeLineAction: '从桌面抬眼看向character-b并停住半秒', partnerReaction: 'character-b轻眨一次眼后手指才松开',
        axisConstraint: '摄影机保持在两人轴线同一侧', endState: '两人保持对视，character-a手掌仍压住桌沿'
      },
      spatialContract: {
        firstFramePolicy: 'all_required_visible', requiredSubjects: ['character-a', 'character-b'],
        cameraSide: '摄影机保持在两人轴线同一侧，从character-a右肩外侧观察', shotMode: 'single_continuous_take',
        subjects: [
          { subjectId: 'character-a', screenPosition: '画面左侧三分之一', worldPosition: '桌面左侧椅前，手掌压住桌沿', depthLayer: 'midground', bodyFacing: '朝向character-b', gazeTarget: 'character-b眼睛位置', movementDirection: '手指停住后抬眼', landmarkAnchor: '右手接触桌沿' },
          { subjectId: 'character-b', screenPosition: '画面右侧三分之一', worldPosition: '桌面右侧椅前，手指靠近桌沿', depthLayer: 'midground', bodyFacing: '朝向character-a', gazeTarget: 'character-a眼睛位置', movementDirection: '保持原位，以呼吸和眨眼回应', landmarkAnchor: '左手停在桌沿内侧' }
        ]
      },
      performanceMode: 'emotion_dlc', performancePlan: performancePlan()
    }],
    ...overrides
  };
}

test('director narration requires anti-AI realism, partner eyeline and routed skills', () => {
  assert.equal(assertNarrationMatchesCapabilityManifest(narration(), manifest, manifestSha), true);
  const missingEyeLine = narration();
  delete missingEyeLine.shots[0].interactionPlan;
  assert.throws(() => assertNarrationMatchesCapabilityManifest(missingEyeLine, manifest, manifestSha), /interactionPlan/);
  const missingSkill = narration();
  missingSkill.shots[0].skillsApplied = missingSkill.shots[0].skillsApplied.filter(item => item !== 'seedance-antislop');
  assert.throws(() => assertNarrationMatchesCapabilityManifest(missingSkill, manifest, manifestSha), /seedance-antislop/);
  const missingSpatial = narration();
  delete missingSpatial.shots[0].spatialContract;
  assert.throws(() => assertNarrationMatchesCapabilityManifest(missingSpatial, manifest, manifestSha), /spatialContract/);
});

test('revision-one relationship narration remains readable without retroactive spatial-contract invalidation', () => {
  const legacy = narration({ revision: 1 });
  delete legacy.shots[0].spatialContract;
  assert.equal(assertNarrationMatchesCapabilityManifest(legacy, manifest, manifestSha), true);
});

test('unmotivated partner avoidance cannot satisfy the eyeline contract', () => {
  const bad = narration();
  bad.shots[0].interactionPlan.gazeTarget = '镜头外空处';
  assert.throws(() => assertNarrationMatchesCapabilityManifest(bad, manifest, manifestSha), /gazeTarget/);
});

test('archived director capsule still carries the full routed audit detail', () => {
  const capsule = renderDirectorCapabilityCapsules(narration(), manifest, manifestSha);
  assert.match(capsule, /禁止样板动作：无动机挥手/);
  assert.match(capsule, /视线动作/);
  assert.match(capsule, /叙事工作/);
});

test('only camera-observable constraints reach the model prompt', () => {
  const block = renderDirectorScreenConstraints(narration(), manifest, manifestSha);
  assert.match(block, /视线目标/);
  assert.match(block, /从桌面抬眼看向character-b并停住半秒/);
  assert.match(block, /轴线约束/);
  assert.match(block, /动作终点/);
  assert.match(block, /禁止动作/);
  assert.match(block, /首帧：character-a、character-b 已全部在画面中/);
  assert.match(block, /空间：character-a 位于画面左侧三分之一/);
  // Narrative rationale and capability bookkeeping must stay out of the prompt.
  assert.doesNotMatch(block, /叙事工作/);
  assert.doesNotMatch(block, /必用能力/);
  assert.doesNotMatch(block, /观众感受/);
  assert.equal(assertPromptContainsDirectorScreenConstraints(`开场\n${block}\n结尾`, narration(), manifest, manifestSha), true);
  assert.throws(() => assertPromptContainsDirectorScreenConstraints('只有普通提示词', narration(), manifest, manifestSha), /missing the exact director screen-constraint block/);
});

test('embedding the full director capsule in the prompt is rejected', () => {
  const capsule = renderDirectorCapabilityCapsules(narration(), manifest, manifestSha);
  assert.throws(() => assertPromptExcludesDirectorCapsuleMetadata(`镜头正文\n${capsule}`), /must not embed/);
  assert.equal(assertPromptExcludesDirectorCapsuleMetadata('镜头正文'), true);
});

test('a legacy terminal unit suffix can bridge exactly one routed shot without mutating narration', () => {
  const legacy = narration({ shots: [{ ...narration().shots[0], shotId: 'shot-001_unit' }] });
  assert.equal(assertNarrationMatchesCapabilityManifest(legacy, manifest, manifestSha), true);
  assert.equal(legacy.shots[0].shotId, 'shot-001_unit');
  assert.match(renderDirectorScreenConstraints(legacy, manifest, manifestSha), /【director-constraints-v1｜shot-001】/);
});

test('a non-terminal or ambiguous narration shot id is still rejected', () => {
  const invalid = narration({ shots: [{ ...narration().shots[0], shotId: 'shot-001_unit_extra' }] });
  assert.throws(() => assertNarrationMatchesCapabilityManifest(invalid, manifest, manifestSha), /unrouted shot/);
});
