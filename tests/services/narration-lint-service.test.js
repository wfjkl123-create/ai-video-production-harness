import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';
import { lintNarration } from '../../src/services/narration-lint-service.js';
import { readJson } from '../../src/storage/json-store.js';

async function projectWithNarration(shots, { workflowVersion = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'narration-gate-'));
  await initializeProject(root, { projectId: 'NARRATION-TEST', workflowVersion });
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts/segment-001-narration.json'), JSON.stringify({
    id: 'narration-001', segmentId: 'segment-001', sourceSegmentId: 'segment-001', revision: 1, status: 'draft', shots
  }, null, 2) + '\n');
  await registerArtifact(root, {
    id: 'narration-001', type: 'shot_narration', segmentId: 'segment-001', revision: 1,
    status: 'draft', path: 'prompts/segment-001-narration.json'
  });
  return root;
}

const disciplinedShot = {
  shotId: 'shot-001', physicalActions: ['她抬手把碗放到桌上，指尖沿桌沿滑过'],
  cameraMove: '推近', lightSources: ['左前方暖光'], emotionThroughAction: '嘴角轻轻上扬'
};

const legacyEmotionShot = {
  ...disciplinedShot,
  performanceMode: 'emotion_dlc',
  performancePlan: {
    dlcId: 'emotion-performance-v1', templateSource: 'knowledge/capabilities/dlc/emotion-performance.md',
    skillsApplied: ['seedance2-prompt', 'seedance-characters'], focusedCharacter: 'Character A',
    objective: '拒绝接受关系结束', subtext: '嘴上平静，身体不接钥匙',
    obstacle: '钥匙已经被推到桌面中央', tactic: '停住伸出的手',
    beatPlan: [{ tactic: '维持平静', visibleChange: '右手停在钥匙旁，视线仍看桌面' }],
    trigger: 'Character B 把钥匙推到桌面中央', performanceRegister: 'restrained_realism',
    intensity: 'restrained', dominantTrack: 'hands', startBehavior: '右手停在自己一侧，视线看桌面',
    primaryAction: '右手伸向钥匙后停住', supportingCues: ['吞咽后呼吸变轻'],
    voiceBreath: '无台词，只保留一次短吸气', endBehavior: '右手仍停在钥匙旁',
    continuityCarry: ['钥匙仍在桌面中央'], backgroundCharacters: []
  }
};

test('machine review auto-locks a disciplined narration', async () => {
  const root = await projectWithNarration([disciplinedShot]);
  const { artifact, lint, review } = await lintNarration(root, 'narration-001');
  assert.equal(artifact.status, 'locked');
  assert.equal(artifact.lockedByReviewId, review.id);
  assert.equal(review.actor, 'system');
  assert.equal(review.autoLocked, true);
  assert.equal(lint.passed, true);
});

test('machine review blocks emotion-only actions and leaves the artifact in draft', async () => {
  const root = await projectWithNarration([{ ...disciplinedShot, physicalActions: ['她很欣慰'] }]);
  await assert.rejects(() => lintNarration(root, 'narration-001'), /narration-lint failed/);
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(({ id }) => id === 'narration-001').status, 'draft');
});

test('human submit-review cannot bypass the machine gate for shot_narration', async () => {
  const root = await projectWithNarration([disciplinedShot]);
  await assert.rejects(() => submitForReview(root, 'narration-001'), /narration-lint/);
});

test('after machine review passes, narration is already locked without human step', async () => {
  const root = await projectWithNarration([disciplinedShot]);
  await lintNarration(root, 'narration-001');
  const state = await readJson(join(root, 'project-state.json'));
  const locked = state.artifacts.find(({ id }) => id === 'narration-001');
  assert.equal(locked.status, 'locked');
  assert.ok(typeof locked.lockedByReviewId === 'string' && locked.lockedByReviewId.length > 0);
});

test('normalizes a relative project root before auto-locking narration', async () => {
  const root = await projectWithNarration([disciplinedShot]);
  const relativeRoot = relative(process.cwd(), root);
  await lintNarration(relativeRoot, 'narration-001');
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(({ id }) => id === 'narration-001').status, 'locked');
});

test('workflow v2 current writes reject a readable legacy emotion plan without actingControlVersion 2', async () => {
  const root = await projectWithNarration([legacyEmotionShot]);
  await assert.rejects(() => lintNarration(root, 'narration-001'), /actingControlVersion 2/);
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(({ id }) => id === 'narration-001').status, 'draft');
});

test('workflow v1 historical reads keep the legacy emotion plan compatible and report an upgrade warning', async () => {
  const root = await projectWithNarration([legacyEmotionShot], { workflowVersion: 1 });
  const result = await lintNarration(root, 'narration-001');
  assert.equal(result.artifact.status, 'locked');
  assert.ok(result.lint.warnings.some(message => /legacy emotion-performance-v1/.test(message)));
});
