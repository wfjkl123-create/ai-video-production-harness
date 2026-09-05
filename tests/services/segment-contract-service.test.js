import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';
import { persistSegmentation } from '../../src/services/segmentation-workflow-service.js';
import { createSegmentContract } from '../../src/services/segment-contract-service.js';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import { registerRealismAuthority } from '../../src/services/realism-authority-service.js';

async function lockedProject({ rubricPayloadId = 'rubric-v1' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'segment-contract-'));
  await initializeProject(root, { projectId: 'CONTRACT-1' });
  await mkdir(join(root, 'assets', 'project'), { recursive: true });
  await writeFile(join(root, 'assets', 'project', 'character.png'), 'character');
  await writeFile(join(root, 'brief', 'rubric.json'), `${JSON.stringify({
    id: rubricPayloadId, version: 1, threshold: 80,
    dimensions: [{ id: 'quality', label: '整体质量', weight: 100, minimum: 80, critical: true }], vetoes: []
  })}\n`);
  for (const descriptor of [
    { id: 'character-1', type: 'project_asset', assetType: 'character_board', characterId: 'character-a', visualContractVersion: 1, visualAuditId: 'visual-audit-character-1', path: 'assets/project/character.png' },
    { id: 'rubric-v1', type: 'quality_rubric', path: 'brief/rubric.json' }
  ]) {
    await registerArtifact(root, { ...descriptor, revision: 1, status: 'draft' });
    await submitForReview(root, descriptor.id);
    await approveArtifact(root, descriptor.id, `approve ${descriptor.id}`);
  }
  const segment = {
    id: 'segment-001', duration: 12, narrativeTask: '展示收腹裤塑形效果',
    startState: '主角站在镜前', actionNodes: ['展示腰腹'], endState: '主角正面定格',
    projectAssetIds: ['character-1'], segmentAssetRequirements: ['initial_blocking', 'camera_blocking'],
    previousSegmentId: null, nextSegmentId: null, status: 'locked', lockedByReviewId: 'review-segmentation'
  };
  const segmentation = await persistSegmentation(root, {
    id: 'segmentation-v1', path: 'segments/segmentation-v1.json', segments: [{ ...segment, status: 'awaiting_review', lockedByReviewId: undefined }]
  });
  await submitForReview(root, segmentation.id);
  await approveArtifact(root, segmentation.id, 'approve canonical segment');
  return root;
}

test('creates an awaiting-review contract bound to locked inputs and the rubric version', async () => {
  const root = await lockedProject();
  const artifact = await createSegmentContract(root, {
    id: 'contract-segment-001-v1', segmentId: 'segment-001', revision: 1, rubricId: 'rubric-v1',
    immutableConstraints: ['人物身份不得改变', '产品结构不得改变'],
    assetResponsibilities: { 'character-1': '只负责人物身份与外观' },
    allowedStrategies: ['refine', 'pivot', 'escalate'],
    attemptPolicy: { automaticPaidRetries: false, maxPaidAttempts: null, maxAssetAttempts: null },
    completionEvidence: ['人工质量审核', 'RunningHub SUCCESS 运行证据']
  });
  assert.equal(artifact.type, 'segment_contract');
  assert.equal(artifact.status, 'awaiting_review');
  const contract = JSON.parse(await readFile(join(root, artifact.path), 'utf8'));
  assert.equal(contract.narrativeTask, '展示收腹裤塑形效果');
  assert.equal(contract.expectedStartState, '主角站在镜前');
  assert.equal(contract.expectedEndState, '主角正面定格');
  assert.equal(contract.segmentation.id, 'segmentation-v1');
  assert.equal(contract.segmentation.revision, 1);
  assert.match(contract.segmentation.sha256, /^[a-f0-9]{64}$/);
  assert.equal(contract.rubric.version, 1);
  assert.ok(contract.lockedInputs.every(input => /^[a-f0-9]{64}$/.test(input.sha256)));
  assert.equal(contract.requiredBindings.version, 1);
  assert.equal(contract.requiredBindings.entries.find(item => item.bindingType === 'replacement_asset')?.artifactId, 'character-1');
  assert.equal(contract.requiredBindings.entries.find(item => item.bindingType === 'character_acting_master_v1')?.applicability, 'not_applicable');
  assert.equal(contract.attemptPolicy.automaticPaidRetries, false);
});

