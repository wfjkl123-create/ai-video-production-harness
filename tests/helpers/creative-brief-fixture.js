export function directorCreativeContract(overrides = {}) {
  return {
    structureMode: 'product_demo',
    characterMode: 'character_driven',
    projectIntent: {
      purpose: '用短剧情建立可验证的产品价值',
      audience: '对夸张宣传保持怀疑的潜在用户',
      desiredAudienceEffect: '从质疑转为愿意亲手验证',
      deliveryContext: '十五秒竖屏商业短视频',
      commercialIntent: true,
      productDramaticFunction: '产品作为改变人物立场的可见证据'
    },
    recommendedDirection: {
      directionId: 'direction-visible-proof',
      logline: '主角停止解释，用一次现场演示改变质疑者的立场',
      coreMeaning: '可信度来自可见结果',
      extensionOfUserIdea: '把笼统的产品被质疑延伸为拒绝动作、现场证明和主动验证的完整因果链',
      openingDesign: {
        firstFrame: '对方把产品推回桌面，主角的手停在半空', trigger: '拒绝动作先于任何解释发生',
        audienceQuestion: '她还能怎样证明自己', storyBridge: '主角收回解释欲，直接进入现场演示',
        rationale: '用动作同时建立冲突、人物压力和后续证明任务'
      },
      centralConflict: '口头解释无效，主角必须现场证明',
      coreTurn: '质疑者亲手确认演示结果',
      endingPayoff: '质疑者主动拿起产品查看',
      progressionLogic: '拒绝触发演示，演示产生证据，证据改变对方动作',
      recommendationRationale: {
        audienceEffect: '观众与质疑者同步被证据说服',
        storyCausality: '开头、转折和结尾由动作因果连接',
        productFunction: '产品直接承担冲突解决功能',
        executionRisk: '单场景和单一关键动作便于稳定验证'
      }
    },
    alternativesConsidered: [],
    characters: [{
      characterId: 'character-a', importance: 'lead', dramaticFunction: '承担从解释到行动证明的选择',
      emotionalBaseline: '克制谨慎', audienceRelationship: '观众先观察再认同', visibleBehavior: '停顿后开始演示',
      objective: '让对方相信产品', obstacle: '对方拒绝口头说明', tactic: '用行动代替辩解', arc: '从被动解释转为主动证明'
    }],
    storyOutline: ['开头出现拒绝', '中段完成演示与转折', '结尾用主动验证兑现变化'],
    scenePriorities: ['拒绝动作先于解释', '完整看清产品结果'],
    emotionAndRhythm: { emotionCurve: '怀疑施压到证据释放', rhythmStrategy: '快建立冲突，完整保留动作与反应' },
    audiovisualStrategy: {
      pointOfView: '跟随主角承受质疑，用对方反应完成意义', cameraMotive: '只在证据出现时靠近',
      editingStrategy: '拒绝、证明、反应各自完整', soundStrategy: '保留真实接触声', specialTechniques: []
    },
    creativeBoundaries: { mustKeep: ['产品结果必须可见'], mustAvoid: ['不用无动机运镜冒充电影感'] },
    uncertaintyLedger: [{
      variable: '精确资产范围', disposition: 'deferred_to_gate2', owner: 'director',
      status: 'deferred', resolution: '由 Gate 2 从锁定 Shotlist 反推，不影响当前创意方向',
      evidenceOrReason: '必须从 Shotlist 反推', revisitAt: 'Gate 2'
    }],
    decisionLedger: {
      confirmedFacts: ['项目目标是通过剧情证明产品价值'],
      professionalRecommendations: ['采用一个明确推荐方向'],
      lockedVariables: ['观众体验与故事闭环'],
      rejectedPatterns: [{
        pattern: '把质疑者写成纯粹恶人', reason: '削弱观众代入', scope: '当前创意母版',
        reopenTrigger: '项目类型改为夸张讽刺喜剧时'
      }]
    },
    provisionalExecution: {
      segmentation: 'provisional_until_gate2', assetScope: 'provisional_until_gate2', parallelism: 'provisional_until_gate2'
    },
    ...overrides
  };
}

export function creativeDecision(overrides = {}) {
  const contract = directorCreativeContract();
  return {
    storyDirection: contract.recommendedDirection.logline,
    successDefinition: contract.projectIntent.desiredAudienceEffect,
    segmentationStrategy: 'single_clip',
    segmentationRationale: 'Gate 1 暂定单段，Gate 2 根据 Shotlist 精确锁定',
    executionMode: 'mixed',
    assetExecutionMode: 'parallel',
    videoExecutionMode: 'sequential',
    parallelPlan: ['人物、场景和产品资产按统一视觉合同并行制作'],
    estimatedAssetCombination: ['character_board', 'scene_multiview', 'product_reference'],
    referenceWorkflow: { referenceIntent: 'idea_only', sourceVideoIds: [] },
    directorCreativeContract: contract,
    revisionImpact: {
      previousCreativeBriefId: null,
      changeSummary: 'Initial Gate 1 director creative master; no prior downstream work is invalidated',
      changedDecisionPaths: [], affectedStages: [], affectedArtifactIds: [], requiredRework: [], preservedDecisions: [],
      impactPolicy: 'conservative_v1'
    },
    ...overrides
  };
}

export function creativeBrief({ projectId = 'PROJECT-1', id = 'creative-brief-v1', ...overrides } = {}) {
  return {
    schemaVersion: 3,
    id,
    projectId,
    targetDurationSec: 15,
    creativeDecision: creativeDecision(),
    lockedConstraints: ['创意只在 Gate 1 正式确认一次'],
    ...overrides
  };
}
