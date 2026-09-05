import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/services/project-service.js';
import { appendExecutionEvent } from '../../src/services/execution-ledger-service.js';

const execFileAsync = promisify(execFile);

test('ledger-status CLI returns the shared read-only status contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-status-cli-'));
  await initializeProject(root, { projectId: 'LEDGER-STATUS-CLI' });
  await appendExecutionEvent(root, {
    type: 'preflight.ready', occurredAt: '2026-08-24T10:00:00.000Z',
    actor: { kind: 'system', id: null }, segmentId: 'segment-001', correlationId: 'preflight-001', causationId: null,
    idempotencyKey: 'preflight.ready:preflight-001', references: [], facts: { preflightId: 'preflight-001' }
  });
  const { stdout, stderr } = await execFileAsync(process.execPath, ['src/cli.js', 'ledger-status', '--project', root]);
  assert.equal(stderr, '');
  const status = JSON.parse(stdout);
  assert.equal(status.kind, 'execution_ledger_status');
  assert.equal(status.consistency, 'consistent');
  assert.equal(status.funnel.find(stage => stage.id === 'preflight').status, 'observed');
});
