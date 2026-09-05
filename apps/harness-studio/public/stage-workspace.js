export const STAGE_NAMES = ['说明需求','确认方向','整理镜头','准备素材','确认并生成','检查成片','导出交付'];
const types = [[],['creative_brief'],['story_plan','segmentation','storyboard_panel'],['project_asset','segment_asset'],['seedance_prompt'],['video_segment','final_edit'],['final_edit','handoff']];
export function stageResults(project, stage) {
 const artifacts = (project.artifacts ?? []).filter(a => types[stage]?.includes(a.type) && !a.invalidatedByScopeRevisionId);
 const latest = new Map();
 for (const a of artifacts) { const key=['creative_brief','story_plan','segmentation','final_edit','seedance_prompt'].includes(a.type)?[a.type,a.segmentId??'',a.scopeKey??''].join('|'):a.id; const old=latest.get(key);if(!old||a.revision>old.revision)latest.set(key,a); }
 return [...latest.values()];
}
export function directionEditableArtifact(project, stage) {
 const type=stage===2?'story_plan':'creative_brief';
 return (project.artifacts??[]).filter(a=>a.type===type&&!a.invalidatedByScopeRevisionId).sort((a,b)=>b.revision-a.revision)[0]
  ?? (project.artifacts??[]).filter(a=>a.type==='creative_brief'&&!a.invalidatedByScopeRevisionId).sort((a,b)=>b.revision-a.revision)[0] ?? null;
}
