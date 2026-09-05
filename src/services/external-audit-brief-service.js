import { join, relative, sep } from 'node:path';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';

function latestLocked(artifacts, predicate) {
  return artifacts.filter(artifact => artifact.status === 'locked' && predicate(artifact))
    .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0) || b.id.localeCompare(a.id))[0] ?? null;
}

export async function preparePreGenerationAuditBrief(root, preflightId) {
  const preflightPath = join(root, 'runs', `${encodeURIComponent(preflightId)}.json`);
  const preflight = await readJson(preflightPath);
  if (preflight.kind !== 'video_preflight' || preflight.status !== 'READY') throw new Error('pre-audit brief requires a ready video preflight');
  const state = await readJson(join(root, 'project-state.json'));
  const artifacts = state.artifacts ?? [];
  const exactSegmentOrGlobal = type => latestLocked(artifacts, artifact => artifact.type === type && artifact.segmentId === preflight.segmentId)
    ?? latestLocked(artifacts, artifact => artifact.type === type && artifact.segmentId == null);
  const selected = [
    latestLocked(artifacts, artifact => artifact.type === 'reference_video' && artifact.segmentId === preflight.segmentId),
    latestLocked(artifacts, artifact => artifact.type === 'script'),
    exactSegmentOrGlobal('shotlist'),
    latestLocked(artifacts, artifact => artifact.type === 'segment_contract' && artifact.segmentId === preflight.segmentId),
    latestLocked(artifacts, artifact => artifact.type === 'shot_narration' && artifact.segmentId === preflight.segmentId)
  ].filter(Boolean);
  if (!selected.some(artifact => artifact.type === 'reference_video')) throw new Error('pre-audit brief requires a locked reference video for the same segment');
  const evidenceFiles = [];
  for (const artifact of selected) evidenceFiles.push({
    id: artifact.id, type: artifact.type, path: artifact.path, sha256: await sha256File(join(root, artifact.path))
  });
  const fingerprint = preflight.fingerprint;
  const brief = {
    kind: 'external_pre_generation_audit_brief', segmentId: preflight.segmentId, preflightId: preflight.id,
    fingerprintSha256: fingerprint.sha256,
    task: 'Independently compare the exact source-video segment, script, locked shot narration, prompt, compiled package, and every media asset. Audit the main action before, during, and after. Do not rewrite or improve materials. Return FAIL if any required evidence cannot be inspected.',
    mandatoryCoverage: [
      'exact_source_range_and_plot', 'main_action_before_during_after', 'character_identity_age_and_fixed_position',
      'speaker_dialogue_mouth_binding', 'scene_props_and_product_scale', 'dressing_or_contact_physics',
      'camera_blocking_and_continuity', 'prompt_asset_plot_consistency',
      'director_intent_and_shot_motivation', 'performance_realism_eyeline_and_partner_reaction',
      'required_capability_and_skill_adoption', 'anti_ai_mannerism_motion_specificity_and_natural_asymmetry'
    ],
    sourceEvidence: evidenceFiles,
    generationEvidence: {
      generationContract: fingerprint.generationContract,
      package: { path: fingerprint.packagePath, sha256: fingerprint.packageSha256 },
      prompt: { path: fingerprint.promptPath, sha256: fingerprint.promptSha256 },
      inputMedia: fingerprint.inputMedia,
      priorIndependentAudit: fingerprint.independentCreativeAudit ?? null
    },
    passRule: 'PASS only when every mandatoryCoverage item is explicitly PASS with concrete file or frame evidence. Any FAIL or NOT_VERIFIABLE requires overall FAIL.',
    createdAt: new Date().toISOString()
  };
  const briefPath = join(root, 'reviews', 'external-audit-briefs', `${encodeURIComponent(preflight.segmentId)}-${encodeURIComponent(preflight.id)}.json`);
  await writeJsonAtomic(briefPath, brief);
  const pointer = { path: relative(root, briefPath).split(sep).join('/'), sha256: await sha256File(briefPath) };
  await withProjectLock(root, async () => {
    const current = await readJson(preflightPath);
    if (current.fingerprint?.sha256 !== preflight.fingerprint.sha256) throw new Error('preflight changed before audit brief publication');
    await writeJsonAtomic(preflightPath, { ...current, externalAuditBrief: pointer });
  });
  return { ...brief, briefPath: pointer.path, briefSha256: pointer.sha256 };
}
