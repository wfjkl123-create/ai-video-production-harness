import { assertArtifact } from './artifact.js';
import { assertAssetSelection, assertRemakeControlSelection, assertWorkflowProfile } from './workflow-profile.js';
import { REALISM_CONTRACT_VERSIONS } from './realism-contracts.js';

const requiredFields = ['projectId', 'phase', 'activeSegmentId', 'blockedReason', 'artifacts', 'updatedAt'];

const EXECUTION_MODES = new Set(['parallel', 'sequential']);
const INGRESS_POLICY_VERSION = 'ingress-route-v1';
const INGRESS_REASONS = new Set([
  'explicit_opt_out',
  'informational_intent',
  'video_input',
  'video_input_and_creation_intent',
  'video_creation_intent',
  'non_video_request'
]);
const INPUT_TYPES = new Set(['video', 'image', 'audio', 'text', 'binary']);
const REFERENCE_ROLE_STATUSES = new Set([
  'not_applicable',
  'awaiting_reference_role',
  'awaiting_source_video',
  'inspiration',
  'authority'
]);
const EXECUTION_CLASSES = new Set(['bypass', 'creative_production', 'mechanical_asset_prompt']);
const DIRECTION_REVISION_STATUSES = new Set(['awaiting_answers', 'confirmed']);

