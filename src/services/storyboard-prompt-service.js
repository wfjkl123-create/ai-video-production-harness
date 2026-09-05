// An eleven-beat opening is a valid editorial unit for a 15-second short-drama
// clip.  It is laid out in a 4-by-3 reading grid with one deliberately blank
// terminal cell, rather than inventing a twelfth dramatic beat merely to fill
// a rectangular grid.
const GRID_COUNTS = new Set([6, 9, 11, 12]);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function textArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  value.forEach((item, index) => text(item, `${field}[${index}]`));
}

function validateCharacters(characters) {
  if (!Array.isArray(characters)) throw new TypeError('characters must be an array');
  for (const [index, character] of characters.entries()) {
    for (const field of ['characterId', 'tag', 'identityDefinition', 'wardrobe']) text(character?.[field], `characters[${index}].${field}`);
  }
}

function validatePanels(sheet) {
  if (!sheet.layout || !Number.isInteger(sheet.layout.rows) || !Number.isInteger(sheet.layout.columns)) throw new TypeError('layout rows and columns must be integers');
  const gridCellCount = sheet.layout.rows * sheet.layout.columns;
  const panelCount = sheet.panels?.length;
  const validElevenPanelLayout = panelCount === 11 && gridCellCount === 12;
  if (!GRID_COUNTS.has(panelCount) || (!validElevenPanelLayout && gridCellCount !== panelCount)) {
    throw new TypeError('storyboard sheet must contain exactly 6, 9, 11, or 12 panels; eleven panels use a 4-by-3 grid with one blank terminal cell');
  }
  if (!Array.isArray(sheet.panels) || sheet.panels.length !== panelCount) throw new TypeError(`panels must contain exactly ${panelCount} entries`);
  let priorTime = -1;
  for (const [index, panel] of sheet.panels.entries()) {
    if (panel.panelIndex !== index + 1) throw new TypeError(`panels[${index}].panelIndex must be ${index + 1}`);
    if (typeof panel.timeSec !== 'number' || !Number.isFinite(panel.timeSec) || panel.timeSec < 0 || panel.timeSec > sheet.segmentDurationSec || panel.timeSec <= priorTime) throw new TypeError('panel timeSec values must be strictly increasing inside the segment');
    for (const field of ['shotId', 'purpose', 'subjectAction', 'shotContract', 'blocking', 'startState', 'endState']) text(panel[field], `panels[${index}].${field}`);
    textArray(panel.continuityAnchors, `panels[${index}].continuityAnchors`);
    textArray(panel.risks, `panels[${index}].risks`);
    priorTime = panel.timeSec;
  }
  if (sheet.panels[0].timeSec !== 0 || Math.abs(sheet.panels.at(-1).timeSec - sheet.segmentDurationSec) > 0.001) throw new TypeError('storyboard panels must include both 0s and the segment endpoint');
}

function validateDerivedExecutionPanels(sheet) {
  if (sheet.panels.length !== 11) return null;
  const derivation = sheet.derivedExecutionPanels;
  if (!derivation || typeof derivation !== 'object' || Array.isArray(derivation)) {
    throw new TypeError('eleven-panel storyboard sheets require a deterministic derivedExecutionPanels contract');
  }
  for (const field of ['assetId', 'sourceSheetAssetId', 'derivationMethod', 'acceptance']) {
    text(derivation[field], `derivedExecutionPanels.${field}`);
  }
  if (derivation.sourceSheetAssetId !== sheet.assetId) {
    throw new TypeError('derivedExecutionPanels.sourceSheetAssetId must equal the storyboard assetId');
  }
  const grid = derivation.grid;
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)
    || grid.columns !== sheet.layout.columns || grid.rows !== sheet.layout.rows
    || grid.sheetAspectRatio !== '3:4' || grid.cellAspectRatio !== '9:16'
    || grid.terminalBlankCell?.row !== 3 || grid.terminalBlankCell?.column !== 4) {
    throw new TypeError('eleven-panel storyboard execution crops require a 4-by-3 portrait 3:4 sheet, 9:16 cells, and a row-3 column-4 blank terminal cell');
  }
  if (!Array.isArray(derivation.panels) || derivation.panels.length !== 11) {
    throw new TypeError('derivedExecutionPanels.panels must contain one deterministic crop for each active storyboard panel');
  }
  for (const [index, panel] of derivation.panels.entries()) {
    const source = sheet.panels[index];
    const expectedRow = Math.floor(index / 4) + 1;
    const expectedColumn = (index % 4) + 1;
    if (panel?.panelIndex !== index + 1 || panel.shotId !== source.shotId
      || panel.row !== expectedRow || panel.column !== expectedColumn) {
      throw new TypeError(`derivedExecutionPanels.panels[${index}] must map the matching storyboard panel to its fixed grid crop`);
    }
  }
  return structuredClone(derivation);
}

