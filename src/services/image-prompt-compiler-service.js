import { createHash } from 'node:crypto';
import { canonicalJson, imagePromptIrFingerprint } from '../domain/image-prompt-ir.js';
import { assertImageModelProfile } from '../domain/image-model-profile.js';
import { requireCleanImagePromptIr } from './image-prompt-lint-service.js';

function lines(value, prefix = '- ') {
  if (Array.isArray(value)) return value.map(item => `${prefix}${item}`).join('\n');
  return Object.entries(value).map(([key, item]) => `${prefix}${key}: ${typeof item === 'object' ? canonicalJson(item) : item}`).join('\n');
}

function inputBlock(bindings) {
  if (bindings.length === 0) return 'No media is bound to this request. Every required visual fact is fully defined in the text contracts below.';
  return bindings.map(binding => [
    `${binding.tag} (${binding.artifactId})`,
    `subject selector: ${binding.subjectSelector}`,
    `use only for: ${binding.primaryRole}; transfer ${binding.transfer.join(', ')}`,
    `must ignore: ${binding.ignore.join(', ')}`,
    `bound file: ${binding.path}; sha256: ${binding.sha256}`
  ].join('\n')).join('\n\n');
}

export function compileImagePrompt(ir, modelProfile) {
  assertImageModelProfile(modelProfile);
  const lint = requireCleanImagePromptIr(ir, modelProfile);
  const prompt = [
    'TASK AND PURPOSE',
    `${ir.operation.toUpperCase()} one ${ir.assetType}. ${ir.purpose}`,
    '',
    'RESPONSIBILITY',
    ir.responsibility,
    `Must not control: ${ir.mustNotControl.join(', ')}`,
    '',
    'GLOBAL VISUAL STYLE CONTRACT',
    `${ir.visualStyleContract.id} v${ir.visualStyleContract.version}: ${ir.visualStyleContract.description}`,
    lines(ir.visualStyleContract.locks),
    '',
    'SUBJECT CONTRACT',
    lines(ir.subjectContract),
    '',
    'INPUT BINDINGS',
    inputBlock(ir.inputBindings),
    '',
    ...(ir.sourceReferenceContract ? [
      'SOURCE REFERENCE CONTRACT',
      `referenceIntent: ${ir.referenceIntent}`,
      `sourceRole: ${ir.sourceRole}`,
      lines(ir.sourceReferenceContract),
      ''
    ] : []),
    ...(ir.failureRemediationBinding ? [
      'FAILURE REMEDIATION BINDING',
      lines(ir.failureRemediationBinding),
      ''
    ] : []),
    'OUTPUT STRUCTURE',
    lines(ir.compositionContract),
    lines(ir.outputSpec),
    '',
    'PHOTOGRAPHY AND ART DIRECTION',
    lines(ir.photographyContract),
    '',
    ...(ir.editScope ? [
      'EDIT SCOPE',
      `Mode: ${ir.editScope.mode}`,
      `CHANGE: ${ir.editScope.change}`,
      `CONTINUITY AFTER CHANGE: ${ir.editScope.continuityAfterChange}`,
      ...(ir.viewChangeMap ? [
        `SOURCE VIEW: ${ir.viewChangeMap.sourceView}`,
        `TARGET VIEW: ${ir.viewChangeMap.targetView}`,
        'VIEW-CHANGE ANCHORS',
        ...ir.viewChangeMap.anchors.map(anchor => `- ${anchor.anchorId}: ${anchor.sourcePosition} -> ${anchor.targetPosition}`)
      ] : []),
      ''
    ] : []),
    'PRESERVE',
    ir.preserve.length > 0 ? lines(ir.preserve) : '- No pixels are bound for preservation; use the complete text contracts in this request.',
    '',
    'HARD CONSTRAINTS',
    lines(ir.constraints),
    '',
    'EXCLUDE',
    lines(ir.avoid),
    '',
    'VISIBLE ACCEPTANCE CHECKS',
    lines(ir.acceptanceChecks)
  ].join('\n');
  const promptSha256 = createHash('sha256').update(prompt).digest('hex');
  const irFingerprint = imagePromptIrFingerprint(ir);
  const immutable = {
    id: `request-${ir.atomicAssetId}`,
    assetId: ir.assetId,
    atomicAssetId: ir.atomicAssetId,
    assetType: ir.assetType,
    segmentId: ir.segmentId ?? null,
    operation: ir.operation,
    profileId: ir.profileId,
    modelProfileId: modelProfile.id,
    executionSurface: modelProfile.executionSurface,
    templateSource: ir.templateSource,
    skillsApplied: [...ir.skillsApplied],
    ...(ir.skillRoutingDecision ? { skillRoutingDecision: structuredClone(ir.skillRoutingDecision) } : {}),
    selfContainedContextVersion: ir.selfContainedContextVersion,
    visualStyleContract: structuredClone(ir.visualStyleContract),
    inputBindings: ir.inputBindings.map(binding => ({ ...binding, transfer: [...binding.transfer], ignore: [...binding.ignore] })),
    ...(ir.sourceReferenceContract ? {
      referenceIntent: ir.referenceIntent,
      sourceRole: ir.sourceRole,
      sourceReferenceContract: structuredClone(ir.sourceReferenceContract)
    } : {}),
    ...(ir.failureRemediationBinding ? {
      failureRemediationBinding: structuredClone(ir.failureRemediationBinding)
    } : {}),
    ...(ir.editScope ? { editScope: structuredClone(ir.editScope) } : {}),
    ...(ir.viewChangeMap ? { viewChangeMap: structuredClone(ir.viewChangeMap) } : {}),
    ...(ir.derivedExecutionPanels ? { derivedExecutionPanels: structuredClone(ir.derivedExecutionPanels) } : {}),
    ...(ir.profileId === 'storyboard_execution_panel_v1' ? {
      storyboardPanel: {
        storyboardSequenceId: ir.compositionContract.sequenceId,
        panelIndex: ir.compositionContract.panelIndex,
        shotId: ir.compositionContract.shotId,
        beatStartSec: ir.compositionContract.beatStartSec,
        beatEndSec: ir.compositionContract.beatEndSec,
        representativeFrameSec: ir.compositionContract.representativeFrameSec,
        revision: ir.compositionContract.revision ?? 1,
        rawCandidateAssetId: `${ir.atomicAssetId}-candidate`,
        rawCandidateVisualAuditId: `visual-audit-${ir.atomicAssetId}-candidate`,
        finalAssetId: ir.atomicAssetId,
        finalVisualAuditId: `visual-audit-${ir.atomicAssetId}`
      }
    } : {}),
    outputSpec: structuredClone(ir.outputSpec),
    prompt,
    promptSha256,
    irFingerprint,
    count: 1,
    autoRetry: false,
    modelFallbackPlan: [...ir.modelFallbackPlan]
  };
  const requestFingerprint = createHash('sha256').update(canonicalJson(immutable)).digest('hex');
  return { ...immutable, status: 'PREPARED', requestFingerprint, lint };
}
