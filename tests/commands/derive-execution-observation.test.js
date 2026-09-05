import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/services/project-service.js';
import { sha256File } from '../../src/storage/checksum.js';
import { writeJsonAtomic } from '../../src/storage/json-store.js';

const execFileAsync = promisify(execFile);

test('derive-execution-observation CLI previews without writes, then records the same SHA-bound observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'derive-execution-observation-cli-'));
  await initializeProject(root, { projectId: 'DERIVATION-CLI' });
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'outputs', 'segment.mp4'), 'video');
  const videoSha256 = await sha256File(join(root, 'outputs', 'segment.mp4'));
  const reportPath = 'reviews/video-audits/cli-audit/report.json';
  await writeJsonAtomic(join(root, reportPath), {
    id: 'cli-audit', kind: 'video_audit_package', segmentId: 'segment-001', videoRunId: 'run-cli-001',
    videoPath: 'outputs/segment.mp4', videoSha256, metadata: { duration: 9.5 },
    machineDecision: 'PASS', createdAt: '2026-08-24T13:00:00.000Z'
  });
  await writeJsonAtomic(join(root, 'runs', 'run-cli-001.json'), {
    id: 'run-cli-001', status: 'SUCCESS', segmentId: 'segment-001',
    outputs: [{ path: 'outputs/segment.mp4', sha256: videoSha256 }],
    auditPackage: {
      id: 'cli-audit', reportPath, reportSha256: await sha256File(join(root, reportPath))
    }
  });
  const inputPath = join(root, 'derivation-input.json');
  await writeJsonAtomic(inputPath, {
    schemaVersion: 1, kind: 'execution_observation_derivation',
    sourceType: 'video_audit_media', reportPath
  });

  const previewRun = await execFileAsync(process.execPath, [
    'src/cli.js', 'derive-execution-observation', '--project', root, '--input', inputPath, '--dry-run'
  ]);
  assert.equal(previewRun.stderr, '');
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.status, 'READY');
  assert.equal(preview.observation.media.durationMs, 9500);
  await assert.rejects(access(join(root, 'ledger', 'head.json')), /ENOENT/);

  const deriveRun = await execFileAsync(process.execPath, [
    'src/cli.js', 'derive-execution-observation', '--project', root, '--input', inputPath
  ]);
  assert.equal(deriveRun.stderr, '');
  const result = JSON.parse(deriveRun.stdout);
  assert.equal(result.reused, false);
  assert.equal(result.observationId, preview.observationId);
  assert.equal(result.event.facts.derivationSourceType, 'video_audit_media');
});
