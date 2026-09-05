import { randomUUID } from 'node:crypto';

const STATUSES = new Set(['candidate', 'hard']);
const CONTEXT_FIELDS = ['product', 'assetType', 'shotType', 'motionType', 'spaceComplexity'];

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  value.forEach((entry, index) => text(entry, `${field}[${index}]`));
  if (new Set(value).size !== value.length) throw new TypeError(`${field} entries must be unique`);
}

function timestamp(value, field) {
  text(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new TypeError(`${field} must be an RFC3339 date-time`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]
    || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) {
    throw new TypeError(`${field} must be an RFC3339 date-time`);
  }
  const milliseconds = Number(`0.${fraction || '0'}`) * 1000;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), milliseconds);
  const offset = zone.toLowerCase() === 'z' ? 0 : (offsetHour * 60 + offsetMinute) * 60_000 * (sign === '+' ? 1 : -1);
  return date.getTime() + (second === 60 ? 1000 : 0) - offset;
}

function assertTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new TypeError('trigger must be an object');
  for (const field of CONTEXT_FIELDS) stringList(trigger[field], `trigger.${field}`);
  const range = trigger.peopleCountRange;
  if (!range || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 0 || range.max < range.min) {
    throw new TypeError('trigger.peopleCountRange must contain an ordered non-negative integer min and max');
  }
}

export function assertRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new TypeError('rule must be an object');
  text(rule.id, 'id');
  if (!STATUSES.has(rule.status)) throw new TypeError('status must be candidate or hard');
  assertTrigger(rule.trigger);
  for (const field of ['symptom', 'reason', 'correction', 'sourceProject', 'sourceSegment']) text(rule[field], field);
  stringList(rule.evidence, 'evidence');
  stringList(rule.forbidden, 'forbidden');
  if (!Array.isArray(rule.applications)) throw new TypeError('applications must be an array');
  for (const application of rule.applications) {
    text(application.runId, 'application.runId');
    timestamp(application.appliedAt, 'application.appliedAt');
    if (!Number.isInteger(application.revision) || application.revision < 1) {
      throw new TypeError('application.revision must be a positive integer');
    }
    if (application.reviewId !== undefined) text(application.reviewId, 'application.reviewId');
  }
  if (rule.verificationReviewId !== null) text(rule.verificationReviewId, 'verificationReviewId');
  if (rule.status === 'hard' && rule.verificationReviewId === null) throw new TypeError('hard rule requires verificationReviewId');
  if (rule.status === 'hard' && !rule.applications.some(({ reviewId, revision }) => (
    reviewId === rule.verificationReviewId && revision === rule.revision
  ))) {
    throw new TypeError('hard rule verificationReviewId must be linked to a recorded application of the current rule revision');
  }
  if (!Number.isInteger(rule.revision) || rule.revision < 1) throw new TypeError('revision must be a positive integer');
  timestamp(rule.createdAt, 'createdAt');
  timestamp(rule.updatedAt, 'updatedAt');
  return rule;
}

export function createCandidateRule(feedback, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const rule = {
    id: options.id ?? feedback.id ?? `rule-${randomUUID()}`,
    status: 'candidate',
    trigger: structuredClone(feedback.trigger),
    symptom: feedback.symptom,
    evidence: [...feedback.evidence],
    reason: feedback.reason,
    correction: feedback.correction,
    forbidden: [...feedback.forbidden],
    sourceProject: feedback.sourceProject,
    sourceSegment: feedback.sourceSegment,
    applications: [],
    verificationReviewId: null,
    revision: 1,
    createdAt,
    updatedAt: createdAt
  };
  return assertRule(rule);
}

export function recordRuleApplication(rule, runId, options = {}) {
  assertRule(rule);
  text(runId, 'runId');
  if (rule.applications.some(application => application.runId === runId)) throw new Error(`rule already applied to run: ${runId}`);
  const updated = {
    ...rule,
    applications: [...rule.applications, {
      runId,
      revision: rule.revision,
      appliedAt: (options.now ?? (() => new Date().toISOString()))()
    }]
  };
  updated.updatedAt = updated.applications.at(-1).appliedAt;
  return assertRule(updated);
}