function nonEmptyUniqueStrings(value, field, allowedValues) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') throw new TypeError(`${field}[${index}] must be a non-empty string`);
    if (allowedValues && !allowedValues.has(item)) throw new TypeError(`${field}[${index}] is invalid`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must not contain duplicates`);
}

function assertRouteDecision(value, ingressPolicyVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('routeDecision must be an object');
  if (ingressPolicyVersion === undefined) throw new TypeError('ingressPolicyVersion is required when routeDecision is present');
  if (value.policyVersion !== ingressPolicyVersion) throw new TypeError('routeDecision.policyVersion must match ingressPolicyVersion');
  if (typeof value.harnessRequired !== 'boolean') throw new TypeError('routeDecision.harnessRequired must be a boolean');
  if (!INGRESS_REASONS.has(value.reason)) throw new TypeError('routeDecision.reason is invalid');
  nonEmptyUniqueStrings(value.inputTypes, 'routeDecision.inputTypes', INPUT_TYPES);
  nonEmptyUniqueStrings(value.sourceVideoIds, 'routeDecision.sourceVideoIds');
  if (value.assetInputIds !== undefined) nonEmptyUniqueStrings(value.assetInputIds, 'routeDecision.assetInputIds');
  if (!REFERENCE_ROLE_STATUSES.has(value.referenceRoleStatus)) throw new TypeError('routeDecision.referenceRoleStatus is invalid');
  if (value.executionClass !== undefined && !EXECUTION_CLASSES.has(value.executionClass)) throw new TypeError('routeDecision.executionClass is invalid');
  if (value.executionClass === 'mechanical_asset_prompt' && (!value.harnessRequired || value.referenceRoleStatus !== 'authority')) {
    throw new TypeError('mechanical_asset_prompt requires a Harness authority route');
  }
  if (!value.harnessRequired && value.referenceRoleStatus !== 'not_applicable') {
    throw new TypeError('routeDecision.referenceRoleStatus must be not_applicable when Harness is bypassed');
  }
  return value;
}

function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= monthLengths[month - 1]
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 60
    && (offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59));
}

export function assertProjectState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('project state must be an object');
  for (const field of requiredFields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${field} is required`);
  }
  if (typeof value.projectId !== 'string' || value.projectId.trim().length === 0) throw new TypeError('projectId must be a non-empty string');
  if (typeof value.phase !== 'string' || value.phase.trim().length === 0) throw new TypeError('phase must be a non-empty string');
  if (value.activeSegmentId !== null && (typeof value.activeSegmentId !== 'string' || value.activeSegmentId.trim().length === 0)) {
    throw new TypeError('activeSegmentId must be null or a non-empty string');
  }
  if (value.blockedReason !== null && (typeof value.blockedReason !== 'string' || value.blockedReason.trim().length === 0)) {
    throw new TypeError('blockedReason must be null or a non-empty string');
  }
  if (!Array.isArray(value.artifacts)) throw new TypeError('artifacts must be an array');
  value.artifacts.forEach(assertArtifact);
  if (value.workflowVersion !== undefined && ![1, 2].includes(value.workflowVersion)) throw new TypeError('workflowVersion must be 1 or 2');
  if (value.realismContractsVersion !== undefined && !REALISM_CONTRACT_VERSIONS.includes(value.realismContractsVersion)) {
    throw new TypeError('realismContractsVersion must be 1 or 2');
  }
  if (value.realismContractsWriteMode !== undefined && !['enabled', 'read_only'].includes(value.realismContractsWriteMode)) {
    throw new TypeError('realismContractsWriteMode must be enabled or read_only');
  }
  if (value.realismContractsVersion === 2 && value.realismContractsWriteMode === undefined) {
    throw new TypeError('realismContractsWriteMode is required when realismContractsVersion is 2');
  }
  if (value.ingressPolicyVersion !== undefined && value.ingressPolicyVersion !== INGRESS_POLICY_VERSION) {
    throw new TypeError(`ingressPolicyVersion must be ${INGRESS_POLICY_VERSION}`);
  }
  if (value.routeDecision !== undefined) assertRouteDecision(value.routeDecision, value.ingressPolicyVersion);
  if (value.videoGovernanceVersion !== undefined && value.videoGovernanceVersion !== 2) {
    throw new TypeError('videoGovernanceVersion must be 2');
  }
  if (value.directionRevision !== undefined) {
    const revision = value.directionRevision;
    if (!revision || typeof revision !== 'object' || Array.isArray(revision)) throw new TypeError('directionRevision must be an object');
    if (!Number.isInteger(revision.revision) || revision.revision < 1) throw new TypeError('directionRevision.revision must be positive');
    if (!DIRECTION_REVISION_STATUSES.has(revision.status)) throw new TypeError('directionRevision.status is invalid');
    for (const field of ['id', 'routeFingerprint', 'reason', 'updatedAt']) {
      if (typeof revision[field] !== 'string' || revision[field].trim() === '') throw new TypeError(`directionRevision.${field} must be a non-empty string`);
    }
    nonEmptyUniqueStrings(revision.invalidatedArtifactIds ?? [], 'directionRevision.invalidatedArtifactIds');
    if (revision.interviewInputFingerprint !== undefined
      && (typeof revision.interviewInputFingerprint !== 'string' || revision.interviewInputFingerprint.trim() === '')) {
      throw new TypeError('directionRevision.interviewInputFingerprint must be a non-empty string');
    }
  }
  if (value.verifiedCapabilityManifestId !== undefined && value.verifiedCapabilityManifestId !== null
    && (typeof value.verifiedCapabilityManifestId !== 'string' || value.verifiedCapabilityManifestId.trim() === '')) {
    throw new TypeError('verifiedCapabilityManifestId must be null or a non-empty string');
  }
  if (value.directorRoutingVersion !== undefined && value.directorRoutingVersion !== 1) throw new TypeError('directorRoutingVersion must be 1');
  if (value.workflowProfile !== undefined) assertWorkflowProfile(value.workflowProfile);
  if (value.assetSelection !== undefined) assertAssetSelection(value.assetSelection);
  if (value.remakeControlSelection !== undefined) assertRemakeControlSelection(value.remakeControlSelection);
  if (value.executionMode != null && !EXECUTION_MODES.has(value.executionMode)) {
    throw new TypeError(`executionMode must be null, 'parallel', or 'sequential'`);
  }
  if (!isRfc3339DateTime(value.updatedAt)) throw new TypeError('updatedAt must be an RFC3339 date-time string');
  return value;
}

export { EXECUTION_MODES };
