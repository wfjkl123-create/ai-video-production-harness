import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CANONICAL_PROMPT_SKILL_ID,
  CANONICAL_PROMPT_SKILL_ROOT,
  canonicalPromptSkillRoot,
  assertCanonicalPromptSource,
  sha256Bytes
} from '../domain/canonical-prompt-source.js';
import { assertProjectState } from '../domain/project-state.js';
import { currentArtifactsOf } from '../domain/current-artifact.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { verifyLockedArtifact } from './artifact-file-service.js';

const SKIP_NAMES = new Set(['.DS_Store', '.git', '__pycache__', 'backups']);

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function stableDigest(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

async function walkFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (SKIP_NAMES.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) paths.push(absolute);
  }
  return paths;
}

export async function computeCanonicalPromptSkillTreeDigest(skillRoot = CANONICAL_PROMPT_SKILL_ROOT) {
  const configuredRoot = canonicalPromptSkillRoot();
  const root = await realpath(resolve(skillRoot));
  if (root !== await realpath(configuredRoot)) throw new Error('only the configured canonical Seedance prompt Skill tree may be fingerprinted');
  const rows = [];
  for (const path of await walkFiles(root)) {
    const bytes = await readFile(path);
    rows.push({ path: relative(root, path).split(sep).join('/'), sha256: sha256Bytes(bytes) });
  }
  if (!rows.some(row => row.path === 'SKILL.md')) throw new Error('canonical Seedance prompt Skill is missing SKILL.md');
  return { root, files: rows, sha256: stableDigest(rows) };
}

async function loadReferences(skillRoot, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('loadedReferencePaths must be a non-empty array');
  const unique = [...new Set(paths)];
  if (!unique.includes('SKILL.md')) throw new Error('loadedReferencePaths must include SKILL.md');
  const output = [];
  for (const path of unique.sort()) {
    if (typeof path !== 'string' || path.trim() === '' || isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
      throw new TypeError('loaded reference paths must be safe Skill-relative paths');
    }
    const requested = resolve(skillRoot, path);
    if (outside(skillRoot, requested)) throw new Error(`loaded reference escapes canonical Skill root: ${path}`);
    const actual = await realpath(requested);
    const metadata = await stat(actual);
    if (!metadata.isFile() || outside(skillRoot, actual)) throw new Error(`loaded reference is not a canonical Skill file: ${path}`);
    output.push({ path: relative(skillRoot, actual).split(sep).join('/'), sha256: sha256Bytes(await readFile(actual)) });
  }
  return output;
}

function artifactBinding(artifact) {
  return { id: artifact.id, revision: artifact.revision, sha256: artifact.sha256 };
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function authorExecutionEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('authorExecution must be an object');
  requiredText(value.taskId, 'authorExecution.taskId');
  requiredText(value.outputId, 'authorExecution.outputId');
  requiredText(value.completedAt, 'authorExecution.completedAt');
  if (Number.isNaN(Date.parse(value.completedAt))) throw new TypeError('authorExecution.completedAt must be a date-time');
  return { taskId: value.taskId, outputId: value.outputId, completedAt: value.completedAt };
}

async function writePromptBytesBeforePublication(path, body) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== body) throw new Error('canonical prompt publication path already contains different bytes');
  }
}

async function resolveCurrentLockedBindings(root, state, ids, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(ids) || (!allowEmpty && ids.length === 0)) throw new TypeError(`${field} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${field} must not contain duplicates`);
  const current = new Map(currentArtifactsOf(state.artifacts).map(artifact => [artifact.id, artifact]));
  const bindings = [];
  for (const id of ids) {
    const artifact = current.get(id);
    if (!artifact || artifact.status !== 'locked') throw new Error(`${field} must reference current locked artifacts: ${id}`);
    await verifyLockedArtifact(root, artifact);
    bindings.push(artifactBinding(artifact));
  }
  return bindings;
}

