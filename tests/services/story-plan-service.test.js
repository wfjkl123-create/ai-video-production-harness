import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { initializeProject } from '../../src/services/project-service.js';
import { createStoryPlan } from '../../src/services/story-plan-service.js';
import { assertStoryPlan, storyPlanSegmentationFingerprint } from '../../src/domain/story-plan.js';
import { createCreativeBrief } from '../../src/services/creative-brief-service.js';
import { approveArtifact, autoLockArtifact, submitForReview } from '../../src/services/review-service.js';
import { determineNextActions } from '../../src/services/next-action-service.js';
import { runCheckpointApprove } from '../../src/commands/checkpoint-approve.js';
import { runStoryPlan } from '../../src/commands/story-plan.js';
import { readJson } from '../../src/storage/json-store.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';
import { routeLockedStoryPlan } from '../../src/services/director-route-service.js';
import { setWorkflowProfile } from '../../src/services/workflow-profile-service.js';
import { persistSegmentation } from '../../src/services/segmentation-workflow-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { creativeBrief } from '../helpers/creative-brief-fixture.js';

function validPlan(overrides = {}) {
  const shot = (value, closePerformance = false) => ({
    ...value,
    segmentId: 'segment-001',
    sceneId: 'scene-001',
    characterIds: ['character-a'],
    directorIntent: {
      narrativeFunction: value.purpose,
      valueTurn: `${value.startState} -> ${value.endState}`,
      povCharacter: 'character-a',
      powerShift: '质疑者只能在看见演示结果后改变判断',
      subtext: '设计师停止争辩，把判断权交给可见证据',
      feltIntent: '观众从不确定转为看见可以复核的产品证据',
      whyThisShot: `${value.shotContract}持续看清主体动作和终点，不用切镜掩盖过程`,
      audienceAttention: value.subjectAction,
      expressiveDetail: value.blocking,
      intentCarriers: [
        { channel: 'camera', instruction: value.shotContract, visibleEvidence: value.endState },
        { channel: 'blocking', instruction: value.blocking, visibleEvidence: value.subjectAction }
      ],
      signals: {
        hasDialogue: false, emotionalTurn: false, relationshipBeat: false, closePerformance,
        requiresMutualEyeLine: false, complexBlocking: false, complexPhysicalAction: false,
        viralRemake: false, productInteraction: 'display'
      }
    }
  });
  return {
    schemaVersion: 2, id: 'story-plan-v1', projectId: 'STORY-1', creativeBriefId: 'creative-brief-v1',
    finalExecutionDecision: {
      segmentationStrategy: 'story_beat',
      segmentationRationale: '完整 Shotlist 证明按情节闭环比 Gate 1 暂定单段更准确',
      assetExecutionMode: 'mixed', videoExecutionMode: 'sequential',
      parallelPlan: ['独立身份与场景资产可并行，视频按连续性串行'],
      assetScopeBasis: '从三镜 Shotlist 的人物、场景和产品交互风险反推'
    },
    directorPlan: {
      projectType: 'product_demo', directorialVoice: '克制写实，以可见产品证据推动判断变化',
      audienceFeltIntent: '观众从怀疑转为看见可复核的现场结果', visualStrategy: '每镜只保留一个动作重点',
      rhythmStrategy: '动作完成后保留反应时间', realismStrategy: '保留自然停顿和细微重心变化'
    },
    story: {
      logline: '谨慎的设计师面对质疑，用一次真实演示证明自己的产品', storyPromise: '观众看到怀疑被可见证据改变',
      initialCondition: '设计师拿着产品站在工作台后，被同事质疑', objective: '让同事相信产品确实有效',
      centralConflict: '口头解释无效，只有现场结果能改变对方', turn: '同事亲手确认材料变化',
      climax: '设计师停止解释并完成一次清楚的产品演示', finalOutcome: '同事放下质疑并主动拿起产品查看', tone: '克制写实'
    },
    characters: [{
      characterId: 'character-a', tag: 'Character A', role: '设计师', background: '长期做产品研发，对夸张宣传保持警惕',
      personality: '谨慎克制，压力下反而更少说话', stance: '只接受能被看见的证据', objective: '证明产品价值', obstacle: '同事不相信口头说明',
      appearance: '三十岁原创女性，黑色齐肩发，米白上衣', wardrobeLock: '米白上衣和深灰长裤全片不变',
      relationshipMap: '与同事平等，但专业判断受到挑战', arc: '从解释转为用行动证明'
    }],
    script: { scenes: [{ sceneId: 'scene-001', location: '工作室', timeOfDay: '白天', sceneFunction: '完成怀疑到相信的转折', pov: '设计师', powerShift: '从质疑者转向设计师', subtext: '她不再争辩', beats: ['质疑出现', '演示完成', '对方确认'], dialogue: [] }] },
    videoSegments: [{ segmentId: 'segment-001', startSec: 0, endSec: 15, sceneIds: ['scene-001'], storyBeat: '完成一次演示并让质疑者改变行为', splitReason: '故事在可见结果出现时完成', continuityStrategy: 'canonical_open' }],
    shotPlanning: {
      mode: 'shotlist', roughStoryboardPreview: null, continuousTakePlan: null,
      shots: [
        shot({ shotId: 'S01_SH01', durationSec: 5, purpose: '建立质疑', subjectAction: '同事把产品推回桌面', shotContract: '中景固定机位', blocking: '两人隔桌相对', startState: '产品在同事手中', endState: '产品停在设计师面前', continuityAnchors: ['人物', '产品', '桌面方向'], audio: '桌面摩擦声', risks: ['手与产品接触'] }),
        shot({ shotId: 'S01_SH02', durationSec: 5, purpose: '完成演示', subjectAction: '设计师拿起产品并完成一次清楚操作', shotContract: '近景缓慢推进', blocking: '设计师居中，同事保持背景微动作', startState: '产品在桌面', endState: '演示结果朝向同事', continuityAnchors: ['人物', '产品结构', '光线'], audio: '材料摩擦声', risks: ['产品结构'] }, true),
        shot({ shotId: 'S01_SH03', durationSec: 5, purpose: '兑现转折', subjectAction: '同事主动拿起产品仔细查看', shotContract: '反应近景固定', blocking: '同事前景，设计师背景静止', startState: '结果朝向同事', endState: '同事低头查看产品', continuityAnchors: ['人物', '产品', '屏幕方向'], audio: '环境声减弱', risks: ['手与视线'] }, true)
      ]
    },
    assetPlan: [
      { assetType: 'character_board', decision: 'required', reason: '两个人物跨镜头出现' },
      { assetType: 'scene_multiview', decision: 'required', reason: '正反机位需要固定工作室空间' },
      { assetType: 'camera_blocking', decision: 'conditional', reason: '只有两人站位不清时启用' },
      { assetType: 'mannequin_grid', decision: 'skipped', reason: '不是爆款复刻且动作简单' }
    ],
    ...overrides
  };
}

