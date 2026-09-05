import { join } from 'node:path';
import { assertBatchGenerationApproval } from '../domain/batch-generation.js';
import { readJson } from '../storage/json-store.js';
import { createVideoPreflight } from './video-generation-service.js';
import { preparePreGenerationAuditBrief } from './external-audit-brief-service.js';
import { executeExternalAudit } from './external-audit-execution-service.js';
import { createDerivedPaidGenerationApproval } from './batch-generation-service.js';
import { executeLibTvVideo } from './libtv-video-generation-service.js';
import { prepareVideoAuditPackage } from './video-audit-package-service.js';
import { planBatchNext } from './batch-orchestrator-service.js';

const DEFAULT_OPERATIONS = {
  createPreflight: (root, next) => createVideoPreflight(root, next.segmentId, {
    executor: next.executor,
    libtvProjectUuid: next.libtvProjectUuid,
    nodeName: next.nodeName
  }),
  preparePreAuditBrief: (root, next) => preparePreGenerationAuditBrief(root, next.preflightId),
  runExternalAudit: (root, input, options) => executeExternalAudit(root, input, options),
  deriveApproval: (root, input) => createDerivedPaidGenerationApproval(root, input),
  runLibTvVideo: (root, input, options) => executeLibTvVideo(root, input, options),
  prepareVideoAudit: (root, next, options) => prepareVideoAuditPackage(root, next.runId, options)
};

export async function runBatchAutonomously(root, batchApprovalId, options = {}) {
  const batch = assertBatchGenerationApproval(await readJson(join(root, 'reviews', `${encodeURIComponent(batchApprovalId)}.json`)));
  const operations = { ...DEFAULT_OPERATIONS, ...(options.operations ?? {}) };
  const planner = options.planner ?? planBatchNext;
  const maxSteps = options.maxSteps ?? Math.max(20, batch.segments.length * 10);
  const history = [];
  for (let index = 0; index < maxSteps; index += 1) {
    const next = await planner(root, batch.id);
    history.push(next);
    if (['COMPLETE', 'STOPPED', 'BLOCKED', 'WAITING'].includes(next.status)) return { batchApprovalId: batch.id, status: next.status, next, history };
    switch (next.action) {
      case 'CREATE_VIDEO_PREFLIGHT':
        await operations.createPreflight(root, {
          ...next,
          executor: batch.executor,
          libtvProjectUuid: batch.libtvProjectUuid,
          nodeName: `${next.segmentId}-seedance-video`
        }); break;
      case 'PREPARE_PRE_GENERATION_AUDIT_BRIEF':
        await operations.preparePreAuditBrief(root, next); break;
      case 'RUN_PRE_GENERATION_EXTERNAL_AUDIT':
        await operations.runExternalAudit(root, {
          batchApprovalId: batch.id, segmentId: next.segmentId, auditStage: 'pre_generation',
          preflightId: next.preflightId, promptPath: next.promptPath,
          model: batch.externalAuditModel, maxBudgetUsd: batch.externalAuditBudget.perCallLimit
        }, options.externalAuditOptions); break;
      case 'DERIVE_PAID_GENERATION_APPROVAL':
        await operations.deriveApproval(root, {
          batchApprovalId: batch.id, segmentId: next.segmentId, preflightId: next.preflightId,
          externalAuditAttestationId: next.externalAuditAttestationId
        }); break;
      case 'RUN_LIBTV_VIDEO_ONCE':
        if (options.userAuthorizedVideoGeneration !== true) {
          return {
            batchApprovalId: batch.id,
            status: 'WAITING',
            next: {
              status: 'WAITING',
              action: 'USER_CANVAS_GENERATION',
              segmentId: next.segmentId,
              paidApprovalId: next.paidApprovalId,
              reviewSurface: 'libtv_canvas',
              assistantMaySubmitByDefault: false,
              instruction: '在 LibTV/立布 TV 画布内审核当前视频节点并由用户点击“生成视频”；系统不自动提交。'
            },
            history
          };
        }
        await operations.runLibTvVideo(root, {
          segmentId: next.segmentId, paidApprovalId: next.paidApprovalId
        }, options.libTvOptions); break;
      case 'PREPARE_VIDEO_AUDIT_PACKAGE':
        await operations.prepareVideoAudit(root, next, options.videoAuditOptions); break;
      case 'RUN_POST_GENERATION_EXTERNAL_AUDIT':
        await operations.runExternalAudit(root, {
          batchApprovalId: batch.id, segmentId: next.segmentId, auditStage: 'post_generation',
          videoRunId: next.runId, promptPath: next.promptPath,
          model: batch.externalAuditModel, maxBudgetUsd: batch.externalAuditBudget.perCallLimit
        }, options.externalAuditOptions); break;
      default:
        throw new Error(`batch runner does not implement action ${next.action}`);
    }
  }
  throw new Error(`batch runner exceeded ${maxSteps} steps without reaching a terminal or waiting state`);
}