export async function authorCanonicalPromptSource(root, input) {
  root = resolve(root);
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const statePath = join(root, 'project-state.json');
    const state = assertProjectState(await readJson(statePath));
    if ((state.realismContractsVersion ?? 1) !== 2 || state.realismContractsWriteMode === 'read_only') {
      throw new Error('canonical prompt source v1 writes require realismContractsVersion 2 with write mode enabled');
    }
    requiredText(input?.segmentId, 'segmentId');
    if (input.sourcePromptArtifactId !== undefined) {
      throw new Error('direct wrapping of an existing seedance_prompt is forbidden; caller-supplied sourceBody has route-and-byte integrity only, not verified authorship');
    }
    const sourceBody = requiredText(input.sourceBody, 'sourceBody');
    const executionEvidence = authorExecutionEvidence(input.authorExecution);
    const inputIrBindings = await resolveCurrentLockedBindings(root, state, input.inputIrArtifactIds, 'inputIrArtifactIds');
    const lockedAssetBindings = await resolveCurrentLockedBindings(root, state, input.lockedAssetArtifactIds ?? [], 'lockedAssetArtifactIds', { allowEmpty: true });
    const skillTree = await computeCanonicalPromptSkillTreeDigest();
    const loadedReferences = await loadReferences(skillTree.root, input.loadedReferencePaths);
    const sourceBodySha256 = sha256Bytes(sourceBody);
    const authorRequestFingerprint = stableDigest({
      projectId: state.projectId,
      segmentId: input.segmentId,
      inputIrBindings,
      lockedAssetBindings,
      skillTreeSha256: skillTree.sha256,
      loadedReferences,
      sourceBodySha256,
      executionEvidence
    });
    const existing = currentArtifactsOf(state.artifacts, artifact => artifact.type === 'canonical_prompt_source'
      && artifact.segmentId === input.segmentId && artifact.status === 'locked'
      && artifact.authorRequestFingerprint === authorRequestFingerprint)[0];
    if (existing) {
      await verifyLockedArtifact(root, existing);
      const source = assertCanonicalPromptSource(await readJson(join(root, existing.path)));
      const prompt = currentArtifactsOf(state.artifacts, artifact => artifact.id === source.sourcePrompt.id
        && artifact.type === 'seedance_prompt' && artifact.status === 'locked')[0];
      if (!prompt) throw new Error('reused canonical author publication is missing its current locked prompt');
      await verifyLockedArtifact(root, prompt);
      return { artifact: existing, promptArtifact: prompt, source, reused: true };
    }

    const promptRevision = 1 + Math.max(0, ...state.artifacts
      .filter(artifact => artifact.type === 'seedance_prompt' && artifact.segmentId === input.segmentId)
      .map(artifact => artifact.revision));
    const sourceRevision = 1 + Math.max(0, ...state.artifacts
      .filter(artifact => artifact.type === 'canonical_prompt_source' && artifact.segmentId === input.segmentId)
      .map(artifact => artifact.revision));
    const promptId = `prompt-${input.segmentId}-v${promptRevision}-${sourceBodySha256.slice(0, 12)}`;
    const promptPath = `prompts/${input.segmentId}/canonical-source-v${promptRevision}.txt`;
    const authorEventId = `canonical-prompt-author-${randomUUID()}`;
    const promptReviewId = `review-${randomUUID()}`;
    const sourceReviewId = `review-${randomUUID()}`;
    const occurredAt = new Date().toISOString();
    const currentById = new Map(currentArtifactsOf(state.artifacts).map(artifact => [artifact.id, artifact]));
    const narrationArtifacts = input.inputIrArtifactIds
      .map(id => currentById.get(id))
      .filter(artifact => artifact?.type === 'shot_narration');
    if (narrationArtifacts.length > 1) throw new Error('canonical author route accepts at most one shot_narration input per segment');
    const promptArtifact = {
      id: promptId,
      type: 'seedance_prompt',
      segmentId: input.segmentId,
      revision: promptRevision,
      status: 'locked',
      path: promptPath,
      sha256: sourceBodySha256,
      lockedByReviewId: promptReviewId,
      canonicalAuthorEventId: authorEventId,
      canonicalAuthorRequestFingerprint: authorRequestFingerprint,
      canonicalSkillTreeSha256: skillTree.sha256,
      canonicalAuthorOutputSha256: sourceBodySha256,
      ...(narrationArtifacts.length === 1 ? {
        narrationSourceId: narrationArtifacts[0].id,
        narrationSha256: narrationArtifacts[0].sha256
      } : {})
    };
    const provenanceFingerprint = stableDigest({
      authorRequestFingerprint,
      sourcePrompt: artifactBinding(promptArtifact)
    });
    const id = `canonical-prompt-source-${input.segmentId}-v${sourceRevision}-${provenanceFingerprint.slice(0, 12)}`;
    const payload = assertCanonicalPromptSource({
      kind: 'canonical_prompt_source_v1',
      id,
      projectId: state.projectId,
      segmentId: input.segmentId,
      revision: sourceRevision,
      skillId: CANONICAL_PROMPT_SKILL_ID,
      skillRoot: canonicalPromptSkillRoot(),
      skillTreeSha256: skillTree.sha256,
      sourcePrompt: artifactBinding(promptArtifact),
      inputIrBindings,
      lockedAssetBindings,
      loadedReferences,
      authorEvent: {
        id: authorEventId,
        route: 'canonical_skill_author_service',
        skillId: CANONICAL_PROMPT_SKILL_ID,
        proofLevel: 'system_route_and_byte_integrity',
        occurredAt,
        executionEvidence
      },
      sourceBody,
      sourceBodyOrigin: 'caller_supplied_unverified',
      sourceBodySha256,
      authorRequestFingerprint,
      provenanceFingerprint
    });
    const path = `prompts/${input.segmentId}/canonical-prompt-source-v${sourceRevision}.json`;
    const sourceArtifact = {
      id,
      type: 'canonical_prompt_source',
      segmentId: input.segmentId,
      revision: sourceRevision,
      status: 'locked',
      path,
      sha256: stableDigest(payload),
      lockedByReviewId: sourceReviewId,
      provenanceFingerprint,
      authorRequestFingerprint,
      sourcePromptArtifactId: promptArtifact.id,
      sourceBodySha256,
      skillTreeSha256: skillTree.sha256
    };
    const review = (reviewId, artifact, note) => ({
      id: reviewId,
      artifactId: artifact.id,
      decision: 'approved',
      note,
      correction: null,
      createdAt: occurredAt,
      actor: 'system',
      autoLocked: true,
      machineReviewed: true,
      authorEventId,
      submittedArtifactSha256: artifact.sha256,
      artifactSha256: artifact.sha256
    });
    await writePromptBytesBeforePublication(join(root, promptPath), sourceBody);
    state.artifacts.push(promptArtifact, sourceArtifact);
    state.updatedAt = occurredAt;
    assertProjectState(state);
    await commitJsonTransaction(root, `canonical-author-publication-${authorEventId}`, [
      { path: join(root, path), value: payload },
      { path: join(root, 'reviews', `${promptReviewId}.json`), value: review(promptReviewId, promptArtifact, 'auto-locked: prompt bytes entered the project through the canonical Skill author service') },
      { path: join(root, 'reviews', `${sourceReviewId}.json`), value: review(sourceReviewId, sourceArtifact, 'auto-locked: canonical Skill route, current bindings, reference digests and source bytes verified') },
      { path: statePath, value: state }
    ]);
    return { artifact: sourceArtifact, promptArtifact, source: payload, reused: false };
  });
}

