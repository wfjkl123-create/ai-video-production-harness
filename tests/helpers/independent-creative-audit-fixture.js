import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readJson, writeJsonAtomic } from '../../src/storage/json-store.js';
import { sha256File } from '../../src/storage/checksum.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { submitForReview, approveArtifact } from '../../src/services/review-service.js';

export async function lockPassingIndependentAudit(root, segmentId, {
  id = `independent-audit-${segmentId}-v1`,
  revision = 1,
  agentTaskId = 'clean-agent-fixture'
} = {}) {
  const packagePath = `prompts/${segmentId}/seedance-package.json`;
  const packageValue = await readJson(join(root, packagePath));
  const inputMedia = {};
  for (const [key, source] of [['images', 'imageInputs'], ['videos', 'videoInputs'], ['audio', 'audioInputs']]) {
    inputMedia[key] = packageValue[source].map(({ id: mediaId, path, sha256 }) => ({
      id: mediaId,
      path: (isAbsolute(path) ? relative(root, path) : path).split(sep).join('/'),
      sha256
    }));
  }
  const reportPath = `reviews/${id}-report.md`;
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(join(root, reportPath), '# Independent clean audit\n\nPASS: prompt, plot, blocking, camera and assets are aligned.\n');
  const auditPath = `reviews/${id}.json`;
  await writeJsonAtomic(join(root, auditPath), {
    id,
    kind: 'independent_creative_audit',
    segmentId,
    revision,
    decision: 'PASS',
    agentContextMode: 'clean_zero_context',
    agentTaskId,
    sourceRange: '00:00-00:12',
    reportPath,
    reportSha256: await sha256File(join(root, reportPath)),
    promptSha256: await sha256File(join(root, packageValue.promptPath)),
    packageSha256: await sha256File(join(root, packagePath)),
    inputMedia,
    blockerCount: 0,
    importantCount: 0,
    reviewedAt: '2026-07-24T00:00:00.000Z'
  });
  const artifact = await registerArtifact(root, {
    id, type: 'independent_creative_audit', segmentId, revision, status: 'draft', path: auditPath
  });
  await submitForReview(root, artifact.id);
  await approveArtifact(root, artifact.id, 'human accepts independent clean audit PASS evidence');
  return artifact;
}
