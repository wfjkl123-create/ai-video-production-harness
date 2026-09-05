export function verifiedModelProfile(overrides = {}) {
  return {
    id: 'test-image-model-v1',
    executionSurface: 'test-image-surface',
    supportedOperations: ['create', 'edit'],
    supportedProfileIds: ['*'],
    supportedAspectRatios: ['4:3', '1:1'],
    qualityOptions: ['high'],
    maxInputImages: 5,
    ratioPolicy: 'native',
    evidenceStatus: 'verified',
    evidence: { source: 'unit-test contract', scope: 'test-only image surface', notes: 'deterministic fixture evidence' },
    updatedAt: '2026-07-30T00:00:00Z',
    ...overrides
  };
}

export function visualStyleContract(overrides = {}) {
  return {
    id: 'visual-style-v1',
    version: 1,
    description: 'natural live-action studio reference photography with neutral colors',
    locks: ['neutral gray background', 'soft three-point lighting', 'natural skin texture'],
    ...overrides
  };
}

export function validCharacterIr(overrides = {}) {
  const ir = {
    schemaVersion: 1,
    id: 'ir-character-a-front-v1',
    projectId: 'project-001',
    segmentId: null,
    assetId: 'character-a-board-v1',
    atomicAssetId: 'character-a-front-v1',
    assetType: 'character_board',
    profileId: 'character_front_face_closeup_v1',
    operation: 'create',
    purpose: 'Create the front identity image for Character A for the declared production',
    responsibility: 'front face identity and hair only',
    mustNotControl: ['story scene', 'camera movement'],
    templateSource: 'knowledge/image-profiles/character-board.md#character_front_face_closeup_v1',
    skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-characters'],
    selfContainedContextVersion: '1.0',
    visualStyleContract: visualStyleContract(),
    inputBindings: [],
    subjectContract: {
      characterId: 'character-a',
      tag: 'Character A',
      identityDefinition: 'Chinese woman, age 30 to 35, oval face, straight black shoulder-length hair',
      wardrobe: 'plain cream crew-neck top',
      bodyProportions: 'natural adult proportions',
      action: 'neutral reference pose'
    },
    compositionContract: { view: 'front face close-up', subjectCount: 1 },
    photographyContract: { background: 'neutral gray studio', lighting: 'soft three-point light', realism: 'live-action photography' },
    preserve: [],
    constraints: ['exactly one person', 'front face visible'],
    avoid: ['duplicate person', 'text', 'watermark'],
    acceptanceChecks: ['one identity only', 'both eyes visible', 'hair silhouette readable'],
    outputSpec: { aspectRatio: '4:3', quality: 'high' },
    executionProfile: 'test-image-model-v1',
    count: 1,
    autoRetry: false,
    modelFallbackPlan: [],
    ...overrides
  };
  if (ir.operation === 'edit' && ir.editScope === undefined) {
    ir.editScope = {
      mode: 'reference_derivation',
      change: 'derive only the declared character identity view from the bound source image',
      continuityAfterChange: 'preserve the declared identity, wardrobe and body proportions outside the requested view framing'
    };
  }
  return ir;
}

