import { assertArtifact } from '../domain/artifact.js';
import { requireMatchingAssetVisualAudit } from '../domain/asset-visual-audit.js';
import { hasPreciseVerifiedDirectorRoute, preciseCapabilityArtifact } from '../domain/director-route-state.js';
import { workflowProfileIdOf } from '../domain/workflow-profile.js';
import { currentArtifactsOf } from '../domain/current-artifact.js';
import {
  assertCanonicalHdRestorationHandoffArtifact,
  assertObservedHandoffArtifact
} from './handoff-service.js';

export const PROJECT_ASSET_TYPES = Object.freeze([
  'character_board', 'character_front_face_closeup_v1', 'character_identity_single_view', 'product_reference', 'scene_multiview', 'scene_overhead', 'story_prop',
  'character_product_state', 'wardrobe_board', 'color_board'
]);

export const SEGMENT_ASSET_TYPES = Object.freeze([
  'initial_blocking', 'handoff_blocking', 'camera_blocking', 'director_view_proxy', 'spatial_control_animatic', 'depth_video_reference', 'storyboard',
  'character_product_state', 'expression_board', 'wardrobe_board', 'color_board',
  'dialogue_axis_board', 'mannequin_grid', 'identity_pair_board', 'dialogue_audio_reference', 'timing_audio_reference', 'source_audio_candidate'
]);

const RESPONSIBILITIES = Object.freeze({
  character_board: ['identity, face, hair, body proportions, and approved styling', ['scene', 'story action', 'camera', 'product appearance', 'color grade']],
  character_front_face_closeup_v1: ['talking-head facial identity, forehead mole, hair silhouette, visible jewelry and the on-camera neckline wardrobe only', ['scene layout', 'story action', 'camera', 'product appearance', 'color grade', 'unseen full-body proportions']],
  character_identity_single_view: ['single-view identity, face, hair, wardrobe and body proportions only', ['scene', 'story action', 'camera', 'product appearance', 'color grade', 'reference-board layout']],
  identity_pair_board: ['the two explicitly mapped identities, faces, hair, wardrobes and body proportions only; left/right mapping is local to the board', ['scene', 'story action', 'camera', 'product appearance', 'color grade', 'reference-board layout', 'generated cast blocking']],
  product_reference: ['product structure, color, material, and immutable details', ['identity', 'wardrobe', 'scene', 'camera', 'story action']],
  scene_multiview: ['space structure, fixed anchors, boundaries, and light direction', ['identity', 'wardrobe', 'product appearance', 'story action', 'final texture']],
  scene_overhead: ['complete spatial layout', ['identity', 'wardrobe', 'product appearance', 'color grade', 'final texture']],
  story_prop: ['prop appearance, structure, material, and key details', ['identity', 'wardrobe', 'camera', 'color grade', 'story timing']],
  initial_blocking: ['initial positions, orientations, sightlines, distances, and camera position', ['identity', 'wardrobe', 'product appearance', 'color grade', 'final texture']],
  handoff_blocking: ['observed prior-segment ending positions, states, camera, and open motion', ['identity', 'wardrobe', 'product appearance', 'color grade', 'final texture']],
  camera_blocking: ['character paths, orientations, entrances, exits, camera points, and camera path', ['identity', 'wardrobe', 'product appearance', 'color grade', 'final texture']],
  dialogue_axis_board: ['speaker and listener screen positions, mutual eyelines, and screen-direction axis only', ['identity', 'wardrobe', 'product appearance', 'story action', 'reaction order', 'final texture', 'dialogue wording']],
  mannequin_grid: ['frame-derived pose timing, blocking, contact points, camera and occlusion using gray-white or role-bound low-saturation gray mannequins', ['identity', 'wardrobe texture', 'product appearance', 'mannequin material transfer', 'final human appearance']],
  director_view_proxy: ['final camera-view subject order, screen scale, foreground/background layers, pose, and occlusion using color-coded mannequins', ['identity', 'wardrobe', 'product appearance', 'mannequin color transfer', 'final texture']],
  spatial_control_animatic: ['camera-matched blocking, pose, contact, occlusion, camera path, action timing, and shot transitions rendered from the locked Blender control model', ['identity', 'face', 'wardrobe appearance', 'product appearance', 'gray-model material transfer', 'rig controls', 'guides', 'axes', 'labels', 'final texture', 'final color']],
  depth_video_reference: ['per-frame monocular relative depth, camera path, subject scale, occlusion, and motion timing from the exact locked source clip', ['identity', 'face', 'wardrobe appearance', 'product appearance', 'scene texture', 'depth grayscale as final color', 'dialogue wording', 'audio']],
  storyboard: ['nine-panel cut order, rough framing, screen-side blocking, action endpoints, and visual rhythm only', ['identity', 'wardrobe', 'product appearance', 'color grade', 'final texture']],
  character_product_state: ['approved relationship and state between character and product', ['identity', 'wardrobe', 'product appearance', 'scene', 'camera', 'color grade', 'story timing', 'final texture']],
  expression_board: ['script-required facial expression states', ['identity', 'wardrobe', 'scene', 'camera', 'product appearance']],
  wardrobe_board: ['approved reusable wardrobe and styling', ['identity', 'scene', 'camera', 'product appearance', 'story action']],
  color_board: ['color roles and their allowed usage ranges', ['identity', 'wardrobe structure', 'product structure', 'camera', 'story action']],
  dialogue_audio_reference: ['speaker order, vocal tone, pauses, cadence, and mouth-timing clock only; written prompt text supplies dialogue words', ['dialogue wording', 'visual identity', 'wardrobe', 'product appearance', 'scene', 'camera', 'framing']],
  timing_audio_reference: ['dialogue entry timing, cadence, pauses, stress, speaker handoff, action clock and trim window only', ['dialogue wording', 'final speaker timbre', 'speaker identity', 'visual identity', 'wardrobe', 'product appearance', 'scene', 'camera', 'framing']],
  source_audio_candidate: ['exact approved source-audio waveform, dialogue words, original speaker timbre, cadence, pauses, ambient sound, dialogue and lipsync clock, trim window, and final-mux candidate', ['visual identity', 'wardrobe', 'product appearance', 'scene', 'camera', 'framing']]
});

