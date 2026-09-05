// Machine review gate ("先机审") for shot_narration.
// Design source: docs/superpowers/specs/2026-07-21-shot-narration-director-gate-design.md §3b
// Flow: draft|rework --(machine lint passes)--> locked (auto-lock, no human step).
// If the machine lint fails, the artifact stays where it is and the errors are thrown; the
// operator must fix and re-run narration-lint.
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertProjectState } from '../domain/project-state.js';
import { transitionArtifact } from '../domain/artifact.js';
import { lintShotNarration, shotAuthorityBindings } from '../domain/shot-narration.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { inspectArtifactFile, verifyLockedArtifact } from './artifact-file-service.js';
import { currentArtifactsOf } from '../domain/current-artifact.js';
import { loadCanonicalSegments } from '../commands/assets.js';
import { commitJsonTransaction } from '../storage/transaction-journal.js';
import { loadVerifiedCapabilityManifest } from './director-route-service.js';
import { assertNarrationMatchesCapabilityManifest } from '../domain/director-narration.js';
import { assertCharacterActingMaster, assertVoiceIdentity } from '../domain/realism-authority.js';

async function lockedSegmentShotIds(root, state, sourceSegmentId) {
  let segments;
  try {
    segments = await loadCanonicalSegments(root, state, { requireLockedSegmentation: true });
  } catch {
    return undefined; // 无锁定分段时跳过 shotId 子集校验（讲戏本可以早于分段锁定编写）。
  }
  const segment = segments.find(({ id }) => id === sourceSegmentId);
  return Array.isArray(segment?.shotIds) ? segment.shotIds : undefined;
}

export function assertNarrationAuthoritySelections(narration, authorityPayloads) {
  for (const shot of narration.shots ?? []) {
    for (const character of shot.authorityAdaptation?.characters ?? []) {
      const master = assertCharacterActingMaster(authorityPayloads.get(character.actingMasterBinding.id));
      for (const selected of character.selectedMasterCues) {
        const canonicalCue = master.triggeredHabits.find(cue => cue.cueId === selected.masterCueId);
        if (!canonicalCue || canonicalCue.cue !== selected.masterCue) {
          throw new Error(`shot ${shot.shotId} selectedMasterCues must reference an exact cueId and cue from ${character.actingMasterBinding.id}`);
        }
      }
      if (character.voiceIdentityBinding) {
        const voice = assertVoiceIdentity(authorityPayloads.get(character.voiceIdentityBinding.id));
        const canonicalDelta = voice.allowedStateDeltas.find(delta => delta.deltaId === character.voiceStateDelta.voiceDeltaId);
        if (!canonicalDelta || canonicalDelta.allowedChange !== character.voiceStateDelta.audibleChange
          || canonicalDelta.stableCore !== character.voiceStateDelta.stableCore) {
          throw new Error(`shot ${shot.shotId} voiceStateDelta must reference the exact permitted delta from ${character.voiceIdentityBinding.id}`);
        }
      }
    }
  }
  return true;
}

export async function lintNarration(root, artifactId) {
  if (typeof artifactId !== 'string' || artifactId.trim() === '') throw new TypeError('artifact id is required');
  // The studio always passes an absolute project root, but the command/service
  // API is also used by local repair tools. Normalize here so transaction
  // writes cannot accidentally nest a second copy of the project beneath a
  // relative root (for example `project/project-state.json`).
  root = resolve(root);
  return withProjectLock(root, async () => {
    const statePath = join(root, 'project-state.json');
    const state = assertProjectState(await readJson(statePath));
    const index = state.artifacts.findIndex(({ id }) => id === artifactId);
    if (index === -1) throw new Error(`artifact not found: ${artifactId}`);
    const artifact = state.artifacts[index];
    if (artifact.type !== 'shot_narration') throw new Error(`narration-lint target must be a shot_narration: ${artifactId}`);
    if (!['draft', 'rework'].includes(artifact.status)) {
      throw new Error(`narration-lint requires draft or rework status, found ${artifact.status}`);
    }
    const narration = await readJson(join(root, artifact.path));
    const segmentShotIds = await lockedSegmentShotIds(root, state, narration.sourceSegmentId);
    const result = lintShotNarration(narration, {
      segmentShotIds,
      requireActingControlV2: state.workflowVersion === 2,
      requireRealismAuthorityV2: state.realismContractsVersion === 2
    });
    if (result.passed && state.realismContractsVersion === 2) {
      const current = new Map(currentArtifactsOf(state.artifacts).map(item => [item.id, item]));
      const authorityPayloads = new Map();
      for (const binding of shotAuthorityBindings(narration)) {
        const artifact = current.get(binding.id);
        if (!artifact || artifact.status !== 'locked' || artifact.type !== binding.expectedType
          || artifact.revision !== binding.revision || artifact.sha256 !== binding.sha256
          || (binding.characterId && artifact.characterId !== binding.characterId)) {
          throw new Error(`narration authority binding is stale, wrong-scope or wrong-type: ${binding.id}`);
        }
        await verifyLockedArtifact(root, artifact);
        if (artifact.type === 'character_acting_master') {
          authorityPayloads.set(artifact.id, assertCharacterActingMaster(await readJson(join(root, artifact.path))));
        } else if (artifact.type === 'voice_identity') {
          authorityPayloads.set(artifact.id, assertVoiceIdentity(await readJson(join(root, artifact.path))));
        }
      }
      assertNarrationAuthoritySelections(narration, authorityPayloads);
    }
    const routed = await loadVerifiedCapabilityManifest(root, state, { segmentId: narration.segmentId });
    if (routed) assertNarrationMatchesCapabilityManifest(narration, routed.manifest, routed.sha256);
    if (!result.passed) {
      const error = new Error(`narration-lint failed: ${result.errors.join('; ')}`);
      error.lint = result;
      throw error;
    }
    const inspected = await inspectArtifactFile(root, artifact.path);
    // Auto-lock: machine lint passed → skip human review → locked directly.
    const reviewId = `review-${randomUUID()}`;
    let transitioned = transitionArtifact({ ...artifact, sha256: inspected.sha256 }, 'awaiting_review');
    transitioned = transitionArtifact(transitioned, 'locked', reviewId);
    state.artifacts[index] = transitioned;
    state.updatedAt = new Date().toISOString();
    assertProjectState(state);
    const review = {
      id: reviewId,
      artifactId,
      decision: 'approved',
      note: routed ? `auto-locked: machine lint and director capability adoption passed (${routed.artifact.id})` : 'auto-locked: machine lint passed (legacy project without capability manifest)',
      correction: null,
      createdAt: new Date().toISOString(),
      actor: 'system',
      autoLocked: true,
      submittedArtifactSha256: inspected.sha256,
      artifactSha256: inspected.sha256
    };
    await commitJsonTransaction(root, `narration-auto-lock-${reviewId}`, [
      { path: join(root, 'reviews', `${reviewId}.json`), value: review },
      { path: statePath, value: state }
    ]);
    return { artifact: state.artifacts[index], lint: result, review, capabilityManifestId: routed?.artifact.id ?? null };
  });
}