function commonSheetValidation(sheet) {
  for (const field of ['projectId', 'segmentId', 'assetId', 'purpose']) text(sheet?.[field], field);
  if (typeof sheet.segmentDurationSec !== 'number' || !Number.isFinite(sheet.segmentDurationSec) || sheet.segmentDurationSec <= 0 || sheet.segmentDurationSec > 15) throw new TypeError('segmentDurationSec must be greater than 0 and at most 15');
  if (!Array.isArray(sheet.inputBindings)) throw new TypeError('inputBindings must be an array');
  validateCharacters(sheet.characters ?? []);
  if (!sheet.sceneContract || typeof sheet.sceneContract !== 'object' || Array.isArray(sheet.sceneContract)) throw new TypeError('sceneContract must be an object');
  for (const field of ['sceneId', 'geography', 'lighting', 'screenDirection']) text(sheet.sceneContract[field], `sceneContract.${field}`);
  validatePanels(sheet);
  return validateDerivedExecutionPanels(sheet);
}

export function buildStoryboardSheetIr(sheet, defaults) {
  const derivedExecutionPanels = commonSheetValidation(sheet);
  const characters = sheet.characters ?? [];
  const hasCharacters = characters.length > 0;
  const skillsApplied = ['gpt-image-2-style-library', 'imagegen', 'seedance-sequence', 'seedance-camera', ...(hasCharacters ? ['seedance-characters'] : [])];
  const tags = characters.map(character => character.tag).join(', ') || 'no recurring character';
  return {
    schemaVersion: 1,
    id: `ir-${sheet.assetId}-full-sheet-v1`,
    projectId: sheet.projectId,
    segmentId: sheet.segmentId,
    assetId: sheet.assetId,
    atomicAssetId: `${sheet.assetId}-full-sheet-v1`,
    assetType: 'storyboard_sheet',
    profileId: 'storyboard_sheet_15s_v1',
    operation: 'create',
    purpose: `${sheet.purpose}; generate the complete ${sheet.segmentDurationSec}-second storyboard as one sheet so all panels share one continuity model`,
    responsibility: 'panel order, shot framing, blocking, action phase, visible endpoints and continuity across the declared time interval',
    mustNotControl: ['canonical character identity', 'canonical wardrobe design', 'product geometry', 'actions outside the declared time interval', 'final typography'],
    templateSource: 'knowledge/image-profiles/storyboard-sheet.md#storyboard_sheet_15s_v1',
    skillsApplied,
    selfContainedContextVersion: '1.0',
    visualStyleContract: structuredClone(defaults.visualStyleContract),
    inputBindings: structuredClone(sheet.inputBindings),
    subjectContract: {
      segmentId: sheet.segmentId,
      segmentDurationSec: sheet.segmentDurationSec,
      recurringCharacters: tags,
      characterContracts: structuredClone(characters),
      sceneContract: structuredClone(sheet.sceneContract),
      declaredTimeRange: `0s through ${sheet.segmentDurationSec}s`,
      actionScope: sheet.actionScope ?? `show only the stated actions inside 0s through ${sheet.segmentDurationSec}s`,
      prohibitedAdvance: sheet.prohibitedAdvance ?? sheet.reservedForLater ?? 'do not show any action that happens after the declared endpoint'
    },
    compositionContract: {
      mode: 'complete_storyboard_sheet_first_pass',
      rows: sheet.layout.rows,
      columns: sheet.layout.columns,
      panelCount: sheet.panels.length,
      ...(sheet.panels.length === 11 ? { reservedBlankGridCells: 1 } : {}),
      ...(derivedExecutionPanels ? { executionSinglePanelDerivation: derivedExecutionPanels } : {}),
      readingOrder: 'left_to_right_then_top_to_bottom',
      panels: structuredClone(sheet.panels)
    },
    ...(derivedExecutionPanels ? { derivedExecutionPanels: structuredClone(derivedExecutionPanels) } : {}),
    photographyContract: structuredClone(sheet.photographyContract ?? {
      cameraRule: 'each panel uses exactly the shot contract assigned to that panel; camera choices remain physically possible and motivated by the visible action',
      continuityRule: 'preserve screen direction, scene geography, identity, wardrobe, light direction and prop state across adjacent panels',
      rendering: 'clear pre-production storyboard frames with readable live-action staging and consistent physical volume'
    }),
    preserve: [],
    constraints: [
      'generate one complete storyboard sheet in one image request; do not create separate panel files on the first pass',
      'each panel shows exactly one visible action beat and one completed visual endpoint',
      'keep every panel in its fixed slot and preserve the declared reading order',
      ...(sheet.panels.length === 11 ? ['use a 4-by-3 layout containing exactly eleven active storyboard panels; leave the twelfth terminal cell completely blank with no image, text, action, or extra beat'] : []),
      'all panels share one character, wardrobe, scene geography, lighting and screen-direction continuity contract',
      'do not replay completed actions and do not show actions outside the declared endpoint',
      'use clean panel dividers but no captions, panel numbers, subtitles, watermark, logo or unrelated text'
    ],
    avoid: ['independent mismatched illustrations', 'changed identity', 'changed wardrobe', 'axis jump', 'teleported props', 'duplicate panels', 'missing panels', 'extra panels', 'paper-cutout people', 'text or watermark'],
    acceptanceChecks: [
      `exactly ${sheet.panels.length} active storyboard panels appear in the declared reading order`,
      ...(sheet.panels.length === 11 ? ['the remaining terminal grid cell is blank and contains no twelfth action beat'] : []),
      'panel reading order matches increasing panelIndex and timeSec',
      'every panel matches its shotId, visible action, camera contract, blocking and endpoint',
      'adjacent panels preserve identity, wardrobe, scene geography, screen direction, lighting and prop state',
      'the output is one complete sheet and contains no unrelated out-of-range action or text'
    ],
    outputSpec: structuredClone(sheet.outputSpec ?? { aspectRatio: '16:9', quality: 'high', deliverable: 'one complete storyboard sheet' }),
    executionProfile: defaults.modelProfile.id,
    count: 1,
    autoRetry: false,
    modelFallbackPlan: [...(sheet.modelFallbackPlan ?? [])]
  };
}

