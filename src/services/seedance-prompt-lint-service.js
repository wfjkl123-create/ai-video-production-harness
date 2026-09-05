const HIDDEN_CONTEXT = /(已列明|上述|前述|沿用此前|沿用之前|参考前面|参考上面|同上|结合现有素材|按之前(?:的)?设定|和前面一样|像这样|类似这样|这张图|那张图|这几张图|那些图|上一段|前一段|上一个片段|前一个片段|上一镜|前一镜|上个镜头|前个镜头|继续上段|承接上段|与第?[一二三四五六七八九十0-9]+段(?:完全)?一致)/u;
const HUMAN_ONLY_APPENDIX = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:Skill\s*自检|提示词自检|审核说明|机审说明|审计说明|给审核人的说明)\s*(?:[:：]|(?=\r?\n|$))/iu;
const INTERNAL_DIRECTOR_METADATA = /(?:story-spine-v1|emotion-arc-v1|performance-continuity-v1|director-constraints-v1|director-capability-v1|emotion-performance-v1)/iu;
const INTERNAL_MEDIA_BINDING_METADATA = /(?:^|\n)\s*(?:【参考素材｜本次实际上传】|编号只承担所列职责，不交换。|【执行提示词正文】|R[0-9]+｜控:)/u;
const INTERNAL_FACS_METADATA = /(?:\bFACS\b|\bAU(?:\s*0?\d{1,2}(?:[A-E])?)?\b|\bAction\s+Units?\b)/iu;
const SOURCE_VIDEO_REFERENCE = /(原视频|原片|源视频|参考视频)/u;
const ALLOWED_MEDIA_REFERENCE = /@(?:图|视频|音频)\s*[1-9][0-9]*|@(?:Image|Video|Audio)\s*[1-9][0-9]*/giu;
const ANY_AT_REFERENCE = /@[A-Za-z0-9\u3400-\u9fff][A-Za-z0-9._:\-\u3400-\u9fff]*/gu;
// These two compact blocks are the explicit model-facing continuity contract
// required by the director compiler.  They are not the archived capsules:
// the latter remain forbidden because they contain audit prose and internal
// routing metadata.  Strip only well-formed required blocks before the
// generic metadata scan so the linter agrees with the compiler contract.
const ALLOWED_DIRECTOR_CONTRACT_BLOCK = /【(?<blockType>performance-continuity-v1|director-constraints-v1)｜(?<shotId>[^｜\n】]+)(?:｜[^\n】]+)*】[\s\S]*?【\/\k<blockType>｜\k<shotId>】/gu;
const DIALOGUE_QUOTE = /[“"]([^”"]{2,240})[”"]/gu;
const QUOTED_SPEECH_CUE = /(?:说|讲|道|喊|问|答|念|唱|吟唱|低语|耳语|says?|asks?|answers?|whispers?|shouts?|speaks?|tells?)[^“”"\n]{0,12}[“"][^”"\n]+[”"]/iu;
const PERFORMANCE_TIME_RANGE = /\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-—–~至到]\s*\d+(?:\.\d+)?\s*(?:s|秒)/giu;
const HUMAN_DIALOGUE_SIGNAL = /(说话人|听者|对方|人物|角色|推荐者|试穿者|朋友|女人|男人|女孩|男孩|开口|回答|反问|对白)/u;
const SILENT_RELATION_SIGNAL = /(情绪|关系|潜台词|反应|对视|凝视|回避|被戳中|尴尬|紧张|犹豫)/u;
const PERFORMANCE_EVIDENCE = {
  trigger: /(听见|看到|看见|当|说到|话音|触到|因为|这句话|问完|举起)/u,
  attention: /(视线|眼睛|目光|看向|转头|头晚|没有看|不看镜头)/u,
  body: /(呼吸|鼻息|吞咽|手指|拇指|下颌|肩膀|嘴角|嘴唇|气口|停住|停半拍|松开|收住|压住|身体|上身)/u,
  choice: /(没有立刻|仍|继续|忍住|选择|回答|反问|开口|不接话|靠近|移开|才)/u,
  counterpart: /(听者|对方|她听见|回应|包带|衣料|布料|背景|路人|车流|镜头|肩带)/u,
  ending: /(末态|收尾|停在|保持|留下|余波|仍看|最后|结束|稳住|没有定格)/u
};
const ABSTRACT_EMOTION = /(紧张|尴尬|被戳中|自然|克制|松弛|犹豫|开心|震惊|难过|不安)/gu;
const NEGATIVE_PERFORMANCE_MARKER = /(不要|禁止|不得|无字幕|无文字|无水印|不看镜头|不能|避免)/gu;

