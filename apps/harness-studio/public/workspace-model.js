// Pure display projection. No approval, task or artifact state is changed here.
export const USER_STEPS = ['说明需求', '确认方向', '整理镜头', '准备素材', '确认并生成', '检查成片', '导出交付'];
export function workspaceProgress(project, gate = 0) {
  let complete = project.studioFlow?.completion?.wholeFilmComplete === true;
  const phase = project.status?.phase;
  const mechanical = project.routeDecision?.executionClass === 'mechanical_asset_prompt';
  let index = Number.isInteger(gate) ? Math.max(0, Math.min(5, gate)) : 0;
  if (mechanical) index = project.mechanicalCanvas?.status === 'READY_FOR_USER_CANVAS_GENERATION' ? 4 : 3;
  if (phase === 'delivery_preparation' || complete) index = 6;
  if (project.studioFlow?.completion?.level === 'final_edit_ready') index = 5;
  if (complete) index = 6;
  const pendingDirection = (project.artifacts ?? project.status?.artifacts ?? []).some(a => a.type === 'creative_brief' && !a.invalidatedByScopeRevisionId && ['draft', 'rework', 'awaiting_review'].includes(a.status));
  const intakePending = project.directorInterview?.status === 'awaiting_answers';
  if (pendingDirection) index = 1;
  if (intakePending) index = 0;
  complete = complete && !pendingDirection && !intakePending;
  return { currentStep: index + 1, totalSteps: 7, complete,
    steps: USER_STEPS.map((label, i) => ({ label, index: i, active: i === index,
      // A step being earlier is not evidence that it passed.
      verified: (complete && !pendingDirection && !intakePending) || (i !== index && project.gateStates?.some(g => g.gate === i && g.status === 'passed') === true),
      notApplicable: mechanical && !pendingDirection && [1, 2].includes(i) })) };
}
export function mediaKindOf(artifact) {
  const path = String(artifact.path ?? '').split('?')[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|avif)$/.test(path)) return 'image';
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return 'video';
  if (/\.(mp3|wav|m4a|ogg|aac|flac)$/.test(path)) return 'audio';
  return null;
}
export function groupProjectMedia(project) {
  const groups = new Map();
  for (const artifact of project.artifacts ?? []) {
    if (!mediaKindOf(artifact)) continue;
    const run = artifact.runId ? (project.runs ?? []).find(r => r.id === artifact.runId) : null;
    const key = artifact.runId ? `run:${artifact.runId}` : 'unassigned';
    if (!groups.has(key)) groups.set(key, { key, run, segmentId: artifact.segmentId, kind: artifact.runId ? 'run' : 'unassigned', artifacts: [] });
    groups.get(key).artifacts.push(artifact);
  }
  for (const group of groups.values()) group.artifacts.sort((a,b)=>({video:0,image:1,audio:2})[mediaKindOf(a)]-({video:0,image:1,audio:2})[mediaKindOf(b)]);
  const priority = group => Math.min(...group.artifacts.map(a => ({video:0,image:1,audio:2})[mediaKindOf(a)]));
  return [...groups.values()].reverse().sort((a,b) => priority(a)-priority(b));
}
export function reviewAudience(review, artifacts = []) {
  // Do not infer a human decision from an approved status alone.
  const actor = review.actor ?? review.reviewer;
  if (actor === 'system' || actor === 'machine' || review.automatic === true) return 'machine';
  if (actor === 'human' || actor === 'user') return 'human';
  return 'unknown';
}
