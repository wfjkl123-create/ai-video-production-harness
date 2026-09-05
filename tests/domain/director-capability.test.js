import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCapabilityManifest, compileDirectorCapabilityManifest } from '../../src/domain/director-capability.js';
import { reconcileCapabilityManifestSegmentIds } from '../../src/services/director-route-service.js';

const sha = 'a'.repeat(64);

function intent(overrides = {}) {
  return {
    narrativeFunction: '让男主从逃避交流转为正面回应女主',
    valueTurn: '男主从回避女主视线转向主动看向她并停住',
    povCharacter: 'character-b',
    powerShift: '解释权从男主转向等待回应的女主',
    subtext: '男主嘴上轻描淡写，身体却终于承认这段关系重要',
    feltIntent: '观众从男主的回避中感到距离，再从迟来的对视中感到关系松动',
    whyThisShot: '固定双人中近景保留两人的距离，随后轻微推近到男主抬眼的终点，让对视成为唯一变化',
    audienceAttention: '先看女主等待的手，再注意到男主终于从桌面抬眼',
    expressiveDetail: '男主手指停止无意义摆动，女主没有马上微笑，只在对视后松开握紧的手',
    intentCarriers: [
      { channel: 'camera', instruction: '双人中近景固定到男主抬眼时轻微推近', visibleEvidence: '镜头终点同时保留两人的眼睛和视线方向' },
      { channel: 'performance', instruction: '男主先停手再抬眼，女主等对视建立后才松手', visibleEvidence: '两个人物反应有明确先后而非同时表演' }
    ],
    signals: {
      hasDialogue: true, emotionalTurn: true, relationshipBeat: true, closePerformance: true,
      requiresMutualEyeLine: true, complexBlocking: false, complexPhysicalAction: false,
      viralRemake: false, productInteraction: 'none'
    },
    ...overrides
  };
}

function plan(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'story-plan-v2', projectId: 'DIRECTOR-1',
    directorPlan: {
      projectType: 'narrative', transformMode: 'story_creation', directorialVoice: '克制写实', audienceFeltIntent: '看见关系变化',
      visualStrategy: '视线和手部细节承担关系表达', rhythmStrategy: '触发后先停顿再反应',
      realismStrategy: '保留呼吸、不对称和未完成动作'
    },
    story: { tone: '克制写实', storyPromise: '观众看见关系从回避转为回应' },
    characters: [{ characterId: 'character-a' }, { characterId: 'character-b' }],
    script: { scenes: [{ sceneId: 'scene-001', subtext: '两人都不愿先承认在意', powerShift: '从男主到女主', dialogue: ['你看着我。'] }] },
    videoSegments: [{ segmentId: 'segment-001', startSec: 0, endSec: 8, sceneIds: ['scene-001'] }],
    shotPlanning: {
      mode: 'shotlist', continuousTakePlan: null,
      shots: [{
        shotId: 'shot-001', segmentId: 'segment-001', sceneId: 'scene-001', characterIds: ['character-a', 'character-b'],
        durationSec: 8, purpose: '关系转折', subjectAction: '男主停止挥手并看向女主', shotContract: '双人中近景轻微推近',
        blocking: '男主画面左侧，女主右侧，互为视线方向', startState: '男主看桌面', endState: '两人对视',
        audio: '一句对白后留停顿', continuityAnchors: ['视线'], risks: ['僵硬表演'], directorIntent: intent(),
        performanceBeat: {
          trigger: '女主停止说话并等待', observableReaction: '男主手指先停住再抬眼', decision: '男主选择正面回应',
          partnerFeedback: '女主在对视建立后才松开手', cutPoint: '双方视线稳定且手部动作结束', soundRole: '对白结束后的停顿承载转折'
        }
      }]
    },
    assetPlan: [
      { assetType: 'character_board', decision: 'required', reason: '两位人物需要稳定身份' },
      { assetType: 'scene_multiview', decision: 'required', reason: '双人轴线需要固定空间' }
    ],
    ...overrides
  };
}

