import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { previewChangeImpact } from './change-impact-preview-service.js';

const directory = root => join(root, 'reviews', 'change-requests');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requestError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export async function loadChangeImpactPreview(root, request = {}) {
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const current = resolveCurrentArtifacts(state.artifacts).current;
  const segmentation = current.find(item => item.type === 'segmentation' && item.status === 'locked');
  let segments = [];
  if (segmentation) {
    const inspected = await inspectArtifactFile(root, segmentation.path);
    if (segmentation.sha256 && segmentation.sha256.toLowerCase() !== inspected.sha256) throw new Error('segmentation checksum changed');
    const payload = await readJson(inspected.path);
    if (!Array.isArray(payload.segments)) throw new Error('current segmentation has no segments array');
    segments = payload.segments;
  }
  return previewChangeImpact(state, request, { segments });
}

/** Persist an inbox item only; an AI consumer must analyze and explicitly apply it.
 * Unknown impacts remain unknown. Existing execution and approvals are untouched.
 */
export async function recordChangeRequest(root, input = {}) {
  if (input.confirm !== true) throw requestError(400, '请明确确认保存修改要求。');
  if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 12000) {
    throw new TypeError('description must contain 1 to 12000 characters');
  }
  if (!/^[a-f0-9]{64}$/.test(input.snapshotSha256 ?? '')) throw new TypeError('snapshotSha256 is required');
  for (const field of ['segmentIds', 'artifactIds']) {
    if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].some(id => typeof id !== 'string' || !id.trim()))) {
      throw new TypeError(`${field} must be an array of non-empty strings`);
    }
  }
  const projectRoot = resolve(root);
  return withProjectLock(projectRoot, async () => {
    const request = { scope: input.scope ?? 'unknown', description: input.description.trim(),
      segmentIds: [...new Set(input.segmentIds ?? [])].sort(), artifactIds: [...new Set(input.artifactIds ?? [])].sort() };
    const preview = await loadChangeImpactPreview(projectRoot, request);
    if (preview.snapshotSha256 !== input.snapshotSha256) throw requestError(409, '项目已更新，影响预览已过期；请重新查看影响后保存。');
    const id = `change-${hash({ projectId: preview.projectId, request, snapshotSha256: preview.snapshotSha256 })}`;
    const path = join(directory(projectRoot), `${id}.json`);
    const existing = await readJson(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) return { request: existing, reused: true };
    const record = {
      schemaVersion: 1, kind: 'change_request', id, projectId: preview.projectId,
      status: 'awaiting_analysis', createdAt: new Date().toISOString(), request, preview,
      execution: { applied: false, tasksPaused: false, approvalsInvalidated: false, paidSubmissionAllowed: false },
      notice: '修改要求已保存，等待分析；尚未改变制作方向或停止任务。未知影响需要核实，新付费生成仍须单独确认。'
    };
    await writeJsonAtomic(path, record);
    return { request: await readJson(path), reused: false };
  });
}

export async function listChangeRequests(root) {
  const names = await readdir(directory(root)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const state = assertProjectState(await readJson(join(root, 'project-state.json')));
  const records = [];
  for (const name of names.filter(name => /^change-[a-f0-9]{64}\.json$/.test(name))) {
    const record = await readJson(join(directory(root), name));
    if (record.kind !== 'change_request' || record.projectId !== state.projectId || `${record.id}.json` !== name) {
      throw new Error('invalid change request project binding');
    }
    records.push(record);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
