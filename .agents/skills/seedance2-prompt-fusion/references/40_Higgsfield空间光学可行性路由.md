# Higgsfield 空间光学可行性路由

本文件吸收用户提供的 `higgsfield-seedance-prompt-builder.md` 中具有新增价值的空间、机位、光学与镜头装置方法。它是 `seedance2-prompt` 的条件审查层，不是独立 Skill、主系统提示词或第二个提示词作者。

## 1. 来源与证据边界

- 来源文件：经本地审查的第三方公开提示词资料；原始本机文件路径不随公开发行版分发。
- 来源声明版本：`4.4.2`
- 来源 SHA256：`0ef0fff88bd563eafb223b7892c506cd9c1c638e0c72d5946934fc958d5d2e6d`
- 本地审查日期：`2026-08-24`
- 已核事实：Higgsfield 官方页面 `https://higgsfield.ai/blog/case4k` 公开分发同类 Prompt Skill；`https://higgsfield.ai/blog/seedance-2-5-prompting-guide` 在 2026-08-24 的核验中使用对角 FOV/镜头锁定表达。
- 未核事实：公开页面没有证明这个本地文件的 `4.4.2` 与上述 SHA 是最新发布包。

规则分六级：

1. `official_documented_syntax`：官方页面展示或建议过这种写法，只证明写法存在；
2. `source_reported_test`：Higgsfield 声称或展示过测试，只证明来源方报告；
3. `official_parameter_contract`：当前官方接口/界面把该数值暴露为可控参数，并绑定证据 ID、surface、model version 与核验日期；
4. `current_runtime_verified`：当前 surface/model/settings 的当次复现实验支持，并绑定测试 ID、日期与有效参数范围；
5. `cinematography_heuristic`：摄影学上合理，但不是模型能力合同；
6. `unsupported_claim`：100% 匹配、像素级复刻、绝对锁定等不可验证承诺。

只有 `official_parameter_contract`、`current_runtime_verified` 或用户本次明确给定的测量值可以让精确数值进入正文；前两级只能说明提示意图或来源示例，不能称为已验证控制。摄影启发式默认压成可见自然语言；不可验证承诺必须删除或降级表述。即使精确值有证据，也只证明参数输入或复现实验，不承诺生成结果必然精确执行。

## 2. 何时加载

命中任一条件时加载本文件：

- 当前 surface 明确为 Higgsfield；
- 用户指定 FOV、焦段、机位距离、极端俯仰或滚转；
- 狭小房间、车内、柜内、贴墙机位等空间净空可能限制镜头；
- 多人复杂调度、强前后景遮挡、轴线或接触关系容易漂移；
- 首帧有空镜、入场、揭示、POV、白闪/黑场恢复等特殊意图；
- dolly zoom、crash zoom、荷兰角、窥视、穿越前景、甩镜等强镜头装置；
- 已生成失败表现为人物太小、微表演不可读、空间挤压、透视不符或装置没有被执行。

普通单主体、普通景别、无空间冲突的简单镜头不加载，避免把每条提示词都参数化。

## 3. 渐进路由

- 镜头任务、FOV/焦段感、画框占比、表演可读性或空间净空冲突：读 ref 41。
- 机位高度/侧别/距离/瞄准点/滚转、空间地图、轴线、首帧调度：读 ref 42。
- 具名镜头装置、风格翻译、镜头装置失败或多装置冲突：读 ref 43。

一个任务可同时命中多份，但不得因为加载本路由就全量打开 refs 41–43。

## 4. 内部空间光学合同

复杂镜头先在内部得到下列最小结果，再写正文：

```text
contractVersion：固定为 spatial-optics-v1
surface / modelVersion
shotJob：当前镜头唯一主要任务
readabilityTarget：必须让观众读到什么，主体需占多大画面
worldMap：主体、相机、动作轴、前中后景、遮挡、接触和出口
cameraPose：高度、左右侧、可用距离/净空、瞄准点、必要滚转
opticsIntent：视野广度、透视/压缩、背景信息量；精确值及证据级别
firstFrameMode：主体已在场 / 有意空镜 / 入场 / 揭示 / POV 恢复
primaryDevice：最多一个强镜头装置及其触发、峰值、恢复
conflicts：冲突项、保护优先级、所需调整
changeClass：无损归一化 / 参数降级 / 实质创意变化
approvedIntent：批准来源 payload、其可重算 SHA 与锁定字段，用于由验证器推导是否改变核心意图
promptBody：最终模型正文，机器直接检查污染、标签、语言和无证据精确值
```

这些字段只留在导演预演或审计记录。最终模型正文只写当前镜头可见、可听、可执行的结果。

## 5. 可行性否决权与用户意图保护

冲突优先级固定为：安全与授权 → 当前 surface 已验证限制 → 用户明确锁定项 → 素材职责 → 物理/空间可行性与可读性 → 连续性 → 摄影/剪辑 → 风格偏好。

允许无提示完成的调整：

- 同义摄影术语归一化；
- 删除没有证据的多余小数、米数或角度，改成等价的可见关系；
- 将审计字段压成自然导演语言；
- 不改变故事、景别、装置、素材职责和台词的局部消歧。

必须向用户或审核门暴露的实质变化：

- 改变用户锁定的景别、机位侧、主装置、首帧揭示或主体关系；
- 为解决物理冲突而删掉人物、镜头、台词或产品功能；
- 改变素材权威、平台 surface、中文台词或已批准的故事因果；
- 把一个不可兼容目标替换为“最接近效果”。

不能同时满足时，保留优先级更高的要求，清楚标记受限项和最小替代方案；禁止静默牺牲核心意图。

## 6. 正文编译边界

- 默认仍为简体中文正文；Higgsfield 或摄影术语只保留必要英文锚点。
- Higgsfield 界面中用户已提供的原生 `@` 标签逐字保留；Harness 内部只写 `@素材[exact-id]`，由编译器机械映射。不得混用自由别名。
- 负面约束只针对当前高概率失败，不因来源文件偏好删除既有的必要防污染约束。
- 不写 `FOV solver`、`feasibility veto`、`world map`、证据级别或审核结论等内部标题。
- 不承诺 100% 匹配、像素级一致、绝对锁脸、绝对锁镜头或精确声音复制。

## 7. 验证

命中本路由的复杂镜头必须保存完整空间光学合同并运行：

```bash
python3 scripts/validate_spatial_optics_contract.py contract.json
```

报告必须同时得到 `CONTRACT_VALIDATION_PASS` 与 `PROMPT_BODY_LINT_PASS`。任一字段缺失、类型错误、占位值、未声明正文数字或未绑定证据均 FAIL；`PLATFORM_EXECUTION_NOT_VERIFIED` 始终保留，直到当前生成结果完成播放级审片。

合同结构见 `spatial-optics-contract.schema.json`。Schema 与验证器只证明结构完整和预定义矛盾已排除，不证明平台执行，也不替代生成后播放级审片。