test('strong relationship scene automatically routes emotion, eyeline, character and anti-AI skills', () => {
  const manifest = compileDirectorCapabilityManifest(plan(), { storyPlanSha256: sha });
  const shot = manifest.shots[0];
  const capabilityIds = shot.capabilities.map(item => item.id);
  assert.ok(capabilityIds.includes('emotion-performance-v1'));
  assert.ok(capabilityIds.includes('relationship-eyeline-v1'));
  assert.ok(capabilityIds.includes('character-performance-v1'));
  assert.ok(shot.requiredSkillIds.includes('seedance-antislop'));
  assert.ok(shot.requiredSkillIds.includes('seedance-characters'));
  assert.ok(shot.requiredAssets.includes('dialogue_axis_board'));
  assert.deepEqual(manifest.requiredAssetsBySegment['segment-001'].includes('character_board'), true);
});

test('explicit visible roles prevent offscreen scene participants from entering the routed shot', () => {
  const value = plan({
    shotPlanning: {
      ...plan().shotPlanning,
      shots: [{
        ...plan().shotPlanning.shots[0],
        characterIds: ['character-a', 'character-b'],
        visibleCharacterIds: ['character-a'],
        offscreenCharacterIds: ['character-b'],
        visibleSpeakerIds: []
      }]
    }
  });
  const routed = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.deepEqual(routed.characterIds, ['character-a']);
  assert.deepEqual(routed.sceneCharacterIds, ['character-a', 'character-b']);
  assert.deepEqual(routed.offscreenCharacterIds, ['character-b']);
  assert.deepEqual(routed.visibleSpeakerIds, []);
  assert.equal(routed.capabilities.some(item => item.id === 'relationship-eyeline-v1'), false);
});

test('an exact locked canonical timeline may deterministically bridge editorial unit IDs', () => {
  const value = plan({
    videoSegments: [{ segmentId: 'u01', startSec: 0, endSec: 8, sceneIds: ['scene-001'] }],
    shotPlanning: {
      ...plan().shotPlanning,
      shots: [{ ...plan().shotPlanning.shots[0], segmentId: 'u01' }]
    }
  });
  const manifest = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha });
  const bridged = reconcileCapabilityManifestSegmentIds(manifest, [{ id: 'segment-001', duration: 8 }]);
  assert.equal(bridged.manifest.shots[0].segmentId, 'segment-001');
  assert.deepEqual(bridged.manifest.requiredAssetsBySegment['segment-001'].includes('character_board'), true);
  assert.deepEqual(bridged.segmentIdentityMap, { u01: 'segment-001' });
  assert.equal(manifest.shots[0].segmentId, 'u01');
});

test('matching segment IDs still reject a locked segmentation with different durations', () => {
  const manifest = compileDirectorCapabilityManifest(plan(), { storyPlanSha256: sha });
  assert.throws(
    () => reconcileCapabilityManifestSegmentIds(manifest, [{ id: 'segment-001', duration: 7 }]),
    /disagree for segment-001/
  );
});

test('segment identity bridging rejects an unequal duration instead of guessing', () => {
  const value = plan({
    videoSegments: [{ segmentId: 'u01', startSec: 0, endSec: 8, sceneIds: ['scene-001'] }],
    shotPlanning: {
      ...plan().shotPlanning,
      shots: [{ ...plan().shotPlanning.shots[0], segmentId: 'u01' }]
    }
  });
  const manifest = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha });
  assert.throws(
    () => reconcileCapabilityManifestSegmentIds(manifest, [{ id: 'segment-001', duration: 7 }]),
    /differ in order or duration/
  );
});

test('coverage-only director wording is rejected instead of becoming a polished empty shotlist', () => {
  const bad = plan();
  bad.shotPlanning.shots[0].directorIntent.whyThisShot = '推进剧情';
  assert.throws(() => compileDirectorCapabilityManifest(bad, { storyPlanSha256: sha }), /coverage-only|vague/);
});