function validCreativeBrief(overrides = {}) {
  return creativeBrief({ projectId: 'STORY-1', ...overrides });
}

async function lockCreativeBrief(root) {
  const artifact = await createCreativeBrief(root, validCreativeBrief());
  await submitForReview(root, artifact.id);
  await runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_creative', '--note', '创意决策统一通过']);
  return artifact;
}

test('creates one human-review story plan and checkpoint_story locks it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  const artifact = await createStoryPlan(root, validPlan());
  assert.equal(artifact.type, 'story_plan');
  assert.equal(artifact.status, 'draft');
  await assert.rejects(autoLockArtifact(root, artifact.id, 'must not auto lock'), /requires human review/);
  await submitForReview(root, artifact.id);
  const result = await runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_story', '--note', '故事与镜头统一通过']);
  assert.equal(result.approvedCount, 1);
  assert.equal(result.capabilityManifestId, 'capability-story-plan-v1-v7');
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(item => item.id === artifact.id).status, 'locked');
  assert.equal(state.verifiedCapabilityManifestId, result.capabilityManifestId);
  assert.equal(state.directorRoutingVersion, 1);
  assert.equal(state.artifacts.find(item => item.id === result.capabilityManifestId).status, 'locked');
  const storedPlan = JSON.parse(await readFile(join(root, artifact.path), 'utf8'));
  assert.equal(storedPlan.kind, 'story_plan');
  assert.equal(storedPlan.creativeDecision.segmentationStrategy, 'single_clip');
  assert.equal(storedPlan.finalExecutionDecision.segmentationStrategy, 'story_beat');
  assert.equal(storedPlan.finalExecutionDecision.assetExecutionMode, 'mixed');
  assert.equal(
    storedPlan.creativeDecision.directorCreativeContract.recommendedDirection.directionId,
    'direction-visible-proof'
  );
  const reroute = await routeLockedStoryPlan(root, artifact.id);
  assert.equal(reroute.reused, true);
  assert.equal(reroute.artifact.id, result.capabilityManifestId);
  const afterReroute = await readJson(join(root, 'project-state.json'));
  assert.equal(afterReroute.artifacts.filter(item => item.type === 'capability_manifest').length, 1);
});

