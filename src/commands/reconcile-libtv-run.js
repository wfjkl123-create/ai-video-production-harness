import { join, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { reconcileCreatedLibTvVideoWithoutTask } from '../services/libtv-video-reconciliation-service.js';
import { resolveProjectInput } from './project-input.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function runReconcileLibTvRun(args) {
  const root = resolve(option(args, 'project'));
  const runId = option(args, 'run');
  const note = option(args, 'note');
  if (!SAFE_ID.test(runId)) throw new Error('LibTV run ID must be a safe identifier');
  if (note.trim() === '') throw new Error('--note must not be empty');
  const confirmedNoSideEffects = args.includes('--confirmed-no-side-effects');
  const adoptCompletedAssets = args.includes('--adopt-completed-assets');
  const confirmedTerminalFailure = args.includes('--confirmed-terminal-failure');
  const confirmedCreateFailure = args.includes('--confirmed-create-failure');
  const confirmedNodeCreatedNoTask = args.includes('--confirmed-node-created-no-task');
  if ([confirmedNoSideEffects, adoptCompletedAssets, confirmedTerminalFailure, confirmedCreateFailure, confirmedNodeCreatedNoTask].filter(Boolean).length !== 1) {
    throw new Error('choose exactly one LibTV reconciliation decision');
  }
  if (confirmedNodeCreatedNoTask) {
    const nodeKey = option(args, 'node-key');
    if (!/^[a-f0-9-]{36}$/i.test(nodeKey)) throw new Error('created LibTV video node key is invalid');
    const recordedEvidencePath = option(args, 'evidence');
    const evidenceInputPath = resolveProjectInput(root, recordedEvidencePath);
    const evidence = await inspectArtifactFile(root, recordedEvidencePath);
    return reconcileCreatedLibTvVideoWithoutTask(root, {
      runId, nodeKey, note,
      evidencePath: relative(root, evidenceInputPath).split(sep).join('/'),
      evidenceSha256: evidence.sha256
    });
  }
  const terminalFailure = confirmedTerminalFailure ? {
    nodeKey: option(args, 'node-key'),
    taskId: option(args, 'task-id'),
    failureReason: option(args, 'failure-reason')
  } : null;
  if (terminalFailure && !/^[a-f0-9-]{36}$/i.test(terminalFailure.nodeKey)) throw new Error('terminal failure node key is invalid');
  if (terminalFailure && !/^\d+$/.test(terminalFailure.taskId)) throw new Error('terminal failure task id is invalid');
  if (terminalFailure && terminalFailure.failureReason.trim() === '') throw new Error('terminal failure reason must not be empty');
  // The LibTV video executor uses its own owner record and does not create
  // the legacy manifest-fingerprint files used by the older reconciliation
  // path below. Reconcile a confirmed terminal failure against that durable
  // owner/run pair without touching the remote node or retrying it.
  if (confirmedTerminalFailure || confirmedNoSideEffects || confirmedCreateFailure) {
    const candidateRun = await readJson(join(root, 'runs', `${runId}.json`));
    if (candidateRun.kind === 'libtv_video') {
      const evidenceInput = option(args, 'evidence', { required: false });
      const evidenceMeta = evidenceInput
        ? (() => {
          const evidenceInputPath = resolveProjectInput(root, evidenceInput);
          return { evidencePath: relative(root, evidenceInputPath).split(sep).join('/'), evidenceInputPath };
        })()
        : null;
      const evidenceSha = evidenceMeta ? (await inspectArtifactFile(root, evidenceMeta.evidencePath)).sha256 : null;
      return withProjectLock(root, async () => {
        await recoverJsonTransactions(root);
        const runPath = join(root, 'runs', `${runId}.json`);
        const run = await readJson(runPath);
        if (run.kind !== 'libtv_video' || run.status !== 'UNCERTAIN') {
          throw new Error('only an UNCERTAIN LibTV video run can be reconciled here');
        }
        if (confirmedTerminalFailure) {
          if (run.nodeKey !== terminalFailure.nodeKey || run.taskId !== null) {
            throw new Error('terminal failure reconciliation node/task identity does not match the uncertain run');
          }
          const runCommand = (run.commands ?? []).find(command => command.args?.[0] === 'node' && command.args.at(-1) === '--run');
          if (runCommand?.exitCode !== 1) throw new Error('terminal failure reconciliation requires a failed LibTV node run command');
        }
        if (confirmedCreateFailure) {
          const createCommand = (run.commands ?? []).find(command => command.args?.[0] === 'node' && command.args.includes('create'));
          const runCommand = (run.commands ?? []).find(command => command.args?.[0] === 'node' && command.args.at(-1) === '--run');
          if (run.nodeKey !== null || run.taskId !== null || (run.outputs ?? []).length !== 0
            || createCommand?.exitCode !== 1 || runCommand) {
            throw new Error('create-failure reconciliation requires failed node creation with no video node, task, run, or output');
          }
        }
        const ownerPath = join(root, 'runs', 'libtv-video-owner.json');
        const owner = await readJson(ownerPath);
        if (owner.status !== 'UNCERTAIN' || owner.runId !== runId) {
          throw new Error('LibTV video reconciliation ownership does not match');
        }
        const approval = await readJson(join(root, 'reviews', `${encodeURIComponent(run.paidApprovalId)}.json`));
        if (approval.kind !== 'paid_generation_approval' || approval.consumedByRunId !== runId || approval.maxPaidAttempts !== 1) {
          throw new Error('LibTV reconciliation requires the consumed one-attempt paid approval');
        }
        const reconciledAt = new Date().toISOString();
        const status = confirmedTerminalFailure || confirmedCreateFailure ? 'FAILED' : 'RECONCILED_NOT_SUBMITTED';
        const decision = confirmedTerminalFailure ? 'confirmed_terminal_failure' : confirmedCreateFailure ? 'confirmed_create_failure' : 'confirmed_no_side_effects';
        const reviewed = {
          ...run, status,
          ...(confirmedTerminalFailure ? { terminalFailure: { ...terminalFailure, failureReason: terminalFailure.failureReason.trim() } } : {}),
          reconciliation: {
            actor: 'human', decision, note: note.trim(),
            ...(evidenceMeta ? { evidencePath: evidenceMeta.evidencePath, evidenceSha256: evidenceSha } : {}),
            reconciledAt
          },
          updatedAt: reconciledAt
        };
        await commitJsonTransaction(root, `libtv-video-reconcile-${runId}`, [
          { path: runPath, value: reviewed },
          { path: ownerPath, value: { status: 'RELEASED', runId, releasedAt: reconciledAt } }
        ]);
        return reviewed;
      });
    }
  }
  let adoptedOutputs = null;
  let recoveryInputPath = null;
  if (adoptCompletedAssets) {
    recoveryInputPath = resolveProjectInput(root, option(args, 'input'));
    const recovery = await readJson(recoveryInputPath);
    if (!Array.isArray(recovery.outputs) || recovery.outputs.length === 0) throw new Error('recovery outputs must be a non-empty array');
    const ids = new Set();
    adoptedOutputs = [];
    for (const output of recovery.outputs) {
      if (!SAFE_ID.test(output?.assetId ?? '') || ids.has(output.assetId)) throw new Error('recovery asset IDs must be unique safe identifiers');
      if (!/^[a-f0-9-]{36}$/i.test(output.nodeKey ?? '')) throw new Error(`recovery nodeKey is invalid for ${output.assetId}`);
      if (!/^\d+$/.test(output.taskId ?? '')) throw new Error(`recovery taskId is invalid for ${output.assetId}`);
      const inspected = await inspectArtifactFile(root, output.path);
      if (output.sha256 !== inspected.sha256) throw new Error(`recovery checksum mismatch for ${output.assetId}`);
      ids.add(output.assetId);
      adoptedOutputs.push({ assetId: output.assetId, path: output.path, sha256: inspected.sha256, nodeKey: output.nodeKey, taskId: output.taskId });
    }
  }
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const runPath = join(root, 'runs', `${runId}.json`);
    const run = await readJson(runPath);
    if (!['SUBMITTING', 'UNCERTAIN'].includes(run.status)) throw new Error('only a SUBMITTING or UNCERTAIN LibTV run can be reconciled');
    const ownerPath = join(root, 'runs', 'libtv-owner.json');
    const owner = await readJson(ownerPath);
    const fingerprintPath = join(root, 'runs', 'libtv-fingerprints', `${run.manifestFingerprint}.json`);
    const fingerprint = await readJson(fingerprintPath);
    const expectedState = run.status === 'SUBMITTING' ? 'ACTIVE' : 'UNCERTAIN';
    if (owner.runId !== runId || owner.status !== expectedState || fingerprint.runId !== runId || fingerprint.status !== expectedState) {
      throw new Error('LibTV reconciliation ownership does not match');
    }
    const reconciledAt = new Date().toISOString();
    const status = adoptCompletedAssets ? 'SUCCESS' : confirmedTerminalFailure ? 'FAILED' : 'RECONCILED_NOT_RUN';
    const decision = adoptCompletedAssets
      ? 'adopted_completed_assets'
      : confirmedTerminalFailure ? 'confirmed_terminal_failure' : 'confirmed_no_side_effects';
    const reviewed = {
      ...run, status,
      ...(adoptedOutputs ? { outputs: adoptedOutputs } : {}),
      ...(terminalFailure ? { terminalFailure: { ...terminalFailure, failureReason: terminalFailure.failureReason.trim() } } : {}),
      reconciliation: {
        actor: 'human', decision,
        note: note.trim(), reconciledAt,
        ...(recoveryInputPath ? { inputPath: recoveryInputPath.slice(root.length + 1) } : {})
      }
    };
    await commitJsonTransaction(root, `libtv-reconcile-${runId}`, [
      { path: runPath, value: reviewed },
      { path: ownerPath, value: { status: 'RELEASED', runId, manifestFingerprint: run.manifestFingerprint, releasedAt: reconciledAt } },
      { path: fingerprintPath, value: { ...fingerprint, status, reconciledAt } }
    ]);
    return reviewed;
  });
}
