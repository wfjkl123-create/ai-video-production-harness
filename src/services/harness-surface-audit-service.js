import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { assertRule } from '../domain/rules.js';

const COMMAND_SUPPORT_MODULES = new Set([]);
const MAX_EVIDENCE_ITEMS = 20;

function unixPath(value) {
  return value.split(sep).join('/');
}

async function regularFiles(root, predicate = () => true) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('._')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function fileRecord(root, path) {
  const [contents, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  return {
    path: unixPath(relative(root, path)),
    absolutePath: path,
    contents,
    bytes: metadata.size,
    lines: contents === '' ? 0 : contents.split(/\r?\n/).length
  };
}

async function records(root, directory, extensionPattern) {
  const paths = await regularFiles(join(root, directory), path => extensionPattern.test(path));
  return Promise.all(paths.map(path => fileRecord(root, path)));
}

function commandNames(cliText) {
  return [...cliText.matchAll(/\[['"]([a-z0-9][a-z0-9-]*)['"],\s*run[A-Za-z0-9_]+\]/g)]
    .map(match => match[1]);
}

function importedCommandModules(cliText) {
  return new Set([...cliText.matchAll(/from\s+['"]\.\/commands\/([^'"]+\.js)['"]/g)].map(match => match[1]));
}

function referencedBySource(moduleName, ownPath, sourceRecords) {
  const needles = [`/${moduleName}`, `'./${moduleName}'`, `"./${moduleName}"`, `commands/${moduleName}`];
  return sourceRecords.some(record => record.path !== ownPath && needles.some(needle => record.contents.includes(needle)));
}

function capabilityIsReferenced(capability, baseCorpus, capabilityRecords) {
  const relativeFromKnowledge = capability.path.replace(/^knowledge\//, '');
  const names = [capability.path, relativeFromKnowledge, basename(capability.path)];
  if (names.some(name => baseCorpus.includes(name))) return true;
  return capabilityRecords.some(other => other.path !== capability.path && names.some(name => other.contents.includes(name)));
}

function duplicateDefinitionCandidates(sourceRecords) {
  const definitions = [
    { id: 'path_containment_helpers', regex: /\bfunction\s+(?:outside|isOutside)\s*\(/g },
    { id: 'safe_id_constants', regex: /\bconst\s+SAFE_ID\s*=/g },
    { id: 'safe_task_id_constants', regex: /\bconst\s+SAFE_TASK_ID\s*=/g },
    { id: 'optional_json_helpers', regex: /\b(?:function|const)\s+readOptionalJson\b/g }
  ];
  return definitions.map(definition => {
    const locations = [];
    for (const record of sourceRecords) {
      const count = [...record.contents.matchAll(definition.regex)].length;
      if (count > 0) locations.push({ path: record.path, count });
    }
    return { id: definition.id, count: locations.reduce((sum, item) => sum + item.count, 0), locations };
  }).filter(item => item.count > 1);
}

function finding(id, severity, category, evidence, recommendation) {
  return { id, severity, category, evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS), recommendation, automaticAction: 'none' };
}

function compactProjectSurface(project) {
  if (!project) return null;
  return {
    projectId: project.projectId,
    projectStateBytes: project.projectStateBytes,
    artifactCount: project.artifactCount,
    ruleCount: project.ruleCount,
    hardRuleCount: project.hardRuleCount,
    candidateRuleCount: project.candidateRuleCount,
    neverAppliedCandidateCount: project.neverAppliedCandidates.length,
    invalidRuleCount: project.invalidRules.length,
    duplicateArtifactShaCount: project.duplicateArtifactSha.length,
    lockedVideoSegmentCount: project.lockedVideoSegmentCount,
    missingSegmentSummaryCount: project.missingSegmentSummaries.length
  };
}

async function projectSurface(projectRoot) {
  const statePath = join(projectRoot, 'project-state.json');
  const stateText = await readFile(statePath, 'utf8');
  const state = JSON.parse(stateText);
  const artifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
  const shaOwners = new Map();
  for (const artifact of artifacts) {
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? '')) continue;
    const owners = shaOwners.get(artifact.sha256.toLowerCase()) ?? [];
    owners.push(artifact.id);
    shaOwners.set(artifact.sha256.toLowerCase(), owners);
  }
  const duplicateArtifactSha = [...shaOwners.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([sha256, artifactIds]) => ({ sha256, artifactIds }));

  const rulePaths = await regularFiles(join(projectRoot, 'rules'), path => path.endsWith('.json'));
  const rules = [];
  const invalidRules = [];
  for (const path of rulePaths) {
    try {
      const rule = assertRule(JSON.parse(await readFile(path, 'utf8')));
      rules.push(rule);
    } catch (error) {
      invalidRules.push({ path: unixPath(relative(projectRoot, path)), error: error.message });
    }
  }
  const neverAppliedCandidates = rules
    .filter(rule => rule.status === 'candidate' && rule.applications.length === 0)
    .map(rule => rule.id)
    .sort();
  const hardRules = rules.filter(rule => rule.status === 'hard');

  const lockedVideoSegments = [...new Set(artifacts
    .filter(item => item.type === 'video_segment' && item.status === 'locked' && typeof item.segmentId === 'string')
    .map(item => item.segmentId))].sort();
  const missingSegmentSummaries = [];
  for (const segmentId of lockedVideoSegments) {
    try { await stat(join(projectRoot, 'segments', `${segmentId}-summary.json`)); }
    catch (error) {
      if (error.code === 'ENOENT') missingSegmentSummaries.push(segmentId);
      else throw error;
    }
  }

  return {
    projectId: state.projectId ?? basename(projectRoot),
    projectStateBytes: Buffer.byteLength(stateText),
    artifactCount: artifacts.length,
    ruleCount: rules.length,
    hardRuleCount: hardRules.length,
    candidateRuleCount: rules.length - hardRules.length,
    neverAppliedCandidates,
    invalidRules,
    duplicateArtifactSha,
    lockedVideoSegmentCount: lockedVideoSegments.length,
    missingSegmentSummaries
  };
}

export async function auditHarnessSurface(repoRoot, options = {}) {
  const root = await realpath(repoRoot);
  const [agents, runbook, cli, sourceRecords, capabilityRecords, commandRecords] = await Promise.all([
    fileRecord(root, join(root, 'AGENTS.md')),
    fileRecord(root, join(root, 'docs', 'operator-runbook.md')),
    fileRecord(root, join(root, 'src', 'cli.js')),
    records(root, 'src', /\.js$/),
    records(root, 'knowledge/capabilities', /\.(?:md|json)$/),
    records(root, 'src/commands', /\.js$/)
  ]);

  const registeredCommands = [...new Set(commandNames(cli.contents))].sort();
  const importedModules = importedCommandModules(cli.contents);
  const undocumentedCommands = registeredCommands
    .filter(name => !agents.contents.includes(name) && !runbook.contents.includes(name));
  const unreferencedCommandModules = commandRecords
    .map(record => ({ record, moduleName: basename(record.path) }))
    .filter(({ moduleName }) => !moduleName.startsWith('._') && !COMMAND_SUPPORT_MODULES.has(moduleName))
    .filter(({ record, moduleName }) => !importedModules.has(moduleName) && !referencedBySource(moduleName, record.path, sourceRecords))
    .map(({ record }) => record.path);

  const baseCorpus = [agents.contents, runbook.contents, ...sourceRecords.map(record => record.contents)].join('\n');
  const unreferencedCapabilities = capabilityRecords
    .filter(record => !capabilityIsReferenced(record, baseCorpus, capabilityRecords))
    .map(record => record.path);
  const duplicateDefinitions = duplicateDefinitionCandidates(sourceRecords);
  const largestContextFiles = [agents, runbook, ...capabilityRecords]
    .map(({ path, bytes, lines }) => ({ path, bytes, lines }))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
    .slice(0, 12);

  const project = options.projectRoot ? await projectSurface(await realpath(options.projectRoot)) : null;
  const findings = [];
  if (unreferencedCommandModules.length > 0) findings.push(finding(
    'unreferenced_command_modules', 'warning', 'tool_surface', unreferencedCommandModules,
    'Review each module for a production import before proposing deletion; do not delete automatically.'
  ));
  if (undocumentedCommands.length > 0) findings.push(finding(
    'undocumented_registered_commands', 'info', 'tool_surface', undocumentedCommands,
    'Document intentionally public commands or mark them internal so operators do not discover them by accident.'
  ));
  if (unreferencedCapabilities.length > 0) findings.push(finding(
    'unreferenced_capability_files', 'info', 'context_surface', unreferencedCapabilities,
    'Confirm whether each file is a routed capability, reference-only material, or a deletion candidate; do not load it by default.'
  ));
  if (duplicateDefinitions.length > 0) findings.push(finding(
    'duplicate_helper_definitions', 'info', 'code_surface', duplicateDefinitions.map(item => `${item.id}:${item.count}`),
    'Consolidate only helpers whose behavior is proven identical by tests; local security checks may intentionally differ.'
  ));
  if (project?.neverAppliedCandidates.length > 0) findings.push(finding(
    'never_applied_candidate_rules', 'info', 'rule_surface', project.neverAppliedCandidates,
    'Keep as candidates or archive after human review; never promote or delete solely because they are unused.'
  ));
  if (project?.invalidRules.length > 0) findings.push(finding(
    'invalid_rule_files', 'warning', 'rule_surface', project.invalidRules.map(item => `${item.path}: ${item.error}`),
    'Repair or quarantine invalid rule files before loading project rules.'
  ));
  if (project?.duplicateArtifactSha.length > 0) findings.push(finding(
    'duplicate_artifact_sha_references', 'info', 'project_surface',
    project.duplicateArtifactSha.map(item => `${item.sha256}: ${item.artifactIds.join(', ')}`),
    'Confirm that same-SHA artifacts are intentional role aliases; compact metadata only after proving no downstream ID depends on it.'
  ));
  if (project?.missingSegmentSummaries.length > 0) findings.push(finding(
    'missing_completed_segment_summaries', 'info', 'context_surface', project.missingSegmentSummaries,
    'Generate compact segment summaries for completed segments before handing work to later-segment agents.'
  ));
  if ((project?.projectStateBytes ?? 0) > 100_000) findings.push(finding(
    'large_project_state_context', 'warning', 'context_surface', [`${project.projectStateBytes} bytes`],
    'Use segment-context and compact summary cards instead of sending the full project state to each sub-agent.'
  ));

  return {
    schemaVersion: 1,
    kind: 'harness_surface_audit',
    readOnly: true,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    summary: {
      registeredCommandCount: registeredCommands.length,
      commandModuleCount: commandRecords.length,
      capabilityFileCount: capabilityRecords.length,
      capabilityBytes: capabilityRecords.reduce((sum, item) => sum + item.bytes, 0),
      alwaysLoadedInstructionBytes: agents.bytes,
      onDemandRunbookBytes: runbook.bytes,
      findingCount: findings.length,
      warningCount: findings.filter(item => item.severity === 'warning').length
    },
    commandSurface: { registeredCommands, undocumentedCommands, unreferencedCommandModules },
    capabilitySurface: { unreferencedCapabilities, largestContextFiles },
    codeSurface: { duplicateDefinitions },
    projectSurface: compactProjectSurface(project),
    findings
  };
}
