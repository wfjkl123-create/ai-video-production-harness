import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { assertSpatialControlModel } from '../domain/spatial-control-model.js';
import { sha256File } from '../storage/checksum.js';
import { readJson } from '../storage/json-store.js';
import { registerArtifact } from './intake-service.js';

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function verifyFile(root, descriptor, field) {
  if (descriptor.path.startsWith('/')) throw new Error(`${field}.path must be project-relative`);
  const candidate = resolve(root, descriptor.path);
  if (!inside(root, candidate)) throw new Error(`${field}.path escapes the project root`);
  const actual = await realpath(candidate);
  if (!inside(root, actual)) throw new Error(`${field}.path resolves outside the project root`);
  const digest = await sha256File(actual);
  if (digest !== descriptor.sha256) throw new Error(`${field}.sha256 does not match the current file`);
}

export async function registerSpatialControlModel(root, inputPath) {
  root = await realpath(resolve(root));
  const absoluteInput = await realpath(resolve(inputPath));
  if (!inside(root, absoluteInput)) throw new Error('spatial control input must stay inside the project root');
  const value = assertSpatialControlModel(await readJson(absoluteInput));
  const state = await readJson(resolve(root, 'project-state.json'));
  if (value.projectId !== state.projectId) throw new Error('spatial control projectId does not match project-state.json');
  await verifyFile(root, value.blenderProject, 'blenderProject');
  await verifyFile(root, value.animatic, 'animatic');
  if (value.sourceReference) await verifyFile(root, value.sourceReference, 'sourceReference');
  for (const [index, asset] of value.derivedAssets.entries()) await verifyFile(root, asset, `derivedAssets[${index}]`);
  const path = relative(root, absoluteInput);
  return registerArtifact(root, {
    id: value.id,
    type: 'spatial_control_model',
    segmentId: value.segmentId,
    revision: value.revision,
    status: 'draft',
    path,
    fidelityTarget: value.fidelityTarget,
    modelingInputMode: value.modelingInputMode,
    blenderProjectSha256: value.blenderProject.sha256,
    animaticSha256: value.animatic.sha256,
    validationComparisonId: value.validation.comparisonId,
    derivedAssetIds: value.derivedAssets.map(asset => asset.id)
  });
}