export function buildStoryboardPanelRepairIr(repair, defaults) {
  for (const field of ['projectId', 'segmentId', 'assetId', 'purpose']) text(repair?.[field], field);
  if (!repair.targetPanel || typeof repair.targetPanel !== 'object') throw new TypeError('targetPanel is required');
  if (!Number.isInteger(repair.targetPanel.panelIndex) || repair.targetPanel.panelIndex < 1) throw new TypeError('targetPanel.panelIndex must be a positive integer');
  if (!Array.isArray(repair.inputBindings) || repair.inputBindings.length < 2) throw new TypeError('panel repair requires the full source sheet and failed-panel crop bindings');
  const roles = new Set(repair.inputBindings.map(binding => binding.primaryRole));
  if (!roles.has('source storyboard sheet continuity and grid context') || !roles.has('failed panel crop composition and action state')) throw new TypeError('panel repair inputBindings must declare source-sheet and failed-panel roles');
  validateCharacters(repair.characters ?? []);
  const characters = repair.characters ?? [];
  const hasCharacters = characters.length > 0;
  const panel = repair.targetPanel;
  for (const field of ['shotId', 'purpose', 'subjectAction', 'shotContract', 'blocking', 'startState', 'endState']) text(panel[field], `targetPanel.${field}`);
  textArray(panel.continuityAnchors, 'targetPanel.continuityAnchors');
  textArray(repair.adjacentPanelStates, 'adjacentPanelStates');
  return {
    schemaVersion: 1,
    id: `ir-${repair.assetId}-panel-${panel.panelIndex}-repair-v${repair.revision ?? 2}`,
    projectId: repair.projectId,
    segmentId: repair.segmentId,
    assetId: repair.assetId,
    atomicAssetId: `${repair.assetId}-panel-${panel.panelIndex}-repair-v${repair.revision ?? 2}`,
    assetType: 'storyboard_panel_repair',
    profileId: 'storyboard_panel_repair_v1',
    operation: 'edit',
    purpose: `${repair.purpose}; replace only failed panel ${panel.panelIndex} and output one clean panel image, not a storyboard sheet`,
    responsibility: `repair the visible content of panel ${panel.panelIndex} while matching its fixed shot, time, composition, action phase and adjacent-panel continuity`,
    mustNotControl: ['pixels in every other storyboard panel', 'canonical identity', 'canonical wardrobe', 'scene redesign', 'future action', 'grid layout'],
    templateSource: 'knowledge/image-profiles/storyboard-sheet.md#storyboard_panel_repair_v1',
    skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-sequence', 'seedance-camera', ...(hasCharacters ? ['seedance-characters'] : [])],
    selfContainedContextVersion: '1.0',
    visualStyleContract: structuredClone(defaults.visualStyleContract),
    inputBindings: structuredClone(repair.inputBindings),
    subjectContract: { characterContracts: structuredClone(characters), targetShotId: panel.shotId, targetAction: panel.subjectAction },
    compositionContract: {
      mode: 'single_storyboard_panel_repair',
      targetPanelIndex: panel.panelIndex,
      sourceGrid: structuredClone(repair.sourceGrid),
      targetPanel: structuredClone(panel),
      adjacentPanelStates: [...repair.adjacentPanelStates],
      output: 'one borderless replacement panel only'
    },
    photographyContract: structuredClone(repair.photographyContract ?? {
      cameraRule: panel.shotContract,
      blockingRule: panel.blocking,
      continuityRule: 'match identity, wardrobe, scene geometry, screen direction, light direction, prop state and action phase visible in adjacent panels'
    }),
    editScope: {
      mode: 'panel_repair',
      change: `repair only panel ${panel.panelIndex} to its declared action phase and endpoint`,
      continuityAfterChange: 'the repaired panel remains continuous with the source-grid camera, identity, wardrobe, scene, light, prop state and adjacent-panel states'
    },
    preserve: [
      `panel ${panel.panelIndex} fixed slot, shotId and time point`,
      'character identity and wardrobe',
      'scene geometry, screen direction and light direction',
      'camera framing, blocking, action phase and prop state',
      'continuity with both adjacent panel states'
    ],
    constraints: [
      'output exactly one replacement panel with no grid, border, caption or extra panel',
      'perform only the target panel action and stop at its declared endpoint',
      'do not replay completed action and do not advance into the next panel action',
      'do not change any canonical identity, wardrobe, product, prop or scene anchor'
    ],
    avoid: ['full storyboard sheet output', 'multiple panels', 'changed face', 'changed wardrobe', 'axis jump', 'wrong action phase', 'paper-cutout person', 'text', 'watermark'],
    acceptanceChecks: [
      'exactly one borderless replacement panel is present',
      `the image matches panel ${panel.panelIndex}, shot ${panel.shotId}, its action and endpoint`,
      'identity, wardrobe, scene, camera, blocking, lighting and prop state match the source and adjacent panels',
      'no future action, grid, text, watermark or extra panel is present'
    ],
    outputSpec: structuredClone(repair.outputSpec ?? { aspectRatio: '16:9', quality: 'high', deliverable: `replacement panel ${panel.panelIndex}` }),
    executionProfile: defaults.modelProfile.id,
    count: 1,
    autoRetry: false,
    modelFallbackPlan: [...(repair.modelFallbackPlan ?? [])]
  };
}