export async function verifyCanonicalPromptSourceForCompilation(root, state, prompt) {
  root = resolve(root);
  const candidates = currentArtifactsOf(state.artifacts, artifact => artifact.type === 'canonical_prompt_source'
    && artifact.segmentId === prompt.segmentId && artifact.status === 'locked')
    .sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  if (candidates.length !== 1) throw new Error(`exactly one current locked canonical_prompt_source is required for ${prompt.segmentId}`);
  const artifact = candidates[0];
  await verifyLockedArtifact(root, artifact);
  const payload = assertCanonicalPromptSource(await readJson(join(root, artifact.path)));
  const promptFile = await verifyLockedArtifact(root, prompt);
  const sourceBody = await readFile(promptFile.path, 'utf8');
  if (payload.sourcePrompt.id !== prompt.id || payload.sourcePrompt.revision !== prompt.revision || payload.sourcePrompt.sha256 !== prompt.sha256) {
    throw new Error('canonical prompt source is bound to a stale or different Seedance prompt artifact');
  }
  if (prompt.canonicalAuthorEventId !== payload.authorEvent.id
    || prompt.canonicalAuthorRequestFingerprint !== payload.authorRequestFingerprint
    || prompt.canonicalSkillTreeSha256 !== payload.skillTreeSha256
    || prompt.canonicalAuthorOutputSha256 !== payload.sourceBodySha256) {
    throw new Error('Seedance prompt was not published by the same canonical author route event as its provenance artifact');
  }
  if (payload.sourceBody !== sourceBody || payload.sourceBodySha256 !== sha256Bytes(sourceBody)) {
    throw new Error('canonical prompt source bytes no longer match the locked Seedance prompt');
  }
  const current = new Map(currentArtifactsOf(state.artifacts).map(item => [item.id, item]));
  for (const binding of [...payload.inputIrBindings, ...payload.lockedAssetBindings]) {
    const item = current.get(binding.id);
    if (!item || item.status !== 'locked' || item.revision !== binding.revision || item.sha256 !== binding.sha256) {
      throw new Error(`canonical prompt source input binding is stale: ${binding.id}`);
    }
    await verifyLockedArtifact(root, item);
  }
  const skillTree = await computeCanonicalPromptSkillTreeDigest();
  if (skillTree.sha256 !== payload.skillTreeSha256) throw new Error('canonical Seedance prompt Skill tree changed; re-author and re-lock the prompt source');
  const loadedReferences = await loadReferences(skillTree.root, payload.loadedReferences.map(item => item.path));
  if (JSON.stringify(loadedReferences) !== JSON.stringify(payload.loadedReferences)) {
    throw new Error('canonical prompt source reference files changed; re-author and re-lock the prompt source');
  }
  return { artifact, payload };
}
