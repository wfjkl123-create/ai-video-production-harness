# 建模强控制：Blender 空间与镜头预演合同

## 1. 默认触发

用户出现以下任一表达时，默认启用本能力，不再只靠文字提示词、独立分镜图或彼此无关的灰模图片：

- “强控制”“强生成”“严格控制人物站位/构图/镜头”；
- “1:1 复刻”“一比一复刻”“动作和情节与原片一样”；
- 明确要求使用 Blender、白模、灰模、低模动画或三维预演；
- 镜头包含多人复杂调度、连续接触、复杂物理动作或精确运镜，并且普通参考图无法稳定表达。

Gate 1 应锁定：

```json
{
  "transformMode": "faithful_remake",
  "fidelityTarget": "one_to_one",
  "controlMode": "modeling_strong_control",
  "modelingInputMode": "keyframes_only | animatic_video"
}
```

简单换背景、换产品、本地确定性编辑不会因为项目里存在 Blender 而自动升级；只有上述触发成立才进入本路线。

## 2. 核心原则

Blender 场景不是一张辅助图，而是当前生成单元的**空间、接触、动作和摄影机权威源**。人物站位、姿态、距离、遮挡、接触点、镜头位置、镜头路径、切点和动作时序必须在同一个 `.blend` 文件中成立。灰模视频和关键帧只能从该文件确定性导出，禁止分别用图片模型“猜”出几张看起来相似的图后冒充建模控制。

权威分离：

- Blender 控制：`position`、`pose`、`contact`、`occlusion`、`camera`、`camera_path`、`action_timing`、`shot_transitions`；
- canonical 资产控制：人物身份、脸、正式服装、产品结构、场景纹理、材质、颜色、清晰度和世界风格；
- 禁止迁移：灰模颜色、低模表面、骨骼控制器、轨迹线、坐标轴、标签、camera cone、简化几何和代理产品外观。

当用户要求“高精度 3D 建模视频”、人物手指/发型/衣纹或核心产品结构必须清晰时，此空间权威再加载 [高精度三维还原提示词合同](high-fidelity-3d-reconstruction-prompt.md)。它把人物和核心产品升级为高精度可见细节，但不改变 canonical 资产是最终外观权威的边界。

## 3. 从原片到建模的固定流程

### A. 原片测量

先建立无缝覆盖的逐 Shot 时间轴，记录每个可观察时点：景别、人物屏幕位置、身体朝向、视线、接触、遮挡、动作阶段、镜头运动和切点。原片只作分析证据；未获授权时不得作为视频生成输入。

### B. 摄影机匹配

在 Blender 中先匹配画幅、相机高度、视线方向、透视、镜头焦段和构图，再摆人物。不得先做人物动作、最后才随意调整摄影机去“看起来差不多”。

### C. 场景与主体代理

只建立会影响构图、运动、遮挡、接触和光向的低精度几何。每个人物和关键道具使用永久 ID 与唯一低饱和代理色，跨镜头不交换。

### D. 动作与物理接触

每个关键动作都必须有：触发时点、接触开始、作用过程、接触结束、人物反应和最终保持状态。抓布、拉扯、穿衣、拥抱、跌倒等不能只摆一个静态姿势；必须在动画里看到手与目标物的连续接触、目标物受力和松开终点。

### E. 镜头和剪辑

镜头路径、速度变化、停点、硬切和转场时点写进 Blender 时间轴。若原片有多镜头，可在同一工程中使用多个 camera 并锁定切换帧；不得让视频模型自行猜切点。

### F. 确定性导出

每个生成单元至少产出：

1. `.blend` 空间控制工程；
2. 完整灰模/白模 animatic MP4；
3. 从同一 camera 和时间轴导出的起点、触发、接触、反应、终点关键帧；
4. 原片—建模逐时点对照记录；
5. `spatial_control_model` 合同和所有文件 SHA。

关键帧是 `director_view_proxy`，不是独立故事板。建模覆盖完整且审核通过后，默认不再制作 storyboard 或 mannequin grid。

## 4. 两个生成控制等级

### `animatic_video`：视频级强控制

视频模型真实支持白模/灰模视频重渲染，且用户批准视频输入成本时，上传 animatic。它只负责空间、动作、接触、镜头和时序；同时绑定 canonical 人物、产品和场景外观资产。该模式才可以主张“连续动作由建模视频直接控制”。

### `keyframes_only`：建模派生的图片控制

用户不允许上传视频、模型不支持或成本过高时，animatic 仍必须完成并用于内部导演审核，但生成节点只绑定从同一模型导出的关键帧。此模式比独立分镜图更一致，却**不能声称已经锁定连续动作**。Gate 4 必须展示 `MODELING_CONTROL_DOWNGRADED_TO_KEYFRAMES` 警告；复杂接触应拆成更小生成单元。

不得把 `keyframes_only` 的失败归咎于“提示词不够长”，也不得把静态端点通过审核等同于动作过程已经受控。

## 5. 建模审核清单

在资产门展示给用户前，Agent 自检和独立审查至少逐时点核对：

1. 相机画幅、景别和主体屏幕占比；
2. 人物左右关系、前中后景和朝向；
3. 视线目标和对手反应顺序；
4. 动作触发、接触开始、受力过程、接触结束；
5. 道具位置、尺度、归属和遮挡；
6. 相机路径、速度、停点和切点；
7. 起始状态、动作端点和最后保持；
8. 灰模污染、控制器、坐标轴、标签和多余几何是否清除；
9. canonical 外观资产是否仍是身份、产品、材质和世界权威。

任一 Must-see 动作在 animatic 中不可读，直接 FAIL；不得因为整体走位“差不多”而通过。

## 6. Harness 产物与命令

```bash
cp templates/project/spatial-control-model-input.json \
  "$PROJECT/planning/spatial-control-model-segment-001-v1.json"

node src/cli.js spatial-control-model \
  --project "$PROJECT" \
  --input planning/spatial-control-model-segment-001-v1.json
```

登记后的 `spatial_control_model` 必须经过现有审核并锁定。其派生 `director_view_proxy` / `spatial_control_animatic` 必须声明同一个 `sourceControlModelId` 与 `sourceControlModelSha256`；否则资产 manifest 直接 FAIL。

## 7. 停止条件

- 缺 `.blend`、完整 animatic、至少两个模型派生端点或源片对照 PASS，不得进入视频生成；
- `one_to_one` 未启用 `modeling_strong_control`，导演路由直接 BLOCKED；
- 用户未批准视频输入成本时，只能选择 `keyframes_only`，不得擅自上传 animatic；
- 建模通过不代表成片通过；Gate 5 仍必须检查模型是否真正执行了动作、关系和镜头。