test('refuses unlocked inputs, unknown strategies, and automatic paid retries', async () => {
  const root = await lockedProject();
  const base = {
    id: 'contract-segment-001-v1', segmentId: 'segment-001', revision: 1, rubricId: 'rubric-v1',
    immutableConstraints: ['保持一致'], assetResponsibilities: { 'character-1': '身份' },
    allowedStrategies: ['refine'], attemptPolicy: { automaticPaidRetries: false, maxPaidAttempts: null, maxAssetAttempts: null },
    completionEvidence: ['人工审核']
  };
  await assert.rejects(createSegmentContract(root, { ...base, allowedStrategies: ['retry_forever'] }), /strategy/);
  await assert.rejects(createSegmentContract(root, { ...base, attemptPolicy: { ...base.attemptPolicy, automaticPaidRetries: true } }), /automatic paid retries/);
  const statePath = join(root, 'project-state.json');
  const state = await readJson(statePath);
  state.artifacts.find(({ id }) => id === 'character-1').status = 'rework';
  delete state.artifacts.find(({ id }) => id === 'character-1').lockedByReviewId;
  await writeJsonAtomic(statePath, state);
  await assert.rejects(createSegmentContract(root, base), /locked input/);
});

test('duplicate creation cannot overwrite an existing contract file', async () => {
  const root = await lockedProject();
  const input = {
    id: 'contract-segment-001-v1', segmentId: 'segment-001', revision: 1, rubricId: 'rubric-v1',
    immutableConstraints: ['保持人物身份'], assetResponsibilities: { 'character-1': '身份' },
    allowedStrategies: ['refine'], attemptPolicy: { automaticPaidRetries: false, maxPaidAttempts: null, maxAssetAttempts: null },
    completionEvidence: ['人工审核']
  };
  const artifact = await createSegmentContract(root, input);
  const before = await sha256File(join(root, artifact.path));
  await assert.rejects(createSegmentContract(root, { ...input, immutableConstraints: ['恶意覆盖'] }), /already exists/);
  assert.equal(await sha256File(join(root, artifact.path)), before);
});

test('normalizes a relative project root before committing the contract transaction', async () => {
  const root = await lockedProject();
  const relativeRoot = relative(process.cwd(), root);
  const artifact = await createSegmentContract(relativeRoot, {
    id: 'contract-segment-001-relative-root', segmentId: 'segment-001', revision: 1, rubricId: 'rubric-v1',
    immutableConstraints: ['保持人物身份'], assetResponsibilities: { 'character-1': '身份' },
    allowedStrategies: ['refine'], attemptPolicy: { automaticPaidRetries: false, maxPaidAttempts: null, maxAssetAttempts: null },
    completionEvidence: ['人工审核']
  });
  const contract = JSON.parse(await readFile(join(root, artifact.path), 'utf8'));
  assert.equal(contract.id, artifact.id);
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(({ id }) => id === artifact.id)?.path, artifact.path);
});

test('rejects a quality rubric whose payload id does not match its artifact id', async () => {
  const root = await lockedProject({ rubricPayloadId: 'different-rubric-id' });
  await assert.rejects(createSegmentContract(root, {
    id: 'contract-segment-001-v1', segmentId: 'segment-001', revision: 1, rubricId: 'rubric-v1',
    immutableConstraints: ['保持人物身份'], assetResponsibilities: { 'character-1': '身份' },
    allowedStrategies: ['refine'], attemptPolicy: { automaticPaidRetries: false, maxPaidAttempts: null, maxAssetAttempts: null },
    completionEvidence: ['人工审核']
  }), /payload id different-rubric-id must match artifact id rubric-v1/);
});

test('publishes the segment contract schema', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/segment-contract.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.required.includes('lockedInputs'));
  assert.ok(schema.required.includes('segmentation'));
  assert.ok(schema.required.includes('attemptPolicy'));
  assert.ok(schema.required.includes('requiredBindings'));
  assert.equal(schema.properties.requiredBindings.$ref, 'required-bindings.schema.json');
  assert.equal(schema.properties.attemptPolicy.properties.automaticPaidRetries.const, false);
});

