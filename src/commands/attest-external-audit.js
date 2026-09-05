import { resolve } from 'node:path';
import { readJson } from '../storage/json-store.js';
import { persistExternalAuditAttestation } from '../services/batch-generation-service.js';
import { option } from './args.js';

export async function runAttestExternalAudit(args) {
  const root = resolve(option(args, 'project'));
  return persistExternalAuditAttestation(root, {
    attestation: await readJson(resolve(option(args, 'input'))), reportPath: option(args, 'report')
  });
}
