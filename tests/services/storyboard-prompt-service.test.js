import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImagePromptPlan } from '../../src/services/image-profile-router-service.js';
import { buildStoryboardExecutionPanelIrs, buildStoryboardPanelRepairIr, buildStoryboardSheetIr } from '../../src/services/storyboard-prompt-service.js';
import { verifiedModelProfile, visualStyleContract } from '../helpers/image-prompt-fixture.js';

function panels() {
  return [0, 3, 6, 9, 12, 15].map((timeSec, index) => ({
    panelIndex: index + 1,
    timeSec,
    shotId: `S01_SH${String(Math.min(index + 1, 3)).padStart(2, '0')}`,
    purpose: `完成第 ${index + 1} 个可见状态`,
    subjectAction: `Character A 执行动作阶段 ${index + 1} 并停在明确终点`,
    shotContract: '固定中景，眼平机位，保持屏幕方向',
    blocking: 'Character A 位于画面左侧，产品位于桌面中央',
    startState: `动作阶段 ${index} 已完成`,
    endState: `动作阶段 ${index + 1} 已完成`,
    continuityAnchors: ['Character A 身份和服装', '工作室结构', '产品位置', '左到右屏幕方向'],
    risks: ['手与产品接触', '人物身份漂移']
  }));
}

function sheet() {
  return {
    projectId: 'project-001', segmentId: 'segment-001', assetId: 'segment-001-storyboard-v1',
    purpose: '为这十五秒时间区间建立完整动作、机位与走位参考', segmentDurationSec: 15,
    layout: { rows: 2, columns: 3 }, panels: panels(), inputBindings: [],
    characters: [{ characterId: 'character-a', tag: 'Character A', identityDefinition: '原创成年女性，黑色齐肩发', wardrobe: '米白上衣和深灰长裤' }],
    sceneContract: { sceneId: 'scene-001', geography: '工作台居中，入口在画面右后方', lighting: '左侧窗户自然侧光', screenDirection: '人物主要动作从左向右' },
    reservedForLater: '人物不得离开工作室，产品不得进入包装展示阶段'
  };
}

function storyboardModelProfile() {
  return verifiedModelProfile({ supportedAspectRatios: ['4:3', '1:1', '16:9'] });
}

function binding(tag, primaryRole, artifactId) {
  return {
    tag, artifactId, path: `assets/${artifactId}.png`, sha256: tag === 'Image1' ? 'a'.repeat(64) : 'b'.repeat(64),
    primaryRole, subjectSelector: '这十五秒时间区间中的 Character A 和工作台区域',
    transfer: ['目标格构图', '人物与场景连续性'], ignore: ['文字', '水印', '压缩噪声']
  };
}

test('compiles one complete 15-second storyboard sheet instead of six independent first-pass tasks', () => {
  const ir = buildStoryboardSheetIr(sheet(), { visualStyleContract: visualStyleContract(), modelProfile: storyboardModelProfile() });
  assert.equal(ir.operation, 'create');
  assert.equal(ir.compositionContract.panelCount, 6);
  assert.deepEqual(ir.skillsApplied, ['gpt-image-2-style-library', 'imagegen', 'seedance-sequence', 'seedance-camera', 'seedance-characters']);
  const plan = buildImagePromptPlan({
    id: 'storyboard-plan-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 8,
    visualStyleContract: visualStyleContract(), characterBoards: [], storyboardSheets: [sheet()], storyboardRepairs: [], promptIrs: []
  }, storyboardModelProfile());
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].profileId, 'storyboard_sheet_15s_v1');
  assert.equal(plan.requests[0].lint.decision, 'PASS');
  assert.equal(plan.dispatch.waves[0].lanes[0].id, 'storyboard:segment-001-storyboard-v1');
  assert.match(plan.requests[0].prompt, /generate one complete storyboard sheet in one image request/);
});