function withoutAllowedDirectorContracts(text) {
  return text.replace(ALLOWED_DIRECTOR_CONTRACT_BLOCK, '');
}

function finding(code, message) {
  return { code, message };
}

function referencedIndexes(text, patterns) {
  const values = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) values.add(Number(match[1]));
  }
  return [...values].sort((left, right) => left - right);
}

function verifyIndexes(errors, label, indexes, count) {
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 1 || index > count) {
      errors.push(finding('UNBOUND_MEDIA_REFERENCE', `${label}${index} is mentioned but only ${count} ${label} input(s) are bound`));
    }
  }
}

/**
 * Lints the exact text that will be sent to the video model.
 * Human review notes must live in a separate file; the executable prompt may
 * reference only media that exists in the compiled package.
 */
export function lintSeedanceExecutionPrompt(text, media = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { decision: 'FAIL', errors: [finding('EMPTY_PROMPT', 'Seedance execution prompt must be non-empty')], warnings: [] };
  }

  const bindings = media.bindings ?? null;
  if (bindings !== null && !Array.isArray(bindings)) throw new TypeError('media.bindings must be an array');
  const imageCount = bindings ? bindings.filter(item => item.mediaKind === 'image').length : (media.imageCount ?? 0);
  const videoCount = bindings ? bindings.filter(item => item.mediaKind === 'video').length : (media.videoCount ?? 0);
  const audioCount = bindings ? bindings.filter(item => item.mediaKind === 'audio').length : (media.audioCount ?? 0);
  const errors = [];
  const warnings = [];
  const textWithoutAllowedDirectorContracts = withoutAllowedDirectorContracts(text);

  if (HIDDEN_CONTEXT.test(text)) {
    errors.push(finding('IMPLICIT_PRIOR_CONTEXT', 'prompt contains a deictic reference that cannot be resolved from the current request'));
  }
  if (HUMAN_ONLY_APPENDIX.test(text)) {
    errors.push(finding('HUMAN_REVIEW_TEXT_IN_EXECUTION_PROMPT', 'human self-check or audit notes must be stored separately from model-facing text'));
  }
  if (INTERNAL_DIRECTOR_METADATA.test(textWithoutAllowedDirectorContracts)) {
    errors.push(finding('INTERNAL_DIRECTOR_METADATA_IN_EXECUTION_PROMPT', 'internal story, performance, continuity, and director contract labels must stay in the capsule archive'));
  }
  if (INTERNAL_MEDIA_BINDING_METADATA.test(text)) {
    errors.push(finding('INTERNAL_MEDIA_BINDING_METADATA_IN_EXECUTION_PROMPT', 'media binding headers and role codes are audit-only data and must not be sent to the video model'));
  }
  if (INTERNAL_FACS_METADATA.test(text)) {
    errors.push(finding('INTERNAL_FACS_METADATA_IN_EXECUTION_PROMPT', 'FACS/AU codes are audit-only calibration; describe visible facial changes in natural language for the video model'));
  }
  if (videoCount === 0 && SOURCE_VIDEO_REFERENCE.test(text)) {
    errors.push(finding('UNBOUND_SOURCE_VIDEO_REFERENCE', 'prompt names an original/reference video but the compiled package has no video input'));
  }

  const withoutAllowedReferences = text.replace(ALLOWED_MEDIA_REFERENCE, '');
  ALLOWED_MEDIA_REFERENCE.lastIndex = 0;
  const unsupportedAliases = [...withoutAllowedReferences.matchAll(ANY_AT_REFERENCE)].map(match => match[0]);
  if (unsupportedAliases.length > 0) {
    errors.push(finding('UNSUPPORTED_MEDIA_ALIAS', `prompt contains unsupported @ aliases: ${[...new Set(unsupportedAliases)].join(', ')}`));
  }

  const imageIndexes = referencedIndexes(text, [/@图\s*([1-9][0-9]*)/gu, /@Image\s*([1-9][0-9]*)/giu]);
  const videoIndexes = referencedIndexes(text, [/@视频\s*([1-9][0-9]*)/gu, /@Video\s*([1-9][0-9]*)/giu]);
  const audioIndexes = referencedIndexes(text, [/@音频\s*([1-9][0-9]*)/gu, /@Audio\s*([1-9][0-9]*)/giu]);
  verifyIndexes(errors, '@图', imageIndexes, imageCount);
  verifyIndexes(errors, '@视频', videoIndexes, videoCount);
  verifyIndexes(errors, '@音频', audioIndexes, audioCount);

  if (bindings) {
    const allowedTags = new Set(bindings.map(item => item.tag.replace(/\s+/g, '')));
    for (const tag of [
      ...imageIndexes.map(index => `@图${index}`),
      ...videoIndexes.map(index => `@视频${index}`),
      ...audioIndexes.map(index => `@音频${index}`)
    ]) {
      if (!allowedTags.has(tag)) errors.push(finding('MEDIA_BINDING_NOT_DECLARED', `${tag} is not present in the deterministic media binding contract`));
    }
  }

  const mediaCount = imageCount + videoCount + audioCount;
  const indexedReferenceCount = imageIndexes.length + videoIndexes.length + audioIndexes.length;
  if (mediaCount > 0 && indexedReferenceCount === 0) {
    errors.push(finding('MEDIA_ROLES_NOT_INDEXED', 'compiled media exist but the prompt does not use indexed @图N/@视频N/@音频N role bindings'));
  }

  return { decision: errors.length === 0 ? 'PASS' : 'FAIL', errors, warnings };
}