const AUDIO_ASSET_TYPES = new Set(['dialogue_audio_reference', 'timing_audio_reference', 'source_audio_candidate']);
const VIDEO_ASSET_TYPES = new Set(['spatial_control_animatic', 'depth_video_reference']);
const MULTI_INSTANCE_SEGMENT_ASSET_TYPES = new Set(['identity_pair_board']);
// Some generated-control profiles describe a single atomic view rather than a
// canonical multi-view board.  Preserve their profile-specific pixel audit,
// then resolve them to the canonical asset responsibility for manifest use.
const ASSET_TYPE_ALIASES = Object.freeze({
  character_front_face_closeup_v1: 'character_identity_single_view',
  character_identity_source_visible_v1: 'character_identity_single_view',
  scene_multiview_v1: 'scene_multiview',
  story_prop_v1: 'story_prop',
  story_prop_set_v1: 'story_prop',
  color_board_v1: 'color_board'
});
const NON_MEDIA_SEGMENT_REQUIREMENTS = new Set(['continuous_camera_path_contract']);
const MULTI_PROJECT_ASSET_TYPES = new Set(['character_product_state']);

export function canonicalAssetType(value) {
  return ASSET_TYPE_ALIASES[value] ?? value;
}

function requiresPixelVisualAudit(artifact) {
  return artifact.mediaKind !== 'audio';
}

