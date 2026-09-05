import { createHash } from 'node:crypto';

function ids(value, field) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)].sort();
}

/** Read-only scope preview. Text is an explanation, never an inferred instruction.
 * segments must be the currently loaded segmentation artifact, not a guessed list.
 * Known links: segment.projectAssetIds and continuous_proxy_handoff.previousSegmentId.
 * Absence of other links is NOT evidence that a segment is independent.
 */
export function previewChangeImpact(state, request = {}, { segments = [] } = {}) {
  if (!state || !Array.isArray(state.artifacts)) throw new TypeError('state.artifacts must be an array');
  if (!Array.isArray(segments)) throw new TypeError('segments must be an array');
  const scope = request.scope ?? 'unknown';
  if (!['unknown', 'project', 'segments', 'assets', 'presentation'].includes(scope)) throw new TypeError('unsupported change scope');
  const segmentIds = ids(request.segmentIds ?? [], 'segmentIds');
  const artifactIds = ids(request.artifactIds ?? [], 'artifactIds');
  if (scope === 'segments' && !segmentIds.length) throw new TypeError('segment scope requires segmentIds');
  if (scope === 'assets' && !artifactIds.length) throw new TypeError('asset scope requires artifactIds');
  if (scope === 'presentation' && (segmentIds.length || artifactIds.length)) throw new TypeError('presentation scope cannot target production inputs');
  const knownArtifacts = new Map(state.artifacts.map(item => [item.id, item]));
  const knownSegments = new Map(segments.map(item => [item.id, item]));
  const unknowns = [];
  for (const id of artifactIds) if (!knownArtifacts.has(id)) unknowns.push(`未找到所选素材：${id}`);
  for (const id of segmentIds) if (!knownSegments.has(id)) unknowns.push(`未找到所选片段：${id}`);
  if (scope === 'unknown') unknowns.push('尚未确认修改范围；文字说明不会自动当作已确认的范围。');
  if (scope !== 'presentation' && !segments.length) unknowns.push('尚未读取当前分段，无法判断哪些片段相关。');
  const affected = new Set(scope === 'project' ? knownSegments.keys()
    : scope === 'segments' ? segmentIds.filter(id => knownSegments.has(id)) : []);
  const reasons = {};
  for (const id of affected) reasons[id] = [scope === 'project' ? '你选择了整个项目' : '你选择了这个片段'];
  if (scope === 'assets') for (const segment of segments) {
    if ((segment.projectAssetIds ?? []).some(id => artifactIds.includes(id))
      || artifactIds.some(id => knownArtifacts.get(id)?.segmentId === segment.id)) {
      affected.add(segment.id);
      reasons[segment.id] = ['使用了所选素材，或所选素材属于这个片段'];
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const segment of segments) {
      if (!affected.has(segment.id) && segment.continuityStrategy === 'continuous_proxy_handoff'
        && affected.has(segment.previousSegmentId)) {
        affected.add(segment.id);
        reasons[segment.id] = [`接续片段 ${segment.previousSegmentId} 的结束画面，需要检查衔接`];
        changed = true;
      }
    }
  }
  const affectedSegmentIds = [...affected].sort();
  const unassessedSegmentIds = scope === 'presentation' ? [] : [...knownSegments.keys()].filter(id => !affected.has(id)).sort();
  if (unassessedSegmentIds.length) unknowns.push('其他片段暂未发现直接关联；还需检查镜头、共享素材和剪辑依赖，不能据此保证完全不受影响。');
  const affectedArtifactIds = scope === 'presentation' || scope === 'unknown' ? [] : state.artifacts
    .filter(item => scope === 'project' || artifactIds.includes(item.id) || affected.has(item.segmentId))
    .map(item => item.id).sort();
  const basis = { state, segments, scope, segmentIds, artifactIds };
  return {
    schemaVersion: 1, kind: 'change_impact_preview', readOnly: true,
    projectId: state.projectId, scope, description: typeof request.description === 'string' ? request.description : '',
    snapshotSha256: createHash('sha256').update(JSON.stringify(basis)).digest('hex'),
    affectedSegmentIds, affectedArtifactIds, reasons, unassessedSegmentIds,
    unchangedSegmentIds: scope === 'presentation' ? [...knownSegments.keys()].sort() : [],
    unknowns, analysisStatus: unknowns.length ? 'needs_review' : 'scoped_preview',
    actions: { stateChanged: false, tasksPaused: false, approvalsInvalidated: false, paidSubmissionAllowed: false },
    guidance: scope === 'presentation'
      ? '仅适用于界面名称或说明文字；制作输入不变，当前制作可继续。'
      : '只列出已知关联，不会自动停止任务。确认具体改动及依赖后，再决定保留、局部调整或重新生成；已提交结果和费用记录保留。'
  };
}
