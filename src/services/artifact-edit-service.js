import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { verifyArtifactFile } from './artifact-file-service.js';
import { assertCreativeBrief } from '../domain/creative-brief.js';
import { createCreativeBrief } from './creative-brief-service.js';
import { createStoryPlan } from './story-plan-service.js';
import { assertStoryPlan } from '../domain/story-plan.js';

function editError(message, statusCode = 409) { return Object.assign(new Error(message), { statusCode }); }

const labels = {
  'creativeDecision.storyDirection': '整体方向',
  'creativeDecision.successDefinition': '什么样的结果算做好',
  'creativeDecision.directorCreativeContract.projectIntent.purpose': '制作目的',
  'creativeDecision.directorCreativeContract.projectIntent.audience': '给谁看',
  'creativeDecision.directorCreativeContract.recommendedDirection.coreMeaning': '想表达什么',
  'creativeDecision.directorCreativeContract.recommendedDirection.centralConflict': '主要矛盾',
  'creativeDecision.directorCreativeContract.recommendedDirection.coreTurn': '关键转折',
  'creativeDecision.directorCreativeContract.recommendedDirection.endingPayoff': '结尾',
};
const storyLabels = { logline: '一句话概括', storyPromise: '开头给观众的期待', finalOutcome: '最终结果', tone: '整体感觉', initialCondition: '开始的情况', objective: '人物要做什么', centralConflict: '主要矛盾', turn: '关键转折', climax: '高潮', progression: '推进过程' };
const shotLabels = { purpose: '这段要表达什么', subjectAction: '人物动作', shotContract: '画面与镜头', blocking: '人物位置与移动', startState: '开始画面', endState: '结束画面', audio: '台词与声音' };
const get = (value, path) => path.split('.').reduce((result, key) => result?.[key], value);
function set(value, path, text) { const keys = path.split('.'); const key = keys.pop(); get(value, keys.join('.'))[key] = text; }
function fieldsFor(type, document) {
  const entries = type === 'creative_brief' ? Object.entries(labels) : Object.entries(storyLabels).map(([key, label]) => [`story.${key}`, label]);
  if (type === 'story_plan') (document.shotPlanning?.shots ?? []).forEach((shot, index) => {
    for (const [key, label] of Object.entries(shotLabels)) entries.push([`shotPlanning.shots.${index}.${key}`, `第 ${index + 1} 个镜头：${label}`]);
  });
  return entries.filter(([key]) => typeof get(document, key) === 'string').map(([key, label]) => ({ key, label, value: get(document, key) }));
}
function paths(root, id) {
  const key = createHash('sha256').update(id).digest('hex');
  return { directory: join(root, 'planning', 'edit-drafts', key), head: join(root, 'planning', 'edit-drafts', key, 'head.json') };
}
async function load(root, artifactId) {
  const state = await readJson(join(root, 'project-state.json'));
  const artifact = state.artifacts.find(item => item.id === artifactId);
  if (!artifact || !['creative_brief', 'story_plan'].includes(artifact.type)) throw editError('这项内容暂不支持直接改稿，请填写调整要求。');
  if (artifact.invalidatedByScopeRevisionId) throw editError('这份内容已被新的方向替代，请编辑当前版本。');
  const newer = state.artifacts.some(item => item.type === artifact.type && item.revision > artifact.revision && !item.invalidatedByScopeRevisionId);
  if (newer) throw editError('已有更新版本，请刷新后编辑当前版本。');
  const file = await verifyArtifactFile(root, artifact);
  const source = await readJson(file.path);
  const location = paths(root, artifactId);
  const head = await readJson(location.head).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (head && head.sourceSha256 !== file.sha256) throw editError('原稿已变化，请重新核对待修改内容。');
  return { state, artifact, source, file, location, head };
}
export async function readArtifactEditor(root, artifactId) {
  const { artifact, source, file, head } = await load(root, artifactId);
  const document = head?.document ?? source;
  return { artifactId, type: artifact.type, sourceSha256: file.sha256, draftRevision: head?.revision ?? 0, fields: fieldsFor(artifact.type, document), sourceFields: fieldsFor(artifact.type, source), draftId: head?.id ?? null, status: head?.status ?? 'original', notice: '保存后保留为修改稿；确认影响范围前，不替换正在执行的版本。' };
}
export async function saveArtifactEdit(root, input) {
  root = resolve(root);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const { state, artifact, source, file, location, head } = await load(root, input.artifactId);
    if (head?.applied) throw editError('此修改稿已采用，请打开新的版本。');
    if (input.sourceSha256 !== file.sha256 || input.expectedDraftRevision !== (head?.revision ?? 0)) throw editError('内容已被更新，请刷新后再保存，避免覆盖新的修改。');
    if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw editError('请提供要修改的内容。', 400);
    const document = structuredClone(head?.document ?? source);
    const available = new Set(fieldsFor(artifact.type, document).map(item => item.key));
    const changedFields = [];
    for (const [key, value] of Object.entries(input.values)) {
      if (!available.has(key)) throw editError('此项不能通过直接改稿修改，请使用调整方向。', 400);
      if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw editError('修改内容不能为空，每项请控制在两万字以内。', 400);
      if (get(document, key) !== value.trim()) { set(document, key, value.trim()); changedFields.push(key); }
    }
    if (!changedFields.length && (!head || head.stateFingerprint === fingerprint(state))) throw editError('内容没有变化，无需重复保存。', 400);
    if (artifact.type === 'creative_brief' && document.schemaVersion === 3) {
      document.creativeDecision.directorCreativeContract.recommendedDirection.logline = document.creativeDecision.storyDirection;
      document.creativeDecision.directorCreativeContract.projectIntent.desiredAudienceEffect = document.creativeDecision.successDefinition;
    }
    (artifact.type === 'creative_brief' ? assertCreativeBrief : assertStoryPlan)(document);
    const allChangedFields = fieldsFor(artifact.type, document).filter(field => field.value !== get(source, field.key)).map(field => field.key);
    const id = `edit-${randomUUID()}`;
    const draft = { id, artifactId: artifact.id, artifactType: artifact.type, sourceSha256: file.sha256, revision: (head?.revision ?? 0) + 1, previousDraftId: head?.id ?? null, status: 'draft_pending_impact_review', stateFingerprint: fingerprint(state), changedFields: allChangedFields, document, createdAt: new Date().toISOString(), applied: false };
    await commitJsonTransaction(root, id, [{ path: join(location.directory, `${id}.json`), value: draft }, { path: location.head, value: draft }]);
    return { ...await readArtifactEditor(root, artifact.id), draftId: id, applied: false };
  });
}