// The simple-remake core assets and the two explicitly user-bound controls
// below are either supplied by the user or derived locally from the locked
// source. Their semantic role is checked again in the generation package;
// forcing a second visible asset checkpoint would contradict this profile's
// documented three human gates.
function isMachineDelegatedSimpleRemakeAsset(project, artifact) {
  return workflowProfileIdOf(project) === 'simple_remake'
    && artifact?.status === 'locked'
    && ['project_asset', 'segment_asset'].includes(artifact.type)
    && ['depth_video_reference', 'initial_blocking', 'product_reference', 'expression_board', 'source_audio_candidate'].includes(artifact.assetType);
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function isCurrentArtifact(artifact) {
  return typeof artifact?.invalidatedByScopeRevisionId !== 'string';
}

function lockedArtifact(artifacts, type, label) {
  const candidates = artifacts
    .filter((artifact) => artifact.type === type && artifact.status === 'locked' && isCurrentArtifact(artifact))
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (candidates.length > 1 && candidates[0].revision === candidates[1].revision) {
    throw new Error(`multiple locked ${label} artifacts have revision ${candidates[0].revision}`);
  }
  const found = candidates[0];
  if (!found) throw new Error(`a locked ${label} artifact is required`);
  assertArtifact(found);
  return found;
}

function lockedObservedHandoff(artifacts, previousSegmentId) {
  const candidates = artifacts
    .filter((artifact) => artifact.type === 'handoff'
      && artifact.segmentId === previousSegmentId
      && artifact.status === 'locked'
      && artifact.observed === true
      && isCurrentArtifact(artifact))
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (candidates.length > 1 && candidates[0].revision === candidates[1].revision) {
    throw new Error(`multiple locked observed handoff artifacts have revision ${candidates[0].revision}`);
  }
  const found = candidates[0];
  if (!found) throw new Error(`a locked observed handoff for ${previousSegmentId} is required`);
  assertObservedHandoffArtifact(found);
  return found;
}

function lockedCanonicalHdRestorationHandoff(artifacts, previousSegmentId, observedHandoff) {
  const candidates = artifacts
    .filter((artifact) => artifact.type === 'handoff'
      && artifact.segmentId === previousSegmentId
      && artifact.status === 'locked'
      && artifact.handoffKind === 'canonical_hd_restoration'
      && artifact.observed !== true
      && artifact.sourceArtifactId === observedHandoff.id
      && artifact.sourceArtifactSha256 === observedHandoff.sha256
      && isCurrentArtifact(artifact))
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (candidates.length > 1 && candidates[0].revision === candidates[1].revision) {
    throw new Error(`multiple locked canonical HD restoration handoff artifacts have revision ${candidates[0].revision}`);
  }
  const found = candidates[0];
  if (!found) {
    throw new Error(`a locked canonical HD restoration handoff derived from ${observedHandoff.id} is required`);
  }
  assertCanonicalHdRestorationHandoffArtifact(found);
  return found;
}

function lockedHandoffReconciliation(artifacts, previousSegmentId, nextSegmentId, observedHandoff, project) {
  const candidates = currentArtifactsOf(artifacts, artifact => artifact.type === 'handoff_reconciliation'
    && artifact.segmentId === nextSegmentId
    && artifact.previousSegmentId === previousSegmentId
    && artifact.nextSegmentId === nextSegmentId
    && artifact.status === 'locked'
    && artifact.decision === 'PASS'
    && artifact.observedHandoffId === observedHandoff.id
    && artifact.observedHandoffSha256 === observedHandoff.sha256
    && (!project.verifiedSegmentationId || artifact.sourceSegmentationId === project.verifiedSegmentationId)
    && (!project.verifiedSegmentationSha256 || artifact.sourceSegmentationSha256 === project.verifiedSegmentationSha256));
  if (candidates.length !== 1) {
    throw new Error(`exactly one locked PASS handoff reconciliation from ${previousSegmentId} to ${nextSegmentId} is required`);
  }
  assertArtifact(candidates[0]);
  return candidates[0];
}

function manifestItem(type, source, segmentId, scope) {
  if (!['project', 'segment'].includes(scope)) throw new Error(`asset manifest scope must be project or segment: ${scope ?? ''}`);
  if (source && AUDIO_ASSET_TYPES.has(type) && source.mediaKind !== 'audio') {
    throw new Error(`${type} ${source.id} must declare mediaKind audio`);
  }
  if (source && VIDEO_ASSET_TYPES.has(type) && source.mediaKind !== 'video') {
    throw new Error(`${type} ${source.id} must declare mediaKind video`);
  }
  let [responsibility, mustNotControl] = RESPONSIBILITIES[type];
  if (type === 'character_identity_single_view' && source?.assetType === 'character_identity_source_visible_v1') {
    responsibility = 'single identity, face, hair, white mesh top, plaid skirt, and body proportions visible in the source frame from head through at least the knees only';
    mustNotControl = ['source scene appearance or layout', 'story action', 'camera', 'product appearance', 'text', 'watermark', 'UI', 'color grade', 'unseen full-body proportions', 'reference-board layout'];
  } else if (type === 'character_identity_single_view' && source?.assetType === 'character_front_face_closeup_v1') {
    responsibility = 'talking-head inner-face identity and stable facial feature proportions only';
    mustNotControl = ['expression timing', 'smile intensity', 'hair', 'hairline', 'earrings', 'ears', 'neck', 'wardrobe', 'body proportions', 'background', 'scene', 'camera', 'product appearance', 'story action', 'lighting', 'color grade'];
  } else if (type === 'director_view_proxy' && source?.mediaKind === 'video'
    && /(?:original-video authority|source-video (?:bytes|authority))/i.test(source?.authorityScope ?? '')) {
    responsibility = 'exact original-video authority for every source-visible pixel, action, expression timing, lip shape, gaze, blink, head and hand movement, hair, wardrobe, body, product, subtitle, B-roll, transition, composition, camera and lighting outside the explicitly replaced inner-face identity';
    mustNotControl = ['the replacement inner-face identity only'];
  } else if (type === 'expression_board' && source?.simpleRemakeIdentityReference === true) {
    responsibility = 'single protagonist facial identity, face proportions, hairline, facial features and the approved range of expressions only';
    mustNotControl = ['reference-board grid layout', 'white background', 'blue top or any reference wardrobe', 'reference lighting', 'scene', 'camera', 'body proportions', 'product appearance', 'story action', 'color grade'];
  } else if (type === 'character_product_state' && source?.ownerScope === 'unique_global_owner') {
    responsibility = 'unique global owner of identity, face, hair, wardrobe, clay material, background, and long-term body proportions; also owns its approved local chest state';
    mustNotControl = ['camera path', 'story timing', 'other approved pain-state local geometry'];
  } else if (type === 'character_product_state' && source?.stateRole === 'sag_after_flat_profile') {
    responsibility = 'local flat chest geometry, upright posture, and the strict 90-degree side-angle endpoint only';
    mustNotControl = ['identity', 'wardrobe', 'product appearance', 'scene', 'camera path', 'subject scale', 'crop', 'color grade', 'story timing', 'final texture'];
  } else if (type === 'character_product_state' && source?.stateRole === 'right_sidebreast_before') {
    responsibility = 'local right-arm-raised pose, right underarm bulge geometry, and character-right three-quarter direction only';
    mustNotControl = ['identity', 'wardrobe', 'product appearance', 'scene', 'camera path', 'subject scale', 'crop', 'color grade', 'story timing', 'final texture'];
  } else if (type === 'character_product_state' && source?.stateRole === 'right_sidebreast_after') {
    responsibility = 'local same-side raised-arm pose, smooth right underarm geometry, and character-right three-quarter direction only';
    mustNotControl = ['identity', 'wardrobe', 'product appearance', 'scene', 'camera path', 'subject scale', 'crop', 'color grade', 'story timing', 'final texture'];
  }
  const item = {
    id: source?.id ?? `${segmentId}-${type}`,
    type,
    scope,
    status: source?.status ?? 'awaiting_review',
    responsibility,
    mustNotControl: [...mustNotControl]
  };
  if (scope === 'segment') item.segmentId = source?.segmentId ?? segmentId;
  if (source) {
    item.revision = source.revision;
    item.path = source.path;
    item.lockedByReviewId = source.lockedByReviewId;
    item.sha256 = source.sha256;
    if (source.characterId) item.characterId = source.characterId;
    if (source.sceneId) item.sceneId = source.sceneId;
    if (source.stateRole) item.stateRole = source.stateRole;
    if (source.ownerScope) item.ownerScope = source.ownerScope;
    if (source.visualContractVersion) item.visualContractVersion = source.visualContractVersion;
    else if (['character_board', 'character_front_face_closeup_v1', 'character_identity_single_view'].includes(type)
      && source.visualAuditId) item.visualContractVersion = 1;
    if (source.visualAuditId) item.visualAuditId = source.visualAuditId;
    if (source.mediaKind) item.mediaKind = source.mediaKind;
    if (source.segmentationId) item.segmentationId = source.segmentationId;
    if (source.segmentationSha256) item.segmentationSha256 = source.segmentationSha256;
    if (source.required === false) item.required = false;
    if (source.excludeFromGeneration === true) item.excludeFromGeneration = true;
    if (Array.isArray(source.shotIds)) item.shotIds = [...source.shotIds];
    if (Array.isArray(source.sourceAssetIds)) item.sourceAssetIds = [...source.sourceAssetIds];
    if (Array.isArray(source.identitySlotBindings)) item.identitySlotBindings = structuredClone(source.identitySlotBindings);
    if (source.compositionMethod) item.compositionMethod = source.compositionMethod;
    if (source.sourceControlModelId) item.sourceControlModelId = source.sourceControlModelId;
    if (source.sourceControlModelSha256) item.sourceControlModelSha256 = source.sourceControlModelSha256;
  }
  return item;
}

function requireLockedSegment(segment, label) {
  if (segment.status !== 'locked') throw new Error(`${label} ${segment.id} must be locked as approved`);
  if (typeof segment.lockedByReviewId !== 'string' || segment.lockedByReviewId.trim() === '') {
    throw new Error(`${label} ${segment.id} requires human review evidence`);
  }
}

// A story plan may deny a historical visual artifact because its pixels no
// longer meet the reviewed control contract.  The same file can have more
// than one legacy artifact record after a migration or re-review.  Excluding
// only one record would still let an alias of the denied pixels reach a later
// prompt.  Treat exact content/path aliases as denied too; a newly generated
// replacement with different pixels remains eligible.
function excludedAssetIdentity(stateArtifacts, excludedAssetIds) {
  const excluded = stateArtifacts.filter(artifact => excludedAssetIds.has(artifact.id));
  return {
    ids: excludedAssetIds,
    sha256: new Set(excluded.map(artifact => artifact.sha256).filter(Boolean)),
    paths: new Set(excluded.map(artifact => artifact.path).filter(Boolean))
  };
}

function isExcludedAssetAlias(artifact, excluded) {
  return excluded.ids.has(artifact.id)
    || (artifact.sha256 && excluded.sha256.has(artifact.sha256))
    || (artifact.path && excluded.paths.has(artifact.path));
}

// Locked story plans intentionally keep the exact asset IDs reviewed at Gate 2.
// Gate 3 may replace one of those candidates without reopening the story by
// registering a same-scope successor. Resolve that explicit lineage here so a
// stale draft predecessor cannot block the approved successor, while refusing
// ambiguous forks instead of guessing which replacement to use.
function resolveExplicitAssetSuccessor(artifacts, id, expectedType = null, reviewedSuccessors = null) {
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  let current = byId.get(id);
  if (!current || (expectedType && current.type !== expectedType)) return null;
  const lineageType = expectedType ?? current.type;
  const visited = new Set();
  while (true) {
    if (visited.has(current.id)) throw new Error(`asset successor lineage contains a cycle at ${current.id}`);
    visited.add(current.id);
    const successors = artifacts.filter(candidate => candidate.supersedesArtifactId === current.id && isCurrentArtifact(candidate));
    const reviewedTargetId = reviewedSuccessors?.[current.id] ?? null;
    if (reviewedTargetId) {
      const reviewedTarget = byId.get(reviewedTargetId);
      if (!reviewedTarget) throw new Error(`reviewed asset successor ${reviewedTargetId} does not exist`);
      if (reviewedTarget.type !== lineageType) throw new Error(`reviewed asset successor ${reviewedTargetId} changes type from ${lineageType}`);
      if (successors.length > 0 && !successors.some(candidate => candidate.id === reviewedTargetId)) {
        const explicitFinal = successors.length === 1
          ? resolveExplicitAssetSuccessor(artifacts, successors[0].id, lineageType, reviewedSuccessors)
          : null;
        if (!explicitFinal || explicitFinal.id !== reviewedTargetId) {
          throw new Error(`reviewed asset successor ${reviewedTargetId} conflicts with explicit lineage for ${current.id}`);
        }
      }
      current = reviewedTarget;
      continue;
    }
    if (successors.length === 0) return current;
    if (successors.length !== 1) throw new Error(`asset ${current.id} has ambiguous successors: ${successors.map(item => item.id).join(', ')}`);
    if (successors[0].type !== lineageType) throw new Error(`asset successor ${successors[0].id} changes type from ${lineageType}`);
    current = successors[0];
  }
}

function orderedSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('canonical project segment order is required');
  const seen = new Set();
  const parsed = segments.map((segment) => {
    const match = /^segment-(\d{3,})$/.exec(segment?.id ?? '');
    if (!match) throw new Error(`invalid segment ID: ${segment?.id ?? ''}`);
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1 || `segment-${String(number).padStart(3, '0')}` !== segment.id) {
      throw new Error(`invalid segment ID: ${segment.id}`);
    }
    if (seen.has(segment.id)) throw new Error(`duplicate segment ID: ${segment.id}`);
    seen.add(segment.id);
    return { number, segment };
  }).sort((left, right) => left.number - right.number);
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index].number !== index + 1) throw new Error('segment IDs must form a contiguous sequence starting at segment-001');
  }
  return parsed.map(({ segment }) => segment);
}

