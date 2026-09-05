#!/usr/bin/env node
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runSubmitReview, runApprove, runReject } from './commands/review.js';
import { runSegments } from './commands/segments.js';
import { runAssets } from './commands/assets.js';
import { runGenerateAssets } from './commands/generate-assets.js';
import { runCompileSeedance } from './commands/compile-seedance.js';
import { runCompileSeedanceClips } from './commands/compile-seedance-clips.js';
import { runCompileSeedance25Standard30 } from './commands/compile-seedance25-standard30.js';
import { runCompileSeedance25Standard } from './commands/compile-seedance25-standard.js';
import { runPrepareSeedance25Standard30LibTvCanvas } from './commands/prepare-seedance25-standard30-libtv-canvas.js';
import { runPrepareSeedance25StandardLibTvCanvas } from './commands/prepare-seedance25-standard-libtv-canvas.js';
import { runCompileSeedance25VideoEdit } from './commands/compile-seedance25-video-edit.js';
import { runPrepareSeedance25VideoEditLibTvCanvas } from './commands/prepare-seedance25-video-edit-libtv-canvas.js';
import { runVerifyLibTvVideoCanvas } from './commands/verify-libtv-video-canvas.js';
import { runCompileSeedance20Standard15 } from './commands/compile-seedance20-standard15.js';
import { runPrepareSeedance20Standard15LibTvCanvas } from './commands/prepare-seedance20-standard15-libtv-canvas.js';
import { runPrepareHandoff } from './commands/prepare-handoff.js';
import { runRecordHandoff } from './commands/record-handoff.js';
import { runReviewHandoff } from './commands/review-handoff.js';
import { runRules } from './commands/rules.js';
import { runRegisterArtifact } from './commands/register-artifact.js';
import { runGenerateVideoCommand } from './commands/generate-video-cli.js';
import { runReviewAssetManifest } from './commands/review-asset-manifest.js';
import { runRebindAssetManifest } from './commands/rebind-asset-manifest.js';
import { runApprovePaidGeneration } from './commands/approve-paid-generation.js';
import { runReconcileVideoSubmit } from './commands/reconcile-video-submit.js';
import { runReconcileLibTvRun } from './commands/reconcile-libtv-run.js';
import { runVerifyDelivery } from './commands/verify-delivery.js';
import { runDoctor } from './commands/doctor.js';
import { runNext } from './commands/next.js';
import { runQualityReview } from './commands/quality-review.js';
import { runSegmentContract } from './commands/segment-contract.js';
import { runNarrationLint } from './commands/narration-lint.js';
import { runAssetVisualAudit } from './commands/asset-visual-audit.js';
import { runShotStrategy } from './commands/shot-strategy.js';
import { runApproveBatchGeneration } from './commands/approve-batch-generation.js';
import { runAttestExternalAudit } from './commands/attest-external-audit.js';
import { runDerivePaidGeneration } from './commands/derive-paid-generation.js';
import { runExternalAudit } from './commands/external-audit.js';
import { runBatchNext } from './commands/batch-next.js';
import { runGenerateLibTvVideo } from './commands/generate-libtv-video.js';
import { runPrepareVideoAudit } from './commands/prepare-video-audit.js';
import { runPrepareExternalAuditBrief } from './commands/prepare-external-audit-brief.js';
import { runBatchRun } from './commands/batch-run.js';
import { runRecordGenerationFailure } from './commands/record-generation-failure.js';
import { runApproveExternalAuditOnly } from './commands/approve-external-audit-only.js';
import { runIndependentExternalAudit } from './commands/independent-external-audit.js';
import { runCheckpointApprove } from './commands/checkpoint-approve.js';
import { runSegmentSummary } from './commands/segment-summary.js';
import { runSegmentContext } from './commands/segment-context.js';
import { runApproveGptFallbackGeneration } from './commands/approve-gpt-fallback-generation.js';
import { runImagePromptPlan } from './commands/image-prompt-plan.js';
import { runComposeCharacterBoard } from './commands/compose-character-board.js';
import { runStoryPlan } from './commands/story-plan.js';
import { runCreativeBrief } from './commands/creative-brief.js';
import { runRepairStoryboardPanels } from './commands/repair-storyboard-panels.js';
import { runComposeAssetGrid } from './commands/compose-asset-grid.js';
import { runComposeStoryboardContactSheet } from './commands/compose-storyboard-contact-sheet.js';
import { runNormalizeStoryboardPanel } from './commands/normalize-storyboard-panel.js';
import { runRegisterStoryboardPanel } from './commands/register-storyboard-panel.js';
import { runBuildStoryboardPanelNormalizationPlans } from './commands/build-storyboard-panel-normalization-plans.js';
import { runNormalizeStoryboardPanelBatch } from './commands/normalize-storyboard-panel-batch.js';
import { runRegisterStoryboardPanelRawFromPlan } from './commands/register-storyboard-panel-raw-from-plan.js';
import { runRegisterStoryboardPanelFinalBatch } from './commands/register-storyboard-panel-final-batch.js';
import { runComposeColorBoard } from './commands/compose-color-board.js';
import { runPerformanceCapsule } from './commands/performance-capsule.js';
import { runDirectorRoute } from './commands/director-route.js';
import { runDirectorCapsule } from './commands/director-capsule.js';
import { runDepthPlan } from './commands/depth-plan.js';
import { runAuditHarness } from './commands/audit-harness.js';
import { runSpatialControlModel } from './commands/spatial-control-model.js';
import { runVisualControlMethod } from './commands/visual-control-method.js';
import { runReferenceWorkflow } from './commands/reference-workflow.js';
import { runIntakeVideo } from './commands/intake-video.js';
import { runTraceReport } from './commands/trace-report.js';
import { runSourceFactAnalysis } from './commands/source-fact-analysis.js';
import { runTaskCheckpoint } from './commands/task-checkpoint.js';
import { runSourceComparatorAudit } from './commands/source-comparator-audit.js';
import { runRepairArtifactLineage } from './commands/repair-artifact-lineage.js';
import { runAutoLockArtifact } from './commands/auto-lock-artifact.js';
import { runDirectorInterview } from './commands/director-interview.js';
import { runRecordGenerationRemediation } from './commands/record-generation-remediation.js';
import { runLedgerStatus } from './commands/ledger-status.js';
import { runLedgerPortfolio } from './commands/ledger-portfolio.js';
import { runRecordExecutionObservation } from './commands/record-execution-observation.js';
import { runDeriveExecutionObservation } from './commands/derive-execution-observation.js';
import { runPrepareGate5Rework } from './commands/prepare-gate5-rework.js';
import { runGate5ReworkProgress } from './commands/gate5-rework-progress.js';
import { runHistoricalReplayBaseline } from './commands/historical-replay-baseline.js';
import { runLegacyEvidenceAdapter } from './commands/legacy-evidence-adapter.js';
import { runShadowFunnelProjection } from './commands/shadow-funnel-projection.js';
import { runAuthorCanonicalPromptSource } from './commands/author-canonical-prompt-source.js';
import { runRealismAuthority } from './commands/realism-authority.js';
import { runReconcileHandoff } from './commands/reconcile-handoff.js';
import { runKocRemakePlan } from './commands/koc-remake-plan.js';
import { runKocSourceLedger } from './commands/koc-source-ledger.js';
import { runKocMediaPrepare } from './commands/koc-media-prepare.js';
import { runKocReinsert } from './commands/koc-reinsert.js';
import { runKocCanvasBatch } from './commands/koc-canvas-batch.js';

