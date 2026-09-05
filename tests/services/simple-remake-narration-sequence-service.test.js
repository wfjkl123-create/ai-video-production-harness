import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderedPhysicalActionsFromNarration,
  renderOrderedPhysicalActionInstruction
} from '../../src/services/simple-remake-narration-sequence-service.js';

test('preserves every locked simple-remake action in chronological order', () => {
  const narration = {
    shots: [
      { physicalActions: ['用黑色记号笔在肩带边缘旁画短线', '抬臂测试后回到原位比对短线与肩带'] },
      { physicalActions: ['确认短线与肩带相对位置未改变'] }
    ]
  };

  assert.deepEqual(orderedPhysicalActionsFromNarration(narration), [
    '用黑色记号笔在肩带边缘旁画短线',
    '抬臂测试后回到原位比对短线与肩带',
    '确认短线与肩带相对位置未改变'
  ]);
  assert.match(renderOrderedPhysicalActionInstruction(narration), /不得提前、跳过、合并或改写验证步骤/);
  assert.match(renderOrderedPhysicalActionInstruction(narration), /画短线.*抬臂测试.*确认短线/);
});

test('rejects an automatic prompt when narration has no physical actions', () => {
  assert.throws(() => renderOrderedPhysicalActionInstruction({ shots: [] }), /no physical actions/);
});