test('simple product proof does not load emotion or relationship capabilities', () => {
  const value = plan({
    characters: [],
    directorPlan: { ...plan().directorPlan, projectType: 'product_demo' },
    shotPlanning: {
      mode: 'shotlist', continuousTakePlan: null,
      shots: [{
        ...plan().shotPlanning.shots[0], characterIds: [],
        directorIntent: intent({
          narrativeFunction: '证明产品表面在受压后仍保持结构',
          valueTurn: '产品从未经验证变为受压后结构保持完整',
          feltIntent: '观众从怀疑转为看见可复核的结构证据',
          whyThisShot: '锁定微距侧机位持续看清受压点和回弹终点，避免切镜遮掉证明过程',
          audienceAttention: '先看手指压下的位置，再看材料回到原轮廓',
          expressiveDetail: '桌面刻度线提供同画面尺度参照',
          signals: { ...intent().signals, hasDialogue: false, emotionalTurn: false, relationshipBeat: false, closePerformance: false, requiresMutualEyeLine: false, productInteraction: 'scale_sensitive' }
        })
      }]
    },
    assetPlan: [
      { assetType: 'scene_multiview', decision: 'required', reason: '固定桌面空间' },
      { assetType: 'product_reference', decision: 'required', reason: '结构必须准确' }
    ]
  });
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  const ids = route.capabilities.map(item => item.id);
  assert.ok(ids.includes('product-proof-v1'));
  assert.deepEqual(route.capabilities.find(item => item.id === 'product-proof-v1').requiredAssets, ['product_reference']);
  assert.equal(ids.includes('emotion-performance-v1'), false);
  assert.equal(ids.includes('relationship-eyeline-v1'), false);
  assert.equal(route.requiredSkillIds.includes('seedance-antislop'), false);
});

test('project asset planning does not copy unrelated assets into every routed shot', () => {
  const value = plan({
    characters: [],
    directorPlan: { ...plan().directorPlan, projectType: 'product_demo' },
    assetPlan: [
      { assetType: 'character_board', decision: 'required', reason: 'used by other character shots in the project' },
      { assetType: 'story_prop', decision: 'required', reason: 'used by a different shot' },
      { assetType: 'product_reference', decision: 'required', reason: 'this shot proves the product' }
    ],
    shotPlanning: {
      mode: 'shotlist', continuousTakePlan: null,
      shots: [{
        ...plan().shotPlanning.shots[0], characterIds: [],
        directorIntent: intent({
          signals: {
            ...intent().signals, hasDialogue: false, emotionalTurn: false, relationshipBeat: false,
            closePerformance: false, requiresMutualEyeLine: false, productInteraction: 'display', localDeterministic: true
          }
        })
      }]
    }
  });
  const manifest = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha });
  assert.deepEqual(manifest.shots[0].requiredAssets, ['product_reference']);
  assert.deepEqual(manifest.projectRequiredAssets, ['character_board', 'story_prop', 'product_reference']);
});

test('only the stored-route compatibility path may normalize a pre-field explicit-v2 manifest', () => {
  const manifest = compileDirectorCapabilityManifest(plan(), { storyPlanSha256: sha });
  manifest.routeVersion = 'director-route-v5';
  delete manifest.projectRequiredAssets;
  assert.throws(() => assertCapabilityManifest(manifest), /projectRequiredAssets/);
  const normalized = assertCapabilityManifest(manifest, { allowLegacyMissingProjectRequiredAssets: true });
  assert.deepEqual(normalized.projectRequiredAssets, []);
  assert.equal(normalized.routeVersion, 'director-route-v5');
  assert.equal(normalized.routePrecision, 'explicit_v2');
  assert.ok(normalized.shots.every(shot => shot.legacyInference === false));
});

test('a shot may explicitly request one canonical prop asset without inheriting the whole asset plan', () => {
  const value = plan();
  value.assetPlan.push({ assetType: 'story_prop', decision: 'required', reason: 'the current shot uses one locked prop' });
  value.shotPlanning.shots[0].directorIntent.signals.requiredAssetTypes = ['story_prop'];
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.ok(route.requiredAssets.includes('story_prop'));
});

test('an explicit story-prop interaction does not leak the canonical target product into the shot or segment', () => {
  const value = plan();
  value.assetPlan.push(
    { assetType: 'story_prop', decision: 'required', reason: 'the current shot handles a negative-example garment' },
    { assetType: 'product_reference', decision: 'required', reason: 'the target product is reserved for a later proof shot' }
  );
  value.shotPlanning.shots[0].directorIntent.signals.productInteraction = 'display';
  value.shotPlanning.shots[0].directorIntent.signals.requiredAssetTypes = ['character_board', 'story_prop'];

  const manifest = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha });
  const route = manifest.shots[0];
  const productProof = route.capabilities.find(item => item.id === 'product-proof-v1');

  assert.deepEqual(productProof.requiredAssets, ['story_prop']);
  assert.ok(route.requiredAssets.includes('story_prop'));
  assert.equal(route.requiredAssets.includes('product_reference'), false);
  assert.equal(manifest.requiredAssetsBySegment['segment-001'].includes('product_reference'), false);
  assert.ok(manifest.projectRequiredAssets.includes('product_reference'));
});

