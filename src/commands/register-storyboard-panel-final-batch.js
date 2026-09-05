import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { option } from './args.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { registerStoryboardPanel } from '../services/storyboard-panel-registration-service.js';

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

export async function runRegisterStoryboardPanelFinalBatch(args) {
  const root = resolve(option(args, 'project'));
  const plansDir = option(args, 'plans-dir');
  if (outside(root, resolve(root, plansDir))) throw new Error('final registration plans directory must stay inside project root');
  const entries = (await readdir(resolve(root, plansDir)))
    .filter(name => name.endsWith('.normalization-plan.json'))
    .sort();
  if (entries.length !== 11) throw new Error('final registration batch requires exactly eleven normalization plans');
  const registered = [];
  for (const name of entries) {
    const rel = `${plansDir}/${name}`;
    const inspected = await inspectArtifactFile(root, rel);
    const plan = await readJson(inspected.path);
    registered.push(await registerStoryboardPanel(root, {
      id: `registration-${plan.output.assetId}`,
      kind: 'storyboard_panel_registration',
      projectId: plan.projectId,
      stage: 'final_normalized',
      visualAuditId: plan.source.expectedFinalVisualAuditId,
      normalizationPlanPath: rel,
      normalizationPlanSha256: inspected.sha256
    }));
  }
  return { registeredCount: registered.length, assetIds: registered.map(item => item.id) };
}
