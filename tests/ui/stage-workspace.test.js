import test from 'node:test';
import assert from 'node:assert/strict';
import {stageResults,directionEditableArtifact,STAGE_NAMES} from '../../apps/harness-studio/public/stage-workspace.js';
test('all stages can find a current direction without choosing invalidated versions',()=>{
 const project={artifacts:[{id:'old',type:'creative_brief',revision:1},{id:'current',type:'creative_brief',revision:2},{id:'invalid',type:'creative_brief',revision:3,invalidatedByScopeRevisionId:'scope-1'}]};
 for(let stage=0;stage<STAGE_NAMES.length;stage++)assert.equal(directionEditableArtifact(project,stage).id,'current');
});
test('stage results preserve distinct assets and select newest story revision',()=>{
 const project={artifacts:[{id:'a',type:'project_asset',assetType:'character',revision:1},{id:'b',type:'project_asset',assetType:'character',revision:1},{id:'s1',type:'story_plan',revision:1},{id:'s2',type:'story_plan',revision:2,status:'draft'}]};
 assert.equal(stageResults(project,3).length,2);
 assert.equal(stageResults(project,2)[0].id,'s2');
 assert.equal(directionEditableArtifact(project,2).id,'s2');
});