// This controlled recovery path is not a first-pass substitute. It is only
// valid when a complete generated sheet has been quarantined as a failed
// candidate. Each generated frame is an independent, zero-context contract;
// no generated frame may cite or inherit pixels from the quarantined sheet.
function validateExecutionPanel(panel, index, sequence) {
  if (!panel || typeof panel !== 'object' || Array.isArray(panel)) throw new TypeError(`panels[${index}] must be an object`);
  if (!Number.isInteger(panel.panelIndex) || panel.panelIndex < 1 || panel.panelIndex > 11) {
    throw new TypeError(`panels[${index}].panelIndex must be between 1 and 11`);
  }
  for (const field of ['beatStartSec', 'beatEndSec', 'representativeFrameSec']) {
    if (typeof panel[field] !== 'number' || !Number.isFinite(panel[field])
      || panel[field] < 0 || panel[field] > sequence.segmentDurationSec) {
      throw new TypeError(`panels[${index}].${field} must be inside the segment`);
    }
  }
  if (panel.beatEndSec < panel.beatStartSec) {
    throw new TypeError(`panels[${index}] beatEndSec must not precede beatStartSec`);
  }
  if (panel.representativeFrameSec < panel.beatStartSec || panel.representativeFrameSec > panel.beatEndSec) {
    throw new TypeError(`panels[${index}] representativeFrameSec must stay inside its beat range`);
  }
  if (panel.timeSec !== undefined && (typeof panel.timeSec !== 'number' || !Number.isFinite(panel.timeSec)
    || Math.abs(panel.timeSec - panel.beatStartSec) > 0.0005)) {
    throw new TypeError(`panels[${index}].timeSec must equal beatStartSec when present`);
  }
  for (const field of ['assetId', 'shotId', 'purpose', 'subjectAction', 'shotContract', 'blocking', 'startState', 'endState']) {
    text(panel[field], `panels[${index}].${field}`);
  }
  textArray(panel.continuityAnchors, `panels[${index}].continuityAnchors`);
  textArray(panel.risks, `panels[${index}].risks`);
  if (!Array.isArray(panel.inputBindings) || panel.inputBindings.length === 0) {
    throw new TypeError(`panels[${index}].inputBindings must be a non-empty array`);
  }
  validateCharacters(panel.characters ?? []);
}