function canonicalSegmentContext(project, requested) {
  const segments = orderedSegments(project.segments);
  const matching = segments.filter(({ id }) => id === requested.id);
  if (matching.length !== 1) throw new Error(`canonical segment ${requested.id} must appear exactly once`);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const expectedPrevious = index === 0 ? null : segments[index - 1].id;
    const expectedNext = index === segments.length - 1 ? null : segments[index + 1].id;
    if (segment.previousSegmentId !== expectedPrevious) {
      throw new Error(`segment ${segment.id} previousSegmentId must be ${expectedPrevious ?? 'null'} in canonical order`);
    }
    if (segment.nextSegmentId !== expectedNext) {
      throw new Error(`segment ${segment.id} nextSegmentId must be ${expectedNext ?? 'null'} in canonical order`);
    }
  }
  const index = segments.indexOf(matching[0]);
  const canonical = matching[0];
  if (requested.previousSegmentId !== canonical.previousSegmentId || requested.nextSegmentId !== canonical.nextSegmentId) {
    throw new Error(`requested segment ${requested.id} disagrees with canonical segment relationships`);
  }
  return { canonical, index, segments };
}

export function requiresObservedHandoff(segment, index) {
  if (index === 0 && (segment.previousSegmentId === null || segment.previousSegmentId === undefined)) return false;
  if (segment.continuityStrategy === undefined) return true;
  if (!['canonical_open', 'editorial_cut', 'continuous_proxy_handoff'].includes(segment.continuityStrategy)) {
    throw new Error(`unknown continuityStrategy for ${segment.id}: ${segment.continuityStrategy}`);
  }
  return segment.continuityStrategy === 'continuous_proxy_handoff';
}