test('accepts an eleven-beat opening without fabricating a twelfth story beat', () => {
  const eleven = sheet();
  eleven.layout = { rows: 3, columns: 4 };
  eleven.panels = Array.from({ length: 11 }, (_, index) => ({
    ...panels()[Math.min(index, 5)],
    panelIndex: index + 1,
    timeSec: index === 10 ? 15 : index * 1.5,
    purpose: `完成第 ${index + 1} 个可见状态`,
    subjectAction: `Character A 执行动作阶段 ${index + 1} 并停在明确终点`,
    startState: `动作阶段 ${index} 已完成`,
    endState: `动作阶段 ${index + 1} 已完成`
  }));
  eleven.derivedExecutionPanels = {
    assetId: 'segment-001-execution-panels-v1',
    sourceSheetAssetId: eleven.assetId,
    derivationMethod: 'deterministic crop only',
    grid: { columns: 4, rows: 3, sheetAspectRatio: '3:4', cellAspectRatio: '9:16', terminalBlankCell: { row: 3, column: 4 } },
    panels: eleven.panels.map((panel, index) => ({
      panelIndex: panel.panelIndex, shotId: panel.shotId, row: Math.floor(index / 4) + 1, column: (index % 4) + 1
    })),
    acceptance: 'eleven exact textless crops'
  };
  const ir = buildStoryboardSheetIr(eleven, { visualStyleContract: visualStyleContract(), modelProfile: storyboardModelProfile() });
  assert.equal(ir.compositionContract.panelCount, 11);
  assert.equal(ir.compositionContract.reservedBlankGridCells, 1);
  assert.equal(ir.compositionContract.executionSinglePanelDerivation.panels.length, 11);
  assert.match(ir.constraints.join('\n'), /eleven active storyboard panels/);
  const plan = buildImagePromptPlan({
    id: 'storyboard-eleven-plan-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 8,
    visualStyleContract: visualStyleContract(), characterBoards: [], storyboardSheets: [eleven], storyboardRepairs: [], promptIrs: []
  }, storyboardModelProfile());
  assert.equal(plan.requests[0].lint.decision, 'PASS');
});

test('panel repair compiles one edit task bound to the full sheet and failed crop', () => {
  const targetPanel = panels()[2];
  const repair = {
    projectId: 'project-001', segmentId: 'segment-001', assetId: 'segment-001-storyboard-v1', revision: 2,
    purpose: '修复第三格错误动作，同时保持相邻格连续', targetPanel,
    sourceGrid: { rows: 2, columns: 3 }, adjacentPanelStates: [panels()[1].endState, panels()[3].startState],
    characters: sheet().characters,
    inputBindings: [
      binding('Image1', 'source storyboard sheet continuity and grid context', 'storyboard-source-v1'),
      binding('Image2', 'failed panel crop composition and action state', 'storyboard-panel-03-failed-v1')
    ]
  };
  const ir = buildStoryboardPanelRepairIr(repair, { visualStyleContract: visualStyleContract(), modelProfile: storyboardModelProfile() });
  assert.equal(ir.operation, 'edit');
  assert.equal(ir.compositionContract.targetPanelIndex, 3);
  assert.match(ir.compositionContract.output, /one borderless replacement panel/);
  const plan = buildImagePromptPlan({
    id: 'storyboard-repair-plan-v2', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 8,
    visualStyleContract: visualStyleContract(), characterBoards: [], storyboardSheets: [], storyboardRepairs: [repair], promptIrs: []
  }, storyboardModelProfile());
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].lint.decision, 'PASS');
  assert.match(plan.requests[0].prompt, /output exactly one replacement panel/);
});

test('quarantined sheet recovery compiles eleven self-contained vertical atomic storyboard frames', () => {
  const source = sheet();
  const panelList = Array.from({ length: 11 }, (_, index) => {
    const base = {
      ...panels()[Math.min(index, 5)],
      panelIndex: index + 1,
      timeSec: index === 10 ? 15 : index * 1.5,
      beatStartSec: index === 10 ? 15 : index * 1.5,
      beatEndSec: index === 10 ? 15 : (index + 1) * 1.5,
      representativeFrameSec: index === 10 ? 15 : (index + 1) * 1.5,
      shotId: `S01-${String(index + 1).padStart(2, '0')}`,
      purpose: `完成第 ${index + 1} 个可见状态`,
      subjectAction: `Character A 执行动作阶段 ${index + 1} 并停在明确终点`,
      startState: `动作阶段 ${index} 已完成`,
      endState: `动作阶段 ${index + 1} 已完成`,
      assetId: `segment-001-storyboard-panel-${String(index + 1).padStart(2, '0')}-v1`,
      characters: source.characters,
      inputBindings: [binding('Image1', 'Character A identity and wardrobe authority for this one atomic frame', 'character-a-board-v1')]
    };
    return base;
  });
  const irs = buildStoryboardExecutionPanelIrs({
    projectId: 'project-001', segmentId: 'segment-001', sequenceId: 's01-recovery-v1',
    purpose: '在隔离失败整板后重建开场的单格控制序列', fallbackReason: 'complete_sheet_rejected',
    segmentDurationSec: 15, sceneContract: source.sceneContract, panels: panelList
  }, { visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile({ supportedAspectRatios: ['9:16', '4:3', '1:1'] }) });
  assert.equal(irs.length, 11);
  assert.ok(irs.every(ir => ir.profileId === 'storyboard_execution_panel_v1'));
  assert.ok(irs.every(ir => ir.outputSpec.aspectRatio === '9:16'));
  assert.equal(irs[0].compositionContract.beatStartSec, 0);
  assert.equal(irs[0].compositionContract.beatEndSec, 1.5);
  assert.ok(irs.every(ir => ir.constraints.includes('output exactly one borderless 9:16 vertical storyboard control frame, never a sheet, a collage or a multi-panel layout')));
});

