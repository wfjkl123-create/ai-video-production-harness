import test from 'node:test';
import assert from 'node:assert/strict';
import {creationJournal,readCreationJournal} from '../../apps/harness-studio/public/creation-journal.js';
function storage() { const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}; }
test('recovery keeps project and successful steps across failure and rejects changed input',async()=>{
 const s=storage(),input={sourceFile:{name:'a.mp4',size:22,lastModified:1}};
 const first=creationJournal(s,'a',input,()=> 'p1');
 await first.step('created',async()=>({slug:'p1'}));
 await assert.rejects(first.step('intake',async()=>{throw Error('lost response')}));
 const resumed=creationJournal(s,'a',input,()=> 'p2');
 assert.deepEqual(await resumed.step('created',async()=>{throw Error('must not repeat')}),{slug:'p1'});
 assert.throws(()=>creationJournal(s,'a',{sourceFile:{name:'b.mp4'}},()=> 'p3'),/未完成/);
 assert.equal(resumed.record.projectId,'p1');
 resumed.finish(); assert.equal(s.getItem('a'),null);
});
test('damaged journal is preserved and unblocks the key with an explicit error',()=>{
 const s=storage();s.setItem('a','broken');
 assert.throws(()=>readCreationJournal(s,'a'),/损坏/);
 assert.equal(s.getItem('a'),null);
 assert.equal([...s.values.values()][0],'broken');
});
test('principal-specific keys do not share unfinished inputs',()=>{
 const s=storage();creationJournal(s,'member1:original',{text:'private'},()=> 'p1');
 assert.equal(readCreationJournal(s,'member2:original'),null);
});
