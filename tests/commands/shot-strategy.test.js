import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runShotStrategy } from '../../src/commands/shot-strategy.js';

test('shot-strategy command reads an input file and returns a conditional route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shot-strategy-'));
  const input = join(root, 'input.json');
  await writeFile(input, JSON.stringify({
    shotStructure: 'continuous_take', shotCount: 1, peopleCount: 2,
    hasPreviousSegment: true, strictSpatialCarryover: true, hasDialogue: false,
    complexPhysicalAction: false, complexBlocking: false, productInteraction: 'none',
    motionReferenceAvailable: false, visibleDrift: false, extensionDepth: 0
  }));

  const result = await runShotStrategy(['--input', input]);
  assert.equal(result.route, 'continuous_proxy_handoff');
  assert.deepEqual(result.assetRequirements, ['handoff_blocking']);
});
