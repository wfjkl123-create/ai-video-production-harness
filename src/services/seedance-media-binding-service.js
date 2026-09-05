const SAFE_ID_SOURCE = '[A-Za-z0-9][A-Za-z0-9._:-]{0,191}';
const SEMANTIC_REFERENCE = new RegExp(`@(?:素材|Asset)\\[(${SAFE_ID_SOURCE})\\]`, 'giu');
const POSITIONAL_REFERENCE = /@(?:图|视频|音频)\s*[1-9][0-9]*|@(?:Image|Video|Audio)\s*[1-9][0-9]*/iu;
const UNRECOGNIZED_AT_REFERENCE = /@[A-Za-z0-9\u3400-\u9fff][A-Za-z0-9._:\-\u3400-\u9fff]*/gu;

const MEDIA_LABELS = Object.freeze({ image: '图', video: '视频', audio: '音频' });

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function bindingFor(item, mediaKind, index, responsibilityMap) {
  requireText(item.id, `${mediaKind}Inputs[${index - 1}].id`);
  if (!/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new TypeError(`${item.id} requires a lowercase SHA-256 before media binding`);
  const responsibility = responsibilityMap[item.id];
  if (!responsibility || !Array.isArray(responsibility.controls) || responsibility.controls.length === 0
    || !Array.isArray(responsibility.mustNotControl) || responsibility.mustNotControl.length === 0) {
    throw new Error(`selected media ${item.id} requires a complete responsibility contract before media binding`);
  }
  return {
    tag: `@${MEDIA_LABELS[mediaKind]}${index}`,
    semanticToken: `@素材[${item.id}]`,
    id: item.id,
    mediaKind,
    index,
    sha256: item.sha256,
    controls: [...responsibility.controls],
    mustNotControl: [...responsibility.mustNotControl]
  };
}

export function buildSeedanceMediaBindings(compiledPackage) {
  if (!compiledPackage || typeof compiledPackage !== 'object' || Array.isArray(compiledPackage)) throw new TypeError('compiledPackage must be an object');
  const responsibilityMap = compiledPackage.responsibilityMap ?? {};
  const bindings = [];
  const ids = new Set();
  for (const [mediaKind, field] of [['image', 'imageInputs'], ['video', 'videoInputs'], ['audio', 'audioInputs']]) {
    const inputs = compiledPackage[field];
    if (!Array.isArray(inputs)) throw new TypeError(`${field} must be an array`);
    inputs.forEach((item, offset) => {
      if (ids.has(item.id)) throw new Error(`selected media id appears more than once: ${item.id}`);
      ids.add(item.id);
      bindings.push(bindingFor(item, mediaKind, offset + 1, responsibilityMap));
    });
  }
  return bindings;
}

export function assertSeedanceMediaBindingContract(compiledPackage) {
  if (!compiledPackage || typeof compiledPackage !== 'object' || Array.isArray(compiledPackage)) {
    throw new TypeError('compiledPackage must be an object');
  }
  if (compiledPackage.mediaBindingContractVersion !== 1 || !Array.isArray(compiledPackage.mediaBindings)) {
    throw new Error('compiled package must be recompiled with deterministic media binding contract version 1');
  }
  const expected = buildSeedanceMediaBindings(compiledPackage);
  if (JSON.stringify(compiledPackage.mediaBindings) !== JSON.stringify(expected)) {
    const error = new Error('persisted media bindings do not match the exact selected inputs, order, SHA-256 values and responsibility contracts');
    error.code = 'MEDIA_BINDING_CONTRACT_MISMATCH';
    throw error;
  }
  return expected;
}

export function renderSeedanceMediaBindingHeader(bindings) {
  if (!Array.isArray(bindings)) throw new TypeError('media bindings must be an array');
  const lines = [
    '【参考素材｜本次实际上传】',
    '编号只承担所列职责，不交换。'
  ];
  if (bindings.length === 0) {
    lines.push('本次没有绑定图片、视频或音频，所有可见内容必须由下方文字完整定义。');
  } else {
    const grouped = new Map();
    for (const binding of bindings) {
      const key = JSON.stringify([binding.controls, binding.mustNotControl]);
      const members = grouped.get(key) ?? [];
      members.push(binding);
      grouped.set(key, members);
    }
    let roleIndex = 0;
    const roleLines = [];
    for (const members of grouped.values()) {
      if (members.length === 1) {
        const [binding] = members;
        lines.push(`${binding.tag}=${binding.id}｜控:${binding.controls.join('、')}｜禁:${binding.mustNotControl.join('、')}`);
        continue;
      }
      roleIndex += 1;
      const role = `R${roleIndex}`;
      for (const binding of members) lines.push(`${binding.tag}=${binding.id}｜${role}`);
      roleLines.push(`${role}｜控:${members[0].controls.join('、')}｜禁:${members[0].mustNotControl.join('、')}`);
    }
    lines.push(...roleLines);
  }
  return lines.join('\n');
}

function validateSourceReferences(sourceText) {
  if (POSITIONAL_REFERENCE.test(sourceText)) {
    const error = new Error('source prompt must not hard-code @图N/@视频N/@音频N; use @素材[exact-asset-id] so final indexes come from the compiled package');
    error.code = 'POSITIONAL_MEDIA_REFERENCE_IN_SOURCE';
    throw error;
  }
  const withoutSemanticReferences = sourceText.replace(SEMANTIC_REFERENCE, '');
  SEMANTIC_REFERENCE.lastIndex = 0;
  const unrecognized = [...withoutSemanticReferences.matchAll(UNRECOGNIZED_AT_REFERENCE)].map(match => match[0]);
  if (unrecognized.length > 0) {
    const error = new Error(`source prompt contains unsupported media aliases: ${[...new Set(unrecognized)].join(', ')}; use @素材[exact-asset-id]`);
    error.code = 'UNSUPPORTED_MEDIA_ALIAS';
    throw error;
  }
}

export function assertSeedanceSourcePromptReferences(sourceText) {
  requireText(sourceText, 'source prompt');
  validateSourceReferences(sourceText);
  return true;
}

export function compileSeedanceMediaBoundPrompt(sourceText, compiledPackage) {
  requireText(sourceText, 'source prompt');
  validateSourceReferences(sourceText);
  const bindings = buildSeedanceMediaBindings(compiledPackage);
  const byId = new Map(bindings.map(binding => [binding.id, binding]));
  const mediaTokenMappingManifest = [];
  let compiledOffset = 0;
  let sourceOffset = 0;
  let body = '';
  for (const match of sourceText.matchAll(SEMANTIC_REFERENCE)) {
    const [sourceToken, id] = match;
    const binding = byId.get(id);
    if (!binding) {
      const error = new Error(`source prompt references media that is not selected in the compiled package: ${id}`);
      error.code = 'UNBOUND_SEMANTIC_MEDIA_REFERENCE';
      throw error;
    }
    const before = sourceText.slice(sourceOffset, match.index);
    body += before;
    compiledOffset += before.length;
    const compiledStart = compiledOffset;
    body += binding.tag;
    compiledOffset += binding.tag.length;
    mediaTokenMappingManifest.push({
      sourceToken,
      sourceStart: match.index,
      sourceEnd: match.index + sourceToken.length,
      platformToken: binding.tag,
      compiledStart,
      compiledEnd: compiledOffset,
      assetId: binding.id,
      assetSha256: binding.sha256
    });
    sourceOffset = match.index + sourceToken.length;
  }
  body += sourceText.slice(sourceOffset);
  SEMANTIC_REFERENCE.lastIndex = 0;
  return {
    contractVersion: 1,
    bindings,
    mediaTokenMappingManifest,
    // Media roles, SHA-256 values and source IDs remain in `bindings` for
    // audit/readback. They must never be prepended to the model-facing prompt:
    // doing so duplicates every reference and makes internal contract syntax
    // compete with the actual director instructions.
    text: body
  };
}

export function verifySeedanceMediaTokenMapping(sourceText, compiledText, manifest) {
  requireText(sourceText, 'source prompt');
  requireText(compiledText, 'compiled prompt');
  if (!Array.isArray(manifest)) throw new TypeError('media token mapping manifest must be an array');
  let sourceOffset = 0;
  let reconstructed = '';
  for (const [index, item] of manifest.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`media token mapping manifest[${index}] must be an object`);
    if (!Number.isInteger(item.sourceStart) || !Number.isInteger(item.sourceEnd)
      || item.sourceStart < sourceOffset || item.sourceEnd <= item.sourceStart) {
      throw new Error(`media token mapping manifest[${index}] has invalid source offsets`);
    }
    if (sourceText.slice(item.sourceStart, item.sourceEnd) !== item.sourceToken) {
      throw new Error(`media token mapping manifest[${index}] source span does not match sourceToken`);
    }
    reconstructed += sourceText.slice(sourceOffset, item.sourceStart) + item.platformToken;
    sourceOffset = item.sourceEnd;
  }
  reconstructed += sourceText.slice(sourceOffset);
  if (reconstructed !== compiledText) {
    const error = new Error('compiled prompt contains changes outside the declared media token mapping manifest');
    error.code = 'UNDECLARED_PROMPT_SEMANTIC_DIFF';
    throw error;
  }
  return true;
}
