import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic, readJson } from '../../src/storage/json-store.js';
import { registerRealismAuthority } from '../../src/services/realism-authority-service.js';
import { sha256File } from '../../src/storage/checksum.js';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'realism-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJsonAtomic(join(root, 'project-state.json'), {
    projectId: 'project-001', workflowVersion: 2, videoGovernanceVersion: 2,
    realismContractsVersion: 2, realismContractsWriteMode: 'enabled',
    phase: 'gate2', activeSegmentId: null, blockedReason: null, artifacts: [], updatedAt: new Date().toISOString()
  });
  await writeJsonAtomic(join(root, 'story', 'source.json'), { id: 'story-source-v1', fact: 'human-approved Gate 2 story source' });
  const state = await readJson(join(root, 'project-state.json'));
  const sha256 = await sha256File(join(root, 'story', 'source.json'));
  const source = {
    id: 'story-source-v1', type: 'story_plan', revision: 1, status: 'locked', path: 'story/source.json',
    sha256, lockedByReviewId: 'review-story-source-v1'
  };
  state.artifacts.push(source);
  await writeJsonAtomic(join(root, 'reviews', 'review-story-source-v1.json'), {
    id: 'review-story-source-v1', artifactId: source.id, decision: 'approved', actor: 'human', artifactSha256: sha256
  });
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  return { root, source };
}

function payload(source, id = 'acting-a-v1') {
  return {
    kind: 'character_acting_master_v1', version: 1, id, projectId: 'project-001', characterId: 'character-a',
    sourceBindings: [{ id: source.id, revision: source.revision, sha256: source.sha256 }],
    physicalBiography: {
      ageAndPhysiology: 'adult with ordinary facial muscle tone', baselineEnergy: 'contained', posture: 'slight forward shoulder set',
      gait: 'short grounded steps', breath: 'quiet nasal baseline', gazeBaseline: 'task and partner oriented', handBehavior: 'hands stay near the active object'
    },
    psychologicalEngine: { want: 'be understood', fear: 'public pity', protectiveMask: 'competence', fracturePattern: 'gaze drops after a difficult cue', recoveryPattern: 'swallows and resumes the task' },
    triggeredHabits: [{ cueId: 'difficult-subject', cue: 'after the difficult subject is named', observableResponse: 'breath pauses and thumb presses the cup rim', doNotUseAsClock: true }],
    continuityLocks: ['grounded posture', 'partner-oriented gaze'],
    sceneAdaptationPolicy: 'apply only causally triggered habits and allow active stillness',
    responsibility: 'long-term behavior identity that remains stable across scenes', mustNotControl: ['scene lighting', 'current injury']
  };
}

test('registers and machine-locks a source-bound realism authority artifact', async (t) => {
  const { root, source } = await project(t);
  const artifact = await registerRealismAuthority(root, { payload: payload(source) });
  assert.equal(artifact.type, 'character_acting_master');
  assert.equal(artifact.status, 'locked');
  assert.equal(artifact.characterId, 'character-a');
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  const review = await readJson(join(root, 'reviews', `${artifact.lockedByReviewId}.json`));
  assert.equal(review.actor, 'system');
  assert.equal(review.autoLocked, true);
});

test('requires explicit supersession for a second master of the same character', async (t) => {
  const { root, source } = await project(t);
  const first = await registerRealismAuthority(root, { payload: payload(source) });
  await assert.rejects(() => registerRealismAuthority(root, { payload: payload(source, 'acting-a-v2') }), /supersedesArtifactId/);
  const second = await registerRealismAuthority(root, { payload: payload(source, 'acting-a-v2'), supersedesArtifactId: first.id });
  assert.equal(second.revision, 2);
  assert.equal(second.supersedesArtifactId, first.id);
});

test('rejects stale authority source bindings before writing', async (t) => {
  const { root, source } = await project(t);
  const stale = payload(source);
  stale.sourceBindings[0].sha256 = 'f'.repeat(64);
  await assert.rejects(() => registerRealismAuthority(root, { payload: stale }), /stale or unlocked/);
});

test('Master Profile cannot bypass the human-approved Gate 2 Story Plan', async t => {
  const { root, source } = await project(t);
  const state = await readJson(join(root, 'project-state.json'));
  state.artifacts.find(artifact => artifact.id === source.id).type = 'script';
  await writeJsonAtomic(join(root, 'project-state.json'), state);
  await assert.rejects(() => registerRealismAuthority(root, { payload: payload(source) }), /Gate 2 Story Plan/);
});
