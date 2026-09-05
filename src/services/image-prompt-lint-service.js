import { assertImagePromptIr, referencedImageTags, REQUIRED_IMAGE_PROMPT_SKILL, SINGLE_IMAGE_PROMPT_SKILL_DECISION } from '../domain/image-prompt-ir.js';
import { assertModelSupportsImagePrompt } from '../domain/image-model-profile.js';

const DIRECTOR_VIEW_PROXY_TEMPLATE_SOURCE = 'knowledge/image-profiles/director-view-proxy.md#director_view_proxy_v1';
const DIRECTOR_PROXY_SUBJECT_KINDS = new Set(['person', 'prop', 'product', 'environment']);
const DIRECTOR_PROXY_SUBJECT_FIELDS = Object.freeze(['subjectId', 'tag', 'kind', 'proxyColor', 'position', 'screenScale', 'depthLayer', 'pose', 'orientation']);
const DIRECTOR_PROXY_SUBJECT_FIELD_SET = new Set(DIRECTOR_PROXY_SUBJECT_FIELDS);
const DIRECTOR_PROXY_LAYOUT_FIELDS = Object.freeze(['subjectId', 'tag', 'position', 'screenScale', 'depthLayer', 'pose', 'orientation']);
const DIRECTOR_PROXY_LAYOUT_FIELD_SET = new Set(DIRECTOR_PROXY_LAYOUT_FIELDS);
const DIRECTOR_PROXY_DEPTH_LAYERS = new Set(['foreground', 'midground', 'background']);
const DIRECTOR_PROXY_FORBIDDEN_APPEARANCE_CONTENT = /(\b(?:identity|likeness|wardrobe|clothing|garment|shirt|skirt|pants|dress|fabric|material|texture)\b|\bfacial features\b|\bface geometry\b|\bhair(?: style| color)?\b|\bskin(?: tone| texture)?\b|\bproduct (?:appearance|geometry)\b|\bcolor grade\b|身份|五官|脸型|发型|发色|肤色|肤质|服装|妆造|衣物|上衣|裙|裤|面料|材质|纹理|产品外观|产品结构|调色)/i;
const DIRECTOR_PROXY_ALLOWED_TRANSFER = /(camera|framing|shot scale|lens|perspective|blocking|position|screen scale|depth|foreground|midground|background|occlusion|pose|orientation|contact|scene geometry|spatial anchor|机位|构图|景别|镜头|透视|站位|位置|画面比例|前景|中景|后景|遮挡|姿态|朝向|接触点|空间结构|空间锚点)/i;
const DIRECTOR_PROXY_FORBIDDEN_TRANSFER = /(\b(?:identity|likeness|facial|hair|skin|wardrobe|clothing|garment|material|texture)\b|\bface geometry\b|\bproduct (?:appearance|geometry)\b|\bcolor grade\b|身份|五官|脸型|发型|皮肤|服装|妆造|衣物|产品外观|产品结构|材质|纹理|调色)/i;
const DIRECTOR_PROXY_BOUNDARIES = Object.freeze([
  ['identity', /(identity|facial appearance|身份|面部外观)/i],
  ['wardrobe', /(wardrobe|clothing|garment|服装|妆造|衣物)/i],
  ['product', /(product appearance|product geometry|产品外观|产品结构)/i],
  ['material and texture', /(material|texture|材质|纹理)/i],
  ['final color', /(color grade|final color|最终颜色|调色)/i],
  ['proxy color transfer', /(proxy mannequin colors|proxy color|mannequin color|彩模颜色|代理颜色)/i]
]);

function finding(code, field, message) {
  return { code, field, message };
}

