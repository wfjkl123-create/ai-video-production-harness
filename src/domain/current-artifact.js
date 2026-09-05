const SINGLETON_TYPES = new Set([
  'creative_brief',
  'story_plan',
  'segmentation',
  'quality_rubric',
  'segment_contract',
  'shot_narration',
  'seedance_prompt',
  'canonical_prompt_source',
  'character_acting_master',
  'character_story_state',
  'voice_identity',
  'scene_geometry',
  'handoff_reconciliation',
  'final_edit'
]);

const STATUS_PRIORITY = Object.freeze({ locked: 6, awaiting_review: 5, rework: 4, draft: 3, blocked: 2, rejected: 1 });

function familyKey(artifact) {
  if (!SINGLETON_TYPES.has(artifact.type)) return `id:${artifact.id}`;
  // Historical Seedance registrations predate explicit segment IDs.  A source
  // prompt and its compiled execution package legitimately share a revision,
  // but they are separate singleton lineages.  Keep their original, stable
  // execution-unit stem while separating the two roles; otherwise the newest
  // source/package pair is falsely reported as an ambiguous duplicate.
  if (artifact.type === 'seedance_prompt' && !artifact.segmentId) {
    const isPackage = typeof artifact.sourcePromptId === 'string'
      || artifact.id.endsWith('-package')
      || artifact.path.endsWith('/seedance20-standard15-package.json')
      || artifact.path.endsWith('/seedance25-standard-package.json')
      || artifact.path.endsWith('/seedance25-standard30-package.json');
    const executionStem = typeof artifact.executionUnitId === 'string'
      ? artifact.executionUnitId.replace(/-v\d+$/, '')
      : artifact.id.replace(/-v\d+(?:-package)?$/, '');
    if (executionStem && executionStem !== artifact.id) {
      return [artifact.type, 'legacy_execution', isPackage ? 'package' : 'source', executionStem].join('|');
    }
  }
  return [
    artifact.type,
    artifact.segmentId ?? '',
    artifact.sceneId ?? '',
    artifact.characterId ?? '',
    artifact.productId ?? '',
    artifact.scopeKey ?? ''
  ].join('|');
}

function compareCurrent(left, right) {
  return right.revision - left.revision
    || (STATUS_PRIORITY[right.status] ?? 0) - (STATUS_PRIORITY[left.status] ?? 0)
    || right.id.localeCompare(left.id);
}

export function resolveCurrentArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new TypeError('artifacts must be an array');
  const byId = new Map();
  for (const artifact of artifacts) {
    if (byId.has(artifact.id)) throw new Error(`duplicate artifact id: ${artifact.id}`);
    byId.set(artifact.id, artifact);
  }

  const superseded = new Set(
    artifacts
      .filter(artifact => typeof artifact.invalidatedByScopeRevisionId === 'string'
        && artifact.invalidatedByScopeRevisionId.trim() !== '')
      .map(artifact => artifact.id)
  );
  for (const artifact of artifacts) {
    if (!artifact.supersedesArtifactId) continue;
    const prior = byId.get(artifact.supersedesArtifactId);
    if (!prior) throw new Error(`superseded artifact does not exist: ${artifact.supersedesArtifactId}`);
    if (prior.type !== artifact.type) throw new Error(`artifact ${artifact.id} cannot supersede a different type`);
    if (SINGLETON_TYPES.has(artifact.type) && familyKey(prior) !== familyKey(artifact)) {
      throw new Error(`artifact ${artifact.id} cannot supersede a different scope`);
    }
    if (prior.id === artifact.id) throw new Error(`artifact ${artifact.id} cannot supersede itself`);
    superseded.add(prior.id);
  }

  let explicitCurrent = artifacts.filter(artifact => !superseded.has(artifact.id));
  const duplicateVideoGroups = new Map();
  for (const artifact of explicitCurrent) {
    if (artifact.type !== 'video_segment' || !artifact.sha256) continue;
    const key = [artifact.type, artifact.segmentId ?? '', artifact.status, artifact.sha256].join('|');
    const group = duplicateVideoGroups.get(key) ?? [];
    group.push(artifact);
    duplicateVideoGroups.set(key, group);
  }
  for (const group of duplicateVideoGroups.values()) {
    if (group.length < 2) continue;
    group.sort(compareCurrent);
    for (const duplicate of group.slice(1)) superseded.add(duplicate.id);
  }
  explicitCurrent = explicitCurrent.filter(artifact => !superseded.has(artifact.id));
  const grouped = new Map();
  for (const artifact of explicitCurrent) {
    const key = familyKey(artifact);
    const group = grouped.get(key) ?? [];
    group.push(artifact);
    grouped.set(key, group);
  }

  const current = [];
  for (const group of grouped.values()) {
    if (!SINGLETON_TYPES.has(group[0].type)) {
      current.push(...group);
      continue;
    }
    group.sort(compareCurrent);
    if (group.length > 1 && group[0].revision === group[1].revision && group[0].status === group[1].status) {
      const tied = group.filter(item => item.revision === group[0].revision && item.status === group[0].status);
      const duplicateSha = tied[0].sha256 && tied.every(item => item.sha256 === tied[0].sha256);
      if (!duplicateSha) throw new Error(`ambiguous current ${familyKey(group[0])}: revision ${group[0].revision} is duplicated`);
    }
    current.push(group[0]);
    for (const stale of group.slice(1)) superseded.add(stale.id);
  }

  return {
    current: current.sort((left, right) => left.id.localeCompare(right.id)),
    supersededIds: [...superseded].sort()
  };
}

export function currentArtifactsOf(artifacts, predicate = () => true) {
  return resolveCurrentArtifacts(artifacts).current.filter(predicate);
}

export function currentArtifactOf(artifacts, predicate) {
  const matches = currentArtifactsOf(artifacts, predicate);
  if (matches.length > 1) throw new Error(`multiple current artifacts match: ${matches.map(item => item.id).join(', ')}`);
  return matches[0] ?? null;
}