test('simple_remake machine review auto-locks a current story plan without impersonating a human', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-simple-remake-auto-lock-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await setWorkflowProfile(root, {
    id: 'simple_remake',
    selectedBy: 'system_recommendation',
    reason: 'source-authority replacement uses machine-reviewed Gate 2'
  });
  await lockCreativeBrief(root);
  const artifact = await createStoryPlan(root, validPlan());
  const review = await autoLockArtifact(root, artifact.id, 'two independent machine reviews passed', {
    delegatedByProfile: 'simple_remake',
    machineEvidence: { reviewPaths: ['fidelity', 'execution-boundary'] }
  });
  assert.equal(review.actor, 'system');
  assert.equal(review.machineReviewed, true);
  assert.equal(review.delegatedByProfile, 'simple_remake');
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(item => item.id === artifact.id).status, 'locked');
});

test('Gate 2 auto-locks only the exact, prevalidated segmentation candidate after story approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-segmentation-binding-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  const planInput = validPlan({
    segmentationCandidate: { artifactId: 'segmentation-story-plan-v1', expectedRevision: 1 }
  });
  const semanticSha256 = storyPlanSegmentationFingerprint(planInput);
  planInput.segmentationCandidate.expectedStoryPlanFingerprintSha256 = semanticSha256;
  const segmentation = await persistSegmentation(root, {
    id: 'segmentation-story-plan-v1', revision: 1, path: 'segments/segmentation-story-plan-v1.json',
    segments: [{
      id: 'segment-001', duration: 15, timeRange: [0, 15], narrativeTask: '完整承接产品演示的因果节拍',
      startState: { storyState: '演示前产品仍在桌面' }, actionNodes: ['trigger', 'demonstration', 'reaction'],
      endState: { storyState: '同事低头核对产品结果' }, projectAssetIds: [], segmentAssetRequirements: [],
      previousSegmentId: null, nextSegmentId: null, status: 'awaiting_review'
    }],
    storyPlanBinding: { storyPlanId: planInput.id, storyPlanSemanticSha256: semanticSha256 }
  });
  planInput.segmentationCandidate.artifactId = segmentation.id;
  planInput.segmentationCandidate.expectedRevision = segmentation.revision;
  const artifact = await createStoryPlan(root, planInput);
  await submitForReview(root, artifact.id);
  const result = await runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_story', '--note', '故事与匹配分段进入执行路由']);
  assert.equal(result.segmentationArtifactId, segmentation.id);
  assert.ok(result.segmentationAutoLockReviewId);
  const state = await readJson(join(root, 'project-state.json'));
  const locked = state.artifacts.find(item => item.id === segmentation.id);
  assert.equal(locked.status, 'locked');
  assert.equal(state.verifiedCapabilityManifestId, result.capabilityManifestId);
});

