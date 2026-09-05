import { resolve } from 'node:path';
import { option } from './args.js';
import { rebindAssetManifest } from '../services/asset-manifest-rebind-service.js';

export async function runRebindAssetManifest(args) {
  return rebindAssetManifest(
    resolve(option(args, 'project')),
    option(args, 'segment'),
    option(args, 'note')
  );
}