export function lintImagePromptIr(ir, modelProfile) {
  const errors = [];
  try {
    assertImagePromptIr(ir);
  } catch (error) {
    errors.push(finding('IR_INVALID', 'ir', error.message));
    return { decision: 'FAIL', errors, warnings: [] };
  }

  try {
    assertModelSupportsImagePrompt(modelProfile, ir);
  } catch (error) {
    errors.push(finding('MODEL_CAPABILITY_MISMATCH', 'executionProfile', error.message));
  }

  if (!ir.skillsApplied.includes(REQUIRED_IMAGE_PROMPT_SKILL)) {
    errors.push(finding('IMAGE_PROMPT_SKILL_MISSING', 'skillsApplied', `all image prompts must apply ${REQUIRED_IMAGE_PROMPT_SKILL}`));
  }

  const declared = new Set(ir.inputBindings.map(binding => binding.tag));
  for (const tag of referencedImageTags({
    purpose: ir.purpose,
    subjectContract: ir.subjectContract,
    compositionContract: ir.compositionContract,
    photographyContract: ir.photographyContract,
    editScope: ir.editScope,
    viewChangeMap: ir.viewChangeMap,
    preserve: ir.preserve,
    constraints: ir.constraints,
    avoid: ir.avoid,
    acceptanceChecks: ir.acceptanceChecks
  })) {
    if (!declared.has(tag)) errors.push(finding('UNBOUND_REFERENCE', 'inputBindings', `${tag} is mentioned but not bound`));
  }

  if (ir.operation === 'edit' && ir.editScope.mode === 'view_change' && ir.viewChangeMap.anchors.length < 2) {
    errors.push(finding('VIEW_CHANGE_MAP_TOO_THIN', 'viewChangeMap.anchors', 'view-change edits require at least two independently positioned anchors'));
  }

  if (ir.profileId.startsWith('character_')) {
    for (const field of ['characterId', 'tag', 'identityDefinition', 'wardrobe', 'bodyProportions']) {
      if (typeof ir.subjectContract[field] !== 'string' || ir.subjectContract[field].trim() === '') {
        errors.push(finding('CHARACTER_CONTRACT_INCOMPLETE', `subjectContract.${field}`, `${field} is required for character profiles`));
      }
    }
    if (!ir.skillsApplied.includes('seedance-characters')) {
      errors.push(finding('SKILL_TRACE_MISSING', 'skillsApplied', 'character profiles require seedance-characters'));
    }
  }

  if (ir.profileId === 'storyboard_sheet_15s_v1' || ir.profileId === 'storyboard_panel_repair_v1' || ir.profileId === 'storyboard_execution_panel_v1') {
    const singleSkillDecision = ir.skillRoutingDecision?.mode === SINGLE_IMAGE_PROMPT_SKILL_DECISION
      && ir.skillRoutingDecision.skillId === REQUIRED_IMAGE_PROMPT_SKILL
      && ir.skillRoutingDecision.scope === 'storyboard_prompt_method_only';
    if (!singleSkillDecision) {
      for (const skill of ['seedance-sequence', 'seedance-camera']) {
        if (!ir.skillsApplied.includes(skill)) errors.push(finding('SKILL_TRACE_MISSING', 'skillsApplied', `storyboard profiles require ${skill}`));
      }
      if (Array.isArray(ir.subjectContract.characterContracts) && ir.subjectContract.characterContracts.length > 0
        && !ir.skillsApplied.includes('seedance-characters')) {
        errors.push(finding('SKILL_TRACE_MISSING', 'skillsApplied', 'storyboards with recurring characters require seedance-characters'));
      }
    }
  }

  if (ir.profileId === 'storyboard_sheet_15s_v1') {
    const composition = ir.compositionContract;
    const gridCellCount = composition.rows * composition.columns;
    const isElevenPanelSheet = composition.panelCount === 11
      && gridCellCount === 12
      && composition.reservedBlankGridCells === 1;
    if (ir.operation !== 'create' || composition.mode !== 'complete_storyboard_sheet_first_pass') {
      errors.push(finding('STORYBOARD_FIRST_PASS_SPLIT', 'operation', 'the first storyboard pass must be one complete-sheet create task'));
    }
    if ((!isElevenPanelSheet && ![6, 9, 12].includes(gridCellCount))
      || (!isElevenPanelSheet && composition.panelCount !== gridCellCount)
      || !Array.isArray(composition.panels)
      || composition.panels.length !== composition.panelCount) {
      errors.push(finding('STORYBOARD_GRID_INVALID', 'compositionContract', 'storyboard grid must contain exactly 6, 9, or 12 declared panels; eleven panels require a 4-by-3 grid with one blank terminal cell'));
    }
  }

  if (ir.profileId === 'storyboard_panel_repair_v1') {
    if (ir.operation !== 'edit' || ir.compositionContract.mode !== 'single_storyboard_panel_repair') {
      errors.push(finding('STORYBOARD_REPAIR_SCOPE_INVALID', 'compositionContract', 'panel repair must be one edit task for one target panel'));
    }
    const roles = new Set(ir.inputBindings.map(binding => binding.primaryRole));
    if (!roles.has('source storyboard sheet continuity and grid context') || !roles.has('failed panel crop composition and action state')) {
      errors.push(finding('STORYBOARD_REPAIR_BINDINGS_MISSING', 'inputBindings', 'panel repair requires role-bound source sheet and failed-panel crop'));
    }
  }

  if (ir.profileId === 'storyboard_execution_panel_v1') {
    const composition = ir.compositionContract;
    if (ir.operation !== 'create' || composition.mode !== 'atomic_storyboard_execution_frame'
      || !Number.isInteger(composition.panelIndex) || composition.panelIndex < 1
      || typeof composition.shotId !== 'string' || composition.shotId.trim() === '') {
      errors.push(finding('STORYBOARD_ATOMIC_PANEL_INVALID', 'compositionContract', 'an atomic storyboard frame must be one create task with its fixed panel index and shot ID'));
    }
    if (ir.outputSpec.aspectRatio !== '9:16') {
      errors.push(finding('STORYBOARD_ATOMIC_PANEL_RATIO_INVALID', 'outputSpec.aspectRatio', 'an atomic storyboard frame must be 9:16'));
    }
    if (ir.compositionContract.output !== 'one borderless vertical storyboard control frame only') {
      errors.push(finding('STORYBOARD_ATOMIC_PANEL_OUTPUT_INVALID', 'compositionContract.output', 'an atomic storyboard frame must output one borderless vertical control frame'));
    }
    for (const field of ['beatStartSec', 'beatEndSec', 'representativeFrameSec']) {
      if (typeof composition[field] !== 'number' || !Number.isFinite(composition[field])) {
        errors.push(finding('STORYBOARD_ATOMIC_TIMING_INVALID', `compositionContract.${field}`, 'every atomic storyboard frame requires a numeric beat range and representative frame'));
      }
    }
    if (typeof composition.beatStartSec === 'number' && typeof composition.beatEndSec === 'number'
      && composition.beatEndSec < composition.beatStartSec) {
      errors.push(finding('STORYBOARD_ATOMIC_TIMING_INVALID', 'compositionContract', 'atomic storyboard beatEndSec cannot precede beatStartSec'));
    }
    if (typeof composition.representativeFrameSec === 'number' && typeof composition.beatStartSec === 'number'
      && typeof composition.beatEndSec === 'number'
      && (composition.representativeFrameSec < composition.beatStartSec || composition.representativeFrameSec > composition.beatEndSec)) {
      errors.push(finding('STORYBOARD_ATOMIC_TIMING_INVALID', 'compositionContract.representativeFrameSec', 'atomic representative frame must stay inside its declared beat range'));
    }
  }


  if (['scene_multiview_v1', 'scene_overhead_v1'].includes(ir.profileId) && !ir.skillsApplied.includes('seedance-camera')) {
    errors.push(finding('SKILL_TRACE_MISSING', 'skillsApplied', 'scene profiles require seedance-camera'));
  }

  if (ir.profileId === 'director_view_proxy_v1') {
    if (ir.templateSource !== DIRECTOR_VIEW_PROXY_TEMPLATE_SOURCE) {
      errors.push(finding('TEMPLATE_TRACE_MISMATCH', 'templateSource', `director-view proxy profile requires ${DIRECTOR_VIEW_PROXY_TEMPLATE_SOURCE}`));
    }
    if (!ir.skillsApplied.includes('seedance-camera')) {
      errors.push(finding('SKILL_TRACE_MISSING', 'skillsApplied', 'director-view proxy profiles require seedance-camera'));
    }
    for (const field of ['shotId', 'sceneGeometry']) {
      if (typeof ir.subjectContract[field] !== 'string' || ir.subjectContract[field].trim() === '') {
        errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', `subjectContract.${field}`, `${field} is required for a zero-context director-view proxy`));
      }
    }
    const subjects = ir.subjectContract.subjects;
    if (!Array.isArray(subjects) || subjects.length === 0) {
      errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', 'subjectContract.subjects', 'director-view proxy subjects must be a non-empty array'));
    } else {
      const ids = new Set();
      const tags = new Set();
      const colors = new Set();
      for (const [index, subject] of subjects.entries()) {
        if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
          errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', `subjectContract.subjects[${index}]`, 'each director-view proxy subject must be an object'));
          continue;
        }
        for (const field of DIRECTOR_PROXY_SUBJECT_FIELDS) {
          if (typeof subject[field] !== 'string' || subject[field].trim() === '') {
            errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', `subjectContract.subjects[${index}].${field}`, `${field} is required for each director-view proxy subject`));
          }
        }
        if (subject.kind && !DIRECTOR_PROXY_SUBJECT_KINDS.has(subject.kind)) {
          errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', `subjectContract.subjects[${index}].kind`, `unknown director-view proxy subject kind: ${subject.kind}`));
        }
        for (const field of Object.keys(subject)) {
          if (!DIRECTOR_PROXY_SUBJECT_FIELD_SET.has(field)) {
            errors.push(finding('DIRECTOR_PROXY_AUTHORITY_LEAK', `subjectContract.subjects[${index}].${field}`, `${field} is outside the director-view proxy subject contract`));
          }
        }
        if (subject.depthLayer && !DIRECTOR_PROXY_DEPTH_LAYERS.has(subject.depthLayer)) errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', `subjectContract.subjects[${index}].depthLayer`, 'depthLayer must be foreground, midground, or background'));
        if (subject.proxyColor && !/(?:low-saturation|muted|低饱和)/i.test(subject.proxyColor)) errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', `subjectContract.subjects[${index}].proxyColor`, 'proxyColor must be unique, low-saturation, and proxy-only'));
        for (const field of ['position', 'screenScale', 'depthLayer', 'pose', 'orientation']) {
          if (typeof subject[field] === 'string' && DIRECTOR_PROXY_FORBIDDEN_APPEARANCE_CONTENT.test(subject[field])) {
            errors.push(finding('DIRECTOR_PROXY_AUTHORITY_LEAK', `subjectContract.subjects[${index}].${field}`, `${field} contains canonical appearance authority forbidden to a director-view proxy`));
          }
        }
        if (ids.has(subject.subjectId)) errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', 'subjectContract.subjects', `duplicate subjectId: ${subject.subjectId}`));
        if (tags.has(subject.tag)) errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', 'subjectContract.subjects', `duplicate subject tag: ${subject.tag}`));
        if (colors.has(subject.proxyColor)) errors.push(finding('DIRECTOR_PROXY_SUBJECTS_INVALID', 'subjectContract.subjects', `duplicate proxy color: ${subject.proxyColor}`));
        ids.add(subject.subjectId);
        tags.add(subject.tag);
        colors.add(subject.proxyColor);
      }
      if (subjects.some(subject => subject?.kind === 'person') && !ir.skillsApplied.includes('seedance-characters')) {
        errors.push(finding('SKILL_TRACE_MISSING', 'skillsApplied', 'director-view proxies with people require seedance-characters'));
      }
    }
    const composition = ir.compositionContract;
    for (const [field, value] of [
      ['subjectContract.sceneGeometry', ir.subjectContract.sceneGeometry],
      ['compositionContract.occlusion', composition.occlusion],
      ['compositionContract.contacts', composition.contacts]
    ]) {
      if (typeof value === 'string' && DIRECTOR_PROXY_FORBIDDEN_APPEARANCE_CONTENT.test(value)) {
        errors.push(finding('DIRECTOR_PROXY_AUTHORITY_LEAK', field, `${field} contains canonical appearance authority forbidden to a director-view proxy`));
      }
    }
    if (composition.mode !== 'single_final_camera_view_director_proxy'
      || typeof composition.finalCameraView !== 'string' || composition.finalCameraView.trim() === ''
      || typeof composition.occlusion !== 'string' || composition.occlusion.trim() === ''
      || typeof composition.contacts !== 'string' || composition.contacts.trim() === ''
      || composition.output !== 'one independent full-frame director-view proxy image only') {
      errors.push(finding('DIRECTOR_PROXY_COMPOSITION_INVALID', 'compositionContract', 'director-view proxy requires one final-camera-view frame with explicit camera, occlusion, contacts and output scope'));
    }
    if (!Array.isArray(composition.subjectLayout) || !Array.isArray(subjects) || composition.subjectLayout.length !== subjects.length) {
      errors.push(finding('DIRECTOR_PROXY_LAYOUT_INVALID', 'compositionContract.subjectLayout', 'subjectLayout must contain exactly one entry for each declared proxy subject'));
    } else {
      for (const [index, subject] of subjects.entries()) {
        const layout = composition.subjectLayout[index];
        if (!layout || DIRECTOR_PROXY_LAYOUT_FIELDS.some(field => layout[field] !== subject[field])) {
          errors.push(finding('DIRECTOR_PROXY_LAYOUT_INVALID', `compositionContract.subjectLayout[${index}]`, 'subjectLayout must preserve each subject ID, tag, position, screen scale, depth layer, pose and orientation exactly'));
        }
        if (layout && Object.keys(layout).some(field => !DIRECTOR_PROXY_LAYOUT_FIELD_SET.has(field))) {
          errors.push(finding('DIRECTOR_PROXY_AUTHORITY_LEAK', `compositionContract.subjectLayout[${index}]`, 'subjectLayout contains fields outside camera-view composition authority'));
        }
      }
    }
    for (const field of ['viewpoint', 'proxyRendering', 'lighting']) {
      if (typeof ir.photographyContract[field] !== 'string' || ir.photographyContract[field].trim() === '') {
        errors.push(finding('DIRECTOR_PROXY_PHOTOGRAPHY_INVALID', `photographyContract.${field}`, `${field} is required for a readable final-camera proxy view`));
      }
    }
    if (typeof ir.outputSpec.aspectRatio !== 'string' || ir.outputSpec.aspectRatio.trim() === ''
      || typeof ir.outputSpec.quality !== 'string' || ir.outputSpec.quality.trim() === '') {
      errors.push(finding('DIRECTOR_PROXY_OUTPUT_INVALID', 'outputSpec', 'director-view proxy outputSpec requires explicit aspectRatio and quality'));
    }
    for (const [boundary, pattern] of DIRECTOR_PROXY_BOUNDARIES) {
      if (!ir.mustNotControl.some(item => pattern.test(item))) {
        errors.push(finding('DIRECTOR_PROXY_BOUNDARY_MISSING', 'mustNotControl', `director-view proxy must explicitly disclaim ${boundary}`));
      }
    }
    if ((ir.inputBindings.length === 0 && ir.operation !== 'create') || (ir.inputBindings.length > 0 && ir.operation !== 'edit')) {
      errors.push(finding('DIRECTOR_PROXY_OPERATION_INVALID', 'operation', 'director-view proxy must create from text only or edit when role-bounded input images are present'));
    }
    for (const [index, binding] of ir.inputBindings.entries()) {
      if (!DIRECTOR_PROXY_ALLOWED_TRANSFER.test(binding.primaryRole) || DIRECTOR_PROXY_FORBIDDEN_TRANSFER.test(binding.primaryRole)) {
        errors.push(finding('DIRECTOR_PROXY_INPUT_ROLE_INVALID', `inputBindings[${index}].primaryRole`, `${binding.tag} primaryRole must stay inside camera, layout, blocking, depth, occlusion, contact or scene-geometry authority`));
      }
      for (const transfer of binding.transfer) {
        if (!DIRECTOR_PROXY_ALLOWED_TRANSFER.test(transfer) || DIRECTOR_PROXY_FORBIDDEN_TRANSFER.test(transfer)) {
          errors.push(finding('DIRECTOR_PROXY_INPUT_TRANSFER_INVALID', `inputBindings[${index}].transfer`, `${binding.tag} may transfer only camera, blocking, screen scale, depth, pose, occlusion, contact or scene geometry`));
        }
      }
      const ignored = binding.ignore.join(', ');
      for (const [boundary, pattern] of DIRECTOR_PROXY_BOUNDARIES.slice(0, 5)) {
        if (!pattern.test(ignored)) {
          errors.push(finding('DIRECTOR_PROXY_INPUT_IGNORE_INCOMPLETE', `inputBindings[${index}].ignore`, `${binding.tag} must explicitly ignore ${boundary}`));
        }
      }
    }
  }

  if (ir.profileId === 'mannequin_grid_v1') {
    for (const skill of ['seedance-sequence', 'seedance-camera', 'seedance-characters']) {
      if (!ir.skillsApplied.includes(skill)) errors.push(finding('SKILL_TRACE_MISSING', 'skillsApplied', `mannequin frame profiles require ${skill}`));
    }
    if (ir.operation !== 'edit' || ir.compositionContract.output !== 'one repaired source frame only') {
      errors.push(finding('MANNEQUIN_FRAME_SCOPE_INVALID', 'compositionContract', 'mannequin grids must be generated as independently edited source frames'));
    }
  }

  return { decision: errors.length === 0 ? 'PASS' : 'FAIL', errors, warnings: [] };
}

export function requireCleanImagePromptIr(ir, modelProfile) {
  const result = lintImagePromptIr(ir, modelProfile);
  if (result.decision === 'FAIL') {
    const error = new Error(`image prompt lint failed: ${result.errors.map(item => `${item.code}: ${item.message}`).join('; ')}`);
    error.code = 'IMAGE_PROMPT_LINT_FAILED';
    error.findings = result.errors;
    throw error;
  }
  return result;
}
