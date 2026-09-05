import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import { resolveCurrentArtifacts } from '../domain/current-artifact.js';
import { inspectArtifactFile } from './artifact-file-service.js';
import { readJson } from '../storage/json-store.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { withProjectLock } from '../storage/project-lock.js';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function projectPath(root, value, field) {
  requireText(value, field);
  if (isAbsolute(value)) throw new Error(`${field} must be project-relative`);
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${field} must stay inside project root`);
  return target;
}

function evidenceSha256(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

/**
 * Repairs only an already-proven legacy cross-scope supersession pointer.
 * It preserves both historical artifacts and records why the invalid pointer
 * was removed, rather than silently rewriting either artifact's identity.
 */
export async function repairLegacyCrossScopeSupersession(root, input) {
  root = resolve(root);
  for (const field of ['artifactId', 'priorArtifactId', 'segmentAliasPath', 'note']) requireText(input?.[field], field);
  const aliasPath = projectPath(root, input.segmentAliasPath, 'segmentAliasPath');

  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const statePath = join(root, 'project-state.json');
    const state = assertProjectState(await readJson(statePath));
    const artifactIndex = state.artifacts.findIndex(item => item.id === input.artifactId);
    const priorIndex = state.artifacts.findIndex(item => item.id === input.priorArtifactId);
    if (artifactIndex === -1 || priorIndex === -1) throw new Error('both artifactId and priorArtifactId must exist');

    const artifact = state.artifacts[artifactIndex];
    const prior = state.artifacts[priorIndex];
    if (artifact.supersedesArtifactId !== prior.id) throw new Error('artifact does not supersede the declared prior artifact');
    if (artifact.type !== prior.type) throw new Error('legacy repair only applies to same-type supersession records');
    if (!artifact.segmentId || !prior.segmentId || artifact.segmentId === prior.segmentId) {
      throw new Error('legacy repair requires distinct non-empty segment scopes');
    }

    let beforeError;
    try {
      resolveCurrentArtifacts(state.artifacts);
    } catch (error) {
      beforeError = error;
    }
    if (!beforeError || !beforeError.message.includes(`artifact ${artifact.id} cannot supersede a different scope`)) {
      throw new Error('legacy repair is only allowed for the current exact cross-scope lineage failure');
    }

    const aliasInspection = await inspectArtifactFile(root, input.segmentAliasPath);
    const alias = await readJson(aliasPath);
    if (alias?.kind !== 'segment_id_alias' || alias?.projectId !== state.projectId || alias?.oneToOne !== true
      || alias?.storyPlanSegmentId !== prior.segmentId || alias?.canonicalSegmentId !== artifact.segmentId) {
      throw new Error('segment alias does not prove the requested one-to-one legacy scope mapping');
    }

    const repairedArtifact = { ...artifact };
    delete repairedArtifact.supersedesArtifactId;
    const repairedState = structuredClone(state);
    repairedState.artifacts[artifactIndex] = repairedArtifact;
    repairedState.updatedAt = new Date().toISOString();
    assertProjectState(repairedState);
    const after = resolveCurrentArtifacts(repairedState.artifacts);

    const repairId = `lineage-repair-${artifact.id}-${randomUUID()}`;
    const evidence = {
      schemaVersion: 1,
      id: repairId,
      kind: 'legacy_cross_scope_supersession_repair',
      projectId: state.projectId,
      createdAt: repairedState.updatedAt,
      actor: 'system',
      note: input.note,
      reason: 'A legacy narration record used a story-plan label while its successor used the canonical execution segment ID. The locked one-to-one alias proves both labels refer to the same segment, but singleton lineage requires matching stored scopes.',
      removedSupersession: {
        artifactId: artifact.id,
        artifactType: artifact.type,
        artifactSegmentId: artifact.segmentId,
        priorArtifactId: prior.id,
        priorSegmentId: prior.segmentId,
        originalSupersedesArtifactId: artifact.supersedesArtifactId
      },
      segmentAlias: {
        path: input.segmentAliasPath,
        sha256: aliasInspection.sha256,
        id: alias.id,
        storyPlanSegmentId: alias.storyPlanSegmentId,
        canonicalSegmentId: alias.canonicalSegmentId,
        oneToOne: alias.oneToOne
      },
      beforeError: beforeError.message,
      afterCurrentArtifactIds: after.current.map(item => item.id),
      afterSupersededArtifactIds: after.supersededIds,
      evidenceSha256: null
    };
    evidence.evidenceSha256 = evidenceSha256({ ...evidence, evidenceSha256: null });

    await commitJsonTransaction(root, repairId, [
      { path: join(root, 'evidence', 'lineage-repairs', `${repairId}.json`), value: evidence },
      { path: statePath, value: repairedState }
    ]);

    return {
      repairId,
      artifactId: artifact.id,
      removedSupersedesArtifactId: prior.id,
      evidencePath: `evidence/lineage-repairs/${repairId}.json`,
      evidenceSha256: evidence.evidenceSha256,
      currentArtifactIds: after.current.map(item => item.id),
      supersededArtifactIds: after.supersededIds
    };
  });
}