function requirePriorGate(project, index, currentSegment) {
  if (index === 0 || !requiresObservedHandoff(currentSegment, index)) {
    return { observedHandoff: null, canonicalHdRestorationHandoff: null, handoffReconciliation: null };
  }
  const previous = project.segments[index - 1];
  requireLockedSegment(previous, 'earlier segment');
  const observedHandoff = lockedObservedHandoff(project.artifacts, previous.id);
  if (!(project.verifiedObservedHandoffIds ?? []).includes(observedHandoff.id)) {
    throw new Error(`observed handoff ${observedHandoff.id} requires verified file and human review evidence`);
  }
  // The canonical-HD restoration proxy and the three-way reconciliation are
  // realism-v2 contracts.  Legacy workflow/realism-v1 projects historically
  // hand off the reviewed observed frame directly; requiring v2 derivatives
  // here would make a readable v1 project impossible to continue.
  const canonicalHdRestorationHandoff = project.realismContractsVersion === 2
    ? lockedCanonicalHdRestorationHandoff(project.artifacts, previous.id, observedHandoff)
    : null;
  const handoffReconciliation = project.realismContractsVersion === 2
    ? lockedHandoffReconciliation(project.artifacts, previous.id, currentSegment.id, observedHandoff, project)
    : null;
  return { observedHandoff, canonicalHdRestorationHandoff, handoffReconciliation };
}

