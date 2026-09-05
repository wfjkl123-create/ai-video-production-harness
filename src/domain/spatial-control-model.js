const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
import { assertProjectId } from './project-id.js';
const SHA256 = /^[a-f0-9]{64}$/;
const FIDELITY_TARGETS = new Set(['adapted', 'faithful', 'one_to_one']);
const INPUT_MODES = new Set(['keyframes_only', 'animatic_video']);
const CONTROLS = new Set(['position', 'pose', 'contact', 'occlusion', 'camera', 'camera_path', 'action_timing', 'shot_transitions']);
const FORBIDDEN = new Set(['identity', 'face', 'wardrobe_appearance', 'product_appearance', 'texture', 'color', 'quality', 'world_style']);

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function id(value, field) {
  text(value, field);
  if (!SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function file(value, field) {
  object(value, field);
  text(value.path, `${field}.path`);
  if (!SHA256.test(value.sha256 ?? '')) throw new TypeError(`${field}.sha256 must be a lowercase SHA-256`);
}

function exactSet(values, allowed, field, minimum = 1) {
  if (!Array.isArray(values) || values.length < minimum) throw new TypeError(`${field} must contain at least ${minimum} entries`);
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must be unique`);
  for (const value of values) if (!allowed.has(value)) throw new TypeError(`${field} contains unsupported value: ${value}`);
}

export function assertSpatialControlModel(value) {
  object(value, 'spatial control model');
  if (value.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1');
  id(value.id, 'id');
  assertProjectId(value.projectId);
  id(value.segmentId, 'segmentId');
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new TypeError('revision must be a positive integer');
  if (!FIDELITY_TARGETS.has(value.fidelityTarget)) throw new TypeError('fidelityTarget is invalid');
  if (!INPUT_MODES.has(value.modelingInputMode)) throw new TypeError('modelingInputMode is invalid');
  if (value.fidelityTarget === 'one_to_one') file(value.sourceReference, 'sourceReference');
  else if (value.sourceReference !== undefined) file(value.sourceReference, 'sourceReference');
  file(value.blenderProject, 'blenderProject');
  file(value.animatic, 'animatic');
  if (!(value.animatic.durationSec > 0) || !(value.animatic.fps > 0)
    || !Number.isInteger(value.animatic.width) || !Number.isInteger(value.animatic.height)) {
    throw new TypeError('animatic requires positive durationSec/fps and integer width/height');
  }
  object(value.cameraMatch, 'cameraMatch');
  text(value.cameraMatch.aspectRatio, 'cameraMatch.aspectRatio');
  if (!Array.isArray(value.cameraMatch.cutTimesSec)) throw new TypeError('cameraMatch.cutTimesSec must be an array');
  if (!Array.isArray(value.cameraMatch.validationTimesSec) || value.cameraMatch.validationTimesSec.length < 2) {
    throw new TypeError('cameraMatch.validationTimesSec requires at least two times');
  }
  if (!Array.isArray(value.subjects) || value.subjects.length < 1) throw new TypeError('subjects must be a non-empty array');
  const subjectIds = new Set();
  for (const [index, subject] of value.subjects.entries()) {
    object(subject, `subjects[${index}]`);
    id(subject.subjectId, `subjects[${index}].subjectId`);
    text(subject.role, `subjects[${index}].role`);
    text(subject.proxyColor, `subjects[${index}].proxyColor`);
    if (subjectIds.has(subject.subjectId)) throw new TypeError('subject IDs must be unique');
    subjectIds.add(subject.subjectId);
  }
  object(value.authority, 'authority');
  exactSet(value.authority.controls, CONTROLS, 'authority.controls');
  exactSet(value.authority.mustNotControl, FORBIDDEN, 'authority.mustNotControl');
  if (!Array.isArray(value.derivedAssets) || value.derivedAssets.length < 2) throw new TypeError('derivedAssets requires at least two exports');
  const types = [];
  for (const [index, asset] of value.derivedAssets.entries()) {
    object(asset, `derivedAssets[${index}]`);
    id(asset.id, `derivedAssets[${index}].id`);
    if (!['director_view_proxy', 'spatial_control_animatic'].includes(asset.type)) throw new TypeError(`derivedAssets[${index}].type is invalid`);
    file(asset, `derivedAssets[${index}]`);
    types.push(asset.type);
  }
  if (types.filter(type => type === 'director_view_proxy').length < 2) {
    throw new TypeError('spatial control requires at least two model-derived director_view_proxy endpoints');
  }
  if (value.modelingInputMode === 'animatic_video' && !types.includes('spatial_control_animatic')) {
    throw new TypeError('animatic_video requires a spatial_control_animatic derived asset');
  }
  object(value.validation, 'validation');
  if (value.validation.status !== 'PASS') throw new TypeError('validation.status must be PASS');
  id(value.validation.comparisonId, 'validation.comparisonId');
  if (!Array.isArray(value.validation.checks) || value.validation.checks.length < 5) {
    throw new TypeError('validation.checks requires at least five source-to-model checks');
  }
  return value;
}