test('Gate 2 rejects a segmentation candidate whose semantic plan binding is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-segmentation-semantic-mismatch-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  const planInput = validPlan({ segmentationCandidate: { artifactId: 'segmentation-semantic-mismatch', expectedRevision: 1 } });
  planInput.segmentationCandidate.expectedStoryPlanFingerprintSha256 = storyPlanSegmentationFingerprint(planInput);
  const segmentation = await persistSegmentation(root, {
    id: 'segmentation-semantic-mismatch', revision: 1, path: 'segments/segmentation-semantic-mismatch.json',
    segments: [{
      id: 'segment-001', duration: 15, timeRange: [0, 15], narrativeTask: '完整承接产品演示的因果节拍',
      startState: { storyState: '演示前产品仍在桌面' }, actionNodes: ['trigger', 'reaction'],
      endState: { storyState: '同事低头核对产品结果' }, projectAssetIds: [], segmentAssetRequirements: [],
      previousSegmentId: null, nextSegmentId: null, status: 'awaiting_review'
    }],
    storyPlanBinding: { storyPlanId: planInput.id, storyPlanSemanticSha256: '0'.repeat(64) }
  });
  planInput.segmentationCandidate.artifactId = segmentation.id;
  const artifact = await createStoryPlan(root, planInput);
  await submitForReview(root, artifact.id);
  await assert.rejects(
    runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_story', '--note', '不应通过语义错绑分段']),
    /does not bind the exact semantic fingerprint/
  );
});

test('Gate 2 rejects a same-ID segmentation candidate with a mismatched duration before human story locking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-segmentation-mismatch-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  const segmentation = await persistSegmentation(root, {
    id: 'segmentation-story-plan-mismatch', revision: 1, path: 'segments/segmentation-story-plan-mismatch.json',
    segments: [{
      id: 'segment-001', duration: 14, timeRange: [0, 14], narrativeTask: '有意错误的时长用于验证 Gate 2 拦截',
      startState: { storyState: '错误候选开始状态' }, actionNodes: ['trigger', 'reaction'],
      endState: { storyState: '错误候选结束状态' }, projectAssetIds: [], segmentAssetRequirements: [],
      previousSegmentId: null, nextSegmentId: null, status: 'awaiting_review'
    }]
  });
  const artifact = await createStoryPlan(root, validPlan({
    segmentationCandidate: { artifactId: segmentation.id, expectedRevision: segmentation.revision }
  }));
  await submitForReview(root, artifact.id);
  await assert.rejects(
    runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_story', '--note', '不应通过错误分段']),
    /disagree for segment-001/
  );
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(item => item.id === artifact.id).status, 'awaiting_review');
  assert.equal(state.artifacts.find(item => item.id === segmentation.id).status, 'draft');
});

test('creative brief and story plan services resolve a relative project root before transactional writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-relative-root-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  const relativeRoot = relative(process.cwd(), root);
  const creative = await createCreativeBrief(relativeRoot, validCreativeBrief());
  assert.equal((await readJson(join(root, 'project-state.json'))).artifacts.some(item => item.id === creative.id), true);
  assert.equal((await readJson(join(root, creative.path))).id, creative.id);
  await submitForReview(root, creative.id);
  await runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_creative', '--note', '相对路径写入验证']);
  const story = await createStoryPlan(relativeRoot, validPlan());
  assert.equal((await readJson(join(root, 'project-state.json'))).artifacts.some(item => item.id === story.id), true);
  assert.equal((await readJson(join(root, story.path))).id, story.id);
});