export function validDirectorViewProxyIr(overrides = {}) {
  const subjects = [
    {
      subjectId: 'character-a',
      tag: 'Character A proxy',
      kind: 'person',
      proxyColor: 'low-saturation blue',
      position: 'screen-left, one shoulder width from the left frame edge',
      screenScale: 'head-to-foot height equals sixty percent of frame height',
      depthLayer: 'midground',
      pose: 'standing with weight on the left foot and right hand touching the suitcase handle',
      orientation: 'body turned three quarters toward screen-right'
    },
    {
      subjectId: 'suitcase-a',
      tag: 'Suitcase proxy',
      kind: 'prop',
      proxyColor: 'low-saturation amber',
      position: 'screen-center beside Character A proxy right leg',
      screenScale: 'top reaches Character A proxy knee',
      depthLayer: 'midground',
      pose: 'upright on the floor',
      orientation: 'front plane parallel to the camera sensor'
    }
  ];
  const ir = {
    schemaVersion: 1,
    id: 'ir-segment-001-director-proxy-v1',
    projectId: 'project-001',
    segmentId: 'segment-001',
    assetId: 'segment-001-director-proxy-v1',
    atomicAssetId: 'segment-001-director-proxy-v1-camera-view-v1',
    assetType: 'director_view_proxy',
    profileId: 'director_view_proxy_v1',
    operation: 'create',
    purpose: 'Previsualize the locked final camera composition for shot S01 without defining canonical appearance',
    responsibility: 'final camera-view subject order, screen scale, depth layers, occlusion and contact points only',
    mustNotControl: [
      'real-person identity or facial appearance',
      'wardrobe design or wardrobe color',
      'product appearance or geometry',
      'final human, wardrobe, product or scene material and texture',
      'final color grade',
      'transfer of proxy mannequin colors into final video'
    ],
    templateSource: 'knowledge/image-profiles/director-view-proxy.md#director_view_proxy_v1',
    skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-camera', 'seedance-characters'],
    selfContainedContextVersion: '1.0',
    visualStyleContract: visualStyleContract(),
    inputBindings: [],
    subjectContract: {
      shotId: 'S01',
      sceneGeometry: 'level floor with one doorway centered in the background and a clear standing area in front',
      subjects
    },
    compositionContract: {
      mode: 'single_final_camera_view_director_proxy',
      finalCameraView: 'locked 50mm-equivalent eye-level medium full shot, camera faces the doorway without movement',
      subjectLayout: subjects.map(({ subjectId, tag, position, screenScale, depthLayer, pose, orientation }) => ({ subjectId, tag, position, screenScale, depthLayer, pose, orientation })),
      occlusion: 'the suitcase may overlap Character A proxy lower right shin but must not cover either hand',
      contacts: 'Character A proxy right palm contacts only the suitcase handle; both feet and suitcase wheels contact the floor',
      output: 'one independent full-frame director-view proxy image only'
    },
    photographyContract: {
      viewpoint: 'declared final camera view only',
      proxyRendering: 'featureless solid matte color-coded proxy figures in a simplified neutral scene volume',
      lighting: 'neutral readable previs lighting with contact shadows'
    },
    preserve: [],
    constraints: ['one final-camera frame only', 'featureless proxy people', 'declared contact points remain visible', 'no text or alternate view'],
    avoid: ['real-person likeness', 'detailed wardrobe', 'final material', 'wrong depth order', 'text', 'watermark'],
    acceptanceChecks: ['one final camera view', 'unique proxy colors', 'declared layout and contacts are visible', 'no canonical appearance authority'],
    outputSpec: { aspectRatio: '4:3', quality: 'high' },
    executionProfile: 'test-image-model-v1',
    count: 1,
    autoRetry: false,
    modelFallbackPlan: [],
    ...overrides
  };
  if (ir.operation === 'edit' && ir.editScope === undefined) {
    ir.editScope = {
      mode: 'reference_derivation',
      change: 'derive only the declared proxy blocking from the bound source frame',
      continuityAfterChange: 'preserve the declared camera, layout, depth, occlusion and contact facts outside the proxy conversion'
    };
  }
  return ir;
}

export function characterBoardInput(characterId = 'character-a', overrides = {}) {
  return {
    projectId: 'project-001',
    assetId: `${characterId}-board-v1`,
    characterId,
    tag: characterId === 'character-a' ? 'Character A' : 'Character B',
    purpose: `Create a reusable four-view identity board for ${characterId}`,
    identityDefinition: `${characterId} has one stable original face and black hair`,
    wardrobe: `${characterId} wears one stable neutral studio outfit`,
    bodyProportions: 'natural adult proportions with stable height and silhouette',
    inputBindings: [],
    atomicOutputSpec: { aspectRatio: '4:3', quality: 'high', background: 'neutral gray' },
    ...overrides
  };
}

export function directorViewProxyInput(overrides = {}) {
  return {
    projectId: 'project-001',
    segmentId: 'segment-001',
    assetId: 'segment-001-director-proxy-v1',
    shotId: 'S01',
    purpose: 'Previsualize the final camera composition before video prompt compilation',
    sceneGeometryContract: 'level floor, background doorway centered, no other foreground obstacle',
    cameraContract: 'locked 50mm-equivalent eye-level medium full shot facing the doorway',
    occlusionContract: 'the suitcase overlaps only the lower right shin and no face or hand',
    contactContract: 'Character A proxy right palm contacts the suitcase handle; both feet and suitcase wheels contact the floor',
    subjects: [
      {
        subjectId: 'character-a', tag: 'Character A proxy', kind: 'person', proxyColor: 'low-saturation blue',
        position: 'screen-left, one shoulder width from the left edge', screenScale: 'head-to-foot height equals sixty percent of frame height',
        depthLayer: 'midground', pose: 'standing with weight on the left foot and right hand on the suitcase handle',
        orientation: 'body turned three quarters toward screen-right'
      },
      {
        subjectId: 'suitcase-a', tag: 'Suitcase proxy', kind: 'prop', proxyColor: 'low-saturation amber',
        position: 'screen-center beside Character A proxy right leg', screenScale: 'top reaches Character A proxy knee',
        depthLayer: 'midground', pose: 'upright on the floor', orientation: 'front plane parallel to the camera sensor'
      }
    ],
    inputBindings: [],
    atomicOutputSpec: { aspectRatio: '4:3', quality: 'high' },
    modelFallbackPlan: [],
    ...overrides
  };
}