const [command, ...args] = process.argv.slice(2);
const commands = new Map([
  ['init', runInit],
  ['status', runStatus],
  ['ledger-status', runLedgerStatus],
  ['ledger-portfolio', runLedgerPortfolio],
  ['record-execution-observation', runRecordExecutionObservation],
  ['derive-execution-observation', runDeriveExecutionObservation],
  ['prepare-gate5-rework', runPrepareGate5Rework],
  ['gate5-rework-progress', runGate5ReworkProgress],
  ['historical-replay-baseline', runHistoricalReplayBaseline],
  ['legacy-evidence-adapter', runLegacyEvidenceAdapter],
  ['shadow-funnel-projection', runShadowFunnelProjection],
  ['author-canonical-prompt-source', runAuthorCanonicalPromptSource],
  ['realism-authority', runRealismAuthority],
  ['reconcile-handoff', runReconcileHandoff],
  ['koc-remake-plan', runKocRemakePlan],
  ['koc-source-ledger', runKocSourceLedger],
  ['koc-media-prepare', runKocMediaPrepare],
  ['koc-reinsert', runKocReinsert],
  ['koc-canvas-batch', runKocCanvasBatch],
  ['submit-review', runSubmitReview],
  ['approve', runApprove],
  ['reject', runReject],
  ['segments', runSegments],
  ['assets', runAssets],
  ['generate-assets', runGenerateAssets],
  ['compile-seedance', runCompileSeedance],
  ['compile-seedance-clips', runCompileSeedanceClips],
  ['compile-seedance25-standard30', runCompileSeedance25Standard30],
  ['compile-seedance25-standard', runCompileSeedance25Standard],
  ['prepare-seedance25-standard30-libtv-canvas', runPrepareSeedance25Standard30LibTvCanvas],
  ['prepare-seedance25-standard-libtv-canvas', runPrepareSeedance25StandardLibTvCanvas],
  ['compile-seedance25-video-edit', runCompileSeedance25VideoEdit],
  ['prepare-seedance25-video-edit-libtv-canvas', runPrepareSeedance25VideoEditLibTvCanvas],
  ['verify-libtv-video-canvas', runVerifyLibTvVideoCanvas],
  ['compile-seedance20-standard15', runCompileSeedance20Standard15],
  ['prepare-seedance20-standard15-libtv-canvas', runPrepareSeedance20Standard15LibTvCanvas],
  ['prepare-handoff', runPrepareHandoff],
  ['review-handoff', runReviewHandoff],
  ['record-handoff', runRecordHandoff],
  ['rules', runRules],
  ['register-artifact', runRegisterArtifact],
  ['generate-video', runGenerateVideoCommand],
  ['approve-asset-manifest', runReviewAssetManifest],
  ['rebind-asset-manifest', runRebindAssetManifest],
  ['approve-paid-generation', runApprovePaidGeneration],
  ['reconcile-video-submit', runReconcileVideoSubmit],
  ['reconcile-libtv-run', runReconcileLibTvRun],
  ['verify-delivery', runVerifyDelivery],
  ['doctor', runDoctor],
  ['next', runNext],
  ['quality-review', runQualityReview],
  ['segment-contract', runSegmentContract],
  ['narration-lint', runNarrationLint],
  ['asset-visual-audit', runAssetVisualAudit],
  ['shot-strategy', runShotStrategy],
  ['approve-batch-generation', runApproveBatchGeneration],
  ['attest-external-audit', runAttestExternalAudit],
  ['derive-paid-generation', runDerivePaidGeneration],
  ['external-audit', runExternalAudit],
  ['batch-next', runBatchNext],
  ['generate-libtv-video', runGenerateLibTvVideo],
  ['prepare-video-audit', runPrepareVideoAudit],
  ['prepare-external-audit-brief', runPrepareExternalAuditBrief],
  ['batch-run', runBatchRun],
  ['record-generation-failure', runRecordGenerationFailure],
  ['record-generation-remediation', runRecordGenerationRemediation],
  ['approve-external-audit-only', runApproveExternalAuditOnly],
  ['independent-external-audit', runIndependentExternalAudit],
  ['checkpoint-approve', runCheckpointApprove],
  ['approve-gpt-fallback-generation', runApproveGptFallbackGeneration],
  ['segment-summary', runSegmentSummary],
  ['segment-context', runSegmentContext],
  ['image-prompt-plan', runImagePromptPlan],
  ['compose-character-board', runComposeCharacterBoard],
  ['story-plan', runStoryPlan],
  ['creative-brief', runCreativeBrief],
  ['repair-storyboard-panels', runRepairStoryboardPanels],
  ['compose-asset-grid', runComposeAssetGrid],
  ['compose-storyboard-contact-sheet', runComposeStoryboardContactSheet],
  ['normalize-storyboard-panel', runNormalizeStoryboardPanel],
  ['register-storyboard-panel', runRegisterStoryboardPanel],
  ['build-storyboard-panel-normalization-plans', runBuildStoryboardPanelNormalizationPlans],
  ['normalize-storyboard-panel-batch', runNormalizeStoryboardPanelBatch],
  ['register-storyboard-panel-raw-from-plan', runRegisterStoryboardPanelRawFromPlan],
  ['register-storyboard-panel-final-batch', runRegisterStoryboardPanelFinalBatch],
  ['compose-color-board', runComposeColorBoard],
  ['performance-capsule', runPerformanceCapsule],
  ['director-route', runDirectorRoute],
  ['director-capsule', runDirectorCapsule],
  ['depth-plan', runDepthPlan],
  ['audit-harness', runAuditHarness],
  ['spatial-control-model', runSpatialControlModel],
  ['visual-control-method', runVisualControlMethod],
  ['reference-workflow', runReferenceWorkflow],
  ['intake-video', runIntakeVideo],
  ['director-interview', runDirectorInterview],
  ['trace-report', runTraceReport],
  ['source-fact-analysis', runSourceFactAnalysis],
  ['source-comparator-audit', runSourceComparatorAudit],
  ['repair-artifact-lineage', runRepairArtifactLineage],
  ['auto-lock-artifact', runAutoLockArtifact],
  ['task-checkpoint', runTaskCheckpoint]
]);

try {
  const run = commands.get(command);
  if (!run) throw new Error(`unknown command: ${command ?? ''}`);
  console.log(JSON.stringify(await run(args), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
