import { join } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';

export async function reconcileCreatedLibTvVideoWithoutTask(root, {
  runId, nodeKey, note, evidencePath, evidenceSha256
}) {
  return withProjectLock(root, async () => {
    await recoverJsonTransactions(root);
    const runPath = join(root, 'runs', `${runId}.json`);
    const ownerPath = join(root, 'runs', 'libtv-video-owner.json');
    const run = await readJson(runPath);
    const owner = await readJson(ownerPath);
    if (run.kind !== 'libtv_video' || run.status !== 'UNCERTAIN') {
      throw new Error('only an UNCERTAIN LibTV video run can use created-node reconciliation');
    }
    if (run.nodeKey !== nodeKey || typeof run.nodeName !== 'string' || run.nodeName.trim() === '') {
      throw new Error('LibTV video reconciliation node identity does not match the uncertain run');
    }
    if (run.taskId !== null || (run.outputs ?? []).length !== 0) {
      throw new Error('created-node reconciliation requires no taskId and no generated outputs');
    }
    const createCommand = (run.commands ?? []).find(command => command.args?.[0] === 'node' && command.args.includes('create'));
    const runCommand = (run.commands ?? []).find(command => command.args?.[0] === 'node' && command.args.at(-1) === '--run');
    if (createCommand?.exitCode !== 0 || runCommand?.exitCode === 0 || !Number.isInteger(runCommand?.exitCode)) {
      throw new Error('created-node reconciliation requires a successful node create and a failed node run command');
    }
    if (owner.status !== 'UNCERTAIN' || owner.runId !== runId) {
      throw new Error('LibTV video reconciliation ownership does not match');
    }
    const approvalPath = join(root, 'reviews', `${encodeURIComponent(run.paidApprovalId)}.json`);
    const approval = await readJson(approvalPath);
    if (approval.kind !== 'paid_generation_approval' || approval.consumedByRunId !== runId || approval.maxPaidAttempts !== 1) {
      throw new Error('LibTV video reconciliation requires the consumed one-attempt paid approval');
    }
    const reconciledAt = new Date().toISOString();
    const reconciled = {
      ...run,
      status: 'RECONCILED_NOT_SUBMITTED',
      reconciliation: {
        actor: 'human',
        decision: 'confirmed_node_created_without_task',
        note: note.trim(),
        evidencePath,
        evidenceSha256,
        nodeKey,
        taskId: null,
        outputCount: 0,
        paidApprovalRestored: false,
        automaticRetryAllowed: false,
        reconciledAt
      },
      updatedAt: reconciledAt
    };
    await commitJsonTransaction(root, `libtv-video-reconcile-${runId}`, [
      { path: runPath, value: reconciled },
      { path: ownerPath, value: { status: 'RELEASED', runId, releasedAt: reconciledAt } }
    ]);
    return reconciled;
  });
}
