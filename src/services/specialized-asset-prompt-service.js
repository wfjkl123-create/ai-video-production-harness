function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

const DIRECTOR_PROXY_SUBJECT_KINDS = new Set(['person', 'prop', 'product', 'environment']);
const DIRECTOR_PROXY_SUBJECT_FIELDS = Object.freeze(['subjectId', 'tag', 'kind', 'proxyColor', 'position', 'screenScale', 'depthLayer', 'pose', 'orientation']);
const DIRECTOR_PROXY_SUBJECT_FIELD_SET = new Set(DIRECTOR_PROXY_SUBJECT_FIELDS);
const DIRECTOR_PROXY_DEPTH_LAYERS = new Set(['foreground', 'midground', 'background']);

function directorProxySubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) throw new TypeError('director view proxy subjects must be a non-empty array');
  const ids = new Set();
  const tags = new Set();
  const colors = new Set();
  return subjects.map((subject, index) => {
    for (const field of DIRECTOR_PROXY_SUBJECT_FIELDS) {
      text(subject?.[field], `subjects[${index}].${field}`);
    }
    if (!DIRECTOR_PROXY_SUBJECT_KINDS.has(subject.kind)) throw new TypeError(`subjects[${index}].kind is unknown`);
    if (!DIRECTOR_PROXY_DEPTH_LAYERS.has(subject.depthLayer)) throw new TypeError(`subjects[${index}].depthLayer must be foreground, midground, or background`);
    if (!/(?:low-saturation|muted|低饱和)/i.test(subject.proxyColor)) throw new TypeError(`subjects[${index}].proxyColor must be a low-saturation proxy-only color`);
    if (Object.keys(subject).some(field => !DIRECTOR_PROXY_SUBJECT_FIELD_SET.has(field))) throw new TypeError(`subjects[${index}] contains unsupported appearance or metadata fields`);
    if (ids.has(subject.subjectId)) throw new TypeError('director view proxy subjectId values must be unique');
    if (tags.has(subject.tag)) throw new TypeError('director view proxy subject tags must be unique');
    if (colors.has(subject.proxyColor)) throw new TypeError('director view proxy colors must be unique');
    ids.add(subject.subjectId);
    tags.add(subject.tag);
    colors.add(subject.proxyColor);
    return structuredClone(subject);
  });
}

function base(input, defaults, profileId, atomicAssetId, fields) {
  const editScope = fields.operation === 'edit'
    ? structuredClone(fields.editScope ?? input.editScope ?? {
      mode: 'reference_derivation',
      change: 'derive only the atomic responsibility declared for this request from the bound source media',
      continuityAfterChange: 'preserve every declared identity, geometry, camera, lighting and composition fact outside that atomic responsibility'
    })
    : undefined;
  const viewChangeMap = fields.operation === 'edit'
    ? structuredClone(fields.viewChangeMap ?? input.viewChangeMap ?? undefined)
    : undefined;
  return {
    schemaVersion: 1,
    id: `ir-${atomicAssetId}`,
    projectId: input.projectId,
    segmentId: input.segmentId ?? null,
    assetId: input.assetId,
    atomicAssetId,
    profileId,
    visualStyleContract: structuredClone(defaults.visualStyleContract),
    inputBindings: structuredClone(input.inputBindings ?? []),
    selfContainedContextVersion: '1.0',
    outputSpec: structuredClone(input.atomicOutputSpec ?? { aspectRatio: '4:3', quality: 'high' }),
    executionProfile: defaults.modelProfile.id,
    count: 1,
    autoRetry: false,
    modelFallbackPlan: [...(input.modelFallbackPlan ?? [])],
    ...(editScope ? { editScope } : {}),
    ...(viewChangeMap ? { viewChangeMap } : {}),
    ...fields
  };
}

