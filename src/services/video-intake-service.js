import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, link, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { assertProjectState } from '../domain/project-state.js';
import {
  appendExecutionSpan,
  completeExecutionTrace,
  createExecutionTrace
} from '../domain/execution-trace.js';
import { decideIngressRoute } from '../domain/ingress-route.js';
import { sha256File } from '../storage/checksum.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { withProjectLock } from '../storage/project-lock.js';
import { autoLockArtifact } from './review-service.js';
import { registerArtifact } from './intake-service.js';
import { recordAuthoritativeExecutionObservation } from './authoritative-trace-observation-service.js';
import { detectReferenceWorkflow } from './reference-workflow-service.js';
import {
  directorInputFingerprint,
  directorRouteFingerprint,
  prepareDirectorInterview
} from './director-interview-service.js';

function statusFromWorkflow(workflow) {
  if (workflow.status === 'awaiting_reference_role') return 'awaiting_reference_role';
  if (workflow.status === 'awaiting_source_video') return 'awaiting_source_video';
  if (workflow.sourceRole === 'authority') return 'authority';
  if (workflow.sourceRole === 'inspiration') return 'inspiration';
  return 'not_applicable';
}

export function intakeVideoRequest(input) {
  const routeDecision = decideIngressRoute(input);
  if (!routeDecision.harnessRequired) {
    return { routeDecision, referenceWorkflow: null };
  }

  const referenceWorkflow = detectReferenceWorkflow({
    requestText: input.requestText,
    sourceVideoIds: routeDecision.sourceVideoIds,
    explicitIntent: input.explicitReferenceIntent
  });
  return {
    routeDecision: Object.freeze({
      ...routeDecision,
      referenceRoleStatus: statusFromWorkflow(referenceWorkflow)
    }),
    referenceWorkflow
  };
}

function projectRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function safeStem(value) {
  const stem = value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (stem || 'video').slice(0, 96);
}

const VIDEO_EXTENSION_BY_MIME = Object.freeze({
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv'
});
const IMAGE_EXTENSION_BY_MIME = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
});

async function inspectSourceVideo(path) {
  const resolved = await realpath(resolve(path));
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`video input must be a regular file: ${path}`);
  await access(resolved, constants.R_OK);
  return { path: resolved, sha256: await sha256File(resolved) };
}