test('simple relationship performance keeps eyeline checks without forcing an extra axis-board asset', () => {
  const value = plan();
  value.shotPlanning.shots[0].directorIntent.signals.hasDialogue = false;
  value.shotPlanning.shots[0].directorIntent.signals.requiresMutualEyeLine = false;
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.ok(route.capabilities.some(item => item.id === 'relationship-eyeline-v1'));
  assert.equal(route.requiredAssets.includes('dialogue_axis_board'), false);
});

test('silent mutual eyeline keeps the eyeline capability without inventing a dialogue axis board', () => {
  const value = plan();
  value.shotPlanning.shots[0].directorIntent.signals.hasDialogue = false;
  value.shotPlanning.shots[0].directorIntent.signals.requiresMutualEyeLine = true;
  value.script.scenes[0].dialogue = [];
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.ok(route.capabilities.some(item => item.id === 'relationship-eyeline-v1'));
  assert.equal(route.requiredAssets.includes('dialogue_axis_board'), false);
});

test('viral one-take automatically routes frame-derived mannequin and sequence continuity', () => {
  const value = plan({
    directorPlan: { ...plan().directorPlan, projectType: 'viral_remake' },
    shotPlanning: {
      mode: 'single_take', shots: [], roughStoryboardPreview: null,
      continuousTakePlan: {
        phases: ['开始', '随后', '最后'], blocking: '两人沿桌边交换位置', cameraPath: '摄影机保持两人轴线连续跟拍',
        geography: '男主左、女主右', endState: '两人停在门口对视', reservedFutureActions: '开门留到下一段',
        characterIds: ['character-a', 'character-b'],
        directorIntent: intent({ signals: { ...intent().signals, viralRemake: true, complexBlocking: true } })
      }
    }
  });
  const manifest = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha });
  const ids = manifest.shots[0].capabilities.map(item => item.id);
  assert.ok(ids.includes('mannequin-grid-v1'));
  assert.ok(ids.includes('sequence-continuity-v1'));
  assert.ok(ids.includes('overhead-blocking-v1'));
  assert.ok(manifest.requiredAssetsBySegment['segment-001'].includes('mannequin_grid'));
});

test('micro-segmenting relationship performance is blocked before asset routing', () => {
  const value = plan({
    videoSegments: [
      { segmentId: 'segment-001', startSec: 0, endSec: 2, sceneIds: ['scene-001'] },
      { segmentId: 'segment-002', startSec: 2, endSec: 4, sceneIds: ['scene-001'] },
      { segmentId: 'segment-003', startSec: 4, endSec: 8, sceneIds: ['scene-001'] }
    ],
    shotPlanning: {
      mode: 'shotlist', continuousTakePlan: null,
      shots: [
        { ...plan().shotPlanning.shots[0], shotId: 'shot-001', segmentId: 'segment-001', durationSec: 2 },
        { ...plan().shotPlanning.shots[0], shotId: 'shot-002', segmentId: 'segment-002', durationSec: 2 },
        { ...plan().shotPlanning.shots[0], shotId: 'shot-003', segmentId: 'segment-003', durationSec: 4 }
      ]
    },
    assetPlan: [{ assetType: 'character_board', decision: 'conditional', reason: 'visible characters route this per shot' }]
  });
  assert.throws(
    () => compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }),
    /MICRO_SEGMENT_PERFORMANCE_RESET/
  );
});

test('legacy schema cannot be activated as a verified director route', () => {
  const value = plan({ schemaVersion: 1 });
  delete value.directorPlan;
  value.videoSegments = [{ segmentId: 'segment-001', startSec: 0, endSec: 8, sceneIds: ['scene-001'] }];
  value.shotPlanning.shots = [
    { ...value.shotPlanning.shots[0], shotId: 'legacy-001', durationSec: 2 },
    { ...value.shotPlanning.shots[0], shotId: 'legacy-002', durationSec: 2 },
    { ...value.shotPlanning.shots[0], shotId: 'legacy-003', durationSec: 4 }
  ].map(({ segmentId, sceneId, characterIds, directorIntent, ...shot }) => shot);
  assert.throws(
    () => compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }),
    /schemaVersion 2.*explicit per-shot directorIntent/
  );
});

