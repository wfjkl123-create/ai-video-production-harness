# 灌进 harness 的 candidate 规则（避坑解法）

从 A/C/continuity 类提炼的可执行避坑解法，已通过 `node src/cli.js rules create` 落入 `projects/replication-pilot-001/rules/`，状态为 `candidate`，遵循现有 candidate→hard 生命周期（需真实返工成功+人工批准才升级为 hard）。触发字段用现有 `CONTEXT_FIELDS`：product/assetType/shotType/motionType/peopleCountRange/spaceComplexity。

| 规则 id | 症状 | 纠正 | 来源卡 |
|---|---|---|---|
| rule-storyboard-no-frame-marks | 分镜/故事板线稿被当成要画的东西，渲出分格框/箭头/镜号文字 | 故事板只作走位骨架，提示词显式禁止渲出分格线/箭头/文字/镜号 | continuity + 设计规格 §6.4 |
| rule-handoff-not-lastframe | 用首尾帧硬接，段间运动不连续、卡顿变假 | 用「视频延续视频」+ 结尾运动状态重述，而非只取末帧图 | continuity/02 |
| rule-image2-deoil | Image 2.0 皮肤/服装出斑点与油腻塑料感 | 加真实纹理正向词+斑点/油腻负面词，换干净参考图，Nano Banana Pro 二次清理 | image-assets/03 |
| rule-scene-anchor-lock | 镜头一切场景就变，跨镜不一致 | 先建空间真相源（九宫格/俯视/全景）再生成镜头，锁固定锚点与光源方向 | continuity/01 |
| rule-dialogue-no-axis-cross | 对话戏正反打人物左右乱跳（越轴） | 先用站位图锁 180 度轴线，所有镜头在轴线同侧拍 | continuity/03 |
| rule-prompt-only-motion | 提示词重复描述外观、堆砌稀释运动权重 | 只写动，外观交参考图，单条聚焦≤3 个核心动作，冲突项进负面 | prompt-templates/07 |

> 说明：这些是 candidate，不是硬编码进代码。它们只在匹配上下文的返工里被检索加载；实际修复成功且人工批准后才升级 hard。规则库只增不减的审计仍走 harness 既有机制。

## 复现命令

```bash
# 每条规则一个 feedback JSON，逐条 create（已执行，见 projects/replication-pilot-001/rules/）
node src/cli.js rules create --project "$PWD/projects/replication-pilot-001" --feedback <feedback.json>
```

feedback JSON 字段：`id, trigger{product,assetType,shotType,motionType,peopleCountRange{min,max},spaceComplexity}, symptom, evidence[], reason, correction, forbidden[], sourceProject, sourceSegment`。
