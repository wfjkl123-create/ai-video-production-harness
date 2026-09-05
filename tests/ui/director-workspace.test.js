import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceProgress, mediaKindOf, groupProjectMedia, reviewAudience } from '../../apps/harness-studio/public/workspace-model.js';
import { creationJournal } from '../../apps/harness-studio/public/creation-journal.js';

test('mechanical progress has seven stable steps without inventing creative approvals',()=>{
 const p=workspaceProgress({routeDecision:{executionClass:'mechanical_asset_prompt'}},1);
 assert.equal(p.currentStep,4); assert.equal(p.steps.length,7);
 assert.equal(p.steps[1].notApplicable,true); assert.equal(p.steps[1].verified,false);
});
test('delivery is not complete until whole film acceptance projection confirms it',()=>{
 assert.equal(workspaceProgress({status:{phase:'archived'}}).complete,false);
 const p=workspaceProgress({studioFlow:{completion:{wholeFilmComplete:true,level:'final_edit_ready'}}});
 assert.equal(p.currentStep,7); assert.equal(p.complete,true);
});
test('media groups use explicit run IDs and never infer a generation from asset proximity',()=>{
 const result=groupProjectMedia({artifacts:[{id:'a',path:'a.png',runId:'run1'},{id:'b',path:'b.mp4',segmentId:'segment-001'},{id:'c',path:'c.wav'},{id:'d',path:'d.json'}]});
 assert.deepEqual(result.map(g=>g.kind),['unassigned','run']);
 assert.equal(mediaKindOf({path:'CLIP.MP4'}),'video');
});
test('approved records without a human actor remain unknown',()=>{
 assert.equal(reviewAudience({decision:'approved'}),'unknown');
 assert.equal(reviewAudience({actor:'system',decision:'approved'}),'machine');
 assert.equal(reviewAudience({actor:'human'}),'human');
});
function storage(){ const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}; }
test('creation resumes after an error and reload without creating a different project',async()=>{
 const st=storage(); let creates=0;
 const first=creationJournal(st,'task',{text:'same'},()=> 'stable');
 await first.step('created',async r=>{creates++;return {slug:r.projectId};});
 await assert.rejects(first.step('intake',async()=>{throw Error('offline');}),/offline/);
 const second=creationJournal(st,'task',{text:'same'},()=> 'different');
 assert.equal((await second.step('created',async()=>{creates++;})).slug,'stable');
 await second.step('intake',async()=>({done:true}));
 assert.equal(creates,1); second.finish(); assert.equal(st.getItem('task'),null);
});
test('lost creation response retries the same project ID and changing input cannot reuse completed steps',async()=>{
 const st=storage();const ids=[];
 const first=creationJournal(st,'task',{text:'same'},()=> 'stable');
 await assert.rejects(first.step('created',async r=>{ids.push(r.projectId);throw Error('lost response');}));
 const retry=creationJournal(st,'task',{text:'same'},()=> 'different');
 await retry.step('created',async r=>{ids.push(r.projectId);return {slug:r.projectId};});
 assert.deepEqual(ids,['stable','stable']);
 assert.throws(()=>creationJournal(st,'task',{text:'changed'},()=> 'different'),/未完成/);
});

test('pending revised direction takes priority over an old ready mechanical canvas',()=>{
 const p=workspaceProgress({routeDecision:{executionClass:'mechanical_asset_prompt'},mechanicalCanvas:{status:'READY_FOR_USER_CANVAS_GENERATION'},artifacts:[{type:'creative_brief',status:'awaiting_review'}],gateStates:[{gate:1,status:'passed'}]},1);
 assert.equal(p.currentStep,2); assert.equal(p.steps[1].notApplicable,false); assert.equal(p.steps[1].verified,false);
});

test('new direction pending clears current completion while retaining historical evidence',()=>{
 const p=workspaceProgress({studioFlow:{completion:{wholeFilmComplete:true}},artifacts:[{type:'creative_brief',status:'draft'}]});
 assert.equal(p.complete,false); assert.equal(p.currentStep,2);
});