export function buildSceneMultiviewIrs(scene, defaults) {
  for (const field of ['projectId', 'assetId', 'sceneId', 'purpose', 'locationDefinition', 'spatialAnchors', 'lightingContract', 'materialContract']) text(scene?.[field], field);
  if (!Array.isArray(scene.views) || scene.views.length !== 9) throw new TypeError('scene multiview requires exactly nine atomic views');
  if (!Array.isArray(scene.inputBindings)) throw new TypeError('scene inputBindings must be an array');
  const exterior = scene.spaceKind === 'exterior';
  const continuity = exterior
    ? 'this image must fully preserve the declared path geometry, ground surface, boundary line, horizon orientation and fixed exterior anchors'
    : 'this image must fully preserve the declared room dimensions, fixed objects, doorway positions and window positions';
  const preserve = scene.inputBindings.length > 0
    ? exterior
      ? ['scene geography', 'fixed exterior anchors', 'lighting direction', 'material identity']
      : ['scene geography', 'fixed architecture', 'lighting direction', 'material identity']
    : [];
  const avoid = exterior
    ? ['person', 'human shadow', 'changed exterior geography', 'unrelated structure', 'floating object', 'text', 'watermark', 'logo', 'cheap CGI']
    : ['person', 'human shadow', 'changed room layout', 'extra door or window', 'floating furniture', 'text', 'watermark', 'logo', 'cheap CGI'];
  return scene.views.map((view, index) => {
    for (const field of ['viewId', 'cameraContract', 'visibleAnchors', 'purpose']) text(view?.[field], `views[${index}].${field}`);
    const profileId = index === 8 ? 'scene_overhead_v1' : 'scene_multiview_v1';
    const atomicAssetId = `${scene.assetId}-${view.viewId}-v1`;
    return base(scene, defaults, profileId, atomicAssetId, {
      assetType: profileId,
      operation: scene.inputBindings.length > 0 ? 'edit' : 'create',
      purpose: `${scene.purpose}; create one independent empty-scene image for this declared camera view: ${view.purpose}`,
      responsibility: `${view.cameraContract}; show ${view.visibleAnchors} in the complete physical relationships defined in this request`,
      mustNotControl: ['character identity', 'character wardrobe', 'story action', 'product identity', 'final grid labels'],
      templateSource: `knowledge/asset-prompt-templates.md#五、场景资产（九宫格多角度）`,
      skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-camera'],
      subjectContract: { sceneId: scene.sceneId, locationDefinition: scene.locationDefinition, spatialAnchors: scene.spatialAnchors, noPeople: true },
      compositionContract: { atomicViewIndex: index + 1, viewId: view.viewId, cameraContract: view.cameraContract, visibleAnchors: view.visibleAnchors, output: 'one independent scene view only' },
      photographyContract: { lighting: scene.lightingContract, materials: scene.materialContract, continuity },
      preserve,
      constraints: ['empty scene only with no person, body, face, hand, silhouette or reflection', 'one independent view only with no collage or labels', 'every declared fixed anchor remains in its defined physical relationship'],
      avoid,
      acceptanceChecks: ['exactly one empty-scene view', `camera and visible anchors match ${view.viewId}`, 'the declared geography lighting and materials are complete and internally coherent in this image', 'no person text watermark or extra panel']
    });
  });
}

export function buildStoryPropIrs(prop, defaults) {
  for (const field of ['projectId', 'assetId', 'propId', 'purpose', 'structure', 'material', 'color', 'scaleAnchor']) text(prop?.[field], field);
  if (!Array.isArray(prop.views) || prop.views.length !== 4) throw new TypeError('story prop requires front, side, back, and detail atomic views');
  if (!Array.isArray(prop.inputBindings)) throw new TypeError('prop inputBindings must be an array');
  const expected = ['front', 'side', 'back', 'detail'];
  if (prop.views.some((view, index) => view.viewId !== expected[index])) throw new TypeError('prop views must be front, side, back, detail in that order');
  return prop.views.map((view, index) => {
    text(view.description, `views[${index}].description`);
    const atomicAssetId = `${prop.assetId}-${view.viewId}-v1`;
    return base(prop, defaults, 'story_prop_v1', atomicAssetId, {
      assetType: 'story_prop',
      operation: prop.inputBindings.length > 0 ? 'edit' : 'create',
      purpose: `${prop.purpose}; generate only the ${view.viewId} atomic view`,
      responsibility: `${view.description}; preserve exact structure, material, color and scale`,
      mustNotControl: ['character identity', 'story scene', 'character action', 'camera movement', 'final four-panel layout'],
      templateSource: 'knowledge/asset-prompt-templates.md#六、道具资产（三视图）',
      skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'asset-prompt-template-strict-fill'],
      subjectContract: { propId: prop.propId, structure: prop.structure, material: prop.material, color: prop.color, scaleAnchor: prop.scaleAnchor },
      compositionContract: { viewId: view.viewId, description: view.description, objectCount: 1, output: 'one independent prop view only' },
      photographyContract: { background: 'white or light neutral gray seamless background', camera: 'locked orthographic-like product reference view', lighting: 'soft neutral light revealing material and edges' },
      preserve: prop.inputBindings.length > 0 ? ['prop geometry', 'material', 'color', 'scale and key details'] : [],
      constraints: ['exactly one prop', 'complete object inside frame', 'no perspective redesign between views', 'no collage labels or text'],
      avoid: ['changed geometry', 'changed material', 'changed color', 'duplicate object', 'human hand', 'scene background', 'text', 'watermark', 'logo invention'],
      acceptanceChecks: [`one complete ${view.viewId} view`, 'the declared structure material color scale and key details are complete and internally coherent in this image', 'no person text watermark or extra panel']
    });
  });
}

