# 视频复刻知识库（Replication Library）

这是一套从 32 篇外部教学素材蒸馏出来的**备选库**：流程骨架、可复用提示词模板、避坑解法。用途是——当你丢来一条参考视频或一张图，AI 能从这里取用对应模板去**倒推提示词、走复刻流程、给真人感建议**；当踩到坑时，把解法提炼进 harness 的 `rules` 系统。

核心取舍原则（取其精华去其糟粕）：

- **只留**：可执行步骤、结构化模板、失败解法、镜头语言方法。
- **一律删**：营销引流（关注 X/Telegram、试读值 1000 元）、工具跳转广告（flowpix/各家官网链接）、重复内容、与视频生成无关的元工程。

## 目录结构

| 子目录 | 装什么 | 什么时候用 |
|---|---|---|
| `workflows/` | 从0到1 / 复刻全流程 SOP，以及分镜图、深度视频、原视频三种控制方式的组合路由 | 拿到一条参考视频时先定控制方式，再按对应 SOP 走 |
| `prompt-templates/` | 镜头语言与提示词技巧（打光、镜头角度、空间站位、故事板、俯视调度图、画线稿、打斗、统一调色、提示词优化三法则） | 写某一维度提示词时按需取模板 |
| `performance/` | 真人感 / 表演（活人感三法则、NPC重塑、有事可做、动作链、短剧活起来、声音控制） | 人物僵硬、像 NPC、一开口就假时 |
| `continuity/` | 可控性与衔接（场景不穿帮4法、首尾帧替代衔接、越轴正反打） | 多镜头/多段/对话戏，画面跳戏时 |
| `image-assets/` | 图片与资产提示词（资产体系、四视图模板、Image2.0 去斑去油腻） | 生成人物/场景/道具资产、图片质量翻车时 |
| `copywriting/` | 痛点文案（戳痛点 SOP、痛点挖掘模型） | 收腹裤带货脚本要戳卖点/痛点时（不进视频生成流程） |

## 每张卡片的固定结构

每篇素材蒸馏成一张卡，统一含：来源、适用场景、核心方法（精华）、可复用模板（占位符 `{}`）、用途标签、避坑点、什么时候不该用。

## 与 harness 的衔接

- 倒推能力入口见 [reverse-and-diagnose.md](./reverse-and-diagnose.md) 与 [SKILL.md](./SKILL.md)。
- 复刻控制方式先按 [workflows/09-remake-control-router.md](./workflows/09-remake-control-router.md) 路由；选中分镜图或深度视频时，调用 [prompt-templates/09-reverse-storyboard-engineer.md](./prompt-templates/09-reverse-storyboard-engineer.md)。
- 倒推结果先作为源事实底稿与逆向编译合同；对接新人物、商品和场景权威资产并通过编译审核后，才形成 harness 的 `shot_narration` / `seedance_prompt`。
- 反复出现的避坑解法沉淀为 `rules` 的 candidate 规则，见 [harness-rules-candidates.md](./harness-rules-candidates.md)。

## 覆盖清单与排除说明

见 [COVERAGE.md](./COVERAGE.md)：32 篇纳入项逐一对应卡片，9 篇排除项列明理由。

> 固定边界提醒：本库服务竖屏 9:16、单段 ≤15 秒的 Seedance 生产；一致性靠**参考绑定**而非在提示词里反复描述外观；提示词**只写动**，外观交给参考图。
