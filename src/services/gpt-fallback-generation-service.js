import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256File } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { verifyLockedArtifact } from './artifact-file-service.js';
import { inspectVideoPackage } from './video-generation-service.js';
import { assertGenerationFailureGate } from './generation-failure-service.js';
import { auditProjectReadiness } from './project-readiness-audit-service.js';
import { requireExecutionControlEvidence } from './execution-control-evidence-service.js';
import { commitJsonTransaction, recoverJsonTransactions } from '../storage/transaction-journal.js';
import { prepareExecutionLedgerAppend } from './execution-ledger-service.js';

async function assertStrictReadiness(root, state) {
  if (state?.videoGovernanceVersion !== 2) return;
  const audit = await auditProjectReadiness(root);
  const blockers = audit.findings.filter(item => item.severity === 'error');
  if (blockers.length) throw new Error(`strict video governance readiness BLOCKED: ${blockers.map(item => item.id).join(', ')}`);
}

function text(value, field) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`); }
function validateAuthorization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('GPT fallback authorization must be an object');
  for (const field of ['id','projectId','segmentId','preflightId','fingerprintSha256','independentAuditArtifactId','gptAuditExceptionId','gptFingerprintAuditId','libtvProjectUuid','nodeName','approvedAt']) text(value[field], field);
  if (value.kind !== 'human_gpt_fallback_generation_authorization' || value.actor !== 'human' || value.decision !== 'approved') throw new Error('GPT fallback generation requires an explicit human authorization');
  if (value.maxPaidAttempts !== 1 || value.automaticPaidRetries !== false) throw new Error('GPT fallback authorization must allow exactly one paid attempt and no retries');
  if (!/^[a-f0-9]{64}$/.test(value.fingerprintSha256) || !/^[a-f0-9]{32}$/.test(value.libtvProjectUuid)) throw new Error('GPT fallback authorization has an invalid fingerprint or LibTV project UUID');
  if (Number.isNaN(Date.parse(value.approvedAt))) throw new Error('approvedAt must be a date-time');
  return value;
}
async function verifyAudit(root, state, authorization, preflight) {
  const artifact = state.artifacts.find(item => item.id === authorization.independentAuditArtifactId);
  if (!artifact || artifact.type !== 'independent_creative_audit' || artifact.status !== 'locked') throw new Error('a locked independent GPT fallback audit is required');
  await verifyLockedArtifact(root, artifact);
  const audit = await readJson(join(root, artifact.path));
  if (audit.decision !== 'PASS' || audit.agentContextMode !== 'clean_zero_context' || !/gpt/i.test(audit.agentTaskId ?? '')) throw new Error('GPT fallback audit must be a clean-zero-context locked PASS from GPT');
  if (audit.promptSha256 !== preflight.fingerprint.promptSha256 || audit.packageSha256 !== preflight.fingerprint.packageSha256) throw new Error('GPT fallback audit does not bind the current prompt and package');
  if (JSON.stringify(audit.inputMedia) !== JSON.stringify(preflight.fingerprint.inputMedia)) throw new Error('GPT fallback audit media binding changed');
}
async function verifyGptExceptionAndFingerprintAudit(root, state, authorization, preflight) {
  const fingerprint = preflight.fingerprint;
  const exception = await readJson(join(root,'reviews',`${encodeURIComponent(authorization.gptAuditExceptionId)}.json`));
  const attestation = await readJson(join(root,'reviews',`${encodeURIComponent(authorization.gptFingerprintAuditId)}.json`));
  const mediaSha256 = [...fingerprint.inputMedia.images,...fingerprint.inputMedia.videos,...fingerprint.inputMedia.audio].map(item=>item.sha256);
  if (exception.projectId !== state.projectId || exception.segmentId !== authorization.segmentId
    || exception.decision !== 'GPT_ALLOWED_TO_SUBSTITUTE_NON_GPT_AUDIT_FOR_THIS_PROJECT_SEGMENT'
    || exception.binding?.prompt?.path !== fingerprint.promptPath || exception.binding.prompt.sha256 !== fingerprint.promptSha256
    || exception.binding?.package?.path !== fingerprint.packagePath || exception.binding.package.sha256 !== fingerprint.packageSha256
    || !isDeepStrictEqual(exception.binding.inputMediaSha256,mediaSha256)
    || !isDeepStrictEqual(exception.binding.generationContract,fingerprint.generationContract)) throw new Error('GPT fallback exception is stale for the current fingerprint');
  if (exception.limitations?.doesNotAuthorizePaidGeneration !== true || exception.limitations?.doesNotAuthorizeNodeCreation !== true
    || exception.limitations?.doesNotAuthorizeNodeRun !== true || exception.limitations?.doesNotAuthorizeAutomaticRetry !== true
    || exception.limitations?.mustIdentifyReviewerAsGpt !== true) throw new Error('GPT fallback exception must remain audit-only');
  if (attestation.kind !== 'gpt_external_audit_attestation' || attestation.projectId !== state.projectId
    || attestation.segmentId !== authorization.segmentId || attestation.auditStage !== 'pre_generation'
    || attestation.decision !== 'PASS' || attestation.cleanZeroContext !== true || attestation.thirdParty !== false
    || !/^gpt(?:-|$)/i.test(attestation.model ?? '') || attestation.preflightId !== preflight.id
    || attestation.fingerprintSha256 !== fingerprint.sha256 || attestation.userExceptionId !== exception.id) throw new Error('GPT fingerprint audit does not match the current exception and preflight');
  if (await sha256File(join(root,attestation.auditBriefPath)) !== attestation.auditBriefSha256
    || await sha256File(join(root,attestation.reportPath)) !== attestation.reportSha256) throw new Error('GPT fingerprint audit evidence checksum changed');
}
export async function verifyGptFallbackApprovalBindings(root, approval, currentFingerprint) {
  if (approval.auditAuthorizationKind !== 'human_gpt_fallback') throw new Error('approval is not a human GPT fallback approval');
  const authorization = validateAuthorization(await readJson(join(root,'reviews',`${encodeURIComponent(approval.parentBatchApprovalId)}.json`)));
  if (authorization.segmentId !== approval.segmentId || authorization.fingerprintSha256 !== currentFingerprint.sha256 || authorization.preflightId !== approval.preflightId || authorization.independentAuditArtifactId !== approval.externalAuditAttestationId || authorization.gptAuditExceptionId !== approval.gptAuditExceptionId || authorization.gptFingerprintAuditId !== approval.gptFingerprintAuditId || authorization.libtvProjectUuid !== approval.libtvProjectUuid || authorization.nodeName !== approval.nodeName) throw new Error('GPT fallback authorization lost its exact approval binding');
  const state = await readJson(join(root,'project-state.json'));
  const preflight = await readJson(join(root,'runs',`${encodeURIComponent(approval.preflightId)}.json`));
  await verifyAudit(root,state,authorization,preflight);
  await verifyGptExceptionAndFingerprintAudit(root,state,authorization,preflight);
  return authorization;
}
export async function createGptFallbackPaidGenerationApproval(root, authorization, { id = `review-${randomUUID()}` } = {}) {
  validateAuthorization(authorization);
  const state = await readJson(join(root,'project-state.json'));
  if (state.projectId !== authorization.projectId) throw new Error('GPT fallback authorization projectId does not match');
  await assertStrictReadiness(root, state);
  const preflight = await readJson(join(root,'runs',`${encodeURIComponent(authorization.preflightId)}.json`));
  if (preflight.kind !== 'video_preflight' || preflight.status !== 'READY' || preflight.segmentId !== authorization.segmentId || preflight.fingerprint.sha256 !== authorization.fingerprintSha256) throw new Error('GPT fallback authorization requires the exact ready preflight');
  const contract = preflight.fingerprint.generationContract;
  if (contract.provider !== 'libtv' || contract.projectUuid !== authorization.libtvProjectUuid || contract.nodeName !== authorization.nodeName) throw new Error('GPT fallback authorization requires the exact approved LibTV contract');
  await verifyAudit(root,state,authorization,preflight);
  await verifyGptExceptionAndFingerprintAudit(root,state,authorization,preflight);
  const current = await inspectVideoPackage(root,authorization.segmentId,{executor:'libtv',libtvProjectUuid:authorization.libtvProjectUuid,nodeName:authorization.nodeName});
  if (current.fingerprint.sha256 !== authorization.fingerprintSha256) throw new Error('GPT fallback preflight fingerprint changed');
  await assertGenerationFailureGate(root, current.fingerprint);
  const executionControlEvidence = await requireExecutionControlEvidence(root, current.fingerprint);
  const approval = {id,kind:'paid_generation_approval',actor:'delegated_batch_policy',decision:'approved',segmentId:authorization.segmentId,preflightId:authorization.preflightId,fingerprint:current.fingerprint,parentBatchApprovalId:authorization.id,externalAuditAttestationId:authorization.independentAuditArtifactId,gptAuditExceptionId:authorization.gptAuditExceptionId,gptFingerprintAuditId:authorization.gptFingerprintAuditId,auditAuthorizationKind:'human_gpt_fallback',executor:'libtv',libtvProjectUuid:authorization.libtvProjectUuid,nodeName:authorization.nodeName,maxPaidAttempts:1,executionControlEvidence,consumedByRunId:null,consumedAt:null,createdAt:new Date().toISOString()};
  return withProjectLock(root,async()=>{
    await recoverJsonTransactions(root);
    await assertStrictReadiness(root, await readJson(join(root,'project-state.json')));
    const authorizationPath = join(root,'reviews',`${encodeURIComponent(authorization.id)}.json`);
    const approvalPath = join(root,'reviews',`${encodeURIComponent(id)}.json`);
    for (const path of [authorizationPath, approvalPath]) {
      await readJson(path).then(()=>{throw new Error('authorization or approval already exists');},error=>{if(error.code!=='ENOENT')throw error;});
    }
    const ledger = await prepareExecutionLedgerAppend(root, {
      type: 'paid_approval.granted', occurredAt: approval.createdAt,
      actor: { kind: 'delegated_policy', id: null }, segmentId: authorization.segmentId,
      correlationId: approval.id, causationId: authorization.id,
      idempotencyKey: `paid_approval.granted:${approval.id}`,
      references: [
        { kind: 'paid_generation_approval', id: approval.id, path: `reviews/${encodeURIComponent(approval.id)}.json` },
        { kind: 'human_generation_authorization', id: authorization.id, path: `reviews/${encodeURIComponent(authorization.id)}.json` },
        { kind: 'video_preflight', id: preflight.id, path: `runs/${encodeURIComponent(preflight.id)}.json` }
      ],
      facts: {
        approvalId: approval.id, preflightId: preflight.id,
        fingerprintSha256: approval.fingerprint.sha256, executor: approval.executor,
        maxPaidAttempts: approval.maxPaidAttempts, authorizationKind: approval.auditAuthorizationKind
      }
    });
    await commitJsonTransaction(root, `paid-approval-gpt-fallback-${approval.id}`, [
      { path: authorizationPath, value: authorization },
      { path: approvalPath, value: approval },
      ...ledger.writes
    ]);
    return approval;
  });
}