test('atomic storyboard recovery refuses a non-quarantined first-pass split', () => {
  const source = sheet();
  const panel = {
    ...panels()[0], assetId: 'panel-01-v1', characters: source.characters,
    inputBindings: [binding('Image1', 'Character A identity authority for this atomic frame', 'character-a-board-v1')]
  };
  assert.throws(() => buildStoryboardExecutionPanelIrs({
    projectId: 'project-001', segmentId: 'segment-001', sequenceId: 's01-recovery-v1', purpose: 'bad', fallbackReason: 'normal_first_pass',
    segmentDurationSec: 15, sceneContract: source.sceneContract, panels: Array.from({ length: 11 }, (_, index) => ({ ...panel, panelIndex: index + 1, timeSec: index === 10 ? 15 : index * 1.5, beatStartSec: index === 10 ? 15 : index * 1.5, beatEndSec: index === 10 ? 15 : (index + 1) * 1.5, representativeFrameSec: index === 10 ? 15 : (index + 1) * 1.5, assetId: `panel-${index + 1}` }))
  }, { visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile() }), /quarantined complete-sheet rejection/);
});

test('image plan routes the quarantined atomic storyboard sequence as storyboard work', () => {
  const source = sheet();
  const panelList = Array.from({ length: 11 }, (_, index) => ({
    ...panels()[Math.min(index, 5)], panelIndex: index + 1, timeSec: index === 10 ? 15 : index * 1.5,
    beatStartSec: index === 10 ? 15 : index * 1.5, beatEndSec: index === 10 ? 15 : (index + 1) * 1.5,
    representativeFrameSec: index === 10 ? 15 : (index + 1) * 1.5,
    shotId: `S01-${String(index + 1).padStart(2, '0')}`, purpose: `完成第 ${index + 1} 个可见状态`,
    subjectAction: `Character A 执行动作阶段 ${index + 1} 并停在明确终点`, startState: `动作阶段 ${index} 已完成`, endState: `动作阶段 ${index + 1} 已完成`,
    assetId: `segment-001-storyboard-panel-${String(index + 1).padStart(2, '0')}-v1`, characters: source.characters,
    inputBindings: [binding('Image1', 'Character A identity and wardrobe authority for this one atomic frame', 'character-a-board-v1')]
  }));
  const plan = buildImagePromptPlan({
    id: 'storyboard-atomic-plan-v1', projectId: 'project-001', executionMode: 'parallel', maxConcurrency: 8,
    visualStyleContract: visualStyleContract(), characterBoards: [], storyboardSheets: [], storyboardRepairs: [],
    storyboardExecutionPanels: [{ projectId: 'project-001', segmentId: 'segment-001', sequenceId: 's01-recovery-v1', purpose: '在隔离失败整板后重建开场的单格控制序列', fallbackReason: 'complete_sheet_rejected', segmentDurationSec: 15, sceneContract: source.sceneContract, panels: panelList }], promptIrs: []
  }, verifiedModelProfile({ supportedAspectRatios: ['9:16', '4:3', '1:1'] }));
  assert.equal(plan.requests.length, 11);
  assert.ok(plan.requests.every(request => request.profileId === 'storyboard_execution_panel_v1' && request.lint.decision === 'PASS'));
});

test('rejects incomplete time coverage and pre-split first-pass sheets', () => {
  const incomplete = sheet();
  incomplete.panels = incomplete.panels.slice(0, 5);
  assert.throws(() => buildStoryboardSheetIr(incomplete, { visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile() }), /exactly 6/);
  const missingEndpoint = sheet();
  missingEndpoint.panels.at(-1).timeSec = 14;
  assert.throws(() => buildStoryboardSheetIr(missingEndpoint, { visualStyleContract: visualStyleContract(), modelProfile: verifiedModelProfile() }), /endpoint/);
});