/**
 * Blocks structurally valid but performatively empty multi-person dialogue.
 * This is deliberately narrow: non-dialogue/product/landscape prompts remain
 * outside this semantic gate.
 */
function parsePerformanceRanges(text) {
  const ranges = [...text.matchAll(PERFORMANCE_TIME_RANGE)].map(match => {
    const values = match[0].match(/\d+(?:\.\d+)?/g).map(Number);
    return { start: values[0], end: values[1], raw: match[0] };
  });
  PERFORMANCE_TIME_RANGE.lastIndex = 0;
  return ranges;
}

function sameSecond(left, right) {
  return Math.abs(left - right) <= 0.001;
}

function lintReferenceVideoIdentityEdit(text, options) {
  const errors = [];
  const expectedCuts = options.expectedCutTimesSec ?? [];
  const sourceEnd = Number(options.sourceExactSeconds);
  const requestedEnd = Number(options.requestedDurationSeconds);
  if (!Array.isArray(expectedCuts) || !expectedCuts.every(Number.isFinite)
    || !Number.isFinite(sourceEnd) || !Number.isFinite(requestedEnd)) {
    throw new TypeError('reference_video_identity_edit requires finite expectedCutTimesSec, sourceExactSeconds, and requestedDurationSeconds');
  }

  if (!/(参考视频|原视频|原片)/u.test(text) || !/(唯一权威|唯一事实权威)/u.test(text)
    || !/(全片唯一允许的变化是.{0,30}(?:面部|人脸|脸内)身份替换|唯一变化是.{0,30}脸内身份)/su.test(text)) {
    errors.push(finding('REFERENCE_EDIT_SOURCE_AUTHORITY_MISSING', 'reference-video identity edit must declare the source video as authority and face identity as the only change'));
  }
  if (/\bF\d{2}\b/u.test(text)) {
    errors.push(finding('REFERENCE_EDIT_INTERNAL_LABEL', 'reference-video identity edit must not expose internal Fxx shot labels to the model'));
  }

  const ranges = parsePerformanceRanges(text);
  const expectedBoundaries = [0, ...expectedCuts, sourceEnd];
  if (requestedEnd > sourceEnd + 0.001) expectedBoundaries.push(requestedEnd);
  const actualBoundaries = ranges.length === 0
    ? []
    : [ranges[0].start, ...ranges.map(range => range.end)];

  const contiguous = ranges.every((range, index) => range.end > range.start
    && (index === 0 || sameSecond(range.start, ranges[index - 1].end)));
  if (!contiguous || actualBoundaries.length !== expectedBoundaries.length
    || actualBoundaries.some((value, index) => !sameSecond(value, expectedBoundaries[index]))) {
    errors.push(finding(
      'REFERENCE_EDIT_TIMELINE_MISMATCH',
      `time ranges must use only locked source boundaries ${expectedBoundaries.join(', ')}; received ${actualBoundaries.join(', ') || 'none'}`
    ));
  }

  return { applicable: true, decision: errors.length === 0 ? 'PASS' : 'FAIL', errors, warnings: [] };
}