export function buildDirectorViewProxyIr(proxy, defaults) {
  for (const field of ['projectId', 'segmentId', 'assetId', 'shotId', 'purpose', 'sceneGeometryContract', 'cameraContract', 'occlusionContract', 'contactContract']) {
    text(proxy?.[field], field);
  }
  if (!Array.isArray(proxy.inputBindings)) throw new TypeError('director view proxy inputBindings must be an array');
  if (!proxy.atomicOutputSpec || typeof proxy.atomicOutputSpec !== 'object' || Array.isArray(proxy.atomicOutputSpec)) {
    throw new TypeError('director view proxy atomicOutputSpec must be an object');
  }
  text(proxy.atomicOutputSpec.aspectRatio, 'atomicOutputSpec.aspectRatio');
  text(proxy.atomicOutputSpec.quality, 'atomicOutputSpec.quality');
  const subjects = directorProxySubjects(proxy.subjects);
  const hasPeople = subjects.some(subject => subject.kind === 'person');
  return base(proxy, defaults, 'director_view_proxy_v1', `${proxy.assetId}-camera-view-v1`, {
    assetType: 'director_view_proxy',
    operation: proxy.inputBindings.length > 0 ? 'edit' : 'create',
    purpose: `${proxy.purpose}; create one composition-only previs image for locked shot ${proxy.shotId} from the final camera viewpoint`,
    responsibility: 'final camera-view subject order, screen scale, foreground/midground/background placement, pose, occlusion and declared contact points using color-coded proxy figures',
    mustNotControl: [
      'real-person identity or facial appearance',
      'wardrobe design or wardrobe color',
      'product appearance or geometry',
      'final human, wardrobe, product or scene material and texture',
      'final color grade',
      'transfer of proxy mannequin colors into final video'
    ],
    templateSource: 'knowledge/image-profiles/director-view-proxy.md#director_view_proxy_v1',
    skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-camera', ...(hasPeople ? ['seedance-characters'] : [])],
    subjectContract: {
      shotId: proxy.shotId,
      sceneGeometry: proxy.sceneGeometryContract,
      subjects
    },
    compositionContract: {
      mode: 'single_final_camera_view_director_proxy',
      finalCameraView: proxy.cameraContract,
      subjectLayout: subjects.map(subject => ({
        subjectId: subject.subjectId,
        tag: subject.tag,
        position: subject.position,
        screenScale: subject.screenScale,
        depthLayer: subject.depthLayer,
        pose: subject.pose,
        orientation: subject.orientation
      })),
      occlusion: proxy.occlusionContract,
      contacts: proxy.contactContract,
      output: 'one independent full-frame director-view proxy image only'
    },
    photographyContract: structuredClone(proxy.photographyContract ?? {
      viewpoint: 'render only the declared final camera perspective; do not add an overhead, side, reverse or alternate view',
      proxyRendering: 'simplified live-camera previs with featureless solid matte color-coded proxy figures and only enough neutral scene volume to read placement',
      lighting: 'neutral readable previs lighting with contact shadows sufficient to verify depth, overlap and physical contact; not final scene lighting or material design'
    }),
    preserve: proxy.inputBindings.length > 0
      ? ['bound final-camera perspective', 'declared subject layout and screen scale', 'depth order, occlusion and contact points', 'scene geometry needed to locate subjects']
      : [],
    constraints: [
      'render exactly one final-camera-view frame with no collage, alternate angle, diagram or overhead inset',
      'use each declared proxy color only to distinguish its bound subject inside this previs image',
      'show every subject at the declared screen position, scale, depth layer, pose and orientation',
      'make every declared occlusion and contact point directly visible and physically unambiguous',
      'proxy people are smooth featureless forms with no identifiable face, skin, hair, wardrobe detail or fabric texture',
      'for this diagnostic proxy image, the proxy rendering and authority boundaries override any global visual-style wording about skin, wardrobe, product, scene material, texture or final color',
      'no text, label, number, arrow, logo, watermark, subtitle, UI or border'
    ],
    avoid: [
      'real-person likeness', 'recognizable face', 'detailed clothing', 'final material rendering', 'product redesign',
      'proxy color leaking into final wardrobe or skin', 'wrong foreground/background order', 'wrong screen scale',
      'hidden contact point', 'merged limbs', 'extra subject', 'alternate camera angle', 'collage', 'text', 'watermark'
    ],
    acceptanceChecks: [
      'the output contains exactly one full-frame image from the declared final camera viewpoint',
      'every subject tag maps to one unique solid proxy color and no undeclared subject appears',
      'screen position, scale, depth layer, pose, orientation and subject order match the declared layout',
      'occlusion edges and every declared contact point are visible and anatomically separable',
      'no proxy controls or implies real identity, wardrobe design, product appearance, final material, texture or color grade',
      'there is no alternate view, diagram, collage, text, logo, watermark, subtitle, UI or border'
    ]
  });
}

