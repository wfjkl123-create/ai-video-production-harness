import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { assertProjectId } from './project-id.js';

export const IMAGE_PROMPT_OPERATIONS = Object.freeze(['create', 'edit', 'compose', 'extract']);
export const REQUIRED_IMAGE_PROMPT_SKILL = 'gpt-image-2-style-library';
export const SINGLE_IMAGE_PROMPT_SKILL_DECISION = 'user_selected_single_image_prompt_skill';
export const CORE_IMAGE_PROFILE_IDS = Object.freeze([
  'character_identity_anchor_v1',
  'character_front_face_closeup_v1',
  'character_profile_face_closeup_v1',
  'character_front_wardrobe_no_head_v1',
  'character_front_full_body_v2',
  'character_full_body_back_v1',
  'character_board_v1',
  'wardrobe_board_v1',
  'expression_board_v1',
  'product_reference_v1',
  'story_prop_v1',
  'scene_multiview_v1',
  'scene_overhead_v1',
  'initial_blocking_v1',
  'camera_blocking_v1',
  'director_view_proxy_v1',
  'dialogue_axis_board_v1',
  'storyboard_sheet_15s_v1',
  'storyboard_panel_repair_v1',
  'storyboard_execution_panel_v1',
  'mannequin_grid_v1',
  'color_board_v1'
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_TAG = /^Image([1-9][0-9]*)$/;
// Every image request must stand alone: the receiving model has no project, prompt,
// asset, or conversation history unless a concrete ImageN binding declares it.
// Keep this deliberately broad so a compiler cannot accidentally smuggle sequence
// context into an otherwise zero-context prompt.
const IMPLICIT_REFERENCE = /(上述|前述|同上|沿用此前|参考前面|结合现有素材|当前|旧版|上一(?:条|段|张|个)?|前一(?:条|段|张|个)?|此前|\b(?:current|old|previous|earlier|prior)\b|\b(?:other\s+views?|all\s+nine\s+views?|same\s+scene\s+geography)\b)/i;
const UNRESOLVED_PLACEHOLDER = /(TODO|TBD|待补|待填写|请填写|<sha256>|[【\[][^】\]]*(?:填写|待补|TODO|TBD)[^】\]]*[】\]])/i;