test('realism v2 derives reusable characters from the locked Story Plan and refuses to mark Master Profile not applicable', async () => {
  const root = await lockedProject();
  const storyPayload = {
    id: 'story-plan-v2', projectId: 'CONTRACT-1',
    creativeDecision: { referenceWorkflow: { referenceIntent: 'idea_only', sourceVideoIds: [] } },
    characters: [{ characterId: 'character-a' }],
    shotPlanning: { mode: 'shotlist', shots: [
      { shotId: 'S01', segmentId: 'segment-001', characterIds: ['character-a'], visibleSpeakerIds: [] },
      { shotId: 'S02', segmentId: 'segment-001', characterIds: ['character-a'], visibleSpeakerIds: [] }
    ] }
  };
  await writeJsonAtomic(join(root, 'story', 'story-plan-v2.json'), storyPayload);
  const statePath = join(root, 'project-state.json');
  const state = await readJson(statePath);
  const storySha = await sha256File(join(root, 'story', 'story-plan-v2.json'));
  state.artifacts.push({
    id: storyPayload.id, type: 'story_plan', revision: 1, status: 'locked', path: 'story/story-plan-v2.json',
    sha256: storySha, lockedByReviewId: 'review-story-plan-v2'
  });
  await writeJsonAtomic(join(root, 'reviews', 'review-story-plan-v2.json'), {
    id: 'review-story-plan-v2', artifactId: storyPayload.id, actor: 'human', decision: 'approved', artifactSha256: storySha
  });
  state.realismContractsVersion = 2;
  state.realismContractsWriteMode = 'enabled';
  await writeJsonAtomic(statePath, state);
  const base = {
    id: 'contract-realism-v2', segmentId: 'segment-001', revision: 1, rubricId: 'rubric-v1',
    immutableConstraints: ['保持人物身份'], assetResponsibilities: { 'character-1': '身份' },
    allowedStrategies: ['refine'], attemptPolicy: { automaticPaidRetries: false, maxPaidAttempts: null, maxAssetAttempts: null },
    completionEvidence: ['人工审核'],
    audioExecutionPlan: {
      kind: 'audio_execution_plan_v1', version: 1, strategy: 'silent_visual_test', generateAudio: false, enableSound: false,
      syncAuthority: 'visual_only', promptPolicy: { allowedAudibleFacts: [], prohibitedClaims: ['dialogue'] },
      remux: { required: false, mode: 'none', verifyElementaryStreamSha: false },
      capabilitySnapshot: { id: 'capability-v1', surface: 'test', model: 'test', operation: 'test', expiresAt: '2099-01-01T00:00:00Z' },
      rationale: 'deterministic silent fixture'
    }
  };
  await assert.rejects(createSegmentContract(root, base), /Master Profile.*character-a/);
  const refreshed = await readJson(statePath);
  const story = refreshed.artifacts.find(artifact => artifact.id === storyPayload.id);
  await registerRealismAuthority(root, { payload: {
    kind: 'character_acting_master_v1', version: 1, id: 'master-character-a', projectId: 'CONTRACT-1', characterId: 'character-a',
    sourceBindings: [{ id: story.id, revision: story.revision, sha256: story.sha256 }],
    physicalBiography: { ageAndPhysiology: 'adult', baselineEnergy: 'grounded', posture: 'slight forward set', gait: 'short grounded steps', breath: 'quiet nasal baseline', gazeBaseline: 'task oriented', handBehavior: 'hands remain near the active object' },
    psychologicalEngine: { want: 'finish the task', fear: 'public failure', protectiveMask: 'competence', fracturePattern: 'gaze drops after criticism', recoveryPattern: 'resets breath and resumes the task' },
    triggeredHabits: [{ cueId: 'criticism', cue: 'after direct criticism', observableResponse: 'breath pauses and gaze drops to the object', doNotUseAsClock: true }],
    continuityLocks: ['grounded posture'], sceneAdaptationPolicy: 'select only cues caused by the current beat',
    responsibility: 'long-term behavior identity that remains stable across scenes', mustNotControl: ['lighting']
  } });
  const artifact = await createSegmentContract(root, base);
  const contract = await readJson(join(root, artifact.path));
  assert.equal(contract.requiredBindings.entries.find(entry => entry.bindingType === 'character_acting_master_v1')?.scopeKey, 'segment-001:character-a');
});