test('viral mannequin control replaces a duplicate generic storyboard', () => {
  const value = plan();
  value.shotPlanning.shots[0].directorIntent.signals.viralRemake = true;
  value.shotPlanning.shots[0].directorIntent.signals.complexPhysicalAction = true;
  value.assetPlan.push({ assetType: 'storyboard', decision: 'required', reason: 'legacy global requirement that the specialized mannequin control must replace' });
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.ok(route.requiredAssets.includes('mannequin_grid'));
  assert.equal(route.requiredAssets.includes('storyboard'), false);
});

test('an explicitly skipped mannequin route never overrides the approved storyboard route', () => {
  const value = plan();
  value.directorPlan = { ...value.directorPlan, projectType: 'faithful_remake', transformMode: 'faithful_remake', fidelityTarget: 'faithful' };
  value.shotPlanning.shots[0].directorIntent.signals.complexPhysicalAction = true;
  value.assetPlan.push(
    { assetType: 'storyboard', decision: 'required', reason: 'approved visual control route' },
    { assetType: 'mannequin_grid', decision: 'skipped', reason: 'the approved project forbids mannequin control' }
  );
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.equal(route.requiredAssets.includes('mannequin_grid'), false);
  assert.ok(route.requiredAssets.includes('storyboard'));
});

test('one-to-one modeling control replaces storyboard and mannequin with Blender-derived control assets', () => {
  const value = plan();
  value.directorPlan = {
    ...value.directorPlan,
    projectType: 'faithful_remake',
    transformMode: 'faithful_remake',
    fidelityTarget: 'one_to_one',
    controlMode: 'modeling_strong_control',
    modelingInputMode: 'keyframes_only'
  };
  value.shotPlanning.shots[0].directorIntent.signals.complexPhysicalAction = true;
  value.shotPlanning.shots[0].directorIntent.signals.viralRemake = true;
  value.assetPlan.push(
    { assetType: 'storyboard', decision: 'required', reason: 'legacy board replaced by modeling' },
    { assetType: 'mannequin_grid', decision: 'required', reason: 'legacy grid replaced by modeling' }
  );
  const manifest = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha });
  const route = manifest.shots[0];
  assert.ok(route.capabilities.some(item => item.id === 'modeling-control-v1'));
  assert.equal(route.capabilities.some(item => item.id === 'mannequin-grid-v1'), false);
  assert.ok(route.requiredAssets.includes('director_view_proxy'));
  assert.equal(route.requiredAssets.includes('storyboard'), false);
  assert.equal(route.requiredAssets.includes('mannequin_grid'), false);
  assert.deepEqual(route.requiredArtifacts, ['spatial_control_model']);
  assert.deepEqual(manifest.requiredArtifactsBySegment['segment-001'], ['spatial_control_model']);
});

test('animatic video modeling mode requires the model-derived video asset', () => {
  const value = plan();
  value.directorPlan = {
    ...value.directorPlan,
    projectType: 'faithful_remake',
    transformMode: 'faithful_remake',
    fidelityTarget: 'one_to_one',
    controlMode: 'modeling_strong_control',
    modelingInputMode: 'animatic_video'
  };
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.ok(route.requiredAssets.includes('director_view_proxy'));
  assert.ok(route.requiredAssets.includes('spatial_control_animatic'));
});

test('local deterministic product insert does not require a generated scene or storyboard', () => {
  const value = plan({
    characters: [],
    directorPlan: { ...plan().directorPlan, projectType: 'product_demo' },
    shotPlanning: {
      mode: 'shotlist', continuousTakePlan: null,
      shots: [{
        ...plan().shotPlanning.shots[0], characterIds: [],
        directorIntent: intent({
          narrativeFunction: '用锁定产品像素证明全白腰头和立体结构',
          valueTurn: '产品从结构未被看清到结构和颜色都可复核',
          feltIntent: '观众从疑问转为看清解决方案的结构证据',
          whyThisShot: '使用固定产品机位只做本地数字推近与柔光移动，禁止生成模型重画产品或背景',
          audienceAttention: '先看白色腰头，再看立体前囊和腿口缝线',
          expressiveDetail: '柔光扫过后产品像素、比例、颜色和缝线完全不变',
          signals: {
            ...intent().signals,
            hasDialogue: false, emotionalTurn: false, relationshipBeat: false, closePerformance: false,
            requiresMutualEyeLine: false, complexBlocking: false, complexPhysicalAction: false,
            viralRemake: false, productInteraction: 'display', localDeterministic: true
          }
        })
      }]
    },
    assetPlan: [
      { assetType: 'product_reference', decision: 'required', reason: 'this local product insert uses the locked product' },
      { assetType: 'scene_multiview', decision: 'required', reason: 'legacy global requirement that local deterministic routing must suppress' },
      { assetType: 'storyboard', decision: 'required', reason: 'legacy global requirement that local deterministic routing must suppress' },
      { assetType: 'mannequin_grid', decision: 'required', reason: 'legacy global requirement that local deterministic routing must suppress' }
    ]
  });
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.deepEqual(route.requiredAssets, ['product_reference']);
  assert.ok(route.capabilities.some(item => item.id === 'product-proof-v1'));
});