test('rejects incomplete timelines, unresolved template text, and missing rough preview for long shotlists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-invalid-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  await assert.rejects(createStoryPlan(root, validPlan({ story: { ...validPlan().story, logline: '用一句话写清故事' } })), /placeholder/);
  await assert.rejects(createStoryPlan(root, validPlan({ videoSegments: [{ ...validPlan().videoSegments[0], endSec: 14 }] })), /targetDurationSec/);
  const shot = validPlan().shotPlanning.shots[0];
  const shots = Array.from({ length: 13 }, (_, index) => ({ ...shot, shotId: `S01_SH${String(index + 1).padStart(2, '0')}`, durationSec: 15 / 13 }));
  await assert.rejects(createStoryPlan(root, validPlan({ shotPlanning: { mode: 'shotlist', shots, continuousTakePlan: null, roughStoryboardPreview: null } })), /roughStoryboardPreview/);
});

test('rejects an explicit shot time that disagrees with its declared duration', () => {
  const plan = {
    ...validPlan(),
    targetDurationSec: 15,
    creativeDecision: structuredClone(validCreativeBrief().creativeDecision)
  };
  plan.shotPlanning.shots[0] = {
    ...plan.shotPlanning.shots[0],
    startSec: 0,
    endSec: 4
  };
  assert.throws(() => assertStoryPlan(plan), /explicit timing must match durationSec/);
});

test('rejects an explicit shot assigned outside its declared generation segment', () => {
  const plan = {
    ...validPlan(),
    targetDurationSec: 15,
    creativeDecision: structuredClone(validCreativeBrief().creativeDecision)
  };
  plan.videoSegments = [
    { ...plan.videoSegments[0], endSec: 10 },
    { ...plan.videoSegments[0], segmentId: 'segment-002', startSec: 10, endSec: 15 }
  ];
  plan.shotPlanning.shots = plan.shotPlanning.shots.map((shot, index) => ({
    ...shot,
    startSec: index * 5,
    endSec: (index + 1) * 5,
    ...(index === 1 ? { segmentId: 'segment-002' } : {})
  }));
  assert.throws(() => assertStoryPlan(plan), /must remain inside its declared video segment/);
});

test('Gate 2 accepts a subject-only montage without fabricating characters or a three-act conflict', () => {
  const plan = validPlan();
  plan.targetDurationSec = 15;
  const brief = validCreativeBrief();
  const contract = brief.creativeDecision.directorCreativeContract;
  contract.structureMode = 'montage';
  contract.characterMode = 'subject_only';
  contract.characters = [];
  contract.storyOutline = ['材料状态按触感、伸展和回弹逐步呈现'];
  delete contract.recommendedDirection.centralConflict;
  delete contract.recommendedDirection.coreTurn;
  delete contract.recommendedDirection.endingPayoff;
  plan.creativeDecision = brief.creativeDecision;
  plan.story = {
    logline: '用一组递进的材料细节展示触感与回弹', storyPromise: '观众看清材料性能如何逐步显现',
    progression: '从静态纹理到受力伸展，再到松手回弹后的稳定形态', finalOutcome: '材料恢复平整且结构保持清楚', tone: '克制、清晰'
  };
  plan.characters = [];
  plan.shotPlanning.shots = plan.shotPlanning.shots.map(shot => ({
    ...shot,
    characterIds: [],
    directorIntent: { ...shot.directorIntent, povCharacter: 'subject' }
  }));
  delete plan.script.scenes[0].powerShift;
  delete plan.script.scenes[0].subtext;
  assert.equal(assertStoryPlan(plan), plan);
});

