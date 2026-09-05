import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { auditHarnessSurface } from '../../src/services/harness-surface-audit-service.js';
import { runAuditHarness } from '../../src/commands/audit-harness.js';

async function put(root, path, contents) {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, contents);
}

async function snapshot(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result[relative(root, path)] = await readFile(path, 'utf8');
    }
  }
  await visit(root);
  return result;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-audit-'));
  await put(root, 'AGENTS.md', 'foo uses knowledge/capabilities/used.md');
  await put(root, 'docs/operator-runbook.md', 'operator command: foo');
  await put(root, 'src/cli.js', [
    "import { runFoo } from './commands/foo.js';",
    "const commands = new Map([['foo', runFoo]]);"
  ].join('\n'));
  await put(root, 'src/commands/foo.js', "import './helper.js'; export async function runFoo() {}");
  await put(root, 'src/commands/helper.js', 'export const helper = true;');
  await put(root, 'src/commands/dead.js', 'export const dead = true;');
  await put(root, 'src/services/one.js', "const SAFE_ID = /^[a-z]+$/; export { SAFE_ID };");
  await put(root, 'src/services/two.js', "const SAFE_ID = /^[a-z]+$/; export { SAFE_ID };");
  await put(root, 'knowledge/capabilities/used.md', 'Loads shared.json when routed.');
  await put(root, 'knowledge/capabilities/shared.json', '{}');
  await put(root, 'knowledge/capabilities/orphan.md', 'not routed');
  const projectState = {
    projectId: 'AUDIT-DEMO',
    artifacts: [
      { id: 'video-1', type: 'video_segment', status: 'locked', segmentId: 'segment-001', sha256: 'a'.repeat(64) },
      { id: 'video-alias', type: 'video_alias', status: 'locked', sha256: 'a'.repeat(64) }
    ]
  };
  await put(root, 'projects/demo/project-state.json', JSON.stringify(projectState));
  await put(root, 'projects/demo/rules/rule-unused.json', JSON.stringify({
    id: 'rule-unused', status: 'candidate',
    trigger: {
      product: ['underwear'], assetType: ['storyboard'], shotType: ['medium'],
      motionType: ['dialogue'], spaceComplexity: ['simple'], peopleCountRange: { min: 1, max: 2 }
    },
    symptom: 'stiff gaze', evidence: ['review-1'], reason: 'missing eyeline',
    correction: 'bind gaze target', forbidden: ['blank stare'],
    sourceProject: 'AUDIT-DEMO', sourceSegment: 'segment-001', applications: [],
    verificationReviewId: null, revision: 1,
    createdAt: '2026-07-31T00:00:00Z', updatedAt: '2026-07-31T00:00:00Z'
  }));
  return root;
}

test('surface audit reports evidence without changing repository or project files', async () => {
  const root = await fixture();
  const before = await snapshot(root);
  const result = await auditHarnessSurface(root, {
    projectRoot: join(root, 'projects/demo'),
    now: () => '2026-07-31T01:00:00.000Z'
  });
  assert.equal(result.readOnly, true);
  assert.equal(result.generatedAt, '2026-07-31T01:00:00.000Z');
  assert.deepEqual(result.commandSurface.registeredCommands, ['foo']);
  assert.deepEqual(result.commandSurface.unreferencedCommandModules, ['src/commands/dead.js']);
  assert.deepEqual(result.commandSurface.undocumentedCommands, []);
  assert.deepEqual(result.capabilitySurface.unreferencedCapabilities, ['knowledge/capabilities/orphan.md']);
  assert.equal(result.projectSurface.neverAppliedCandidateCount, 1);
  assert.equal(result.projectSurface.missingSegmentSummaryCount, 1);
  assert.equal(result.projectSurface.duplicateArtifactShaCount, 1);
  assert.equal(result.findings.find(item => item.id === 'never_applied_candidate_rules').evidence[0], 'rule-unused');
  assert.equal(result.findings.find(item => item.id === 'missing_completed_segment_summaries').evidence[0], 'segment-001');
  assert.equal(result.codeSurface.duplicateDefinitions.some(item => item.id === 'safe_id_constants'), true);
  assert.equal(result.findings.every(item => item.automaticAction === 'none'), true);
  assert.deepEqual(await snapshot(root), before);
});

test('audit command accepts an in-repository project and rejects paths outside the repository', async () => {
  const root = await fixture();
  const result = await runAuditHarness(['--project', 'projects/demo'], {
    repoRoot: root,
    cwd: root,
    now: () => '2026-07-31T01:00:00.000Z'
  });
  assert.equal(result.projectSurface.projectId, 'AUDIT-DEMO');
  const outside = await mkdtemp(join(tmpdir(), 'outside-audit-project-'));
  await put(outside, 'project-state.json', JSON.stringify({ projectId: 'OUTSIDE', artifacts: [] }));
  await assert.rejects(
    runAuditHarness(['--project', outside], { repoRoot: root, cwd: root }),
    /must stay inside the harness repository/
  );
});

test('surface audit schema fixes the read-only contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/harness-surface-audit.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.readOnly.const, true);
  assert.equal(schema.properties.kind.const, 'harness_surface_audit');
  assert.equal(schema.properties.findings.items.properties.automaticAction.const, 'none');
  assert.equal(schema.additionalProperties, false);
});
