import { resolve } from 'node:path';
import { option } from './args.js';
import { repairLegacyCrossScopeSupersession } from '../services/artifact-lineage-repair-service.js';

export async function runRepairArtifactLineage(args) {
  return repairLegacyCrossScopeSupersession(resolve(option(args, 'project')), {
    artifactId: option(args, 'artifact'),
    priorArtifactId: option(args, 'prior'),
    segmentAliasPath: option(args, 'segment-alias'),
    note: option(args, 'note')
  });
}