export function buildStoryboardExecutionPanelIrs(sequence, defaults) {
  for (const field of ['projectId', 'segmentId', 'sequenceId', 'purpose']) text(sequence?.[field], field);
  if (sequence.fallbackReason !== 'complete_sheet_rejected') {
    throw new TypeError('atomic storyboard frames require a quarantined complete-sheet rejection');
  }
  if (typeof sequence.segmentDurationSec !== 'number' || !Number.isFinite(sequence.segmentDurationSec)
    || sequence.segmentDurationSec <= 0 || sequence.segmentDurationSec > 15) {
    throw new TypeError('segmentDurationSec must be greater than 0 and at most 15');
  }
  if (!sequence.sceneContract || typeof sequence.sceneContract !== 'object' || Array.isArray(sequence.sceneContract)) {
    throw new TypeError('sceneContract must be an object');
  }
  for (const field of ['sceneId', 'geography', 'lighting', 'screenDirection']) text(sequence.sceneContract[field], `sceneContract.${field}`);
  if (!Array.isArray(sequence.panels) || sequence.panels.length !== 11) {
    throw new TypeError('atomic storyboard recovery requires exactly eleven panels');
  }
  const indexes = new Set();
  let previousBeatStart = -1;
  sequence.panels.forEach((panel, index) => {
    validateExecutionPanel(panel, index, sequence);
    if (indexes.has(panel.panelIndex)) throw new TypeError(`duplicate atomic storyboard panel index: ${panel.panelIndex}`);
    if (panel.panelIndex !== index + 1) throw new TypeError('atomic storyboard panels must be declared in reading order');
    if (panel.beatStartSec <= previousBeatStart) throw new TypeError('atomic storyboard beat start times must be strictly increasing');
    indexes.add(panel.panelIndex);
    previousBeatStart = panel.beatStartSec;
  });
  if (sequence.panels[0].beatStartSec !== 0 || Math.abs(sequence.panels.at(-1).beatEndSec - sequence.segmentDurationSec) > 0.001) {
    throw new TypeError('atomic storyboard recovery must include the segment start and endpoint');
  }
  return sequence.panels.map((panel) => {
    const characters = panel.characters ?? [];
    const hasCharacters = characters.length > 0;
    return {
      schemaVersion: 1,
      id: `ir-${panel.assetId}-atomic-v1`,
      projectId: sequence.projectId,
      segmentId: sequence.segmentId,
      assetId: panel.assetId,
      atomicAssetId: `${panel.assetId}-atomic-v1`,
      assetType: 'storyboard_execution_panel',
      profileId: 'storyboard_execution_panel_v1',
      operation: 'create',
      purpose: `${sequence.purpose}; generate the one vertical black-and-white control frame for panel ${panel.panelIndex}, representing ${panel.representativeFrameSec.toFixed(3)} seconds inside the declared ${panel.beatStartSec.toFixed(3)} to ${panel.beatEndSec.toFixed(3)} second beat`,
      responsibility: `the representative end-state inside exact ${panel.shotId}: framing, blocking, visible action phase, action endpoint and neutral line-art control`,
      mustNotControl: ['canonical identity definition outside the bound images', 'canonical wardrobe definition outside the bound images', 'any different storyboard frame', 'future action', 'product geometry', 'final video color grade', 'text or typography'],
      templateSource: 'knowledge/image-profiles/storyboard-sheet.md#storyboard_execution_panel_v1',
      skillsApplied: ['gpt-image-2-style-library', 'imagegen', 'seedance-sequence', 'seedance-camera', ...(hasCharacters ? ['seedance-characters'] : [])],
      selfContainedContextVersion: '1.0',
      visualStyleContract: structuredClone(defaults.visualStyleContract),
      inputBindings: structuredClone(panel.inputBindings),
      subjectContract: {
        sequenceId: sequence.sequenceId,
        segmentId: sequence.segmentId,
        beatStartSec: panel.beatStartSec,
        beatEndSec: panel.beatEndSec,
        representativeFrameSec: panel.representativeFrameSec,
        targetShotId: panel.shotId,
        characterContracts: structuredClone(characters),
        sceneContract: structuredClone(sequence.sceneContract),
        targetAction: panel.subjectAction,
        prohibitedAdvance: panel.prohibitedAdvance ?? `show no action before ${panel.beatStartSec.toFixed(3)} seconds or after ${panel.beatEndSec.toFixed(3)} seconds; render only the declared representative end-state at ${panel.representativeFrameSec.toFixed(3)} seconds`
      },
      compositionContract: {
        mode: 'atomic_storyboard_execution_frame',
        sequenceId: sequence.sequenceId,
        panelIndex: panel.panelIndex,
        shotId: panel.shotId,
        revision: panel.revision ?? 1,
        beatStartSec: panel.beatStartSec,
        beatEndSec: panel.beatEndSec,
        representativeFrameSec: panel.representativeFrameSec,
        purpose: panel.purpose,
        shotContract: panel.shotContract,
        blocking: panel.blocking,
        startState: panel.startState,
        endState: panel.endState,
        continuityAnchors: [...panel.continuityAnchors],
        output: 'one borderless vertical storyboard control frame only'
      },
      photographyContract: structuredClone(panel.photographyContract ?? {
        cameraRule: panel.shotContract,
        blockingRule: panel.blocking,
        continuityRule: 'preserve the identity, wardrobe, geography, daylight direction and screen-side anchors declared in this request',
        rendering: 'pure neutral monochrome black ink and graphite line art on white paper; no hue, no wash and no painted color'
      }),
      preserve: [],
      constraints: [
        'output exactly one borderless 9:16 vertical storyboard control frame, never a sheet, a collage or a multi-panel layout',
        `render only the declared representative end-state at ${panel.representativeFrameSec.toFixed(3)} seconds inside the ${panel.beatStartSec.toFixed(3)} to ${panel.beatEndSec.toFixed(3)} second beat; do not show an action before or after that beat`,
        'use only pure white paper, black ink and neutral graphite gray; every visible pixel must read as black, white or neutral gray',
        'do not add people, props, dialogue captions, subtitles, panel numbers, watermarks, logos or actions not declared in this request',
        ...(panel.constraints ?? [])
      ],
      avoid: [
        'grid', 'panel divider', 'border', 'caption', 'subtitle', 'watermark', 'logo', 'colored pigment',
        'warm paper', 'cool paper', 'photoreal color', 'three-dimensional render', 'human figure model',
        ...(panel.avoid ?? [])
      ],
      acceptanceChecks: [
        'one borderless vertical storyboard control frame only',
        `the visible frame matches panel ${panel.panelIndex}, shot ${panel.shotId}, the ${panel.representativeFrameSec.toFixed(3)}-second representative end-state within its ${panel.beatStartSec.toFixed(3)} to ${panel.beatEndSec.toFixed(3)} second beat`,
        'the bound characters, wardrobe anchors, scene geography, camera blocking and screen direction are visibly continuous inside this frame',
        'the frame contains no future action, no grid, no text, no watermark and no visible color',
        ...(panel.acceptanceChecks ?? [])
      ],
      outputSpec: structuredClone(panel.outputSpec ?? { aspectRatio: '9:16', quality: 'high', deliverable: 'one borderless vertical storyboard control frame' }),
      executionProfile: defaults.modelProfile.id,
      count: 1,
      autoRetry: false,
      modelFallbackPlan: [...(panel.modelFallbackPlan ?? [])]
    };
  });
}
