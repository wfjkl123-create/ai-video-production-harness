import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject } from '../../src/services/project-service.js';
import { createCreativeBrief } from '../../src/services/creative-brief-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { creativeBrief } from '../helpers/creative-brief-fixture.js';
import { readArtifactEditor, saveArtifactEdit, previewArtifactEdit, applyArtifactEdit, rewriteArtifactEdit } from '../../src/services/artifact-edit-service.js';
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'artifact-edit-'));
 await initializeProject(root, {projectId:'PROJECT-1',workflowVersion:2});
 const artifact = await createCreativeBrief(root,creativeBrief());
 const editor = await readArtifactEditor(root,artifact.id);
 return {root,artifact,input:{artifactId:artifact.id,sourceSha256:editor.sourceSha256,expectedDraftRevision:0,values:{'creativeDecision.storyDirection':'用亲身体验展示产品效果'}}};
}
test('candidate leaves project and original unchanged; explicit adoption publishes review version without paid work',async()=>{
 const {root,artifact,input}=await fixture();
 const before=await readJson(join(root,'project-state.json'));
 const source=await readJson(join(root,artifact.path));
 const draft=await saveArtifactEdit(root,input);
 assert.deepEqual(await readJson(join(root,'project-state.json')),before);
 assert.deepEqual(await readJson(join(root,artifact.path)),source);
 const args={artifactId:artifact.id,draftId:draft.draftId,expectedDraftRevision:draft.draftRevision};
 const preview=await previewArtifactEdit(root,args);
 assert.equal(preview.impactPolicy,'conservative_v1');
 await assert.rejects(applyArtifactEdit(root,args),/确认/);
 const result=await applyArtifactEdit(root,{...args,stateFingerprint:preview.stateFingerprint,confirmImpact:true});
 assert.equal(result.artifact.status,'draft');
 assert.equal(result.paidGenerationSubmitted,false);
 const after=await readJson(join(root,'project-state.json'));
 assert.equal(after.artifacts.length,before.artifacts.length+1);
 assert.deepEqual(await readJson(join(root,artifact.path)),source);
 const published=await readJson(join(root,result.artifact.path));
 assert.equal(published.creativeDecision.storyDirection,input.values['creativeDecision.storyDirection']);
 assert.equal(published.creativeDecision.revisionImpact.impactPolicy,'conservative_v1');
});
test('rejects unsupported fields, stale candidate, and changed project impact',async()=>{
 const {root,input}=await fixture();
 await assert.rejects(saveArtifactEdit(root,{...input,values:{'__proto__.polluted':'x'}}),/不能/);
 const draft=await saveArtifactEdit(root,input);
 await assert.rejects(saveArtifactEdit(root,input),/已被更新/);
 const state=await readJson(join(root,'project-state.json'));
 state.updatedAt='2026-09-05T00:00:00.000Z';
 await writeJsonAtomic(join(root,'project-state.json'),state);
 await assert.rejects(previewArtifactEdit(root,{artifactId:input.artifactId,draftId:draft.draftId,expectedDraftRevision:1}),/项目进度/);
});
test('AI has explicit unavailable error and uses same validated candidate channel',async()=>{
 const {root,input}=await fixture();
 await assert.rejects(rewriteArtifactEdit(root,{...input,instruction:'改得更清楚'}),{code:'REWRITE_UNAVAILABLE'});
 const before=await readJson(join(root,'project-state.json'));
 const result=await rewriteArtifactEdit(root,{...input,instruction:'改得更清楚'},{rewrite:async({fields})=>{
 assert.ok(fields.some(item=>item.key==='creativeDecision.storyDirection'));
 return {values:input.values};
 }});
 assert.equal(result.applied,false);
 assert.deepEqual(await readJson(join(root,'project-state.json')),before);
});
test('concurrent adoption publishes only once and obsolete draft cannot be applied',async()=>{
 const {root,input}=await fixture();
 const saved=await saveArtifactEdit(root,input);
 const args={artifactId:input.artifactId,draftId:saved.draftId,expectedDraftRevision:saved.draftRevision};
 const preview=await previewArtifactEdit(root,args);
 const outcomes=await Promise.allSettled([1,2].map(()=>applyArtifactEdit(root,{...args,stateFingerprint:preview.stateFingerprint,confirmImpact:true})));
 assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
 const state=await readJson(join(root,'project-state.json'));
 assert.equal(state.artifacts.filter(item=>item.type==='creative_brief').length,2);
});
test('changed project allows rechecking unchanged candidate without forcing cosmetic edits',async()=>{
 const {root,input}=await fixture();
 const saved=await saveArtifactEdit(root,input);
 const state=await readJson(join(root,'project-state.json'));
 state.updatedAt='2026-09-06T00:00:00.000Z';
 await writeJsonAtomic(join(root,'project-state.json'),state);
 const refreshed=await saveArtifactEdit(root,{...input,expectedDraftRevision:saved.draftRevision});
 assert.equal(refreshed.draftRevision,2);
 assert.ok(await previewArtifactEdit(root,{artifactId:input.artifactId,draftId:refreshed.draftId,expectedDraftRevision:2}));
});