test('a locked keyframe route that skips scene imagery does not force a scene board', () => {
  const value = plan({
    assetPlan: [
      { assetType: 'character_board', decision: 'required', reason: 'two visible people need canonical identity boards' },
      { assetType: 'product_reference', decision: 'required', reason: 'the folded product must retain its approved structure' },
      { assetType: 'scene_multiview', decision: 'skipped', reason: 'a single fixed dialogue shot uses locked start and end keyframes instead' }
    ],
    shotPlanning: {
      ...plan().shotPlanning,
      shots: [{
        ...plan().shotPlanning.shots[0],
        directorIntent: intent({
          signals: {
            ...intent().signals,
            requiresMutualEyeLine: false,
            productInteraction: 'display',
            requiredAssetTypes: ['character_board', 'product_reference']
          }
        })
      }]
    }
  });
  const route = compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }).shots[0];
  assert.ok(route.requiredAssets.includes('character_board'));
  assert.ok(route.requiredAssets.includes('product_reference'));
  assert.equal(route.requiredAssets.includes('scene_multiview'), false);
  assert.equal(route.requiredAssets.includes('scene_overhead'), false);
});

test('a local deterministic product insert cannot omit its product interaction contract', () => {
  const value = plan();
  value.shotPlanning.shots[0].directorIntent.signals.localDeterministic = true;
  assert.throws(
    () => compileDirectorCapabilityManifest(value, { storyPlanSha256: sha }),
    /localDeterministic requires a productInteraction/
  );
});
test('reconciliation preserves reviewed story-plan segment IDs when no canonical segmentation exists yet', () => {
  const storyPlan = plan();
  const manifest = compileDirectorCapabilityManifest(storyPlan, {
    storyPlanId: 'story-plan-v2',
    storyPlanSha256: 'a'.repeat(64)
  });
  const reconciled = reconcileCapabilityManifestSegmentIds(manifest, []);
  assert.equal(reconciled.manifest, manifest);
  assert.equal(reconciled.segmentIdentityMap, null);
});

test('an explicitly required single identity image replaces a four-view board for a minimized character route', () => {
  const storyPlan = plan({
    assetPlan: [
      { assetType: 'character_identity_single_view', decision: 'required', reason: 'user explicitly minimized each character to one image' }
    ]
  });
  storyPlan.shotPlanning.shots[0].directorIntent.signals.requiredAssetTypes = ['character_identity_single_view'];
  const manifest = compileDirectorCapabilityManifest(storyPlan, { storyPlanSha256: sha });
  assert.deepEqual(manifest.projectRequiredAssets, ['character_identity_single_view']);
  assert.ok(manifest.requiredAssetsBySegment['segment-001'].includes('character_identity_single_view'));
  assert.ok(!manifest.requiredAssetsBySegment['segment-001'].includes('character_board'));
});

test('an approved character product state replaces a skipped character board as identity authority', () => {
  const storyPlan = plan({
    assetPlan: [
      { assetType: 'character_product_state', decision: 'required', reason: 'the approved state image owns identity wardrobe and body proportions' },
      { assetType: 'character_board', decision: 'skipped', reason: 'the state image is the sole bound identity source' }
    ]
  });
  storyPlan.shotPlanning.shots[0].directorIntent.signals.requiredAssetTypes = ['character_product_state'];
  const manifest = compileDirectorCapabilityManifest(storyPlan, { storyPlanSha256: sha });
  const required = manifest.requiredAssetsBySegment['segment-001'];
  assert.ok(required.includes('character_product_state'));
  assert.ok(!required.includes('character_board'));
});

