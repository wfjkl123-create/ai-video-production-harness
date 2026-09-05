import { currentArtifactsOf } from './current-artifact.js';

export const REALISM_CONTRACT_VERSIONS = Object.freeze([1, 2]);

export const REQUIRED_BINDING_TYPES = Object.freeze([
  'source_video',
  'replacement_asset',
  'character_identity_pack_v2',
  'character_acting_master_v1',
  'character_story_state_v1',
  'voice_identity_v1',
  'approved_source_audio',
  'scene_geometry_v2',
  'observed_handoff',
  'handoff_reconciliation_v1',
  'spatial_proxy',
  'product_reference',
  'scene_reference',
  'audio_strategy'
]);

const APPLICABILITY = new Set(['required', 'not_applicable']);
const SHA256 = /^[a-f0-9]{64}$/;

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

export function realismContractsVersionOf(state) {
  const value = state?.realismContractsVersion ?? 1;
  if (!REALISM_CONTRACT_VERSIONS.includes(value)) throw new TypeError('realismContractsVersion must be 1 or 2');
  return value;
}

export function canWriteRealismContractsV2(state) {
  return realismContractsVersionOf(state) === 2 && state?.realismContractsWriteMode !== 'read_only';
}

export function assertRequiredBindings(value, field = 'requiredBindings') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  if (value.version !== 1) throw new TypeError(`${field}.version must be 1`);
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new TypeError(`${field}.entries must be a non-empty array`);
  const keys = new Set();
  for (const [index, entry] of value.entries.entries()) {
    const itemField = `${field}.entries[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${itemField} must be an object`);
    const bindingType = text(entry.bindingType, `${itemField}.bindingType`);
    if (!REQUIRED_BINDING_TYPES.includes(bindingType)) throw new TypeError(`${itemField}.bindingType is unsupported`);
    const scopeKey = text(entry.scopeKey ?? 'project', `${itemField}.scopeKey`);
    const key = `${bindingType}|${scopeKey}`;
    if (keys.has(key)) throw new TypeError(`${field} must not repeat ${key}`);
    keys.add(key);
    if (!APPLICABILITY.has(entry.applicability)) throw new TypeError(`${itemField}.applicability must be required or not_applicable`);
    text(entry.reason, `${itemField}.reason`);
    if (entry.applicability === 'required') {
      text(entry.artifactId, `${itemField}.artifactId`);
      if (!SHA256.test(entry.sha256 ?? '')) throw new TypeError(`${itemField}.sha256 must be a lowercase SHA-256`);
    } else if (entry.artifactId !== undefined || entry.sha256 !== undefined) {
      throw new TypeError(`${itemField} must not bind an artifact when not_applicable`);
    }
  }
  return value;
}

export function requiredBinding(bindingType, artifact, reason, scopeKey = 'project') {
  if (!artifact || artifact.status !== 'locked') throw new Error(`${bindingType} requires a locked artifact`);
  if (!SHA256.test(artifact.sha256 ?? '')) throw new Error(`${bindingType} requires a locked artifact SHA-256`);
  return {
    bindingType,
    scopeKey,
    applicability: 'required',
    reason,
    artifactId: artifact.id,
    sha256: artifact.sha256
  };
}

export function notApplicableBinding(bindingType, reason, scopeKey = 'project') {
  return { bindingType, scopeKey, applicability: 'not_applicable', reason };
}

export function assertRequiredBindingsSatisfied(requiredBindings, artifacts, { syntheticBindings = [] } = {}) {
  const contract = assertRequiredBindings(requiredBindings);
  const artifactById = new Map(currentArtifactsOf(artifacts ?? []).map(artifact => [artifact.id, artifact]));
  const syntheticById = new Map(syntheticBindings.map(binding => [binding.artifactId, binding]));
  for (const entry of contract.entries) {
    if (entry.applicability !== 'required') continue;
    const artifact = artifactById.get(entry.artifactId);
    const synthetic = syntheticById.get(entry.artifactId);
    if (artifact) {
      if (artifact.status !== 'locked' || artifact.sha256 !== entry.sha256) {
        throw new Error(`required binding is stale or unlocked: ${entry.bindingType}/${entry.artifactId}`);
      }
      continue;
    }
    if (!synthetic || synthetic.sha256 !== entry.sha256) {
      throw new Error(`required binding is missing: ${entry.bindingType}/${entry.artifactId}`);
    }
  }
  return contract;
}