export const fingerprint = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');
export async function previewArtifactEdit(root, input) {
  const { state, artifact, head } = await load(root, input.artifactId);
  if (!head || head.id !== input.draftId || head.revision !== input.expectedDraftRevision) throw editError('修改稿已变化，请重新查看。');
  if (head.stateFingerprint !== fingerprint(state)) throw editError('项目进度已变化，请重新保存并核对影响。');
  return { draftId: head.id, artifactId: artifact.id, expectedDraftRevision: head.revision, stateFingerprint: head.stateFingerprint,
    changedFields: head.changedFields, impactPolicy: 'conservative_v1', requiresConfirmation: true,
    notice: artifact.type === 'creative_brief'
      ? '采用后进入方向确认。现有机制会要求重新检查后续镜头、素材和生成准备，暂不能保证只重做局部。已有结果与费用记录保留，不会提交付费生成。'
      : '采用后进入镜头方案确认，后续制作需重新核对新版方案。已有结果保留，不会自动取消任务或提交付费生成。',
    affectedArtifactIds: state.artifacts.filter(item => item.id !== artifact.id && item.type !== 'creative_brief').map(item => item.id),
    paidGenerationSubmitted: false };
}
export async function applyArtifactEdit(root, input) {
  root = resolve(root);
  if (input.confirmImpact !== true) throw editError('请先查看并确认这次修改的影响。', 400);
  const preview = await previewArtifactEdit(root, input);
  if (input.stateFingerprint !== preview.stateFingerprint) throw editError('影响范围已变化，请重新查看。');
  const { artifact, head, location } = await load(root, input.artifactId);
  if (head.id !== input.draftId || head.revision !== input.expectedDraftRevision) throw editError('修改稿已变化，请重新查看。');
  const document = structuredClone(head.document);
  document.id = `edited-${head.id}`;
  const publish = artifact.type === 'creative_brief' ? createCreativeBrief : createStoryPlan;
  const published = await publish(root, document, { expectedStateFingerprint: preview.stateFingerprint, validateBeforePublish: async () => {
    const latest = await readJson(location.head);
    if (latest.id !== head.id || latest.revision !== head.revision || latest.applied) throw editError('修改稿已变化，请重新查看。');
  }, publicationWrites: publishedArtifact => {
    const applied = { ...head, applied: true, status: 'published_for_review', publishedArtifactId: publishedArtifact.id };
    return [{ path: join(location.directory, `${head.id}.json`), value: applied }, { path: location.head, value: applied }];
  } });
  return { artifact: published, applied: true, status: 'published_for_review', notice: preview.notice, paidGenerationSubmitted: false };
}
export async function rewriteArtifactEdit(root, input, { rewrite } = {}) {
  if (typeof rewrite !== 'function') { const error = new Error('自动改稿尚未接通，请先使用直接编辑；你的现有内容不会改变。'); error.code = 'REWRITE_UNAVAILABLE'; throw error; }
  if (typeof input.instruction !== 'string' || !input.instruction.trim()) throw editError('请说明希望怎样修改。', 400);
  const editor = await readArtifactEditor(root, input.artifactId);
  if (editor.sourceSha256 !== input.sourceSha256 || editor.draftRevision !== input.expectedDraftRevision) throw editError('内容已变化，请刷新后重试。');
  const result = await rewrite({ instruction: input.instruction.trim(), type: editor.type, fields: editor.fields });
  return saveArtifactEdit(root, { ...input, values: result?.values ?? result });
}
