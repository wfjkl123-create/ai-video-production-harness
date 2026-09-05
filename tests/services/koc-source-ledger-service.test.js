import test from 'node:test';
import assert from 'node:assert/strict';
import { compileKocSourceLedger } from '../../src/services/koc-source-ledger-service.js';

const sourceVideo = { id: 'source-1', sha256: 'a'.repeat(64), durationSec: 40 };

test('compiles a gapless A/B ledger into A-roll-only packages and merges compatible rows', () => {
  const value = compileKocSourceLedger({
    projectId: 'KOC-1', sourceVideo,
    timeline: [
      { id: 'R1', startSec: 0, endSec: 5, shotClass: 'aroll_speaking_lead', spokenLine: '第一句', continuousTakeId: 'T1' },
      { id: 'R2', startSec: 5, endSec: 11, shotClass: 'aroll_speaking_lead', spokenLine: '第二句', continuousTakeId: 'T1' },
      { id: 'R3', startSec: 11, endSec: 18, shotClass: 'broll_preserve_source' },
      { id: 'R4', startSec: 18, endSec: 40, shotClass: 'aroll_speaking_lead', spokenLine: '一段很长但有自然停顿的完整口播', continuousTakeId: 'T2', safeSplitPointsSec: [31] }
    ]
  });
  assert.equal(value.inventoryAudit.fullTimelineCovered, true);
  assert.deepEqual(value.arollSegments.map(item => [item.startSec, item.endSec]), [[0, 11], [18, 31], [31, 40]]);
  assert.equal(value.arollSegments.every(item => item.containsBroll === false && item.durationSec <= 15), true);
});

test('rejects timeline gaps and overlong A-roll without an approved natural split', () => {
  assert.throws(() => compileKocSourceLedger({
    projectId: 'KOC-1', sourceVideo,
    timeline: [{ id: 'R1', startSec: 1, endSec: 40, shotClass: 'broll_preserve_source' }]
  }), /gapless/);
  assert.throws(() => compileKocSourceLedger({
    projectId: 'KOC-1', sourceVideo,
    timeline: [{ id: 'R1', startSec: 0, endSec: 40, shotClass: 'aroll_speaking_lead', spokenLine: '连续口播', continuousTakeId: 'T1' }]
  }), /no approved natural split point/);
});