export function buildMannequinFrameIrs(sequence, defaults) {
  for (const field of ['projectId', 'segmentId', 'assetId', 'purpose', 'originalSceneContract']) text(sequence?.[field], field);
  if (!Array.isArray(sequence.frames) || sequence.frames.length === 0) throw new TypeError('mannequin sequence frames must be non-empty');
  return sequence.frames.map((frame, index) => {
    if (frame.frameIndex !== index + 1 || typeof frame.timeSec !== 'number') throw new TypeError(`frames[${index}] index/time is invalid`);
    for (const field of ['poseContract', 'contactContract', 'cameraContract', 'blockingContract']) text(frame[field], `frames[${index}].${field}`);
    if (!Array.isArray(frame.inputBindings) || frame.inputBindings.length === 0 || frame.inputBindings[0].primaryRole !== 'original frame pose camera blocking and real scene') throw new TypeError(`frames[${index}] requires the original frame as its first role-bound input`);
    const atomicAssetId = `${sequence.assetId}-frame-${String(frame.frameIndex).padStart(2, '0')}-v1`;
    return base({ ...sequence, inputBindings: frame.inputBindings, atomicOutputSpec: sequence.atomicOutputSpec }, defaults, 'mannequin_grid_v1', atomicAssetId, {
      assetType: 'mannequin_frame',
      operation: 'edit',
      purpose: `${sequence.purpose}; replace people only in source frame ${frame.frameIndex} at ${frame.timeSec}s`,
      responsibility: 'preserve original real scene, camera, framing, pose, gestures, contacts, occlusion and blocking; replace every person with a volumetric gray-white clay figure',
      mustNotControl: ['canonical real-person identity', 'new scene design', 'new camera', 'future action', 'grid layout'],
      templateSource: 'knowledge/capabilities/mannequin-grid-prompt.md#步骤 3：生成假模宫格（核心提示词）',
      skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-sequence', 'seedance-camera', 'seedance-characters'],
      subjectContract: { sourceTimeSec: frame.timeSec, characterColorMap: structuredClone(sequence.characterColorMap), mannequinMaterial: 'continuous matte gray-white clay or plaster, smooth faceless oval head, no visible joint balls, clear five-finger hands', productException: sequence.productException ?? 'approved product keeps its real appearance while non-product clothing becomes continuous mannequin material' },
      compositionContract: { frameIndex: frame.frameIndex, pose: frame.poseContract, contact: frame.contactContract, camera: frame.cameraContract, blocking: frame.blockingContract, output: 'one repaired source frame only' },
      photographyContract: { scene: sequence.originalSceneContract, lighting: 'retain source light direction and intensity; mannequin receives contact shadows, cast shadows and environment reflections', volume: 'full 3D body volume integrated into the real scene, never a flat cutout' },
      preserve: ['original real scene and spatial structure', 'camera and shot scale', 'pose joint angles hand gesture and body weight', 'contact points and occlusion', 'light direction and environment interaction'],
      constraints: ['replace every visible person and their non-product clothing with continuous faceless clay figure material', 'same character keeps the same low-saturation color in every frame', 'figure must stand inside the real scene with contact shadow and physical volume', 'output one frame only with no grid text watermark or subtitle'],
      avoid: ['paper-cutout person', 'white outline', 'halo', 'floating body', 'flat silhouette', 'visible real face or skin', 'joint balls', 'missing fingers', 'neutral studio background', 'changed pose', 'changed camera', 'text', 'watermark'],
      acceptanceChecks: ['source pose gesture contact occlusion camera and blocking are preserved', 'all people are fully faceless volumetric clay figures inside the original real scene', 'hands have natural visible fingers', 'character color map stays stable', 'no paper-cutout edge real identity text watermark or extra panel']
    });
  });
}
