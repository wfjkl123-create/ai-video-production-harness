import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const templateUrl = new URL('../../knowledge/replication-library/prompt-templates/09-reverse-storyboard-engineer.md', import.meta.url);
const routerUrl = new URL('../../knowledge/replication-library/workflows/09-remake-control-router.md', import.meta.url);
const skillUrl = new URL('../../knowledge/replication-library/SKILL.md', import.meta.url);

test('reverse storyboard v2 keeps route, evidence, product-slot and compilation boundaries', async () => {
  const template = await readFile(templateUrl, 'utf8');

  for (const required of [
    'reverse-storyboard-engineer-v2',
    'ROUTE_SKIP_REVERSE',
    'BLOCKED_MISSING_SOURCE_EVIDENCE',
    'OBSERVED',
    'INFERRED',
    'UNKNOWN',
    '原商品槽位与交互',
    'Pxx或无商品',
    '生成段覆盖',
    '逆向提示词编译合同',
    '不是最终生成提示词'
  ]) {
    assert.match(template, new RegExp(required), `missing required contract: ${required}`);
  }

  assert.match(template, /只包含 native_source 时[\s\S]*然后停止/);
  assert.match(template, /包含 storyboard_control 或 depth_control 时[\s\S]*输出 0–5/);
  assert.match(template, /每段 <= max_generation_block_sec/);
  assert.doesNotMatch(template, /请确认你已经完全理解/);
});

test('replication library routes four user-facing remake controls and keeps KOC exclusive', async () => {
  const [router, skill] = await Promise.all([
    readFile(routerUrl, 'utf8'),
    readFile(skillUrl, 'utf8')
  ]);

  for (const control of ['分镜图', '深度视频', '原视频', 'KOC 复刻']) {
    assert.match(router, new RegExp(`\\| ${control} \\|`));
  }
  assert.match(router, /分镜图、深度视频、原视频允许自由组合/);
  assert.match(router, /KOC 复刻必须单独选择/);
  assert.match(router, /requires_reverse = selected contains 分镜图 OR selected contains 深度视频/);
  assert.match(router, /firstFramePolicy|首帧策略/);
  assert.match(skill, /“分镜图 \/ 深度视频 \/ 原视频 \/ KOC 复刻”四种方式/);
  assert.match(skill, /只选原视频时跳过逆向/);
});