async function copyOnce(sourcePath, targetPath, expectedSha256) {
  try {
    const existingSha = await sha256File(targetPath);
    if (existingSha !== expectedSha256) throw new Error(`reference target already exists with different content: ${targetPath}`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL);
    if (await sha256File(temporary) !== expectedSha256) throw new Error('reference video copy checksum mismatch');
    try {
      await link(temporary, targetPath);
    } catch (error) {
      if (['ENOTSUP', 'EPERM', 'EXDEV'].includes(error.code)) {
        try {
          await copyFile(temporary, targetPath, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (copyError.code !== 'EEXIST') throw copyError;
        }
      } else if (error.code !== 'EEXIST') {
        throw error;
      }
      if (await sha256File(targetPath) !== expectedSha256) {
        throw new Error(`reference target already exists with different content: ${targetPath}`);
      }
    }
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function persistRouteDecision(root, result, input) {
  return withProjectLock(root, async () => {
    const path = join(root, 'project-state.json');
    const state = assertProjectState(await readJson(path));
    if ((state.workflowVersion ?? 1) < 2) {
      throw new Error('intake-video requires workflowVersion 2; workflowVersion 1 is explicit legacy mode');
    }
    const previous = state.routeDecision;
    const routeChanged = previous !== undefined && JSON.stringify(previous) !== JSON.stringify(result.routeDecision);
    const requestedInputFingerprint = directorInputFingerprint(state.projectId, input.requestText, result.routeDecision);
    const directionInputChanged = state.directionRevision?.interviewInputFingerprint !== undefined
      && state.directionRevision.interviewInputFingerprint !== requestedInputFingerprint;
    const changed = routeChanged || directionInputChanged;
    const downstream = state.artifacts.filter(artifact => artifact.type !== 'reference_video'
      && typeof artifact.invalidatedByScopeRevisionId !== 'string');
    if (changed && downstream.length > 0 && input.confirmScopeRevision !== true) {
      throw new Error('Gate 0 scope revision requires explicit user confirmation before invalidating direction-dependent downstream work');
    }
    const now = new Date().toISOString();
    const nextRevision = (state.directionRevision?.revision ?? 0) + (changed ? 1 : state.directionRevision ? 0 : 1);
    const revisionId = changed ? `direction-revision-${nextRevision}` : (state.directionRevision?.id ?? 'direction-revision-1');
    const invalidatedArtifactIds = changed ? downstream.map(artifact => artifact.id).sort() : [];
    if (changed) {
      state.artifacts = state.artifacts.map(artifact => invalidatedArtifactIds.includes(artifact.id)
        ? {
            ...artifact,
            invalidatedByScopeRevisionId: revisionId,
            invalidationReason: input.scopeRevisionReason?.trim() || 'Gate 0 reference role, creative priority, control method, or delivery direction changed'
          }
        : artifact);
      state.phase = 'intake';
      state.activeSegmentId = null;
      state.blockedReason = null;
      if (result.routeDecision.executionClass !== 'mechanical_asset_prompt') {
        delete state.mechanicalCanvas;
      }
    }
    const pointedCapability = state.artifacts.find(artifact => artifact.id === state.verifiedCapabilityManifestId);
    if (state.verifiedCapabilityManifestId
      && (!pointedCapability || typeof pointedCapability.invalidatedByScopeRevisionId === 'string')) {
      delete state.verifiedCapabilityManifestId;
      delete state.directorRoutingVersion;
    }
    state.ingressPolicyVersion = result.routeDecision.policyVersion;
    state.routeDecision = structuredClone(result.routeDecision);
    state.referenceWorkflow = result.referenceWorkflow === null ? null : structuredClone(result.referenceWorkflow);
    state.videoGovernanceVersion = 2;
    if (result.routeDecision.executionClass === 'mechanical_asset_prompt') {
      delete state.directionRevision;
    } else state.directionRevision = !changed && state.directionRevision
      ? { ...state.directionRevision, routeFingerprint: directorRouteFingerprint(result.routeDecision) }
      : {
          id: revisionId,
          revision: nextRevision,
          status: 'awaiting_answers',
          routeFingerprint: directorRouteFingerprint(result.routeDecision),
          reason: changed
            ? (input.scopeRevisionReason?.trim() || 'User-confirmed Gate 0 scope revision')
            : 'Initial video direction intake',
          invalidatedArtifactIds,
          updatedAt: now
        };
    state.updatedAt = now;
    assertProjectState(state);
    await writeJsonAtomic(path, state);
    return state;
  });
}

async function importReferenceVideo(root, descriptor) {
  const source = await inspectSourceVideo(descriptor.path);
  const extension = VIDEO_EXTENSION_BY_MIME[descriptor.mimeType]
    ?? (/^\.[a-z0-9]{1,8}$/i.test(extname(source.path)) ? extname(source.path).toLowerCase() : '.video');
  const targetDirectory = join(root, 'brief', 'reference');
  const targetPath = join(targetDirectory, `${safeStem(descriptor.id)}-${source.sha256.slice(0, 12)}${extension}`);
  await mkdir(targetDirectory, { recursive: true });
  await copyOnce(source.path, targetPath, source.sha256);

  const existingState = assertProjectState(await readJson(join(root, 'project-state.json')));
  const existing = existingState.artifacts.find(artifact => artifact.id === descriptor.id);
  if (existing) {
    if (existing.type !== 'reference_video' || existing.sha256 !== source.sha256) {
      throw new Error(`artifact ID ${descriptor.id} already exists with different reference content`);
    }
    if (existing.status !== 'locked') await autoLockArtifact(root, existing.id, 'Gate 0 reference video input validated and auto-locked');
    return assertProjectState(await readJson(join(root, 'project-state.json'))).artifacts.find(artifact => artifact.id === descriptor.id);
  }

  await registerArtifact(root, {
    id: descriptor.id,
    type: 'reference_video',
    revision: 1,
    status: 'draft',
    path: projectRelative(root, targetPath),
    sourceMimeType: descriptor.mimeType,
    sourceInputSha256: source.sha256
  });
  await autoLockArtifact(root, descriptor.id, 'Gate 0 reference video input validated and auto-locked');
  return assertProjectState(await readJson(join(root, 'project-state.json'))).artifacts.find(artifact => artifact.id === descriptor.id);
}

async function importMechanicalAsset(root, descriptor) {
  const source = await inspectSourceVideo(descriptor.path);
  const extension = IMAGE_EXTENSION_BY_MIME[descriptor.mimeType]
    ?? (/^\.[a-z0-9]{1,8}$/i.test(extname(source.path)) ? extname(source.path).toLowerCase() : '.image');
  const targetDirectory = join(root, 'assets', 'project', 'uploads');
  const targetPath = join(targetDirectory, `${safeStem(descriptor.id)}-${source.sha256.slice(0, 12)}${extension}`);
  await mkdir(targetDirectory, { recursive: true });
  await copyOnce(source.path, targetPath, source.sha256);

  const existingState = assertProjectState(await readJson(join(root, 'project-state.json')));
  const existing = existingState.artifacts.find(artifact => artifact.id === descriptor.id);
  if (existing) {
    if (existing.type !== 'project_asset' || existing.sha256 !== source.sha256) {
      throw new Error(`artifact ID ${descriptor.id} already exists with different asset content`);
    }
    if (existing.status !== 'locked') {
      await autoLockArtifact(root, existing.id, 'Mechanical task input asset validated and auto-locked', {
        delegatedByExecutionClass: 'mechanical_asset_prompt'
      });
    }
    return assertProjectState(await readJson(join(root, 'project-state.json'))).artifacts.find(artifact => artifact.id === descriptor.id);
  }
  const assetType = descriptor.assetType === 'character_identity_single_view'
    ? 'character_identity_single_view'
    : 'product_reference';
  await registerArtifact(root, {
    id: descriptor.id,
    type: 'project_asset',
    assetType,
    ...(assetType === 'character_identity_single_view' ? {
      characterId: descriptor.characterId?.trim() || 'replacement-face-subject',
      visualContractVersion: 1
    } : {}),
    mediaKind: 'image',
    revision: 1,
    status: 'draft',
    path: projectRelative(root, targetPath),
    sourceMimeType: descriptor.mimeType,
    sourceInputSha256: source.sha256
  });
  await autoLockArtifact(root, descriptor.id, 'Mechanical task input asset validated and auto-locked', {
    delegatedByExecutionClass: 'mechanical_asset_prompt'
  });
  return assertProjectState(await readJson(join(root, 'project-state.json'))).artifacts.find(artifact => artifact.id === descriptor.id);
}

function completeIntakeTrace(projectId, startedAt, endedAt, status, attributes = {}) {
  const traceId = `intake-${randomUUID()}`;
  const coverageSpanId = `${traceId}-machine-coverage`;
  let trace = createExecutionTrace({
    id: traceId,
    projectId,
    startedAt,
    metadata: {
      operation: 'intake-video',
      authoritativeObservation: {
        schemaVersion: 1,
        basis: 'declared_spans',
        spanIds: [coverageSpanId],
        scope: 'project',
        stage: 'intake',
        segmentId: null,
        fields: ['machineExecutionMs']
      }
    }
  });
  trace = appendExecutionSpan(trace, {
    id: `${traceId}-project`,
    kind: 'project',
    name: 'Harness video intake',
    startedAt,
    endedAt,
    status,
    activeComputeMs: 0,
    errorClass: attributes.errorClass ?? null,
    attributes
  });
  trace = appendExecutionSpan(trace, {
    id: coverageSpanId,
    kind: 'task',
    name: 'Harness video intake local execution coverage',
    parentSpanId: `${traceId}-project`,
    startedAt,
    endedAt,
    status,
    activeComputeMs: Date.parse(endedAt) - Date.parse(startedAt),
    errorClass: attributes.errorClass ?? null,
    attributes: { coverage: 'complete_local_execution' }
  });
  return completeExecutionTrace(trace, { endedAt, status });
}

async function recordIntakeTraceBestEffort(dependencies, root, projectId, startedAt, endedAt, status, attributes) {
  try {
    await recordAuthoritativeExecutionObservation(
      root,
      completeIntakeTrace(projectId, startedAt, endedAt, status, attributes),
      {
        recordExecutionTrace: dependencies.recordExecutionTrace,
        deriveExecutionObservation: dependencies.deriveExecutionObservation
      }
    );
  } catch {
    // Trace construction and persistence are observational and must never change intake behavior.
  }
}

export async function persistVideoIntake(root, input, dependencies = {}) {
  const startedAt = new Date().toISOString();
  const result = intakeVideoRequest(input);
  if (!result.routeDecision.harnessRequired) return { ...result, persisted: false, importedReferenceVideos: [] };

  const projectRoot = resolve(root);
  let projectId = 'unknown-project';
  try {
    const state = await persistRouteDecision(projectRoot, result, input);
    projectId = state.projectId;
    const sourceIds = new Set(result.routeDecision.sourceVideoIds);
    const descriptors = input.inputs.filter(descriptor => sourceIds.has(descriptor.id));
    const importedReferenceVideos = [];
    for (const descriptor of descriptors) importedReferenceVideos.push(await importReferenceVideo(projectRoot, descriptor));
    const importedMechanicalAssets = [];
    if (result.routeDecision.executionClass === 'mechanical_asset_prompt') {
      const assetIds = new Set(result.routeDecision.assetInputIds ?? []);
      for (const descriptor of input.inputs.filter(item => assetIds.has(item.id))) {
        importedMechanicalAssets.push(await importMechanicalAsset(projectRoot, descriptor));
      }
    }
    const directorInterview = result.routeDecision.executionClass === 'mechanical_asset_prompt' ? null : await prepareDirectorInterview(projectRoot, {
      projectId: state.projectId,
      requestText: input.requestText,
      routeDecision: result.routeDecision
    });
    const endedAt = new Date().toISOString();
    await recordIntakeTraceBestEffort(
      dependencies,
      projectRoot,
      projectId,
      startedAt,
      endedAt,
      'succeeded',
      {
        referenceVideoCount: importedReferenceVideos.length,
        routeReason: result.routeDecision.reason
      }
    );
    return { ...result, persisted: true, importedReferenceVideos, importedMechanicalAssets, directorInterview };
  } catch (error) {
    const endedAt = new Date().toISOString();
    if (projectId !== 'unknown-project') {
      await recordIntakeTraceBestEffort(
        dependencies,
        projectRoot,
        projectId,
        startedAt,
        endedAt,
        'failed',
        { errorClass: error.name || 'Error' }
      );
    }
    throw error;
  }
}
