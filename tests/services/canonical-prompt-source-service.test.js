import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { approveArtifact, submitForReview } from '../../src/services/review-service.js';
import {
  authorCanonicalPromptSource,
  verifyCanonicalPromptSourceForCompilation
} from '../../src/services/canonical-prompt-source-service.js';
import { readJson } from '../../src/storage/json-store.js';

async function lockedArtifact(root, descriptor, body) {
  await writeFile(join(root, descriptor.path), body);
  await registerArtifact(root, { ...descriptor, revision: 1, status: 'draft' });
  await submitForReview(root, descriptor.id);
  await approveArtifact(root, descriptor.id, `approve ${descriptor.id}`);
  const state = await readJson(join(root, 'project-state.json'));
  return state.artifacts.find(item => item.id === descriptor.id);
}

test('authors an immutable canonical Skill provenance artifact and verifies exact source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-prompt-source-'));
  await initializeProject(root, {
    projectId: 'CANONICAL-SOURCE-1', workflowVersion: 2,
    realismContractsVersion: 2, realismContractsWriteMode: 'enabled'
  });
  await mkdir(join(root, 'prompts', 'segment-001'), { recursive: true });
  await mkdir(join(root, 'segments'), { recursive: true });
  const narration = await lockedArtifact(root, {
    id: 'director-ir-segment-001', type: 'script', segmentId: 'segment-001',
    path: 'segments/director-ir-segment-001.json'
  }, '{"kind":"director_ir_fixture","observable":"她听见门响后才抬眼"}\n');
  const authored = await authorCanonicalPromptSource(root, {
    segmentId: 'segment-001',
    sourceBody: '她听见门响后才抬眼，目光先到，头部晚半拍跟上。\n',
    inputIrArtifactIds: [narration.id],
    lockedAssetArtifactIds: [],
    loadedReferencePaths: ['SKILL.md'],
    authorExecution: {
      taskId: 'codex-task-canonical-source-1',
      outputId: 'assistant-output-canonical-source-1',
      completedAt: '2026-09-04T00:00:00.000Z'
    }
  });
  assert.equal(authored.artifact.type, 'canonical_prompt_source');
  assert.equal(authored.artifact.status, 'locked');
  assert.equal(authored.promptArtifact.type, 'seedance_prompt');
  assert.equal(authored.promptArtifact.status, 'locked');
  assert.equal(authored.promptArtifact.canonicalAuthorEventId, authored.source.authorEvent.id);
  assert.equal(authored.source.authorEvent.route, 'canonical_skill_author_service');
  assert.equal(authored.source.authorEvent.proofLevel, 'system_route_and_byte_integrity');
  assert.equal(authored.source.sourceBodyOrigin, 'caller_supplied_unverified');
  assert.equal(authored.source.sourceBody, '她听见门响后才抬眼，目光先到，头部晚半拍跟上。\n');
  assert.equal(authored.source.loadedReferences[0].path, 'SKILL.md');

  const state = await readJson(join(root, 'project-state.json'));
  const verified = await verifyCanonicalPromptSourceForCompilation(root, state, authored.promptArtifact);
  assert.equal(verified.artifact.id, authored.artifact.id);
  const persisted = JSON.parse(await readFile(join(root, authored.artifact.path), 'utf8'));
  assert.equal(persisted.sourceBodySha256, authored.source.sourceBodySha256);

  const repeated = await authorCanonicalPromptSource(root, {
    segmentId: 'segment-001',
    sourceBody: '她听见门响后才抬眼，目光先到，头部晚半拍跟上。\n',
    inputIrArtifactIds: [narration.id],
    lockedAssetArtifactIds: [],
    loadedReferencePaths: ['SKILL.md'],
    authorExecution: {
      taskId: 'codex-task-canonical-source-1',
      outputId: 'assistant-output-canonical-source-1',
      completedAt: '2026-09-04T00:00:00.000Z'
    }
  });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.promptArtifact.id, authored.promptArtifact.id);
});

test('rejects direct artifact wrapping without overstating caller-supplied body authorship', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-prompt-posthoc-'));
  await initializeProject(root, {
    projectId: 'CANONICAL-POSTHOC-1', workflowVersion: 2,
    realismContractsVersion: 2, realismContractsWriteMode: 'enabled'
  });
  await mkdir(join(root, 'prompts', 'segment-001'), { recursive: true });
  const prompt = await lockedArtifact(root, {
    id: 'arbitrary-prompt-v1', type: 'seedance_prompt', segmentId: 'segment-001',
    path: 'prompts/segment-001/arbitrary.txt'
  }, '这是一条没有 canonical author route 证据的旧提示词。\n');
  await assert.rejects(authorCanonicalPromptSource(root, {
    segmentId: 'segment-001',
    sourcePromptArtifactId: prompt.id
  }), /direct wrapping/);
});

test('refuses canonical source writes on legacy or read-only profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-prompt-source-legacy-'));
  await initializeProject(root, { projectId: 'CANONICAL-LEGACY-1', workflowVersion: 2 });
  await assert.rejects(authorCanonicalPromptSource(root, {}), /realismContractsVersion 2/);
});
