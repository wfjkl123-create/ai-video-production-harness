# 倒推与诊断方法卡（丢一张图/一条视频 → 出提示词 + 真人感体检）

这是本库的**核心能力入口**。分两个能力：A. 图/视频 → 倒推提示词；B. 真人感诊断。

## A. 图 → 倒推提示词

目标：拿一张参考图，产出可直接生成的提示词（分「图片提示词」或「视频某镜提示词」两种落点）。

步骤：

1. **拆画面**（六要素，逐项写具体，不写形容词）：
   - 镜头：角度(平/俯/仰) + 景别 + 焦段感 + 空间前中后景（→ `prompt-templates/02-camera-angle.md`）。
   - 光：主光方位 + 光型 + 软硬 + 色温 + 明暗过渡（→ `prompt-templates/01-lighting-5-methods.md`）。
   - 人物：身份特征交给参考图，只描述**在做什么**的物理动作 + 微表情（→ `performance/`）。
   - 场景：空间结构/锚点/材质/时间天气。
   - 色彩质感：主辅点缀色 + 胶片/数码质感 + 负面词。
   - 动作（若倒推视频）：步态 + 身体联动 + 动作链（→ `performance/04-natural-motion-chain.md`）。
2. **套模板**：按落点选库里对应模板填占位符。
3. **只写动**：外观交参考图，提示词聚焦运动与变化（→ `prompt-templates/07-prompt-optimization-3-rules.md`）。
4. **输出格式**：逐镜「讲戏本」（物理动作/运镜/光源方位/情绪落成动作）→ 可直接作为 harness `shot_narration`；压缩成聚焦提示词 → 作为 `seedance_prompt`。

> 一条参考**视频**倒推：先用 `workflows/09-remake-control-router.md` 判断控制方式。选中分镜图或深度视频时，调用 `prompt-templates/09-reverse-storyboard-engineer.md`（时长锁定 + 台词证据 + Shot/商品槽位账本 + ≤15 秒生成段 + 编译合同）；只选官方原生替换时跳过逆向。

## B. 真人感诊断（逐项体检 → 给修正）

对一张成图/一段视频逐项打分并给修正方向：

| 维度 | 查什么 | 不合格时的修正 |
|---|---|---|
| 脸/皮肤 | 油腻、塑料、过度磨皮、斑点 | `image-assets/03-image2-deoil-despot.md` |
| 状态/表情 | 空洞眼神、模板大表情、面无表情 | `performance/01`、`performance/02` 微表情+情绪切换 |
| 动作 | 站太稳、无动机、滑行、僵硬 | `performance/03`（有事可做）、`04`（动作链） |
| 光 | 太平均、没方向、没层次 | `prompt-templates/01` 打光逻辑 |
| 质感/氛围 | 跳色、平、无空间 | `prompt-templates/06` 统一调色、`01` 体积光 |
| 声音（视频） | 语气平、音色不分 | `performance/05` 声音结构 |
| 衔接（多段） | 段间卡顿、跳戏、越轴 | `continuity/` 三张卡 |

输出：一份「逐维度：现状问题 → 具体修正模板」的诊断清单。

## 与 harness 的对接

- 倒推产出是源事实与编译合同，不直接冒充最终提示词；完成新商品/人物/场景权威绑定和下游编译审核后，才进入 harness `shot_narration` / `seedance_prompt`。
- 诊断反复命中的问题 → 提炼成 `rules` 的 candidate（见 `harness-rules-candidates.md`）。