export function compileAssetManifest(project, segment) {
  requireObject(project, 'project');
  requireObject(segment, 'segment');
  const artifacts = Array.isArray(project.artifacts) ? project.artifacts.filter(isCurrentArtifact) : [];
  const { canonical, index, segments } = canonicalSegmentContext(project, segment);
  requireLockedSegment(canonical, 'current segment');
  let storyPlan = null;
  let excludedAssetIds = new Set();
  if ((project.workflowVersion ?? 1) >= 2) {
    storyPlan = artifacts.find(artifact => artifact.id === project.verifiedStoryPlanId
      && artifact.type === 'story_plan' && artifact.status === 'locked');
    if (!storyPlan) throw new Error('workflowVersion 2 requires verified locked story_plan evidence');
    assertArtifact(storyPlan);
    excludedAssetIds = new Set(storyPlan.excludedAssetIds ?? []);
  }
  const excludedAssets = excludedAssetIdentity(artifacts, excludedAssetIds);
  const script = storyPlan ?? lockedArtifact(artifacts, 'script', 'script');
  const shotlist = storyPlan ?? lockedArtifact(artifacts, 'shotlist', 'shotlist');
  const {
    observedHandoff,
    canonicalHdRestorationHandoff,
    handoffReconciliation
  } = requirePriorGate({ ...project, artifacts, segments }, index, canonical);
  const projectIds = Array.isArray(canonical.projectAssetIds) ? canonical.projectAssetIds : [];
  const requirements = Array.isArray(canonical.segmentAssetRequirements) ? canonical.segmentAssetRequirements : [];

  let capabilityManifest = null;
  let spatialControlModel = null;
  let capabilityAssetRequirements = [];
  let capabilityArtifactRequirements = [];
  if (project.verifiedCapabilityManifestId) {
    capabilityManifest = preciseCapabilityArtifact(project);
    if (!capabilityManifest) throw new Error('verified capability manifest is missing, unlocked, or does not prove explicit schemaVersion 2 routing');
    if (storyPlan && capabilityManifest.storyPlanId !== storyPlan.id) throw new Error('capability manifest does not belong to the verified story plan');
    const resolvedAssets = project.resolvedCapabilityRequirementsBySegment;
    const resolvedArtifacts = project.resolvedCapabilityArtifactsBySegment;
    capabilityAssetRequirements = Array.isArray(resolvedAssets?.[canonical.id])
      ? resolvedAssets[canonical.id]
      : (capabilityManifest.requiredAssetsBySegment?.[canonical.id] ?? []);
    capabilityArtifactRequirements = Array.isArray(resolvedArtifacts?.[canonical.id])
      ? resolvedArtifacts[canonical.id]
      : (capabilityManifest.requiredArtifactsBySegment?.[canonical.id] ?? []);
  }

  // A reviewed segment may list its complete input contract in one array,
  // including canonical project assets such as product_reference. Route those
  // types to the project lane instead of misclassifying them as segment media.
  const requiredProjectAssetTypes = [...new Set([
    ...requirements.filter(type => PROJECT_ASSET_TYPES.includes(type) && !SEGMENT_ASSET_TYPES.includes(type)),
    ...requirements.filter(type => MULTI_PROJECT_ASSET_TYPES.has(type)
      && artifacts.some(artifact => artifact.type === 'project_asset'
        && canonicalAssetType(artifact.assetType) === type && artifact.status === 'locked'
        && !isExcludedAssetAlias(artifact, excludedAssets))),
    ...capabilityAssetRequirements.filter(type => PROJECT_ASSET_TYPES.includes(type))
  ])];
  const effectiveSegmentRequirements = [...new Set([
    ...requirements.filter(type => SEGMENT_ASSET_TYPES.includes(type)
      && !(PROJECT_ASSET_TYPES.includes(type) && !SEGMENT_ASSET_TYPES.includes(type))),
    ...capabilityAssetRequirements.filter(type => SEGMENT_ASSET_TYPES.includes(type))
  ])];
  // A simple remake can add only the two optional controls selected in the
  // visual asset picker until an explicit director route exists. Once such a
  // route is locked, its minimum assets are authoritative: retaining a
  // legacy picker selection may silently add a forbidden source-audio mux
  // candidate or an unnecessary expression board to a direct-edit contract.
  if (workflowProfileIdOf(project) === 'simple_remake' && !hasPreciseVerifiedDirectorRoute(project)) {
    const selected = new Set(project.assetSelection?.selected ?? []);
    // Requirements from the locked segment/capability route are already
    // de-duplicated above.  The visual picker may select an asset that is
    // mandatory on that route (notably the original audio), so keep the
    // manifest to one physical input per semantic responsibility.
    if (selected.has('character_reference') && !effectiveSegmentRequirements.includes('expression_board')) {
      effectiveSegmentRequirements.push('expression_board');
    }
    if (selected.has('voice_reference') && !effectiveSegmentRequirements.includes('source_audio_candidate')) {
      effectiveSegmentRequirements.push('source_audio_candidate');
    }
  }
  // A locked depth video already carries the exact per-frame blocking, camera,
  // occlusion and motion contract. When the reviewed capability route requires
  // depth (and does not independently require a blocking image), the legacy
  // first-frame placeholder is redundant and must not expand Gate 3 scope.
  if (effectiveSegmentRequirements.includes('depth_video_reference')
    && capabilityAssetRequirements.includes('depth_video_reference')
    && !capabilityAssetRequirements.includes('initial_blocking')) {
    const index = effectiveSegmentRequirements.indexOf('initial_blocking');
    if (index >= 0) effectiveSegmentRequirements.splice(index, 1);
  }
  const unsupportedSegmentRequirementTypes = requirements.filter(type => !PROJECT_ASSET_TYPES.includes(type)
    && !SEGMENT_ASSET_TYPES.includes(type) && !NON_MEDIA_SEGMENT_REQUIREMENTS.has(type));
  if (unsupportedSegmentRequirementTypes.length > 0) {
    throw new Error(`unknown segment asset type: ${unsupportedSegmentRequirementTypes.join(', ')}`);
  }
  const unsupportedCapabilityAssetTypes = capabilityAssetRequirements.filter(type => !PROJECT_ASSET_TYPES.includes(type) && !SEGMENT_ASSET_TYPES.includes(type));
  if (unsupportedCapabilityAssetTypes.length > 0) {
    throw new Error(`director capability declares unsupported asset types for ${canonical.id}: ${unsupportedCapabilityAssetTypes.join(', ')}`);
  }

  const resolvedProjectRefs = projectIds.map(id => ({
    id,
    artifact: resolveExplicitAssetSuccessor(artifacts, id, null, project.resolvedAssetSuccessorMap)
  }));
  for (const { id, artifact } of resolvedProjectRefs) {
    if (!artifact) throw new Error(`referenced project asset ${id} is not locked`);
    if (artifact.type === 'segment_asset') {
      const type = canonicalAssetType(artifact.assetType);
      if (artifact.segmentId !== canonical.id || !effectiveSegmentRequirements.includes(type)) {
        throw new Error(`referenced project asset ${id} resolves to an unexpected segment asset`);
      }
    } else if (artifact.type !== 'project_asset') {
      throw new Error(`referenced project asset ${id} resolves to unsupported type ${artifact.type}`);
    }
  }
  const projectItems = resolvedProjectRefs.filter(({ artifact }) => artifact.type === 'project_asset').map(({ id, artifact }) => {
    if (!artifact || artifact.type !== 'project_asset' || artifact.status !== 'locked') {
      throw new Error(`referenced project asset ${id} is not locked`);
    }
    assertArtifact(artifact);
    const assetType = canonicalAssetType(artifact.assetType);
    if (!PROJECT_ASSET_TYPES.includes(assetType)) throw new Error(`unknown project asset type: ${artifact.assetType ?? ''}`);
    if (requiresPixelVisualAudit(artifact)
      && (hasPreciseVerifiedDirectorRoute(project) || ['character_board', 'character_identity_single_view', 'character_identity_source_visible_v1'].includes(artifact.assetType))
      && !isMachineDelegatedSimpleRemakeAsset(project, artifact)) {
      requireMatchingAssetVisualAudit(project, artifact);
    }
    return manifestItem(assetType, artifact, canonical.id, 'project');
  });
  for (const type of requiredProjectAssetTypes) {
    if (projectItems.some(item => item.type === type)) continue;
    const candidates = artifacts
      .filter(artifact => artifact.type === 'project_asset' && canonicalAssetType(artifact.assetType) === type && artifact.status === 'locked'
        && !artifact.invalidatedByScopeRevisionId
        && !isExcludedAssetAlias(artifact, excludedAssets))
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
    if (candidates.length === 0 || (!MULTI_PROJECT_ASSET_TYPES.has(type) && candidates.length !== 1)) {
      throw new Error(`director capability requires exactly one locked project ${type} for ${canonical.id}; found ${candidates.length}`);
    }
    for (const artifact of candidates) {
      assertArtifact(artifact);
      if (requiresPixelVisualAudit(artifact)
        && (hasPreciseVerifiedDirectorRoute(project) || ['character_board', 'character_identity_single_view', 'character_identity_source_visible_v1'].includes(artifact.assetType))
        && !isMachineDelegatedSimpleRemakeAsset(project, artifact)) {
        requireMatchingAssetVisualAudit(project, artifact);
      }
      projectItems.push(manifestItem(type, artifact, canonical.id, 'project'));
    }
  }
  const segmentItems = effectiveSegmentRequirements.filter(type => !projectItems.some(item => item.type === type)).flatMap((type) => {
    if (!SEGMENT_ASSET_TYPES.includes(type)) throw new Error(`unknown segment asset type: ${type}`);
    const requiresCurrentSegmentationBinding = (project.workflowVersion ?? 1) >= 2
      && typeof project.verifiedSegmentationId === 'string'
      && typeof project.verifiedSegmentationSha256 === 'string';
    const explicitCandidates = resolvedProjectRefs
      .map(({ artifact }) => artifact)
      .filter(artifact => artifact.type === 'segment_asset'
        && canonicalAssetType(artifact.assetType) === type
        && artifact.segmentId === canonical.id
        && artifact.status === 'locked'
        && isCurrentArtifact(artifact));
    if (explicitCandidates.length > 1 && !MULTI_INSTANCE_SEGMENT_ASSET_TYPES.has(type)) {
      throw new Error(`multiple explicit locked ${type} assets are referenced for ${canonical.id}`);
    }
    const candidates = explicitCandidates.length > 0 ? explicitCandidates : artifacts
      .filter(artifact => artifact.type === 'segment_asset' && artifact.assetType === type
        && artifact.segmentId === canonical.id && artifact.status === 'locked'
        && isCurrentArtifact(artifact)
        && !isExcludedAssetAlias(artifact, excludedAssets)
        && (!requiresCurrentSegmentationBinding || (
          artifact.segmentationId === project.verifiedSegmentationId
          && artifact.segmentationSha256 === project.verifiedSegmentationSha256
        )))
      .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
    if (!MULTI_INSTANCE_SEGMENT_ASSET_TYPES.has(type) && candidates.length > 1 && candidates[0].revision === candidates[1].revision) {
      throw new Error(`multiple locked ${type} assets have revision ${candidates[0].revision}`);
    }
    const selectedCandidates = MULTI_INSTANCE_SEGMENT_ASSET_TYPES.has(type) ? candidates : candidates.slice(0, 1);
    for (const candidate of selectedCandidates) {
      if (requiresPixelVisualAudit(candidate) && hasPreciseVerifiedDirectorRoute(project)
        && !isMachineDelegatedSimpleRemakeAsset(project, candidate)) {
        requireMatchingAssetVisualAudit(project, candidate);
      }
    }
    if (selectedCandidates.length === 0) return [manifestItem(type, null, canonical.id, 'segment')];
    return selectedCandidates
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(candidate => manifestItem(type, candidate, canonical.id, 'segment'));
  });

  if (project.verifiedCapabilityManifestId) {
    const presentTypes = new Set([...projectItems, ...segmentItems].map(item => item.type));
    const missing = capabilityAssetRequirements.filter(type => !presentTypes.has(type));
    if (missing.length > 0) throw new Error(`director capability assets missing for ${canonical.id}: ${missing.join(', ')}`);
    for (const artifactType of capabilityArtifactRequirements) {
      const matches = artifacts.filter(artifact => artifact.type === artifactType
        && artifact.segmentId === canonical.id && artifact.status === 'locked'
        && isCurrentArtifact(artifact));
      if (matches.length !== 1) throw new Error(`director capability artifact ${artifactType} for ${canonical.id} must have exactly one locked current artifact`);
      assertArtifact(matches[0]);
      if (artifactType === 'spatial_control_model') spatialControlModel = matches[0];
    }
    if (spatialControlModel) {
      for (const item of [...projectItems, ...segmentItems].filter(item => ['director_view_proxy', 'spatial_control_animatic'].includes(item.type))) {
        if (item.sourceControlModelId !== spatialControlModel.id || item.sourceControlModelSha256 !== spatialControlModel.sha256) {
          throw new Error(`${item.type} ${item.id} must derive from the exact locked spatial control model ${spatialControlModel.id}`);
        }
      }
    }
  }

  return {
    id: `${canonical.id}-asset-manifest`,
    segmentId: canonical.id,
    status: 'awaiting_review',
    sourceArtifactIds: {
      script: script.id,
      shotlist: shotlist.id,
      ...(excludedAssetIds.size > 0 ? { excludedAssetIds: [...excludedAssetIds].sort() } : {}),
      ...(project.verifiedSegmentationId ? { segmentation: project.verifiedSegmentationId } : {}),
      ...(capabilityManifest ? { capabilityManifest: capabilityManifest.id } : {}),
      ...(spatialControlModel ? { spatialControlModel: spatialControlModel.id } : {})
    },
    observedHandoffId: observedHandoff?.id ?? null,
    canonicalHdRestorationHandoffId: canonicalHdRestorationHandoff?.id ?? null,
    handoffReconciliationId: handoffReconciliation?.id ?? null,
    items: [...projectItems, ...segmentItems]
  };
}