function object(value, field, { allowEmpty = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  if (!allowEmpty && Object.keys(value).length === 0) throw new TypeError(`${field} must not be empty`);
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function safeId(value, field) {
  string(value, field);
  if (!SAFE_ID.test(value)) throw new TypeError(`${field} must be a safe identifier`);
}

function projectPath(value, field) {
  string(value, field);
  if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) throw new TypeError(`${field} must be project-relative`);
}

function stringList(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError(`${field} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  value.forEach((entry, index) => string(entry, `${field}[${index}]`));
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must contain unique values`);
}

function assertSkillRoutingDecision(value) {
  object(value, 'skillRoutingDecision');
  if (value.mode !== SINGLE_IMAGE_PROMPT_SKILL_DECISION) throw new TypeError('skillRoutingDecision.mode is invalid');
  if (value.skillId !== REQUIRED_IMAGE_PROMPT_SKILL) throw new TypeError(`skillRoutingDecision.skillId must be ${REQUIRED_IMAGE_PROMPT_SKILL}`);
  if (value.scope !== 'storyboard_prompt_method_only') throw new TypeError('skillRoutingDecision.scope must be storyboard_prompt_method_only');
  string(value.reason, 'skillRoutingDecision.reason');
  stringList(value.supersededLegacySkillIds, 'skillRoutingDecision.supersededLegacySkillIds');
}

function walkStrings(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(item => walkStrings(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => walkStrings(item, visit));
}

function assertNoHiddenContext(value) {
  walkStrings(value, (entry) => {
    if (UNRESOLVED_PLACEHOLDER.test(entry)) throw new TypeError(`unresolved placeholder is forbidden: ${entry}`);
    if (IMPLICIT_REFERENCE.test(entry)) throw new TypeError(`implicit prior-context reference is forbidden: ${entry}`);
  });
}

export function assertInputBinding(value, index = 0) {
  object(value, `inputBindings[${index}]`);
  if (!IMAGE_TAG.test(value.tag ?? '')) throw new TypeError(`inputBindings[${index}].tag must be Image1, Image2, ...`);
  safeId(value.artifactId, `inputBindings[${index}].artifactId`);
  projectPath(value.path, `inputBindings[${index}].path`);
  if (!SHA256.test(value.sha256 ?? '')) throw new TypeError(`inputBindings[${index}].sha256 must be a lowercase SHA-256`);
  string(value.primaryRole, `inputBindings[${index}].primaryRole`);
  string(value.subjectSelector, `inputBindings[${index}].subjectSelector`);
  stringList(value.transfer, `inputBindings[${index}].transfer`);
  stringList(value.ignore, `inputBindings[${index}].ignore`);
  const overlap = value.transfer.filter(item => value.ignore.includes(item));
  if (overlap.length > 0) throw new TypeError(`inputBindings[${index}] transfer and ignore conflict: ${overlap.join(', ')}`);
  return value;
}

export function assertVisualStyleContract(value) {
  object(value, 'visualStyleContract');
  safeId(value.id, 'visualStyleContract.id');
  if (!Number.isInteger(value.version) || value.version < 1) throw new TypeError('visualStyleContract.version must be a positive integer');
  string(value.description, 'visualStyleContract.description');
  stringList(value.locks, 'visualStyleContract.locks');
  return value;
}

const EDIT_SCOPE_MODES = new Set(['surgical', 'reference_derivation', 'panel_repair', 'texture_pass', 'view_change']);

export function assertEditScope(value) {
  object(value, 'editScope');
  if (!EDIT_SCOPE_MODES.has(value.mode)) throw new TypeError('editScope.mode is invalid');
  for (const field of ['change', 'continuityAfterChange']) string(value[field], `editScope.${field}`);
  return value;
}

export function assertViewChangeMap(value) {
  object(value, 'viewChangeMap');
  for (const field of ['sourceView', 'targetView']) string(value[field], `viewChangeMap.${field}`);
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) throw new TypeError('viewChangeMap.anchors must be a non-empty array');
  const ids = new Set();
  for (const [index, anchor] of value.anchors.entries()) {
    object(anchor, `viewChangeMap.anchors[${index}]`);
    for (const field of ['anchorId', 'sourcePosition', 'targetPosition']) string(anchor[field], `viewChangeMap.anchors[${index}].${field}`);
    if (ids.has(anchor.anchorId)) throw new TypeError('viewChangeMap anchorId values must be unique');
    ids.add(anchor.anchorId);
  }
  return value;
}

export function assertImagePromptIr(value) {
  object(value, 'image prompt IR');
  if (value.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1');
  safeId(value.id, 'id');
  assertProjectId(value.projectId);
  for (const field of ['assetId', 'atomicAssetId', 'assetType', 'profileId']) safeId(value[field], field);
  if (value.segmentId !== null && value.segmentId !== undefined) safeId(value.segmentId, 'segmentId');
  if (!CORE_IMAGE_PROFILE_IDS.includes(value.profileId)) throw new TypeError(`unknown profileId: ${value.profileId}`);
  if (!IMAGE_PROMPT_OPERATIONS.includes(value.operation)) throw new TypeError(`unknown operation: ${value.operation ?? ''}`);
  for (const field of ['purpose', 'responsibility', 'templateSource', 'selfContainedContextVersion', 'executionProfile']) string(value[field], field);
  projectPath(value.templateSource.split('#')[0], 'templateSource');
  stringList(value.mustNotControl, 'mustNotControl');
  stringList(value.skillsApplied, 'skillsApplied');
  if (value.skillRoutingDecision !== undefined) assertSkillRoutingDecision(value.skillRoutingDecision);
  assertVisualStyleContract(value.visualStyleContract);
  if (!Array.isArray(value.inputBindings)) throw new TypeError('inputBindings must be an array');
  value.inputBindings.forEach(assertInputBinding);
  if (new Set(value.inputBindings.map(binding => binding.tag)).size !== value.inputBindings.length) throw new TypeError('inputBindings tags must be unique');
  object(value.subjectContract, 'subjectContract');
  object(value.compositionContract, 'compositionContract');
  object(value.photographyContract, 'photographyContract');
  if (value.editScope !== undefined) assertEditScope(value.editScope);
  if (value.viewChangeMap !== undefined) assertViewChangeMap(value.viewChangeMap);
  stringList(value.preserve, 'preserve', { allowEmpty: true });
  stringList(value.constraints, 'constraints');
  stringList(value.avoid, 'avoid');
  stringList(value.acceptanceChecks, 'acceptanceChecks');
  object(value.outputSpec, 'outputSpec');
  if (value.count !== 1) throw new TypeError('count must be exactly 1');
  if (value.autoRetry !== false) throw new TypeError('autoRetry must be false');
  if (!Array.isArray(value.modelFallbackPlan)) throw new TypeError('modelFallbackPlan must be an array');
  value.modelFallbackPlan.forEach((entry, index) => string(entry, `modelFallbackPlan[${index}]`));
  if (value.operation === 'edit' && value.inputBindings.length === 0) throw new TypeError('edit requires at least one input binding');
  if (value.operation === 'edit' && value.preserve.length === 0) throw new TypeError('edit requires a non-empty preserve list');
  if (value.operation === 'edit' && value.editScope === undefined) throw new TypeError('edit requires an explicit editScope');
  if (value.editScope?.mode === 'view_change' && value.viewChangeMap === undefined) throw new TypeError('view_change editScope requires a viewChangeMap');
  if (value.viewChangeMap !== undefined && value.editScope?.mode !== 'view_change') throw new TypeError('viewChangeMap requires editScope.mode view_change');
  assertNoHiddenContext(value);
  return value;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function imagePromptIrFingerprint(value) {
  assertImagePromptIr(value);
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function referencedImageTags(value) {
  const found = new Set();
  walkStrings(value, (entry) => {
    for (const match of entry.matchAll(/\bImage([1-9][0-9]*)\b/g)) found.add(`Image${match[1]}`);
  });
  return [...found].sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
}
