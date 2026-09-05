import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExecutionControlContract } from '../domain/execution-control-contract.js';
import { sha256Text } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';

function hashEvidence(value) {
  return sha256Text(`${JSON.stringify(value)}\n`);
}

function stableEvidence(run, fingerprint) {
  const evidence = {
    kind: 'execution_control_readback',
    runId: run.id,
    nodeKey: run.nodeKey,
    parameter: 'multi_shots',
    value: true,
    fingerprintSha256: fingerprint.sha256,
    checkedAt: run.verification.checkedAt
  };
  return { ...evidence, sha256: hashEvidence(evidence) };
}

export async function requireExecutionControlEvidence(root, fingerprint, expected = null) {
  if (fingerprint.executionControlContract === undefined) {
    const evidence = {
      kind: 'legacy_execution_control_not_required',
      strategy: 'legacy_unversioned',
      fingerprintSha256: fingerprint.sha256
    };
    return { ...evidence, sha256: hashEvidence(evidence) };
  }
  const control = assertExecutionControlContract(fingerprint.executionControlContract);
  if (control.executionUnitStrategy !== 'platform_multi_shot') {
    const evidence = {
      kind: 'execution_control_not_required',
      strategy: control.executionUnitStrategy,
      fingerprintSha256: fingerprint.sha256
    };
    return { ...evidence, sha256: hashEvidence(evidence) };
  }
  const generation = fingerprint.generationContract;
  if (generation?.provider !== 'libtv' || generation.request?.multi_shots !== true) {
    throw new Error('platform multi-shot control requires a LibTV request with multi_shots=true');
  }
  if (control.platformCapability.profileId !== fingerprint.videoModelProfileId
    && fingerprint.videoModelProfileId !== undefined) {
    throw new Error('platform multi-shot capability profile does not match the compiled video model profile');
  }
  const entries = await readdir(join(root, 'runs'), { withFileTypes: true })
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.json')) continue;
    const run = await readJson(join(root, 'runs', entry.name)).catch(() => null);
    if (run?.kind !== 'libtv_canvas_preparation'
      || run.status !== 'READY_FOR_USER_CANVAS_GENERATION'
      || run.fingerprint?.sha256 !== fingerprint.sha256
      || run.projectUuid !== generation.projectUuid
      || run.nodeName !== generation.nodeName
      || typeof run.nodeKey !== 'string'
      || run.verification?.snapshot?.settings?.multi_shots !== true) continue;
    candidates.push(run);
  }
  candidates.sort((left, right) => String(right.verification?.checkedAt ?? '').localeCompare(String(left.verification?.checkedAt ?? '')));
  if (candidates.length === 0) {
    throw new Error('platform multi-shot is unverified: prepare the exact LibTV node and read back multi_shots=true before paid approval');
  }
  const evidence = stableEvidence(candidates[0], fingerprint);
  if (expected && (expected.sha256 !== evidence.sha256 || expected.runId !== evidence.runId || expected.nodeKey !== evidence.nodeKey)) {
    throw new Error('execution control readback evidence changed after paid approval');
  }
  return evidence;
}
