import test from 'node:test';
import assert from 'node:assert/strict';
import {chineseInterfaceText,chineseProjectName,chineseSegmentName,chineseMediaName} from '../../apps/harness-studio/public/chinese-copy.js';
test('interface terms translate without erasing filenames or executable identifiers',()=>{
 assert.equal(chineseInterfaceText('Gate 4 · KOC · A-roll · AI检查 · SHA'), '生成前审核 · 口播人物复刻 · 人物口播画面 · 人工智能检查 · 文件校验指纹');
 assert.equal(chineseInterfaceText('project-video-v1.mp4'), 'project-video-v1.mp4');
 assert.equal(chineseInterfaceText('user@example.com'), 'user@example.com');
});
test('display names are Chinese and do not mutate original bindings',()=>{
 const a={id:'original-id',path:'clip.mp4',segmentId:'face-package-007',revision:2};
 const before=JSON.stringify(a);
 assert.equal(chineseMediaName(a,3),'第7段 · 视频素材 4');
 assert.equal(chineseSegmentName({id:'full-source-timeline'}),'完整原片');
 assert.doesNotMatch(chineseProjectName({slug:'qidiao-full-remake-001'}),/[A-Za-z]/);
 assert.equal(JSON.stringify(a),before);
});

test('model identities remain exact and mixed Chinese project names retain their Chinese words',()=>{
 assert.equal(chineseInterfaceText('Seedance 2.5'),'Seedance 2.5');
 assert.equal(chineseInterfaceText('Codex'),'Codex');
 assert.match(chineseProjectName({displayName:'内衣复刻-test'}),/^内衣复刻/);
});
