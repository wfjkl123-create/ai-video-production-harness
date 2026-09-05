import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../../src/services/project-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { repairLegacyCrossScopeSupersession } from '../../src/services/artifact-lineage-repair-service.js';
import { resolveCurrentArtifacts } from '../../src/domain/current-artifact.js';
import { readJson } from '../../src/storage/json-store.js';

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('repairs only a locked one-to-one legacy cross-scope supersession without deleting either artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lineage-repair-'));
  await initializeProject(root, { projectId: 'LINEAGE-1', workflowVersion: 2 });
  await writeJson(join(root, 'prompts', 'narration-v1.json'), { id: 'narration-v1', segmentId: 'A1' });
  await writeJson(join(root, 'prompts', 'narration-v2.json'), { id: 'narration-v2', segmentId: 'segment-001' });
  await writeJson(join(root, 'planning', 'alias.json'), {
    schemaVersion: 1,
    id: 'alias-a1',
    kind: 'segment_id_alias',
    projectId: 'LINEAGE-1',
    storyPlanSegmentId: 'A1',
    canonicalSegmentId: 'segment-001',
    oneToOne: true
  });
  await registerArtifact(root, { id: 'narration-v1', type: 'shot_narration', segmentId: 'A1', revision: 1, status: 'draft', path: 'prompts/narration-v1.json' });
  await registerArtifact(root, { id: 'narration-v2', type: 'shot_narration', segmentId: 'segment-001', revision: 2, status: 'draft', path: 'prompts/narration-v2.json', supersedesArtifactId: 'narration-v1' });

  const before = await readJson(join(root, 'project-state.json'));
  assert.throws(() => resolveCurrentArtifacts(before.artifacts), /cannot supersede a different scope/);
  const result = await repairLegacyCrossScopeSupersession(root, {
    artifactId: 'narration-v2', priorArtifactId: 'narration-v1', segmentAliasPath: 'planning/alias.json', note: 'repair fixture'
  });
  const after = await readJson(join(root, 'project-state.json'));
  assert.equal(after.artifacts.length, 2);
  assert.equal(after.artifacts.find(item => item.id === 'narration-v2').supersedesArtifactId, undefined);
  assert.doesNotThrow(() => resolveCurrentArtifacts(after.artifacts));
  const evidence = await readJson(join(root, result.evidencePath));
  assert.equal(evidence.removedSupersession.originalSupersedesArtifactId, 'narration-v1');
  assert.equal(evidence.segmentAlias.canonicalSegmentId, 'segment-001');
});

test('refuses a repair when the supplied alias does not prove the exact scope mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lineage-repair-mismatch-'));
  await initializeProject(root, { projectId: 'LINEAGE-2', workflowVersion: 2 });
  await writeJson(join(root, 'prompts', 'narration-v1.json'), { id: 'narration-v1' });
  await writeJson(join(root, 'prompts', 'narration-v2.json'), { id: 'narration-v2' });
  await writeJson(join(root, 'planning', 'alias.json'), {
    schemaVersion: 1, id: 'wrong-alias', kind: 'segment_id_alias', projectId: 'LINEAGE-2',
    storyPlanSegmentId: 'wrong', canonicalSegmentId: 'segment-001', oneToOne: true
  });
  await registerArtifact(root, { id: 'narration-v1', type: 'shot_narration', segmentId: 'A1', revision: 1, status: 'draft', path: 'prompts/narration-v1.json' });
  await registerArtifact(root, { id: 'narration-v2', type: 'shot_narration', segmentId: 'segment-001', revision: 2, status: 'draft', path: 'prompts/narration-v2.json', supersedesArtifactId: 'narration-v1' });
  await assert.rejects(
    repairLegacyCrossScopeSupersession(root, { artifactId: 'narration-v2', priorArtifactId: 'narration-v1', segmentAliasPath: 'planning/alias.json', note: 'repair fixture' }),
    /does not prove/
  );
  const state = await readJson(join(root, 'project-state.json'));
  assert.equal(state.artifacts.find(item => item.id === 'narration-v2').supersedesArtifactId, 'narration-v1');
});
