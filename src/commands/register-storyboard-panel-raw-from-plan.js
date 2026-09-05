import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { registerStoryboardPanel } from '../services/storyboard-panel-registration-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runRegisterStoryboardPanelRawFromPlan(args) {
  const root = resolve(option(args, 'project'));
  const planRel = option(args, 'plan');
  const requestId = option(args, 'request');
  const candidate = option(args, 'candidate');
  if (outside(root, resolve(root, planRel)) || outside(root, resolve(root, candidate))) {
    throw new Error('raw registration plan and candidate must stay inside project root');
  }
  const inspected = await inspectArtifactFile(root, planRel);
  const plan = await readJson(inspected.path);
  const request = plan.requests?.find(item => item.id === requestId);
  if (!request || request.profileId !== 'storyboard_execution_panel_v1' || request.status !== 'PREPARED'
    || request.lint?.decision !== 'PASS' || !request.storyboardPanel) {
    throw new Error('raw registration must reference one exact lint-passing atomic storyboard request');
  }
  return registerStoryboardPanel(root, {
    id: `registration-${request.storyboardPanel.rawCandidateAssetId}`,
    kind: 'storyboard_panel_registration',
    projectId: plan.projectId,
    stage: 'raw_candidate',
    visualAuditId: request.storyboardPanel.rawCandidateVisualAuditId,
    promptPlanPath: planRel,
    promptPlanSha256: inspected.sha256,
    requestId,
    requestFingerprint: request.requestFingerprint,
    candidatePath: candidate
  });
}
