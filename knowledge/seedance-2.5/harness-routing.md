# Seedance 2.5 Harness 路由

## 当前决策

Seedance 2.5 不替换全局默认的 Seedance 2.0 VIP。按镜头与返修目标升级：

| 情况 | 默认路由 |
|---|---|
| 4–15 秒、少人物、简单动作 | 保持当前已验证便宜路线 |
| 16–30 秒连续镜头 | `standard_generation` 候选 |
| 多人物、多素材、复杂动作、秒级导演 | `standard_generation` 候选 |
| 下一段必须继承速度、重心、声音和镜头惯性 | `native_extend` 候选 |
| 成片只有局部错误 | `smart_edit` / `advanced_edit` / `video_edit` |
| 需要增加/删除/替换物体或修改属性 | 先用 `smart_edit`；必须指定空间区域时升级 `advanced_edit` |
| 多语言台词或强制无字幕/BGM | 标准生成 + 台词绑定/keep-list + 生成后 ASR/OCR 验收 |
| 复杂机位、追逐、打斗、舞蹈、一镜到底 | `white_model_video` + 标准生成 |
| 强控制或1:1复刻 | 先执行 `modeling_strong_control`；2.5 别名、价格和视频输入授权闭环后，才把 `spatial_control_animatic` 作为白模视频输入 |
| 两条通过视频之间缺桥段 | `transition_bridge` |
| 30–180 秒低返工风险叙事/氛围/预演 | `ultralong` 候选 |
| 精确爆款复刻或后半段失败代价高 | 不默认走超长单任务 |

## 五道门衔接

### 门 1

- 展示 2.0、2.5 标准、延长、超长、编辑、白模和补间的成本/返工差异。
- 只决定执行模式与并行计划，不提前制作资产。

### 门 2

- Shotlist 完整覆盖 `[0,T]`。
- 对 30 秒与超长模式增加章节/时间片、不可逆状态和里程碑。
- 从 Shotlist 反推最小资产集合；不因为 2.5 支持 50 个参考就塞满素材。
- 普通项目的白模只在复杂调度命中时进入 `assetScope`；用户明确“强控制”或1:1复刻时默认进入建模路线，不受普通最小资产规则豁免。
- `.blend`、完整 animatic、模型派生端点和原片逐时点对照必须先按 `knowledge/capabilities/modeling-strong-control.md` 锁定。

### 门 3

- 审核角色板和独立原子视图。
- 审核 `spatial_control_model`、可选 `spatial_control_animatic`、模型派生端点、标注图、多宫格、两个补间端点等新资产。
- 每项资产记录唯一职责、禁止迁移内容和 SHA。

### 门 4

- 重新编译当前 operation 的精确指纹。
- 展示硬上限、稳定警告、分辨率、精确任务数、预计积分和一次失败的最大损失。
- 每次延长、编辑、补间、换模型都需要新的付费批准。
- 当前 LibTV 无 Seedance 2.5 可解析别名，因此所有 2.5 计划保持免费编译状态，禁止提交。

### 门 5

- 先判断整条重生还是局部返修。
- 编辑结果检查标注区外变化、身份、服装、产品、声音和时间边界。
- 延长结果检查原视频是否被改写、衔接动作、音频连续性和新增段污染。
- 补间结果检查 A/B 端是否保持、桥段是否改变身份/分辨率/音轨。
- 超长视频按里程碑逐段检查，不因文件可播放就宣布整条通过。

## operation 与指纹

每个计划必须包含：

```text
modelFamily
operation
capability
sourceMediaIds + SHA
duration/sourceDuration/extensionDuration
media counts and total durations
output resolution and ratio
timeline SHA
annotation SHA / white-model SHA / endpoint SHA
prompt SHA
pricingSnapshot
stabilityWarnings
model alias evidence
automaticRetryAllowed=false
```

## pricingSnapshot

```json
{
  "model": "Seedance 2.5",
  "operation": "standard_generation",
  "resolution": "720p",
  "durationSec": 30,
  "taskCount": 1,
  "displayedPoints": 780,
  "discountState": "account UI observation",
  "observedAt": "2026-07-31T00:00:00+08:00",
  "maximumFailureExposurePoints": 780
}
```

积分截图和当前账号 UI 是时点观察，不是长期价目表。提交前必须刷新；不得把折扣价、划线价或估算人民币伪装成实际扣费。

## 稳定性规则

以下情况只发警告，不自动删除素材：

- 图片超过 8。
- 视频超过 5。
- 音频超过 5。
- 主体音视频超过 10 秒。
- 编辑源超过 20 秒。
- 编辑参考图超过 5。
- 多于 5 个主体仍仅提供一张多视图宫格。

出现警告时重新做职责去重；若素材均有不可替代职责，保留并在门 4 展示风险。

## 分辨率与执行阻塞

- 当前手册正文只确认 480p/720p 输出。
- 原片基准高于 720p 时，2.5 计划在免费编译阶段 FAIL，直到真实模型/API/平台输出验证更高档位。
- 2026-07-31 的 `libtv model search -t video "Seedance 2.5"` 没有匹配结果。
- 不猜测别名、不修改现有 2.0 profile、不复用 2.0 的审批和请求指纹。