export function deriveRequiredBindingsFromAssets(items, { segmentId = 'project' } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const entries = [];
  const scoped = item => item?.characterId ? `${segmentId}:${item.characterId}` : segmentId;
  const add = (bindingType, item, reason, scopeKey = scoped(item)) => {
    if (entries.some(entry => entry.bindingType === bindingType && entry.scopeKey === scopeKey)) return;
    entries.push(requiredBinding(bindingType, item, reason, scopeKey));
  };
  for (const item of items.filter(candidate => candidate?.status === 'locked' && candidate.required !== false)) {
    const assetKind = item.assetType ?? item.type;
    if (assetKind === 'character_identity_pack_v2' || item.type === 'character_identity_pack') {
      add('character_identity_pack_v2', item, '当前 Shot coverage 要求可见人物身份锚。');
    } else if (['character_board', 'character_identity_single_view', 'character_front_face_closeup_v1'].includes(assetKind)) {
      add('replacement_asset', item, 'v1 人物身份资产在 v2 切换期按 dual-read 保留；新项目应由 Shot coverage 迁移为 identity pack。');
    } else if (assetKind === 'character_acting_master_v1' || item.type === 'character_acting_master') {
      add('character_acting_master_v1', item, '复现或复用角色需要稳定的长期行为身份。');
    } else if (assetKind === 'character_story_state_v1' || item.type === 'character_story_state') {
      add('character_story_state_v1', item, '当前剧情外观状态跨 Shot 复用。');
    } else if (assetKind === 'voice_identity_v1' || item.type === 'voice_identity') {
      add('voice_identity_v1', item, '当前对白或跨段声音连续性需要声音身份。');
    } else if (['source_audio_candidate', 'dialogue_audio_reference', 'timing_audio_reference'].includes(assetKind)) {
      add('approved_source_audio', item, '当前声音策略要求已锁定的音频输入。');
    } else if (assetKind === 'scene_geometry_v2' || item.type === 'scene_geometry') {
      if (item.applicability === 'not_applicable') {
        if (!entries.some(entry => entry.bindingType === 'scene_geometry_v2' && entry.scopeKey === segmentId)) {
          entries.push(notApplicableBinding('scene_geometry_v2', '当前镜头已明确判定不存在可复用主空间、走位或反打几何。', segmentId));
        }
      } else {
        add('scene_geometry_v2', item, '当前镜头存在可观察空间几何与反打/走位控制需求。');
      }
    } else if (assetKind === 'handoff_reconciliation_v1' || item.type === 'handoff_reconciliation') {
      add('handoff_reconciliation_v1', item, '下一段开态必须继承已对账的计划尾态、实拍尾态与计划开态。');
    } else if (['scene_multiview', 'scene_overhead'].includes(assetKind)) {
      add('scene_reference', item, 'v1 场景资产在 v2 切换期按 dual-read 保留。');
    } else if (assetKind === 'product_reference') {
      add('product_reference', item, '当前镜头要求产品结构与材质权威。');
    }
  }
  if (!entries.some(entry => ['approved_source_audio', 'voice_identity_v1'].includes(entry.bindingType))) {
    entries.push(notApplicableBinding('approved_source_audio', '当前资产合同未要求外部或原声音频；具体节点声音行为由 audioStrategy 决定。', segmentId));
  }
  if (!entries.some(entry => entry.bindingType === 'character_acting_master_v1')) {
    entries.push(notApplicableBinding('character_acting_master_v1', '当前已锁定资产未证明存在复现/复用角色，不无条件增加 Master Profile。', segmentId));
  }
  if (!entries.some(entry => ['scene_geometry_v2', 'scene_reference'].includes(entry.bindingType))) {
    entries.push(notApplicableBinding('scene_geometry_v2', '当前 Shot 未证明需要复用主空间锚或复杂空间控制。', segmentId));
  }
  if (!entries.some(entry => entry.bindingType === 'handoff_reconciliation_v1')) {
    entries.push(notApplicableBinding('handoff_reconciliation_v1', '当前段未绑定需要连续代理交接的上一段边界。', segmentId));
  }
  return assertRequiredBindings({ version: 1, entries });
}