test('final execution cannot claim single clip for multiple segments or parallelize a continuity handoff', () => {
  const singleClip = { ...validPlan(), creativeDecision: validCreativeBrief().creativeDecision };
  singleClip.targetDurationSec = 15;
  singleClip.finalExecutionDecision.segmentationStrategy = 'single_clip';
  singleClip.videoSegments = [
    { ...singleClip.videoSegments[0], endSec: 10 },
    { ...singleClip.videoSegments[0], segmentId: 'segment-002', startSec: 10, endSec: 15 }
  ];
  assert.throws(() => assertStoryPlan(singleClip), /single_clip.*exactly one/);

  const parallelHandoff = { ...validPlan(), creativeDecision: validCreativeBrief().creativeDecision };
  parallelHandoff.targetDurationSec = 15;
  parallelHandoff.finalExecutionDecision.videoExecutionMode = 'parallel';
  parallelHandoff.videoSegments = [
    { ...parallelHandoff.videoSegments[0], endSec: 10 },
    { ...parallelHandoff.videoSegments[0], segmentId: 'segment-002', startSec: 10, endSec: 15, continuityStrategy: 'continuous_proxy_handoff' }
  ];
  assert.throws(() => assertStoryPlan(parallelHandoff), /parallel video execution/);
});

test('Seedance 2.5 standard profile permits segments up to 30 seconds without relaxing the legacy 15-second default', () => {
  const seedance25 = { ...validPlan(), creativeDecision: validCreativeBrief().creativeDecision };
  seedance25.targetDurationSec = 20;
  seedance25.finalExecutionDecision = {
    ...seedance25.finalExecutionDecision,
    videoGenerationProfile: 'seedance_2_5_standard_30'
  };
  seedance25.videoSegments = [{ ...seedance25.videoSegments[0], endSec: 20 }];
  seedance25.shotPlanning.shots = seedance25.shotPlanning.shots.map((shot, index) => ({
    ...shot,
    durationSec: index === 2 ? 10 : 5
  }));
  assert.equal(assertStoryPlan(seedance25), seedance25);

  const legacy = structuredClone(seedance25);
  delete legacy.finalExecutionDecision.videoGenerationProfile;
  assert.throws(() => assertStoryPlan(legacy), /exceeds 15 seconds/);

  const overThirty = structuredClone(seedance25);
  overThirty.targetDurationSec = 31;
  overThirty.videoSegments[0].endSec = 31;
  overThirty.shotPlanning.shots = [
    { ...overThirty.shotPlanning.shots[0], durationSec: 15 },
    { ...overThirty.shotPlanning.shots[1], durationSec: 15 },
    { ...overThirty.shotPlanning.shots[2], durationSec: 1 }
  ];
  assert.throws(() => assertStoryPlan(overThirty), /exceeds 30 seconds/);
});

test('an awaiting-review Gate 2 plan becomes stale when a newer Gate 1 brief is locked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-stale-awaiting-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  const story = await createStoryPlan(root, validPlan());
  await submitForReview(root, story.id);
  const replacement = await createCreativeBrief(root, validCreativeBrief({ id: 'creative-brief-v2' }));
  await submitForReview(root, replacement.id);
  await runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_creative', '--note', '锁定新版创意母版']);

  const next = await determineNextActions(root);
  assert.deepEqual(next.actions.map(action => action.id), ['prepare_story_plan']);
  assert.equal(next.actions[0].staleStoryPlanId, story.id);
  await assert.rejects(approveArtifact(root, story.id, '不得通过通用 approve 锁定旧版故事'), /stale creative brief/);
  await assert.rejects(
    runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_story', '--note', '不得批准旧版故事']),
    /stale creative brief/
  );
});

test('workflow v2 rejects a legacy story plan before it can enter Gate 2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-legacy-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  await assert.rejects(
    createStoryPlan(root, validPlan({ schemaVersion: 1, directorPlan: undefined })),
    /schemaVersion 2.*existing Gate 2/
  );
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.some(item => item.type === 'story_plan'), false);
});

