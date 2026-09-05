# 覆盖清单与排除说明

## 2026-07-31 Seedance 2.5 官方增量

新增官方来源《【即梦】Seedance 2.5 使用手册》及白模插件手册，单独沉淀在 `../seedance-2.5/`，不混入原 32 篇第三方卡片计数。覆盖：标准 30 秒、多模态参考、时间戳、真人、超长、原生延长、智能/高级/视频编辑、BGM 分离、创意迁移、局部编辑、空间视角、音色、多人、绿幕、粗/细白模、两视频补间、多宫格分镜、转场词库、稳定区间、价格与执行边界。

原始官方案例与 Harness 生产模板分层保存：官方自由编号、隐含指代、时间轴空档、品牌/IP/水印案例和作者主观评价不得直接进入正向生产模板。详细证据和路由见：

- `../seedance-2.5/README.md`
- `../seedance-2.5/prompt-contracts.md`
- `../seedance-2.5/harness-routing.md`

## 纳入（32 篇 → 卡片映射）

### A 复刻全流程（9）→ workflows/

| 源文件 | 卡片 |
|---|---|
| AI视频复刻全攻略：轻松搞定TVC与UGC | 01-tvc-ugc-replication + 09-reverse-storyboard-engineer |
| 一键复刻爆款服装视频 | 01-tvc-ugc-replication + 02-outfit-change-replication |
| 50万赞穿搭视频，如何用AI完整复刻？ | 02-outfit-change-replication + 02-fourview-board |
| AI舞蹈复刻教程 | 03-dance-replication |
| 女频古风短剧工作流 | 04-costume-drama-workflow |
| 30秒日系预告短片 | 05-japanese-trailer-workflow |
| 复杂动作视频：两种方法 | 06-complex-action-two-methods |
| 复刻大师镜头 | 07-master-shots-workflow |
| 【电商赋能】TVC与UGC（复刻全攻略同源实操） | 01 / 00-backbone |

### B 提示词/镜头语言（17）→ prompt-templates/ + performance/

| 源文件（节次） | 卡片 |
|---|---|
| 64 五种打光 / 47 光影重构 | prompt-templates/01-lighting-5-methods |
| 66 镜头角度 | prompt-templates/02-camera-angle |
| 45 空间控制 / 62 画线稿 / 68 俯视调度图 | prompt-templates/03-spatial-anchor-control（+08-rough-sketch-to-image）|
| 57 故事板 | prompt-templates/04-storyboard-stabilize |
| 63 打斗提示词 | prompt-templates/05-fight-choreography |
| 71 统一调色 | prompt-templates/06-color-grading-unify |
| 50 提示词优化三法则 | prompt-templates/07-prompt-optimization-3-rules |
| 49 活人感三法则 | performance/01-liveness-3-laws |
| 51 NPC重塑 | performance/02-npc-to-acting |
| 53 有事可做 / 59 短剧活起来 | performance/03-give-character-something-to-do |
| 54 动作更自然 | performance/04-natural-motion-chain |
| 48 声音控制 | performance/05-voice-control |

> 说明：45/62/68 三篇「空间/线稿/调度」合并到 03-spatial-anchor-control 与 08-rough-sketch-to-image 两张卡（同一方法族）；47 与 64 同为打光并入 01；53 与 59 同为「有事可做/活起来」并入 performance/03。合计覆盖 17 篇。

### C 资产/一致性/图片（4）→ image-assets/ + continuity/

| 源文件 | 卡片 |
|---|---|
| 67 AI资产怎么做 | image-assets/01-asset-system（+02-fourview-board）|
| AI 场景不穿帮 4 种方法 | continuity/01-scene-consistency-4-methods |
| 58 别用首尾帧硬接 | continuity/02-long-video-stitching |
| 图片技巧 Image 2.0 去斑去油腻 | image-assets/03-image2-deoil-despot |
| AI对话戏不越轴（跨 B/C） | continuity/03-dialogue-180-rule |

### D 痛点文案（2）→ copywriting/

| 源文件 | 卡片 |
|---|---|
| 痛点戳不好…用户不掏钱 | copywriting/01-painpoint-sop |
| 痛点戳不好…一次性讲透 | copywriting/01-painpoint-sop（同源合并）|

## 排除（9 篇 + 索引）

| 源文件 | 排除理由 |
|---|---|
| Loops explained Claude, GPT, Mira… | 纯 AI agent 循环工程，正文无 Seedance/视频 |
| Getting started with loops | 同上（Claude Code 团队 loop 定义） |
| Build self-improving agent system with Fable 5… | agent 自进化系统，与视频生成无关 |
| Claude Code 官方教你 Loop 工程 | loop 工程中文解读，无视频内容 |
| How to Build a Second Brain…(Karpathy) | 知识管理/第二大脑 |
| 一文讲清楚…如何搭建AI知识库 | 企业知识库 |
| 一文讲清楚…如何搭建AI知识库 1 | 上一篇的重复文件 |
| Codex自动化剪辑从0到1 | 后期自动剪辑，超出 harness §1 边界（不做后期剪辑） |
| README_网页剪藏待处理规则 | 剪藏索引说明，非内容 |

已逐篇读正文确认 E 类核心非视频生成。