export function lintSeedanceNarrativePerformance(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { applicable: false, decision: 'PASS', errors: [], warnings: [] };
  }
  // Native source-replacement prompts do not author or reinterpret the
  // performance: dialogue, attention, body movement and timing are all copied
  // from the bound source-video window. Requiring a newly written dialogue
  // timeline here would invent performance semantics and contradict the
  // minimal-difference edit contract.
  if (options.sourceControlledPerformance === true) {
    return { applicable: false, decision: 'PASS', errors: [], warnings: [] };
  }
  if (options.mode === 'reference_video_identity_edit') {
    return lintReferenceVideoIdentityEdit(text, options);
  }
  const semanticText = withoutAllowedDirectorContracts(text);
  const quotes = [...semanticText.matchAll(DIALOGUE_QUOTE)];
  DIALOGUE_QUOTE.lastIndex = 0;
  const applicable = (quotes.length >= 1 && (HUMAN_DIALOGUE_SIGNAL.test(text) || QUOTED_SPEECH_CUE.test(text)))
    || (HUMAN_DIALOGUE_SIGNAL.test(text) && SILENT_RELATION_SIGNAL.test(text));
  if (!applicable) return { applicable: false, decision: 'PASS', errors: [], warnings: [] };

  const errors = [];
  const timeRanges = parsePerformanceRanges(text);
  if (timeRanges.length < 3) {
    errors.push(finding('MISSING_PERFORMANCE_TIMELINE', 'multi-person dialogue requires at least three explicit timecoded performance beats'));
  }
  for (const [name, pattern] of Object.entries(PERFORMANCE_EVIDENCE)) {
    if (!pattern.test(text)) errors.push(finding(`MISSING_${name.toUpperCase()}_EVIDENCE`, `dialogue prompt lacks visible ${name} evidence`));
  }

  for (const match of text.matchAll(ABSTRACT_EMOTION)) {
    const window = text.slice(Math.max(0, match.index - 90), Math.min(text.length, match.index + match[0].length + 120));
    if (!PERFORMANCE_EVIDENCE.body.test(window)) {
      errors.push(finding('ABSTRACT_EMOTION_WITHOUT_CARRIER', `abstract emotion “${match[0]}” has no nearby visible body carrier`));
    }
  }
  ABSTRACT_EMOTION.lastIndex = 0;
  const negativeCount = [...semanticText.matchAll(NEGATIVE_PERFORMANCE_MARKER)].length;
  NEGATIVE_PERFORMANCE_MARKER.lastIndex = 0;
  if (negativeCount > 8) {
    errors.push(finding('NEGATIVE_OVERLOAD', `dialogue prompt contains ${negativeCount} negative constraints; visible causal performance is being displaced`));
  }

  return { applicable: true, decision: errors.length === 0 ? 'PASS' : 'FAIL', errors, warnings: [] };
}

export function requireCleanSeedanceExecutionPrompt(text, media = {}) {
  const result = lintSeedanceExecutionPrompt(text, media);
  if (result.decision === 'FAIL') {
    const error = new Error(`Seedance prompt zero-context lint failed: ${result.errors.map(item => `${item.code}: ${item.message}`).join('; ')}`);
    error.code = 'SEEDANCE_PROMPT_ZERO_CONTEXT_LINT_FAILED';
    error.findings = result.errors;
    throw error;
  }
  return { ...result, narrativePerformance: lintSeedanceNarrativePerformance(text, media.narrativePerformance) };
}

export function requireSeedanceNarrativePerformancePrompt(text, options = {}) {
  const result = lintSeedanceNarrativePerformance(text, options);
  if (result.decision === 'FAIL') {
    const error = new Error(`Seedance narrative performance lint failed: ${result.errors.map(item => `${item.code}: ${item.message}`).join('; ')}`);
    error.code = 'SEEDANCE_NARRATIVE_PERFORMANCE_LINT_FAILED';
    error.findings = result.errors;
    throw error;
  }
  return result;
}