test('publishes the story-plan JSON schema', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/story-plan.schema.json', import.meta.url), 'utf8'));
  const creativeSchema = JSON.parse(await readFile(new URL('../../schemas/creative-brief.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.required.includes('creativeBriefId'));
  assert.ok(schema.required.includes('characters'));
  assert.ok(schema.required.includes('shotPlanning'));
  assert.ok(schema.required.includes('assetPlan'));
  assert.ok(creativeSchema.required.includes('lockedConstraints'));
  assert.ok(creativeSchema.properties.schemaVersion.enum.includes(3));
  assert.ok(creativeSchema.properties.creativeDecision.required.includes('assetExecutionMode'));
  assert.ok(creativeSchema.properties.creativeDecision.required.includes('videoExecutionMode'));
  assert.ok(creativeSchema.$defs.directorCreativeContract.required.includes('recommendedDirection'));
});

test('Gate 2 review page exposes every final execution decision before approval', async () => {
  const html = await readFile(new URL('../../templates/lavish-checkpoint/checkpoint-story.html', import.meta.url), 'utf8');
  for (const marker of [
    '{{FINAL_SEGMENTATION_STRATEGY}}', '{{FINAL_SEGMENTATION_RATIONALE}}', '{{FINAL_ASSET_EXECUTION_MODE}}',
    '{{FINAL_VIDEO_EXECUTION_MODE}}', '{{FINAL_PARALLEL_PLAN}}', '{{FINAL_ASSET_SCOPE_BASIS}}'
  ]) assert.match(html, new RegExp(marker.replace(/[{}]/g, '\\$&')));
  assert.equal((html.match(/data-lavish-question=/g) ?? []).length, 1);
});

test('Gate 2 cannot start before exactly one Gate 1 creative decision is human-approved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-gate-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await assert.rejects(createStoryPlan(root, validPlan()), /locked creative_brief/);
  const first = await createCreativeBrief(root, validCreativeBrief());
  await submitForReview(root, first.id);
  const second = await createCreativeBrief(root, validCreativeBrief({ id: 'creative-brief-v2' }));
  assert.equal(second.revision, 2);
  await submitForReview(root, second.id);
  await assert.rejects(
    runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_creative', '--note', '不应批量锁定两个方向']),
    /exactly one/
  );
});

test('story-plan command refuses an input symlink that escapes the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-command-'));
  const outside = await mkdtemp(join(tmpdir(), 'story-plan-outside-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  const outsideInput = join(outside, 'story-plan.json');
  await writeFile(outsideInput, '{}\n');
  await symlink(outsideInput, join(root, 'story-plan.json'));
  await assert.rejects(
    runStoryPlan(['--project', root, '--input', 'story-plan.json']),
    /readable regular project file/
  );
});

test('source-authority Gate 1 cannot enter Gate 2 without a source fact contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-source-fact-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  const base = validCreativeBrief();
  const creative = await createCreativeBrief(root, {
    ...base,
    creativeDecision: {
      ...base.creativeDecision,
      referenceWorkflow: {
        referenceIntent: 'source_modification',
        sourceVideoIds: ['reference-video-001']
      }
    }
  });
  await submitForReview(root, creative.id);
  await runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_creative', '--note', '批准基于原片修改']);
  await assert.rejects(createStoryPlan(root, validPlan()), /sourceFactContract is required/);
});

test('asset-anchored depth replication can enter Gate 2 without a user-authored source fact ledger', () => {
  const plan = validPlan({
    targetDurationSec: 15,
    creativeDecision: {
      ...validCreativeBrief().creativeDecision,
      visualControlMethod: 'depth',
      estimatedAssetCombination: ['深度视频', '首帧', '产品图片'],
      referenceWorkflow: { referenceIntent: 'faithful_remake', sourceVideoIds: ['reference-video-001'] }
    }
  });
  assert.doesNotThrow(() => assertStoryPlan(plan));
  assert.equal(plan.sourceFactContract, undefined);
});