test('a reviewed asset plan may explicitly skip auto storyboard and dialogue-axis expansion', () => {
  const base = plan();
  const shot2 = structuredClone(base.shotPlanning.shots[0]);
  shot2.shotId = 'shot-002';
  shot2.durationSec = 2;
  const shot3 = structuredClone(base.shotPlanning.shots[0]);
  shot3.shotId = 'shot-003';
  shot3.durationSec = 2;
  const storyPlan = plan({
    shotPlanning: { ...base.shotPlanning, shots: [{ ...base.shotPlanning.shots[0], durationSec: 4 }, shot2, shot3] },
    assetPlan: [
      { assetType: 'character_identity_single_view', decision: 'required', reason: 'one approved image per character' },
      { assetType: 'storyboard', decision: 'skipped', reason: 'user explicitly requested no storyboard' },
      { assetType: 'dialogue_axis_board', decision: 'skipped', reason: 'shot contracts lock every camera to one side of the axis' }
    ]
  });
  storyPlan.shotPlanning.shots.forEach(shot => {
    shot.directorIntent.signals.requiresMutualEyeLine = true;
    shot.directorIntent.signals.requiredAssetTypes = ['character_identity_single_view'];
  });
  const manifest = compileDirectorCapabilityManifest(storyPlan, { storyPlanSha256: sha });
  assert.ok(!manifest.requiredAssetsBySegment['segment-001'].includes('storyboard'));
  assert.ok(!manifest.requiredAssetsBySegment['segment-001'].includes('dialogue_axis_board'));
});

test('approved endpoint frames and depth video replace duplicate identity and blocking boards', () => {
  const storyPlan = plan({
    assetPlan: [
      { assetType: 'initial_blocking', decision: 'required', reason: 'the reviewed opening frame carries identity and opening state' },
      { assetType: 'handoff_blocking', decision: 'required', reason: 'the reviewed ending frame carries the final identity and garment state' },
      { assetType: 'depth_video_reference', decision: 'required', reason: 'the approved depth route carries motion blocking and occlusion' },
      { assetType: 'product_reference', decision: 'required', reason: 'the approved product reference carries garment structure and color' },
      { assetType: 'timing_audio_reference', decision: 'required', reason: 'the source audio carries the exact timing clock' },
      { assetType: 'character_identity_single_view', decision: 'skipped', reason: 'identity is carried by the reviewed endpoint frames' },
      { assetType: 'camera_blocking', decision: 'skipped', reason: 'camera and people paths are carried by the depth video' },
      { assetType: 'dialogue_axis_board', decision: 'skipped', reason: 'the fixed source camera and depth route already lock the screen axis' }
    ]
  });
  storyPlan.shotPlanning.shots[0].directorIntent.signals.complexBlocking = true;
  storyPlan.shotPlanning.shots[0].directorIntent.signals.requiredAssetTypes = [
    'depth_video_reference', 'product_reference', 'timing_audio_reference'
  ];
  const manifest = compileDirectorCapabilityManifest(storyPlan, { storyPlanSha256: sha });
  const required = manifest.requiredAssetsBySegment['segment-001'];
  assert.ok(required.includes('initial_blocking'));
  assert.ok(required.includes('depth_video_reference'));
  assert.ok(required.includes('product_reference'));
  assert.ok(required.includes('timing_audio_reference'));
  assert.ok(!required.includes('character_board'));
  assert.ok(!required.includes('character_identity_single_view'));
  assert.ok(!required.includes('camera_blocking'));
  assert.ok(!required.includes('dialogue_axis_board'));
});

test('an approved camera-blocking skip is not reintroduced by complex-blocking inference', () => {
  const base = plan();
  const storyPlan = plan({
    assetPlan: [
      ...base.assetPlan.filter(item => item.assetType !== 'camera_blocking'),
      {
        assetType: 'camera_blocking',
        decision: 'skipped',
        reason: 'the approved storyboard and shot contract already carry the simple camera path'
      }
    ]
  });
  storyPlan.shotPlanning.shots[0].directorIntent.signals.complexBlocking = true;
  const manifest = compileDirectorCapabilityManifest(storyPlan, { storyPlanSha256: sha });
  assert.ok(!manifest.requiredAssetsBySegment['segment-001'].includes('camera_blocking'));
  assert.ok(!manifest.shots[0].capabilities.some(item => item.id === 'overhead-blocking-v1'));
});
