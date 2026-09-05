import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertIndependentCreativeAudit } from '../domain/independent-creative-audit.js';
import { workflowProfileIdOf } from '../domain/workflow-profile.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';

function latestArtifact(state, type, segmentId) {
  return (state.artifacts ?? [])
    .filter(artifact => artifact.type === type && artifact.segmentId === segmentId)
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id))[0] ?? null;
}

// 简单复刻把中间独立审查合并为系统机审。此处仍核验讲戏本、提示词及其审核绑定，
// 不能只因前端选择了轻量路线就放宽到任意未审核的生成包。
export async function requireSimpleRemakeSystemReview(root, segmentId, sourcePromptPath) {
  const state = await readJson(join(root, 'project-state.json'));
  if (workflowProfileIdOf(state) !== 'simple_remake') {
    throw new Error('machine-reviewed generation is limited to the simple-remake workflow');
  }
  const narration = latestArtifact(state, 'shot_narration', segmentId);
  const prompt = latestArtifact(state, 'seedance_prompt', segmentId);
  if (!narration || !prompt) throw new Error(`simple remake ${segmentId} requires locked narration and prompt evidence`);
  if (prompt.path !== sourcePromptPath) throw new Error('simple remake source prompt does not match the compiled package');
  if (prompt.narrationSourceId !== narration.id || prompt.narrationSha256 !== narration.sha256) {
    throw new Error('simple remake prompt is not bound to the latest locked narration');
  }
  if (prompt.promptSelfAudit?.arrangement !== 'PASS' || prompt.promptSelfAudit?.semantics !== 'PASS') {
    throw new Error('simple remake prompt self-check has not passed');
  }
  const [narrationFile, promptFile] = await Promise.all([
    verifyLockedArtifact(root, narration),
    verifyLockedArtifact(root, prompt)
  ]);
  return {
    mode: 'simple_remake_system_review',
    workflowProfileId: 'simple_remake',
    narrationId: narration.id,
    narrationSha256: narrationFile.sha256,
    promptId: prompt.id,
    promptSha256: promptFile.sha256
  };
}

export async function requireIndependentCreativeAudit(root, segmentId, fingerprint) {
  const state = await readJson(join(root, 'project-state.json'));
  const candidates = (state.artifacts ?? [])
    .filter(artifact => artifact.type === 'independent_creative_audit' && artifact.segmentId === segmentId)
    .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id));
  const artifact = candidates[0];
  if (!artifact) throw new Error(`independent creative audit is required for ${segmentId}`);
  if (artifact.status !== 'locked') throw new Error(`latest independent creative audit ${artifact.id} must be locked PASS evidence`);
  const inspected = await verifyLockedArtifact(root, artifact);
  const audit = assertIndependentCreativeAudit(await readJson(join(root, artifact.path)));
  if (audit.id !== artifact.id || audit.segmentId !== segmentId || audit.revision !== artifact.revision) {
    throw new Error('independent creative audit identity does not match its artifact');
  }
  if (audit.decision !== 'PASS') throw new Error(`independent creative audit ${audit.id} did not PASS`);
  if (audit.promptSha256 !== fingerprint.promptSha256 || audit.packageSha256 !== fingerprint.packageSha256) {
    throw new Error(`independent creative audit ${audit.id} is stale for the current prompt or package`);
  }
  if (!isDeepStrictEqual(audit.inputMedia, fingerprint.inputMedia)) throw new Error(`independent creative audit ${audit.id} is stale for the current media inputs`);
  const report = await inspectArtifactFile(root, audit.reportPath);
  if (report.sha256 !== audit.reportSha256) throw new Error(`independent creative audit report checksum changed for ${audit.id}`);
  return {
    id: artifact.id,
    artifactSha256: inspected.sha256,
    reportPath: audit.reportPath,
    reportSha256: report.sha256,
    agentContextMode: audit.agentContextMode,
    agentTaskId: audit.agentTaskId,
    reviewedAt: audit.reviewedAt
  };
}