async function draftSourceAuthorityStory(root) {
  const brief = validCreativeBrief();
  brief.creativeDecision.referenceWorkflow = {
    referenceIntent: 'faithful_remake', sourceVideoIds: ['reference-video-001']
  };
  const creative = await createCreativeBrief(root, brief);
  await submitForReview(root, creative.id);
  await runCheckpointApprove(['--project', root, '--checkpoint', 'checkpoint_creative', '--note', '批准原片权威创意母版']);
  const state = await readJson(join(root, 'project-state.json'));
  const lockedCreative = state.artifacts.find(item => item.id === creative.id);
  const plan = validPlan();
  plan.targetDurationSec = 15;
  plan.creativeBriefId = creative.id;
  plan.creativeBriefSha256 = lockedCreative.sha256;
  plan.creativeDecision = structuredClone(await readJson(join(root, creative.path))).creativeDecision;
  plan.sourceFactContract = {
    analysisMode: 'adaptive_source_analysis', sourceVideoIds: ['reference-video-001'],
    sourceRange: { startSec: 0, endSec: 15 }, dialoguePolicy: 'none',
    visualEvidence: ['人物完成产品展示'], dialogueEvidence: [],
    preserveFacts: ['人物完成产品展示'], replaceFacts: [], uncertainties: [],
    actionLedger: [{ startSec: 0, endSec: 15, observedAction: '人物完成产品展示', emotionBeat: '中性', spokenLine: null }]
  };
  const path = 'planning/story-plans/source-authority-story.json';
  await writeJsonAtomic(join(root, path), plan);
  const artifact = await registerArtifact(root, {
    id: plan.id, type: 'story_plan', revision: 1, status: 'draft', path
  });
  return artifact;
}

test('source-authority story cannot enter the Gate 2 human queue before comparator PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-source-comparator-fail-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  const artifact = await draftSourceAuthorityStory(root);
  await assert.rejects(submitForReview(root, artifact.id, {
    requirePassingSourceComparatorAudit: async () => { throw new Error('source comparator FAIL'); }
  }), /source comparator FAIL/);
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(item => item.id === artifact.id).status, 'draft');
});

test('Gate 2 accepts a source-authority story only after the exact comparator PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-source-comparator-pass-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  const artifact = await draftSourceAuthorityStory(root);
  await submitForReview(root, artifact.id, {
    requirePassingSourceComparatorAudit: async () => ({ decision: 'PASS' })
  });
  let checkedArtifactId = null;
  const result = await runCheckpointApprove([
    '--project', root, '--checkpoint', 'checkpoint_story', '--note', 'comparator passed'
  ], {
    requirePassingSourceComparatorAudit: async (_root, candidate) => {
      checkedArtifactId = candidate.id;
      return { decision: 'PASS' };
    }
  });
  assert.equal(checkedArtifactId, artifact.id);
  assert.equal(result.approvedCount, 1);
});

test('story edits remain candidates until explicitly adopted and preserve original shot plan', async () => {
  const { readArtifactEditor, saveArtifactEdit, previewArtifactEdit, applyArtifactEdit } = await import('../../src/services/artifact-edit-service.js');
  const root = await mkdtemp(join(tmpdir(), 'story-edit-'));
  await initializeProject(root, { projectId: 'STORY-1', workflowVersion: 2 });
  await lockCreativeBrief(root);
  const original = await createStoryPlan(root, validPlan());
  const before = await readJson(join(root, 'project-state.json'));
  const editor = await readArtifactEditor(root, original.id);
  const saved = await saveArtifactEdit(root, { artifactId: original.id, sourceSha256: editor.sourceSha256, expectedDraftRevision: 0, values: { 'story.tone': '自然温暖' } });
  assert.deepEqual(await readJson(join(root, 'project-state.json')), before);
  const args = { artifactId: original.id, draftId: saved.draftId, expectedDraftRevision: saved.draftRevision };
  const preview = await previewArtifactEdit(root, args);
  const result = await applyArtifactEdit(root, { ...args, stateFingerprint: preview.stateFingerprint, confirmImpact: true });
  assert.equal(result.artifact.type, 'story_plan');
  assert.equal(result.artifact.status, 'draft');
  assert.equal((await readJson(join(root, original.path))).story.tone, '克制写实');
  assert.equal((await readJson(join(root, result.artifact.path))).story.tone, '自然温暖');
});