export function assertLockedAssetInputs(manifest) {
  requireObject(manifest, 'manifest');
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) throw new Error('manifest items are required');
  for (const item of manifest.items) {
    if (item.status !== 'locked') throw new Error(`asset input ${item.id ?? ''} is not locked`);
    if (typeof item.responsibility !== 'string' || item.responsibility.trim() === '') throw new Error('each asset input requires exactly one responsibility string');
    if (!Array.isArray(item.mustNotControl) || item.mustNotControl.length === 0) throw new Error('each asset input requires a non-empty mustNotControl array');
    if (['character_board', 'character_front_face_closeup_v1', 'character_identity_single_view'].includes(item.type)) {
      if (typeof item.characterId !== 'string' || item.characterId.trim() === '') throw new Error(`${item.type} ${item.id} requires exactly one characterId`);
      if (item.visualContractVersion !== 1 || typeof item.visualAuditId !== 'string' || item.visualAuditId.trim() === '') {
        throw new Error(`${item.type} ${item.id} requires the version 1 multimodal visual audit contract`);
      }
    }
    if (AUDIO_ASSET_TYPES.has(item.type) && item.mediaKind !== 'audio') {
      throw new Error(`${item.type} ${item.id} must declare mediaKind audio`);
    }
  }
  const characterIds = manifest.items.filter(({ type }) => ['character_board', 'character_front_face_closeup_v1', 'character_identity_single_view'].includes(type)).map(({ characterId }) => characterId);
  if (new Set(characterIds).size !== characterIds.length) throw new Error('each character must use exactly one independent character_board');
  return true;
}