export function createRuleReviewEvidence(rule, input, options = {}) {
  assertRule(rule);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('review input must be an object');
  if (!['approved', 'rejected'].includes(input.decision)) throw new TypeError('review decision must be approved or rejected');
  text(input.runId, 'review.runId');
  text(input.note, 'review.note');
  if (input.decision === 'rejected') text(input.correction, 'review.correction');
  const application = rule.applications.find(({ runId, revision }) => (
    runId === input.runId && revision === rule.revision
  ));
  if (!application) throw new Error('rule review must reference an application of the current rule revision');
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  if (timestamp(createdAt, 'review.createdAt') <= timestamp(application.appliedAt, 'application.appliedAt')) {
    throw new Error('rule review must be later than application');
  }
  const review = {
    id: options.id ?? `review-${randomUUID()}`,
    decision: input.decision,
    actor: 'human',
    ruleId: rule.id,
    ruleRevision: rule.revision,
    runId: input.runId,
    note: input.note,
    correction: input.decision === 'rejected' ? input.correction : null,
    createdAt
  };
  text(review.id, 'review.id');
  return review;
}

export function verifyRule(rule, review) {
  assertRule(rule);
  if (review?.decision !== 'approved' || review?.actor !== 'human') {
    throw new Error('rule verification requires an approved human review');
  }
  if (review.ruleId !== rule.id) throw new Error('approved review must be tied to this rule');
  if (review.ruleRevision !== rule.revision) throw new Error('approved review must be tied to the current rule revision');
  const application = rule.applications.find(({ runId, revision }) => runId === review.runId && revision === rule.revision);
  if (!application) throw new Error('approved review must be tied to a recorded application of the current rule revision');
  if (timestamp(review.createdAt, 'review.createdAt') <= timestamp(application.appliedAt, 'application.appliedAt')) {
    throw new Error('approved review must be later than application');
  }
  text(review.id, 'review.id');
  return assertRule({
    ...rule,
    status: 'hard',
    verificationReviewId: review.id,
    applications: rule.applications.map(value => value.runId === review.runId ? { ...value, reviewId: review.id } : value),
    updatedAt: review.createdAt
  });
}

export function reviseRule(rule, revision, options = {}) {
  assertRule(rule);
  if (!revision || typeof revision !== 'object') throw new TypeError('revision must be an object');
  text(revision.correction, 'revision.correction');
  stringList(revision.evidence, 'revision.evidence');
  text(revision.failedRunId, 'revision.failedRunId');
  const application = rule.applications.find(({ runId, revision: appliedRevision }) => (
    runId === revision.failedRunId && appliedRevision === rule.revision
  ));
  if (!application) {
    throw new Error('failed revision must reference a recorded application run of the current rule revision');
  }
  const review = revision.review;
  if (review?.decision !== 'rejected' || review?.actor !== 'human') {
    throw new Error('rule revision requires a rejected human review');
  }
  if (review.ruleId !== rule.id || review.ruleRevision !== rule.revision || review.runId !== revision.failedRunId) {
    throw new Error('rejected review must be tied to this rule and application run');
  }
  if (timestamp(review.createdAt, 'revision.review.createdAt') <= timestamp(application.appliedAt, 'application.appliedAt')) {
    throw new Error('rejected review must be later than application');
  }
  return assertRule({
    ...rule,
    status: 'candidate',
    correction: revision.correction,
    evidence: [...rule.evidence, ...revision.evidence],
    verificationReviewId: null,
    revision: rule.revision + 1,
    updatedAt: options.now ? options.now() : review.createdAt
  });
}

function matches(rule, context) {
  for (const field of CONTEXT_FIELDS) {
    if (!rule.trigger[field].includes(context[field])) return false;
  }
  const range = rule.trigger.peopleCountRange;
  return Number.isInteger(context.peopleCount) && context.peopleCount >= range.min && context.peopleCount <= range.max;
}

export function applicableRules(rules, context) {
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
  const linked = new Set(context?.reworkRuleIds ?? []);
  return rules
    .map(assertRule)
    .filter(rule => matches(rule, context)
      && (rule.status === 'hard' || rule.status === 'candidate' && linked.has(rule.id)))
    .sort((left, right) => {
      const statusOrder = Number(left.status === 'candidate') - Number(right.status === 'candidate');
      return statusOrder || left.id.localeCompare(right.id);
    });
}
