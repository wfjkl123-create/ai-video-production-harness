# AI 视频生产 Harness 操作手册

本手册是当前 CLI 的可执行顺序。项目事实以项目目录内的 `project-state.json` 为准；不要手改它来跳过审核。

## 0. 固定边界

### 0.0 确定性视频入口

新项目默认使用 workflow v2。上传视频、视频创作、视频生成或 AI 生成视频必须先经过统一入口；普通问答、纯研究、单独解释和明确 opt-out 会只读旁路。入口会把视频复制到项目内、计算 SHA、登记并自动锁定 `reference_video`，同时持久化路由决定。进入 Harness 不会自动把视频升级为复刻权威。

```bash
node src/cli.js init --project "$PROJECT" --project-id pilot-001
node src/cli.js intake-video --project "$PROJECT" \
  --request "用上传的视频做一条 AI 视频" \
  --inputs-json '[{"id":"source-001","mimeType":"video/mp4","path":"/绝对路径/source.mp4"}]'
node src/cli.js next --project "$PROJECT"
```

若视频用途不明，`next` 返回 `resolve_reference_role`；明确后用 `--reference-intent inspiration_only|faithful_remake|source_modification` 重跑同一入口。显式 legacy 项目才使用 `init --workflow-version 1`。

入口会同时创建 route-bound `brief/director-interview-v1.json`；`next` 必须先返回 `answer_director_interview`，完成后才允许进入 Gate 1。若已有下游产物后方向改变，必须使用用户明确确认过的 scope revision；旧产物保留但从 current artifact 集合失效：

```bash
node src/cli.js director-interview --project "$PROJECT" --request "当前用户视频需求原文"
# 将页面/对话中用户回答按 question id 写入 Gate 0 答案 JSON
node src/cli.js director-interview --project "$PROJECT" --answers brief/director-interview-answers.json
```

```bash
node src/cli.js intake-video --project "$PROJECT" \
  --request "照着原片的动作、构图和节奏做，只替换产品" \
  --reference-intent source_modification \
  --confirm-scope-revision \
  --scope-revision-reason "用户把原片从灵感参考改为事实权威，只替换产品"
```

### 0.1 Gate 0：需求剖析与主动提问（进入门1之前）

对每一个新创意、图片、视频、复刻或项目范围变更，先只读检查项目上下文和已有素材，再动态提出 `1–5` 个真正会改变目的、创意方向、故事因果、人物关系、产品功能、资产范围、成本或验收的问题。`3–5` 只是复杂新项目的常见范围；只缺一个决定性变量时不得为了凑数扩大问卷，也不得重复询问已经锁定的用途、受众、平台或时长。

用户回答前，不得开始创意定稿、编写资产提示词、图片/视频生成、付费提交或任何实质项目写入。把答案、已确认事实、专业建议和未知处置写入门1的 `creative_brief`；未知按 `must_answer_now / director_recommendation / deferred_to_gate2 / experiment_required / irrelevant_to_scope` 分类，只有未解决的 `must_answer_now` 阻止进入门1。已锁定项目继续执行时不重复询问旧事实，范围变化只追问受影响的上游变量。Gate 0 的文字方案比较不产生 review ID、Lavish 页或额外批准，正式创意只在 Gate 1 确认一次。Gate 1 服务会读回完成的访谈、route fingerprint 与 `directionRevision`；缺失或陈旧时直接拒绝发布。

### 0.2 四路复刻控制方式

当用户提出一比一/1:1复刻、视频复现、镜头还原等需求但未指定控制方式时，先询问一次：分镜图、深度视频、原视频还是 KOC 复刻。前三种可组合；KOC 复刻必须单独选择。不要再把分镜图或首帧图作为所有项目的默认资产。

```bash
node src/cli.js visual-control-method --request "用户原始需求文本"
```

用户选择后登记对应路由：`storyboard_control` 使用分镜图/分镜宫格；`depth_control` 使用深度视频；`native_source` 使用官方原视频替换；`koc_remake` 使用全量 A-roll 清单、精确整头匿名控制、用户人物身份图、用户选择的首帧策略和源时码回填。建模/白模仍由后台镜头风险路由触发，不是前台第五种常规入口。

KOC 复刻的准备屏障为：A-roll 全量账本锁定、每段按连续表演边界且不超过 15 秒、人物身份图锁定、所有控制片整头匿名审查通过、首帧策略已经由用户选择。屏障通过后，所有相互独立片段并行进行提示词编译、资产绑定、三路预审和 LibTV 画布准备；付费生成仍需要当前节点的完整读回与节点级授权。最终回填、整轨原声和覆盖审计串行收口。

深度视频硬条件固定为：短边至少 720 像素、原比例、原帧率和帧序、全片统一归一化、光流对齐时序稳定、历史帧权重不超过 25%、无拖影/明显闪烁/频闪、H.264 MP4、无音频、每段最多 15 秒、原文件不覆盖。完整最终提示词见 `knowledge/capabilities/monocular-depth-final-prompt.md`。

- `15 秒`、`480p`、开启生成音频只作为低成本能力测试基线。正式时长、画幅、分辨率和声音由 Gate 2 的生成单元、锁定原片与交付规格反推，并在当前生成前审核包中重新绑定。
- 默认不上传视频作为生成输入；上传视频会显著增加积分消耗。任何特殊的视频上传需求必须先询问用户，得到明确确认前不得把视频加入提示词包、画布节点或 live 请求。
- 编译器默认拒绝视频输入；只有在用户明确确认后，才允许同时使用 `--include-source-video --user-confirmed-video-upload`（或分段编译的 `--user-confirmed-video-upload`）。
- 图片资产默认按 `AGENTS.md` 的强制 `gpt-image-2-style-library` 路由并由 Codex `image_gen` 执行；只有当前项目明确选择 LibTV/RunningHub 等平台时才切换，并保留平台与失败证据。LibTV 路线仍只能使用官方 CLI，不得自行请求 HTTP 或网页自动化。
- 视频默认通过官方 LibTV CLI 的 `Seedance 2.0 VIP` 生成；RunningHub 仅在用户对当次生成明确指定时启用。`15 秒 / 480p / 带生成音频` 只是低成本能力测试基线；正式规格必须由 Gate 2 的生成单元、锁定原片/产品证据、投放平台与交付规格反推。
- LibTV 与 RunningHub live 都会产生费用；必须先锁定零上下文审核 PASS，并在 LibTV/立布 TV 画布内完成生成前人工审核。默认由用户在画布点击生成，助手不代提交。
- 只有 `locked` 产物可以进入下游。
- 审核分两类（见 `src/domain/review-policy.js`）：
  - **自动锁定**（`actor: system`）：剧本和镜头规划的内部草稿、分段、段落契约、讲戏本、提示词、独立审核、资产视觉审核、质量量表、规则、交接、参考视频。这些中间产物通过机器校验后自动锁定，不需要人工逐个批准。
  - **人工审核**（`actor: human`）：创意决策（`creative_brief`）、故事规划包（`story_plan`）、项目资产图（`project_asset`）、段落资产图（`segment_asset`）、视频（`video_segment`）。门1和门2各只允许一个待审核主产物，避免多个方向被一次误批。
- **审核模型（5 道门）**：
  1. `checkpoint_creative` — 用户确认导演创意母版：目的/受众、推荐方向与理由、人物底色、开头—转折—结尾闭环、冲突和产品功能、节奏/镜头/剪辑/声音策略、禁止项与未知处置。分段、并行和预估资产只作暂定建议，由门2根据完整 Shotlist 精确锁定。
  2. `checkpoint_story` — 展示完整剧本、人物圣经和确定性 Shotlist；一镜到底改为连续动作/机位/调度计划。Shotlist 太长时附一张低成本粗分镜预览，只帮助理解，不作为正式生成资产。
  3. `checkpoint_assets` — 从已锁定故事规划反推的必要资产全部准备完毕，用 `checkpoint-approve --checkpoint checkpoint_assets` 批量批准。
  4. `checkpoint_preflight` — 编译包准备完毕，系统完成 dry-run 与独立预审后，把节点放入 LibTV/立布 TV 画布，由用户在画布内审核并点击生成。
  5. `checkpoint_video` — 视频生成完毕，用 `checkpoint-approve --checkpoint checkpoint_video` 批量批准。
  - 机器审核和非 GPT 独立审核作为"预审"在展示给用户之前跑完，用户看到的是已经过筛的结果。
- **用户可见反馈边界**：用户只参与上述 5 道门及确需授权的阻塞。原片事实表、采样计划、快速核对、机器检查、代理降级和内部重试不得形成额外审核页或高频进度消息；相关证据合并进下一道正式审核页。工程参数由系统自行决定，不要求用户理解或选择 FPS、并发、本地/代理、模型缓存和重试策略。
- **内部时效预算**：不超过 2 分钟的原片，事实分析目标 30 分钟、软预算 45 分钟。软预算不是强制杀进程条件；超过时由系统内部停止无收益工作并从最近 checkpoint 收敛交付。禁止整段无理由按原片全帧率抽证据、重复下载同一模型、失败代理反复排队、重复读取已锁定产物或为了等待 Lavish 页面而延迟已具备的正式门交付。
- **门1、门2、门3、门5的人工审核通过 Lavish 网页进行；门4改在 LibTV/立布 TV 画布内进行**，不在纯文本对话里要批准。Lavish 模板在 `templates/lavish-checkpoint/`：
  1. 复制对应模板到 `.lavish/<项目>-<段>-<类型>-review/index.html`，替换 `{{...}}` 占位符，把图片/视频复制到同目录用相对路径引用；
  2. `lavish-axi <html-file>` 打开，`lavish-axi poll <html-file>` 长轮询等待用户决定（不要中途杀掉）；
  3. 根据审核结果执行：创意 A → `checkpoint_creative`；故事与镜头 A → `checkpoint_story`；资产 A → `checkpoint_assets`；生成前由用户在 LibTV/立布 TV 画布审核并点击生成；视频 A → `checkpoint_video`；任何 B/C → `reject` + rework，不得付费生成。
- 失败输出和运行档案必须保留。不要删除后重复抽卡。

以下命令均在仓库根目录执行：

```bash
export PROJECT="$PWD/projects/pilot-001"
node src/cli.js init --project "$PROJECT" --project-id pilot-001
npm run test:e2e
```

## 1. 门1：锁定导演创意母版

把创意沟通结论整理成一份主决策文件。默认只提交一个明确推荐方向并说明观众效果、故事因果、产品功能和执行风险；只有存在实质差异时才在同一文件附最多两个文字对照方向。文件必须写清人物底色、开头承诺、核心转折、结尾回报、情绪与节奏、镜头/剪辑/声音策略、产品戏剧功能、必须保留/避免、被否决方向和重新打开条件。分段、并行和预计资产仍需写明，但状态统一为 `provisional_until_gate2`，不得冒充已经从 Shotlist 精确反推的结果。

```bash
cp templates/project/creative-brief-input.json "$PROJECT/planning/creative-brief-input.json"
node src/cli.js creative-brief --project "$PROJECT" --input planning/creative-brief-input.json
node src/cli.js submit-review --project "$PROJECT" --artifact creative-brief-v1
node src/cli.js checkpoint-approve --project "$PROJECT" --checkpoint checkpoint_creative --note "导演创意母版已确认；分段、并行和资产范围待门2精确化"
```

新发布的 `creative_brief` 必须使用 schemaVersion 3；历史 v1/v2 只读兼容，不迁移、不重写，也不改变 SHA。`creative_brief` 没有被人工锁定时，`story-plan` 会直接拒绝执行。门1一次只能批准一个主方向；对照方向只是同一份创意单中的比较材料，不能作为多个待审 artifact 同时进入下游。

## 2. 门2：剧本、人物圣经与镜头规划

门1通过后，AI自主完成专业剧本与故事规划，不在中间询问“人物这样可以吗”或“要不要继续写 Shotlist”。故事规划输入只填写 `creativeBriefId`，目标时长和创意决策由程序从已锁定门1产物自动带入，禁止悄悄改方向。

故事规划包必须包含：

- `finalExecutionDecision`：依据完整故事和 Shotlist 精确确定最终分段策略、资产/视频并行方式、并行计划和资产范围依据；它可以不同于 Gate 1 的暂定估算，下游以本字段、`videoSegments` 与 `assetPlan` 为权威，不得因为技术精确化返回 Gate 1；
- 一句话故事承诺、开局状态、人物目标、核心阻碍、冲突升级、转折、高潮和结局；
- 每个主要人物的固定标签、背景底色、性格、立场、欲望、阻碍、外形、服装锁、人物弧和与他人的关系；
- 与目标时长匹配的场景、情节节拍和视频分段表，每段说明为什么按场景、情节或连续性边界切分；
- 非一镜到底项目的确定性 Shotlist：Shot ID、时长、叙事目的、主体动作与终点、景别/角度/机位/运镜、场景调度、起止状态、连续性锚点、声音和风险；
- 一镜到底项目不强制 Shotlist，但必须提供 Beginning/Then/Finally 连续阶段、人物路径、摄影机路径、场景地理、动作终点和不能提前发生的后续动作；
- 条件资产建议表：每类资产标记 `required`、`conditional` 或 `skipped` 并写原因。不得因为模板存在就自动制作分镜图、站位图、调度图或假模分镜图；
- Shotlist 超过 12 镜或纯表格不易阅读时，附一张粗分镜预览。它只需帮助用户理解故事走向、机位和调度，不追求精致，也不进入后续模型输入。

把上述内容保存为项目内故事规划 JSON。先复制模板并填写，再用专用命令校验和登记。它是门2唯一人工审核对象，避免拆成多个逐项批准：

```bash
cp templates/project/story-plan-input.json "$PROJECT/planning/story-plan-input.json"
```

```bash
node src/cli.js story-plan --project "$PROJECT" --input planning/story-plan-input.json
node src/cli.js submit-review --project "$PROJECT" --artifact story-plan-v1
node src/cli.js checkpoint-approve --project "$PROJECT" --checkpoint checkpoint_story --note "剧本、人物、时长、分段、Shotlist/一镜到底计划与条件资产建议已统一确认"
```

workflow v2 项目只有这个 `story_plan` locked 后，`assets` 才会继续；否则程序直接拒绝。下面旧项目中分别登记剧本、Shotlist 的方式仍兼容，但新项目不得把它拆成多次人工审核。

原视频为 `authority` 时，Gate 1 通过后、Gate 2 故事规划前，`next` 会返回 `prepare_source_fact_analysis`。把观察结果按普通区间低频、强动作区间 4–8fps 写入输入 JSON，并保持 `observedFacts`、`interpretation`、`uncertainties` 分离：

```bash
node src/cli.js source-fact-analysis --project "$PROJECT" --input planning/source-fact-input.json
```

命令会核对绑定的 locked `reference_video` ID/revision/SHA，相同内容指纹直接复用，策略或输入变化才创建新版本。它只建立事实证据结构，不代替后续源对照审核与门2人审。

`story-plan-input.json` 新项目使用 `schemaVersion: 2`。项目级 `directorPlan` 只写统一导演方向；每个 Shot 的 `directorIntent` 必须写清价值变化、观众感受、镜头动机、潜台词和至少两种不同表达载体。只写“推进剧情”“讲完故事”“更有电影感”会被 `coverage_only` 直接拒绝。

旧 `schemaVersion: 1` 故事计划仍可作为历史证据读取，但绝对不能生成、复用或激活新版 `capability_manifest`。AI 必须先自主整理成 `schemaVersion: 2` 替代稿，再放回同一个门2审核；这不是新增审核点。`checkpoint_story` 会先在内存中完整预演导演路由，预演失败时不会先锁定故事计划再留下半完成状态。

`checkpoint_story` 批准成功后，CLI 会自动在本地运行确定性导演路由，生成并自动锁定 `capability_manifest`，同时写入 `verifiedCapabilityManifestId`。这一步不调用模型、不增加审核门。中断恢复时可幂等执行：

原片为事实权威（`sourceRole: authority`）时，故事计划在进入门2人工审核队列前还必须完成一次本地 source comparator。它只比较已锁定 source facts 中的可观察事实，不把解释或推断升级为事实，并绑定 source analysis 与 story plan 的精确 ID、revision 和 SHA：

```bash
node src/cli.js source-comparator-audit --project "$PROJECT" \
  --source-analysis source-fact-analysis-001 --story-plan story-plan-001
```

只有精确绑定的 comparator PASS 才允许提交门2；FAIL、旧 SHA、缺失不确定项或把 interpretation 当成 fact 都会在人工审核前阻断。workflow v2 的每个视频段还必须显式填写 `continuityStrategy`：首段为 `canonical_open`，后续根据已审核镜头选择 `canonical_open`、`editorial_cut` 或 `continuous_proxy_handoff`。这项分类决定 fast DAG 哪些段可并行，不能由执行器事后猜测。

```bash
node src/cli.js director-route --project "$PROJECT" --story-plan story-plan-v1
```

路由清单逐 Shot 记录必须调用的 Skill/DLC、必须制作的最小资产和结果检查。下游漏用会自动失败；未命中的能力不加载。

### 2.1 v1 旧项目兼容方式

先把人工提供的原文件复制到项目内，再创建登记描述文件。描述文件的初始状态只能是 `draft`；原文件不会被覆盖。

```bash
cp /绝对路径/剧情剧本.md "$PROJECT/brief/script-v1.md"
cp /绝对路径/分镜脚本.md "$PROJECT/brief/shotlist-v1.md"
```

`$PROJECT/brief/script-v1.artifact.json`：

```json
{"id":"script-v1","type":"script","revision":1,"status":"draft","path":"brief/script-v1.md"}
```

`$PROJECT/brief/shotlist-v1.artifact.json`：

```json
{"id":"shotlist-v1","type":"shotlist","revision":1,"status":"draft","path":"brief/shotlist-v1.md"}
```

登记、提交人工审核、批准或退回：

```bash
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/brief/script-v1.artifact.json"
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/brief/shotlist-v1.artifact.json"
node src/cli.js submit-review --project "$PROJECT" --artifact script-v1
node src/cli.js approve --project "$PROJECT" --artifact script-v1 --note "剧本约束完整，批准"
node src/cli.js submit-review --project "$PROJECT" --artifact shotlist-v1
node src/cli.js approve --project "$PROJECT" --artifact shotlist-v1 --note "分镜逻辑成立，批准"
```

退回时使用：

```bash
node src/cli.js reject --project "$PROJECT" --artifact shotlist-v1 --note "动作断点不成立" --correction "把转身完成点移到第12秒"
```

## 3. 生成、持久化并审核分段

下面示例把 24 秒按自然节拍分成两段；任一段都不会超过 15 秒。命令同时写入分段文件并把 segmentation 产物登记为 `draft`。

```bash
node src/cli.js segments --project "$PROJECT" --artifact segmentation-v1 --output segments/segmentation-v1.json --duration 24 --beats 0,12,24
node src/cli.js submit-review --project "$PROJECT" --artifact segmentation-v1
node src/cli.js approve --project "$PROJECT" --artifact segmentation-v1 --note "两段起止点和承接任务批准"
```

批准 segmentation 时，canonical 文件中的各段会绑定同一人工 review ID 并进入 `locked`；原提案快照保存在 `versions/`。

## 3.1 锁定质量量表

复制并人工修改评分模板。模板权重不是不可改变的系统常量；一旦批准，该版本和文件 SHA 会绑定后续视频审核：

```bash
cp templates/project/quality-rubric.json "$PROJECT/brief/quality-rubric-v2.json"
```

登记描述：

```json
{"id":"rubric-v2","type":"quality_rubric","revision":1,"status":"draft","path":"brief/quality-rubric-v2.json"}
```

```bash
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/brief/quality-rubric-v2.artifact.json"
node src/cli.js submit-review --project "$PROJECT" --artifact rubric-v2
node src/cli.js approve --project "$PROJECT" --artifact rubric-v2 --note "人工批准本项目可观察质量维度、锚点 SHA、权重、底线和 veto"
```

## 4. 登记并审核项目级资产

人物资产必须先遵循 [资产图多模态视觉审核门](asset-visual-audit-gate.md)。一人一张独立人物信息板；禁止三人合板或单角度全身照冒充 `character_board`。每张人物图必须绑定唯一 `characterId`、`visualContractVersion: 1` 和同 SHA 的 locked PASS `asset_visual_audit`，否则后续资产 manifest 编译会拒绝。

人物信息板、收腹裤产品母图、场景多视图、全场景俯拍图、贯穿主线道具分别登记。一张图只承担一个核心职责。下面以产品图为例：

```json
{"id":"product-shapewear","type":"project_asset","assetType":"product_reference","revision":1,"status":"draft","path":"assets/project/product-shapewear.png"}
```

```bash
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/assets/project/product-shapewear.artifact.json"
node src/cli.js submit-review --project "$PROJECT" --artifact product-shapewear
node src/cli.js approve --project "$PROJECT" --artifact product-shapewear --note "结构、颜色、纹路、腰头、裆部和腿口一致"
```

对人物、场景多视图、场景俯拍和重要道具重复同一登记与审核流程。媒体登记时 Harness 会从真实本地文件计算 SHA-256。

### 4.1 建立当前段开工契约

项目资产锁定后，为当前段建立输入文件 `segments/segment-001-contract-input.json`。`assetResponsibilities` 必须覆盖本段引用的每个项目资产；金额和尝试上限可以保持 `null`，但不允许自动付费重试：

```json
{
  "id": "contract-segment-001-v1",
  "segmentId": "segment-001",
  "revision": 1,
  "rubricId": "rubric-v2",
  "immutableConstraints": ["人物身份不得改变", "收腹裤结构和纹路不得改变"],
  "assetResponsibilities": {
    "character-main": "只负责人物身份、脸、发型、身形和妆造",
    "product-shapewear": "只负责产品结构、材质、颜色和关键细节"
  },
  "allowedStrategies": ["refine", "pivot", "escalate"],
  "attemptPolicy": {"automaticPaidRetries": false, "maxPaidAttempts": null, "maxAssetAttempts": null},
  "executionControl": {
    "version": 1,
    "plannedShotCount": 12,
    "generatedUnitShotCount": 1,
    "executionUnitStrategy": "segmented_editorial",
    "requiresIndependentShotControl": false,
    "platformCapability": {
      "surface": "LibTV Seedance 2.0 current node",
      "profileId": "seedance-2-libtv-v1",
      "parameter": "multi_shots",
      "exposed": false,
      "enabled": false,
      "evidence": "current node schema readback; therefore one shot per paid unit"
    }
  },
  "completionEvidence": ["人工质量审核", "LibTV SUCCESS 运行证据", "本地视频 SHA"]
}
```

`quality_rubric` 新视频项目必须使用 v2。每个 dimension 除权重/最低分外，还必须写 `observableRequirement`、`evidenceType`、`timeOrRegion`、`canonicalAnchorIds` 和每个锚点的 `canonicalAnchorSha256ById`；模板中的全 0 SHA 只是必填占位，锁定前必须替换为当前 locked artifact 的实际 SHA。Gate 5 的 `evidenceByDimension` 必须逐项给出实际时码/区域、锚点 ID 和同一 SHA。若一个付费单元包含两个以上镜头，只有创建命令实际写入 `multi_shots=on`，且当前 LibTV 节点写后读回 `multi_shots=true`、读回 run 与当前生成指纹一致时，才能批准 `platform_multi_shot`；否则必须拆成单镜单元后剪辑。

严格治理项目在 Gate 5 退回时，还必须填写结构化 `failureObservation`：`category`、稳定 `rootCauseKey`、`responsibilityStage`、最小 `returnStage` 和 `retryKind: none`。这些字段必须来自人的逐画面判断；系统不从分数、否决项、备注或 `correction` 关键词猜测。审核记录、被审视频 SHA 和 `quality_review.rejected` 事件在同一事务写入；项目锁释放后再 fail-open 派生失败观察。派生失败不会抹掉退回事实，也不会触发重试。

可从 `templates/project/gate5-quality-review-input.json` 开始填写。若新视频直接 `supersedesArtifactId` 指向被退回版本，后续通过必须提交该前序版本的精确 `resolvesReviewId`。服务会校验前序 artifact、退回 review 及两者 SHA，并把绑定写入新审核和 `quality_review.accepted` 事件。这里只证明“该次退回被后续人工接受关闭”，不证明重试免费、付费或已经发生额外生成；费用仍只能由独立费用证据登记。

`next` 与 Harness Studio 会把当前严格退回投影为只读 `gate5_failure_return`。它按 `returnStage` 列出 `preserveStages` 与 `reworkStages`：前者继续冻结，后者才允许返工；不得因为 Gate 5 退回而整链重跑。替代视频必须提高 revision，并用 `supersedesArtifactId` 直接继承被退回 artifact；草稿或 rework 版本的唯一下一步是重新提交 Gate 5，而不是直接交付。若回流阶段位于生成或更早，投影只会声明 `newPaidAuthorizationRequired: true`，不会创建批准、消费旧批准或自动重试。历史退回缺少结构化根因时，`next` 返回阻塞的 `classify_gate5_rejection`，系统不会从备注猜测阶段。

首次进入该返工时，`next` 返回 `prepare_gate5_rework_order`。使用返回的 `failureReturnId` 建立本地、可恢复工作单：

```bash
node src/cli.js prepare-gate5-rework \
  --project "$PROJECT" \
  --failure-return gate5-return-实际ID \
  --confirm
node src/cli.js next --project "$PROJECT"
```

工作单写入 `reviews/gate5-rework/`，绑定失败投影 SHA、当前被退回视频、所有早于 `returnStage` 的 current locked 证据及其 review/SHA、允许修改的阶段、替代版本最低 revision 和付费边界。精确重复会幂等复用；本地事务中断后按 journal 恢复。任一冻结产物的 current 身份、路径、SHA、审核绑定或实际文件发生变化，`next` 会转为 `repair_project_evidence`，不得继续返工。工作单不会调用模型、创建画布、批准费用或复用旧付费授权。

工作单 v2 把每个允许返工阶段持久化为 `pending → in_progress → completed`。阶段只能按 `allowedMutationStages` 顺序推进；暂停保留当前阶段，恢复后继续，不能清零或跳级。开始、暂停和恢复只改本地检查点：

```bash
node src/cli.js gate5-rework-progress --project "$PROJECT" --work-order "$WORK_ORDER_ID" \
  --action start --stage assets --confirm
node src/cli.js gate5-rework-progress --project "$PROJECT" --work-order "$WORK_ORDER_ID" \
  --action pause --reason "等待商品结构复核" --confirm
node src/cli.js gate5-rework-progress --project "$PROJECT" --work-order "$WORK_ORDER_ID" \
  --action resume --confirm
```

阶段完成必须绑定证据 ID、SHA 和可选项目内路径。付费阶段若 `newAuthorizationRequired=true`，证据类型必须是 `new_paid_authorization`；生成、剪辑、技术审片和 Gate 5 分别要求 `generation_output`、`final_edit`、`machine_video_audit` 和 `gate5_review`。例如：

```bash
node src/cli.js gate5-rework-progress --project "$PROJECT" --work-order "$WORK_ORDER_ID" \
  --action complete --stage assets --note "资产绑定已复核" \
  --evidence-kind artifact --evidence-id asset-v2 --evidence-sha256 "$ASSET_SHA" \
  --evidence-path "assets/asset-v2.png" --confirm
```

检查点本身不验证业务证据已经通过对应 Gate；它只拒绝缺失、错序和不符合关键阶段类型的记录。正式通过仍由原有 artifact/review/run 服务和 Gate 5 决定。重复请求按请求指纹幂等；事务中断后恢复同一 revision，不会制造第二次阶段完成。任何检查点操作都不会调用外部服务或产生费用。

成片失败后先复制模板，用 `record-generation-failure` 写入 `rootCauseKey`、`controlRouteFingerprint`、镜内证据、规范化 `failureObservation` 和多因归因 `causalAttribution`：

```bash
cp templates/project/generation-failure-input.json "$PROJECT/reviews/generation-failure-input.json"
node src/cli.js record-generation-failure --project "$PROJECT" --input "$PROJECT/reviews/generation-failure-input.json"
```

`category`、`responsibilityStage` 和 `returnStage` 必须由实际证据给出；不确定时用 `other`，不能关键词猜测。`causalAttribution` 必须把主因、贡献因子、反证、未知、可证伪条件和“只改变一个主变量”的最小检查分开记录；它禁止把“提示词不好”当成无证据总因，也禁止只换同义词或 seed 继续付费。新失败的 `retryKind` 必须为 `none`，因为失败记录本身不能证明后续已经免费或付费重试。严格治理会在同一事务写入 `runs/generation-failures/<failure-id>.json` 不可变记录，项目锁释放后自动、fail-open 地登记根因观察。观察派生失败不删除失败事实，也不放行下一次生成。

只有控制路线确实改变后，才能经人工复核写入 remediation：

```bash
node src/cli.js record-generation-remediation --project "$PROJECT" --input reviews/generation-remediation-input.json
```

新提示词、新 seed 或调色不算控制路线改变；这种情况 preflight、批准与 claim 都会继续拒绝。

```bash
node src/cli.js segment-contract --project "$PROJECT" --input segments/segment-001-contract-input.json
node src/cli.js approve --project "$PROJECT" --artifact contract-segment-001-v1 --note "批准当前段起止状态、输入、职责和完成标准"
```

### 4.2 从已锁定导演路由反推条件资产

workflow v2 新项目不再要求操作者另填一份镜头策略表。门2批准时生成的 locked `capability_manifest` 是唯一能力路由来源：图片任务、段资产 manifest、讲戏本和最终提示词都绑定同一 story-plan SHA。它只要求当前 Shot 真正需要的资产；未命中的分镜图、站位图、调度图、假模图和情绪库不会进入任务。

当用户说“强控制”或“1:1/一比一复刻”时，门1/门2必须启用 `modeling_strong_control`。先按 `knowledge/capabilities/modeling-strong-control.md` 在一个 Blender 工程中完成 camera match、人物/道具代理、接触动画、镜头路径、切点和完整 animatic，再从同一工程导出关键帧。建模审核通过后不再制作独立 storyboard 或 mannequin grid。

若用户要求“高精度 3D 建模视频”，在上述路线中先使用 `knowledge/capabilities/high-fidelity-3d-reconstruction-prompt.md` 的 A 源片测量提示词产出带时码的 `ReconstructionManifest`，再使用 B 建模与动画提示词。人物的发型轮廓、五指、衣物剪裁/纹理与核心产品结构必须在 MustSeeFrame 逐帧验收；场景只按摄影机透视、遮挡、接触和光向建模。不可直接用一条“高精度白模”提示词生图代替这个过程。

- `animatic_video`：用户批准视频输入成本且模型支持白模重渲染时，animatic 作为动作/镜头输入；canonical 资产继续负责身份、服装、产品和材质。
- `keyframes_only`：不上传视频时，animatic 只作内部导演证据，生成节点仅用模型派生关键帧；生成前审核必须明确提示连续动作控制已降级。

登记建模权威：

```bash
cp templates/project/spatial-control-model-input.json "$PROJECT/planning/spatial-control-model-segment-001-v1.json"
node src/cli.js spatial-control-model --project "$PROJECT" --input planning/spatial-control-model-segment-001-v1.json
```

随后按现有审核流程锁定 `spatial_control_model`。其派生 `director_view_proxy` 与 `spatial_control_animatic` 必须绑定同一 `sourceControlModelId` 和 `sourceControlModelSha256`。

下面的 `shot-strategy` 只保留给尚未采用 `directorRoutingVersion: 1` 的旧项目：

不要默认给每一段都制作白模、尾帧续写、俯视调度和完整故事板。复制模板并填写当前段事实：

```bash
cp templates/project/shot-strategy-input.json "$PROJECT/segments/segment-001-shot-strategy-input.json"
node src/cli.js shot-strategy \
  --input "$PROJECT/segments/segment-001-shot-strategy-input.json" \
  > "$PROJECT/segments/segment-001-shot-strategy.json"
```

把输出中的 `assetRequirements` 合并进当前段 contract 的 `segmentAssetRequirements`，只制作命中的条件资产。主要路线：

- `editorial_cut`：用镜头切分、反应镜头、遮挡或插入特写衔接；不需要白模交接，不把上一段尾帧当下一段首帧。
- `continuous_proxy_handoff`：只在连续一镜、上一段存在且严格空间承接时触发白模交接。生成尾帧只做观察证据；禁止把原始生成尾帧直接作为下一段首帧。需要严格连续时，先由尾部多帧重建 observed handoff，再制作独立派生图：`canonical_hd_reconstruction` 只在身份、服装和产品状态都正确时使用；`articulated_mannequin_replacement` 用完整3D关节彩模替换全部人物，只保留机位、构图、站位、姿态、距离、遮挡、道具位置和摄影机透视。派生图必须有新的 SHA、单一职责、污染审查和 locked 审核，不得继承原尾帧压缩、模糊和伪影。
- `canonical_open`：独立镜头从原始高清人物、场景、产品资产重新开镜。

当 `cameraComposition` 为 `over_shoulder` / `foreground_layered`，或四人以上同框时，路由会条件触发 `director_view_proxy`。该资产是在最终摄影机视角下生成的彩模镜头代理：固定颜色绑定固定角色，只锁定人物排序、大小、前中后景、姿态和遮挡。它不是俯视调度图、不是首帧，也不得把彩模颜色和低多边形材质传给正式人物。当前 LibTV CLI 未暴露网页3D导演台命令时，可以通过官方CLI图片节点生成这张代理图，再按普通 `segment_asset` 审核锁定；不得改用网页自动化。

所有输入在编译前执行提示词与参考源污染检查：每个媒体只允许承担 manifest 中的一项明确职责；彩模不得向真人外观传递颜色或塑料材质，线稿不得传递画风，动作供体不得传递身份、服装或背景，原片局部证据不得成为完整首帧，产品图不得控制人物姿势。提示词不得包含不可从画面判断的裸物理尺度（厘米、毫米、角度数、半步、一点点）；改用手指、手掌、鞋长、前臂、身体接触点、遮挡比例和画面边界等可见锚点。污染风险未通过全新非GPT零上下文审核时，不得创建视频 dry-run。

复杂穿衣、打斗、舞蹈等动作只有在 `motionReferenceAvailable: true` 时加载动作参考视频；否则先拆动作。多人台词加载身份—当前站位—台词绑定。产品穿着或尺度敏感互动加载真人比例与穿前/穿后状态资产。详细职责见 `knowledge/replication-library/workflows/08-shot-strategy-router.md`。

路由本身不调用外部工具、不生成资产、不产生费用。它只减少无关工作，并把真正高风险的段落送到对应能力。

## 5. 编译、审核并生成当前段资产

只为当前段即时编译需求。第一段使用初始站位图；后续段必须先有上一段真实视频的 locked observed handoff。

### 5.1 新版图片任务编译与并行分派（默认）

新建图片任务不得直接手写 `.txt` 后提交。先准备项目内输入 JSON，其中必须包含同一份 `visualStyleContract`、人物/场景/道具任务、每个输入媒体的职责与 SHA、以及实际使用的模板和 Skill。人物角色板只填写人物合同，编译器会自动展开为正脸、侧脸、正面服装无头图、完整背面全身图四张原子图。

采用导演路由的新项目还必须填写 `capabilityManifestId` 和本次覆盖的 `segmentIds`。编译器会把本批新任务与已经 locked 的同类资产合并核对：少任何导演清单要求的资产都会 FAIL，多余能力不会因“模板里存在”而自动加载。

```bash
node src/cli.js image-prompt-plan \
  --project "$PROJECT" \
  --input "inputs/image-prompt-plan-v1.json"
```

未传 `--model-profile` 时使用 Harness 内置的 `codex-image-gen-generic-v1`；只有项目明确选择其他图片执行面时，才把经过验证的模型档案复制到项目目录并显式传入。

输出默认写入 `runs/image-prompt-plans/<plan-id>.json`。该命令只做以下工作，不调用图片模型、不产生费用：

- 检查提示词合同能否在零历史上下文下独立执行；
- 拒绝未填占位符、“同上/沿用此前”等隐含指代和未声明的 `ImageN`；
- 校验模型能力档案、输入数量、比例和质量；
- 记录 `templateSource`、`skillsApplied`、输入 SHA、Prompt SHA、IR 指纹和不可变请求指纹；
- 按人物、场景、道具等类型建立并行 lane；多个人物或多个场景各自使用独立 lane；
- 强制全部 lane 共享同一个视觉风格合同；人物 lane 强制使用 `seedance-characters`。

同一个人物的四张原子图留在同一人物 lane 内，避免不同子智能体各自理解人物；不同人物、场景和道具 lane 可以同时运行。某一 lane 失败只阻断它自己及依赖它的下游，不阻断其他独立 lane。机器审核和局部修复完成后，最终仍只在门 3 批量交给用户。

四张人物原子图生成并分别取得真实 SHA 后，准备 `image-composite-plan.schema.json` 对应的拼版 JSON，再运行：

```bash
node src/cli.js compose-character-board \
  --project "$PROJECT" \
  --input "inputs/character-a-composite-v1.json"
```

拼版器使用本地 ffmpeg：上方三分之一放正脸和侧脸，下方三分之二放正面服装无头图和完整背面全身图。它只缩放、留白和排列，不重新绘制已通过的图片；任一输入 SHA 变化或输出文件已经存在都会拒绝执行。

15 秒分镜图不套用人物四图拆分逻辑：首轮默认由分镜子智能体一次生成完整分镜板。只有某格错误时才裁出该格单独修改，并确定性放回原槽位；正确格不得重绘。

任何图片计划的第一步都必须使用经团队批准的 `gpt-image-2-style-library` Skill：先读取 Skill 与 `references/style-library.md`，按图片类型、风格和场景选择最匹配的模板与案例，再将其与本 Harness 的自包含合同、绑定媒体职责和当前资产模板合并。`imagegen` 仅是 Codex 的图片执行/验收 Skill，不能代替这一步；缺少 `gpt-image-2-style-library` 的图片计划由 lint 拒绝。

图片计划中的 `storyboardSheets` 必须把当前完整视频段编译成一个请求。每格绑定格位、时间点、Shot ID、动作终点、机位、调度和连续性锚点，并应用 `seedance-sequence`、`seedance-camera`；有人物时追加 `seedance-characters`。

少数格失败时，在下一份图片计划的 `storyboardRepairs` 中建立单格 edit 请求。修复格通过独立视觉审核后，运行确定性回填：

```bash
cp templates/project/storyboard-panel-repair-input.json "$PROJECT/planning/storyboard-panel-repair-input.json"
node src/cli.js repair-storyboard-panels --project "$PROJECT" --input planning/storyboard-panel-repair-input.json
```

回填器逐格比较源图和新图的像素哈希；任一正确格变化就直接 FAIL。失败格达到整板一半、格位结构错误或连续性整体失效时，程序拒绝局部修复，要求重做整板。

场景、故事道具和假模资产也必须通过同一图片计划编译，不得临时手写提示词：

- `sceneMultiviews`：一个场景固定展开为九张独立原子图。前八张是明确机位的空场景，第九张是俯视空间图；所有原子图共享同一场景地理、固定物、光线和材质，只加载 `seedance-camera`。
- `storyProps`：一个道具固定展开为正面、侧面、背面、细节四张原子图，严格填充 `knowledge/asset-prompt-templates.md` 的道具模板。图片模型只画单个物体视图，不负责四宫格排版。
- `mannequinSequences`：按原片采样帧逐格建立 edit 请求。每格第一张输入必须明确绑定为“原始帧的姿势、机位、调度和真实场景”，只把人物替换成置身原场景、带体积和接触阴影的灰白黏土假模；多人用已锁定的低饱和颜色表区分。严禁把整张宫格交给模型统一改写。

每张原子图都取得真实 SHA，并具有与该 SHA、资产类型、revision 完全一致的 locked `clean_zero_context` 视觉 PASS 后，再由程序拼版：

采用导演路由的新项目中，AI 视觉 PASS 会由系统自动锁定；在它完成前，`project_asset`/`segment_asset` 连 `awaiting_review` 都不能进入，因此 Lavish 资产页只展示 AI 已经看过第一遍的图片。人物图与分镜图除身份、构图和结构外，还必须检查：视线是否落在明确对象上、同场人物是否有自然反应、表情是否非塑料/非模板、动作是否有触发与终点、是否出现呆滞凝视或无动机挥手。图片文件一旦更换，SHA 变化会让旧 PASS 自动失效。

```bash
cp templates/project/asset-grid-input.json "$PROJECT/planning/asset-grid-input.json"
node src/cli.js compose-asset-grid --project "$PROJECT" --input planning/asset-grid-input.json

cp templates/project/color-board-input.json "$PROJECT/planning/color-board-input.json"
node src/cli.js compose-color-board --project "$PROJECT" --input planning/color-board-input.json
```

`compose-asset-grid` 支持场景九宫格、道具四宫格和 1–16 格假模宫格。程序只做缩放、留白和固定格位排列，不重新绘制原子图；输入 SHA 变化、审核不匹配、格位顺序错误、输出已存在或路径越界都会拒绝执行。某一场景视图、道具视图或假模帧失败时，只重新生成该原子图，保留其余已通过文件，再用新输出路径拼出新 revision。`compose-color-board` 则由程序直接绘制七种项目颜色、准确 HEX 和用途文字，图片模型不参与文字和色值排版。

### 5.2 单目相对深度图/视频（按需 DLC）

用户需要深度图、灰度深度图、空间灰白图、深度视频或视频转深度时，加载 `knowledge/capabilities/monocular-depth-conversion.md`。单独说“灰白图/灰度图/灰白视频/灰度视频”按当前用户约定默认走深度；假模、角模和灰白假模仍走假模分镜能力；明确的普通黑白滤镜或去色不属于深度估计。

两份用户锁定模板保存在 `knowledge/capabilities/monocular-depth-templates.json`。运行前先编译免费任务合同：

```bash
# 用户已经明确指定一个视频
node src/cli.js depth-plan --project "$PROJECT" --kind video --input "inputs/source.mp4"

# 用户只指定目录：目录内必须恰好有一个同类型候选文件
node src/cli.js depth-plan --project "$PROJECT" --kind image --input-dir "inputs/depth-source"
```

规则如下：

- `--input` 与 `--input-dir` 只能二选一；目录出现多个候选时命令列出全部文件名并停止，不调用模型、不写计划，由用户只选择一次。
- 命令读取唯一输入的 SHA、尺寸；视频还读取精确帧率和总时长。原文件只读，拒绝符号链接、路径越界和输出覆盖。
- 视频合同固定近白远黑、全片统一深度范围、禁止逐帧拉伸、适度边缘保持时间稳定、H.264 MP4、720p 等比输出、无音频，并按源帧边界连续拆为每段最多 15 秒。
- 图片合同固定输入原尺寸和构图、姿势、轮廓及遮挡，只输出纯灰度深度 PNG，不保留颜色、纹理、文字、材质和原光影风格。
- 输出计划写入 `runs/depth-conversion-plans/`，执行说明写入 `prompts/depth/`。`depth-plan` 不调用深度模型，也不代表转换已经完成；真正执行时必须解析并记录一个可用的单目深度模型，不能用普通去色伪造结果。

这个 DLC 不自动进入普通项目的资产清单，也不新增审核门。只有用户当前要求或已批准的资产范围确实需要深度控制时才制作。

### 5.3 旧 LibTV 段资产批处理兼容入口

下面的 `generate-assets` 保留给已经按旧格式锁定的 LibTV 段资产项目。它不是新版图片提示词编译器，新项目不得用它绕过 `image-prompt-plan` 的模板、Skill、零上下文 Lint 和请求指纹。

```bash
node src/cli.js assets --project "$PROJECT" --segment segment-001 > "$PROJECT/assets/segment-001-asset-manifest.json"
node src/cli.js approve-asset-manifest --project "$PROJECT" --segment segment-001 --note "本段资产职责和触发项批准"
```

为 manifest 中每个待生成项建立同名提示词，例如 `prompts/segment-001-camera_blocking.txt`。先做无成本检查。dry-run 也会在读取提示词前重新核对 manifest 人工审核绑定、项目状态、ID、真实路径和 SHA；它不会读取项目外文件：

```bash
node src/cli.js generate-assets --project "$PROJECT" --segment segment-001 --libtv-project "画布UUID" --dry-run
```

确认输出只包含官方 `libtv` 命令、输入和职责无误后执行。该路径不调用 LibTV HTTP：

```bash
libtv --version
libtv account
node src/cli.js generate-assets --project "$PROJECT" --segment segment-001 --libtv-project "画布UUID" --live
```

每次 live 会先取得项目级 LibTV owner，并使用 `outputs/.libtv-runs/<run-id>/` 独立暂存；成功后才在项目锁内发布到 `outputs/<asset-id>.png`。同一时刻只有一个 live owner，manifest 指纹也只能被一个 run 占有。带图片参考的节点必须在 create 时显式设置 `modeType=image2image`；随后严格拆成“create 不运行 → 已有节点连接参考图 → 单独 `node <name> --run`”，不要把多图连线和 `--run` 合并进 create。run 只保存受控错误码，不保存 LibTV stderr、URL 或 token。

若 CLI 失败或进程在 claim 后崩溃，run 会保持 `UNCERTAIN` 或 `SUBMITTING`，后续 live 一律停止。只有人工确认 LibTV 画布没有产生任何远端副作用后才能解除：

```bash
node src/cli.js reconcile-libtv-run --project "$PROJECT" --run libtv-实际run-id --confirmed-no-side-effects --note "已人工核实 LibTV 画布没有新增或运行节点"
```

若 CLI 已经实际生成成功、但本地发布阶段失败，不得冒充“无副作用”或重新生成。先用官方 CLI 查询并下载同一节点，准备含 `assetId/path/sha256/nodeKey/taskId` 的项目内恢复 JSON，然后采纳已完成结果：

```bash
node src/cli.js reconcile-libtv-run --project "$PROJECT" --run libtv-实际run-id --adopt-completed-assets --input reviews/libtv-recovery.json --note "已核实并下载同一批成功节点"
```

若官方 CLI 已能确认任务为终态失败，且没有可采用输出，用结构化失败证据解除不确定门禁；不得谎称“没有副作用”：

```bash
node src/cli.js reconcile-libtv-run --project "$PROJECT" --run libtv-实际run-id --confirmed-terminal-failure --node-key "节点UUID" --task-id "任务ID" --failure-reason "官方终态失败原因" --note "已核对节点、任务号和终态失败"
```

若 LibTV 视频节点已经创建，但 `node --run` 在返回 taskId 前失败，不能谎称“完全无副作用”，也不能重跑。保存人工提供的画布截图，并同时用官方 CLI 核对该节点无 taskId、无输出 URL、无封面；随后用专用决定释放视频 owner。原付费批准保持已消费，禁止自动重试：

```bash
node src/cli.js reconcile-libtv-run --project "$PROJECT" --run libtv-video-实际run-id \
  --confirmed-node-created-no-task --node-key "节点UUID" \
  --evidence "reviews/evidence/画布截图.png" \
  --note "人工截图与官方CLI均确认节点已创建但无taskId、无输出；不恢复付费批准"
```

每张成功输出会在 `runs/libtv-*.json` 记录命令退出码、最终路径和 SHA。把每张结果作为 `segment_asset` 登记并人工审核。例如：

```json
{"id":"segment-001-camera","type":"segment_asset","assetType":"camera_blocking","segmentId":"segment-001","revision":1,"status":"draft","path":"outputs/segment-001-camera_blocking.png"}
```

```bash
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/segment-001-camera.artifact.json"
node src/cli.js submit-review --project "$PROJECT" --artifact segment-001-camera
node src/cli.js approve --project "$PROJECT" --artifact segment-001-camera --note "人物路径、朝向、机位和运镜路径批准"
```

所有段落资产批准后重新编译最终输入 manifest；编译器会复用同一段、同一资产类型的最高 locked 版本。再次人工批准：

```bash
node src/cli.js assets --project "$PROJECT" --segment segment-001 > "$PROJECT/assets/segment-001-asset-manifest.json"
node src/cli.js approve-asset-manifest --project "$PROJECT" --segment segment-001 --note "最终锁定输入和职责批准"
```

## 6. 编译 Seedance 多模态包

### 6.0 先产出并锁定讲戏本（Shot Narration Gate）

写视频提示词之前，先为本段产出一份逐镜「讲戏本」`shot_narration`（只写镜头拍得到的物理动作、运镜、光源方位、情绪落成动作）。它只经过一次确定性机审：`narration-lint` 通过后由系统自动锁定，不新增单独人工审核；完整提示词和表演合同仍在现有生成前审核一起给用户看。`knowledge/replication-library/` 及其他能力文档只能作为非提示词审计或素材分析证据，不能提供提示词措辞、结构或改写内容。

提示词正文的唯一写作来源是项目配置的 Prompt Skill（`HARNESS_CANONICAL_PROMPT_SKILL_ROOT`）。其他 Skill、模板、方法论、模型输出或助手自创结构不得参与提示词生成、撰写、重写或润色；它们最多用于非提示词任务。若该 Skill 无法读取或 SHA 不一致，必须停止。`compile-seedance` 只允许做平台编号、媒体职责头、SHA 和执行包的机械编译，不得新增任何语义。

采用导演路由时，讲戏本必须绑定 `capabilityManifestId` 与清单 SHA，并在 `skillsApplied` 中真实列出路由要求。人物镜头必须填写 `realismPlan`：有动机动作、物理终点、自然不对称变化、非焦点人物持续微动作，以及禁止无动机挥手、呆滞凝视、标准笑容、机械重复。关系或对白镜头还必须填写 `interactionPlan`：触发、具体注视对象、目光动作、对方反应、轴线和结束状态。男主“看向前方”不能替代“看向女主哪一处并在何时移开”。

```bash
# 复制模板；新讲戏本每镜还要明确 performanceMode
cp templates/project/shot-narration-input.json "$PROJECT/prompts/segment-001-narration.json"
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/prompts/segment-001-narration.artifact.json"
# 机审通过后系统自动锁定，不需要再运行 approve
node src/cli.js narration-lint --project "$PROJECT" --artifact narration-segment-001
```

逐镜路由：没有人物表演用 `none`；普通拿放和简单动作用 `basic`；情绪转折、对白反应、潜台词、近景表演或复杂矛盾情绪用 `emotion_dlc`。只有 `emotion_dlc` 才加载 `knowledge/capabilities/dlc/emotion-performance.md`，所以 100/40 种情绪库不会常驻上下文。

新建或重写的复杂表演镜头使用 `actingControlVersion: 2`：必须显式记录 `hasDialogue`、`performanceArc`（保护策略→触发裂缝→暴露→主动选择→外部反馈→回稳）与 `prohibitedEarlyReactions`；`hasDialogue: true` 时逐句增加 `dialoguePerformance` 的台词全文、说话人、反应人和重音，并把同一重音以规范化完全相等的独立字段绑定到同一反应人的守卫；`hasDialogue: false` 若同时出现明确说出台词的指令直接 FAIL。任何 `explosive`，或 `intensity: clear` 且存在面部主导/校准时增加 `performanceEnvelope`。`micro` 或 `restrained` 镜头不强制凑齐进入—峰值—退出；极短窗口若装不下三相，必须降为 `micro` 或 `restrained`，不得用自由文本豁免 `clear`。可选 `facialCalibration.facsAuHints` 只用于内部审计，最终执行提示词一旦出现 `FACS`、`AU` 或 `Action Unit`，零上下文 lint 直接 FAIL。旧 `emotion-performance-v1` 项目仍可读取并产生升级提醒；workflow v2 的当前写入必须是 v2，不自动篡改历史锁定产物。

机审锁定后，为命中的镜头生成精确表演胶囊：

```bash
node src/cli.js performance-capsule \
  --project "$PROJECT" \
  --input prompts/segment-001-narration.json
```

命令返回两份产物，用途不同，不能混用：

- `promptBlock`：`performance-continuity-v1` 块；旧计划只含结束状态与连续保留，v2 另含紧凑的“禁止提前反应”时间守卫，**原样**放进当前段 Seedance 提示词正文。
- `archivedCapsule`：完整表演胶囊，只作审计留档，**禁止**粘贴进提示词。

表演本身由镜头正文用导演语言写清楚；正文里已经写过的动作不要在块里再说一遍。`compile-seedance` 逐 Shot 校验 `promptBlock` 存在且未被改写，同时校验正文没有出现 `【emotion-performance-v1｜` 标签或 FACS/AU 编号；任一不满足都拒绝编译。

再生成导演能力约束块与留档胶囊：

```bash
node src/cli.js director-capsule \
  --project "$PROJECT" \
  --input prompts/segment-001-narration.json
```

同样取 `promptBlock`（`director-constraints-v1`：视线目标、轴线约束、动作终点、禁止动作）进入正文，`archivedCapsule` 只留档。完整的导演审计元数据、必用能力、实际技能和验收证据仍属于留档；但**全片故事发展、关系变化、关键情绪转折和动作动机不能从正文删除**。它们必须压缩成模型能执行的因果句：`触发事件 → 人物情绪变化 → 为什么选择这个动作 → 对方反应 → 新状态`，并把抽象情绪落成眼神、呼吸、嘴角、肩背、重心、步态或道具反馈。只写动作、不写原因的提示词直接 FAIL。

`compile-seedance` 会校验最终提示词是否包含能力清单要求的可见约束、真人感/视线合同和精确约束块；Skill/DLC 名称只作为审计元数据，不参与提示词措辞。日志里写“已调用”但提示词没有实际内容，仍然 FAIL。它同时会把两份完整胶囊写入 `prompts/<segment>/capsule-archive.txt` 并在 `governanceBindings.capsuleArchive` 记录 SHA，审计链不因胶囊移出正文而断开。

在进入任何机器/独立审查或用户人审之前，Agent 必须先完成 `docs/prompt-self-audit-checklist.md` 的 A/B 自检：先检查镜头编排中的情绪冲突、夸张程度和核心需求，再检查提示词是否真正承载完整故事、情绪和动作动机。A/B 任一 FAIL 必须重写；机器 lint PASS 不能替代这两项自检。人审页面必须展示自检结论和修订记录。

### 6.1 登记并批准提示词（必须绑定讲戏本）

把当前段提示词保存为 `prompts/segment-001.txt`，按普通 artifact 流程登记为 `seedance_prompt`。**提示词必须带上 `narrationSourceId` 与 `narrationSha256`，指向已锁定的讲戏本**；讲戏本一改，绑定即失效需重审。带上 `segmentId` 后人工批准：

```json
{"id":"prompt-segment-001","type":"seedance_prompt","segmentId":"segment-001","revision":1,"status":"draft","path":"prompts/segment-001.txt","narrationSourceId":"narration-segment-001","narrationSha256":"<讲戏本文件的SHA-256>"}
```

```bash
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/prompts/segment-001.artifact.json"
node src/cli.js submit-review --project "$PROJECT" --artifact prompt-segment-001
node src/cli.js approve --project "$PROJECT" --artifact prompt-segment-001 --note "时序、因果、物理反馈、段尾状态和负面约束批准"
node src/cli.js compile-seedance --project "$PROJECT" --segment segment-001
```

源提示词不得手写 `@图1`、`@音频1`，也不得使用 `@产品图`、`@分镜` 等自定义别名。只允许用稳定资产 ID，例如：

```text
@素材[product-709-white-v1] 只负责产品结构；动作时钟来自 @素材[segment-001-dialogue-audio-v2]。
```

`compile-seedance` 在最终媒体排序和 SHA 校验完成后，自动把稳定 ID 翻译成真实平台编号，并写出 `prompts/<segment>/execution-prompt.txt`。模型可见正文只保留导演指令中实际引用的 `@图N/@视频N/@音频N`；机器生成的资产 ID、SHA、职责合同和编号映射只保存在包内 `mediaBindings` 审计字段，禁止前置或附加到执行提示词。原始已锁定提示词保留为 `sourcePromptPath`。未绑定 ID、硬编码平台编号、上一段/前一镜等隐含上下文、任何未识别 `@` 别名，以及把审计头写入模型提示词的做法，都会在免费编译阶段 FAIL。

同一 SHA 的媒体不得以多个 ID 或多个职责重复占据输入槽。确实需要一张图承担多个兼容职责时，先在资产清单中合并成一个规范资产和一份明确合同；冲突职责必须制作独立派生资产。

默认按官方 LibTV `Seedance 2.0 VIP` 编译。明确切换 RunningHub 时，必须重编译对应模型档案，不能复用另一执行器的批准指纹：

```bash
node src/cli.js compile-seedance --project "$PROJECT" --segment segment-001 \
  --video-executor libtv --video-model "Seedance 2.0 VIP"

node src/cli.js compile-seedance --project "$PROJECT" --segment segment-001 \
  --video-executor runninghub
```

若要加载规则，先准备当前段 context JSON，再加：

```bash
node src/cli.js compile-seedance --project "$PROJECT" --segment segment-001 --rule-context "$PROJECT/segments/segment-001-rule-context.json"
```

## 7. 零上下文独立创意审核、画布生成前审核与默认用户点击生成

生成前的独立 AI 首审除原有完整性、SHA 和引用污染外，还必须核对：导演意图是否真正进入镜头、人物目光是否指向剧情对象、对方是否有反应、非焦点人物是否持续有细微生命感、是否存在标准笑容/呆滞凝视/无动机挥手/机械重复，以及路由要求的可见约束是否真正出现在最终包。Skill/DLC 名称只核对其审计元数据，不得作为提示词写作来源。PASS 后进入 LibTV/立布 TV 画布生成前审核，用户只在画布中检查最终节点并自行点击生成；助手不得把此步骤替换为 `approve-paid-generation` 或自动 `--live` 提交。OpenCodex 非 GPT 通道不可用时按项目规则降级 GPT，不得因审核模型故障卡住进度。

### 爆款复刻生成前的三类条件合同

进入 LibTV 视频 dry-run 前，从 current locked Shotlist 反推并锁定当前段真正适用的合同：

1. 每位主要出镜人物一份 Shot coverage 驱动的身份包：按实际景别、脸部角度、正背面、全身/局部、服装与遮挡风险选择单图、双角度、局部特写或四视图；提示词从 `knowledge/asset-prompt-templates.md` 模板 B 取对应视图部件。没有覆盖缺口时不得为了形式强制四视图。
2. 只有复杂物理动作、多人调度或逐时点姿态复现需要假模/分镜宫格；需要时按实际时点逐格验收，单格失败只替换该格。简单口播、产品插入或本地确定性编辑显式 `not_applicable`。
3. 每个生成单元必须有 `audioExecutionPlan`。按 `preserve_source_audio_exact`、`native_generate`、`reference_guided`、`external_remux`、`silent_visual_test` 五选一决定是否上传音频、节点是否生成声音、谁是同步权威及最终是否 stream-copy 回填；不能把“音频已上传”写成“原波形已保留”。

模型 IO 必须在 dry-run 前通过 `libtv model <name>` 重新核对。媒体数量超限时不得静默删资产，必须重新选择支持完整包的模型或重编译职责。

### 首帧驱动模式（第二段及以后，用户明确要求不上传原视频时）

709 项目第二段已实测通过的六项输入契约。原视频文件不进入生成输入，只作分析证据：

| 输入 | 职责 |
|---|---|
| 首帧图（前一段成片尾帧派生，4K） | 仅作瞬时空间代理：站位、姿态、视线、运动相位、机位与遮挡；不得控制人物身份、产品结构、纹理或画质 |
| 假模分镜宫格 | 仅姿态时间表：每个采样时刻的站位、朝向、手指、腿脚、遮挡、产品接触点 |
| 人物身份包（按 Shot coverage 选择视图） | 人物身份与当前镜头实际需要的角度一致性 |
| 产品图 | 产品结构、颜色、纹理 |
| 场景图 | 空间结构 |
| 音频（仅在所选策略需要时绑定） | 按 `audioExecutionPlan` 限定为原声权威、参考时钟或不上传；不得越权控制画面 |

连续代理交接还必须先运行 `reconcile-handoff`，把上一段计划尾态、经人工确认的实拍尾态和下一段计划开态在人物、距离、产品、道具、机位、未完动作、光线、声音、身份九维逐项对账。只有决策为 `PASS` 的 artifact 会自动锁定并进入下一段资产清单；`HOLD`/`FAIL` 保留证据但不会放行。

```bash
cp templates/project/handoff-reconciliation-input.json "$PROJECT/reviews/handoff-reconciliation-input.json"
node src/cli.js reconcile-handoff --project "$PROJECT" --input "$PROJECT/reviews/handoff-reconciliation-input.json"
```

若某一维不是 `consistent`，必须增加 `nextStateInstruction`；`absorb_in_next` 仍可 PASS，`unknown` 会 HOLD，`repair_previous` 会 FAIL。使用尾帧空间代理时，模板中的 `spatialProxyArtifactId` 必须指向当前锁定的上一段派生物；不使用则删除该字段并写 `spatialProxyNotUsedReason`。

首帧派生流程走 `knowledge/replication-library/tail-frame-handoff-spec.md`。提示词中必须显式声明「宫格只给姿态、不要把假模材质带进成片」，并在负面里禁止成片出现假模，否则真人成片会混入灰白假模。

### Seedance 2.0 VIP 平台约束（`star-video2`，已由 709 项目实测）

`libtv model star-video2` 返回的 schema 是这些约束的权威来源，dry-run 前必须重新核对：

| 约束 | 事实 | 操作要求 |
|---|---|---|
| 音频编码 | `mixed2video` 下 AAC 输入在进度 100% 处终态失败，返回“视频生成失败，积分将会在2小时内返还” | 上传前一律转 48kHz 单声道 WAV：`ffmpeg -i src.m4a -ac 1 -ar 48000 -c:a pcm_s16le out.wav` |
| 参考音视频时长 | 平台终态明确返回：“参考视频与音频总时长均不可超过 15 秒，单长度须大于 1.8 秒” | 上传前对每个视频/音频运行 `ffprobe`；任一单段 `<=1.8s` 或视频+音频合计 `>15s` 立即 FAIL。最小替换/回填窗口与上传参考素材长度是两个独立字段；短目标窗必须从原片取真实上下文扩成 `>1.8s`，并声明上下文不控制语义和回填范围，禁止用补静音伪造参考时长 |
| 真人合规 | 真人参考图在 `autoCompliance: 0` 时被拒，返回“参考图可能包含真人形象，请先进行合规校验后重试” | 含真人参考图的节点必须设 `autoCompliance: true`，由平台签发 `assetId` |
| 时长下限 | `duration.min` 为 4，短于 4 秒的段无法直接生成 | 音频用 `apad` 补静音生成 4 秒，成片后用 `ffmpeg -t <实际秒数>` 裁切 |
| 媒体上限 | `mixed2video` 支持最多 9 图 / 3 视频 / 3 音频，单段最长 15 秒 | 超限时重选模型或重编译职责，不得静默删资产 |
| 清晰度 | `resolution.enum` 为 `480p / 720p / 1080p / 4k` | 由锁定原片/产品基准、投放平台与交付规格反推；`480p` 只是低成本能力测试基线，不得静默带入正式成片。视频上传特殊需求仍须先询问用户 |

节点必须与资产处于同一画布 UUID，跨画布 nodeKey 无法连线。`libtv node --run` 会阻塞等待终态，需轮询读取输出。

### LibTV CLI 实操约束（709 项目实测）

| 约束 | 说明 |
|---|---|
| 项目 UUID | 非绑定目录下执行必须显式带 `-p <画布UUID>`，否则报「缺少项目」 |
| `node create -t` | 只接受英文类型 `audio / image / script / storyboard / text / video / video-clip`，中文「图片」会被拒 |
| `upload -t` | 与 `node create` 相反，接受中文「图片 / 视频 / 音频」 |
| 图片参考入边 | 新建的 image 节点默认 `text2image`，直接连图会报入边组合校验失败。必须先 `-s modeType=image2image` 再连边，或与连边同一条命令下发 |
| `-s` 键名 | 只能用顶层键名（`ratio`、`quality`、`resolution`），写 `settings.ratio` 会被拒为未知字段 |
| `-s model=` | 只接受 modelName（如 `Seedream 5.0 Pro`），不接受 modelKey |
| 入边参数 | `--left` 与 `--left-add` 不可混用 |
| 终态判据 | `"status":2` 且 `url` 非空才算完成 |
| 下载 | `libtv download -n <节点> -o <目录> --without-ai-watermark --vip`，图片/视频单节点直存文件 |

可用图片模型（用户当前授权范围）：`Seedream 5.0 Pro`、`Seedream 5.0 Lite`、`Lib Image`。目录中不存在 `Banana 2.0`；`Qwen` 与 `Nebula / General image` 系列已被用户禁用。

### 段间尾帧交接的画质红线

`knowledge/replication-library/tail-frame-handoff-spec.md` 要求交接图分辨率不低于原片。709 项目的实测教训：成片 720×1280、原片 1080×1920，尾帧仅用 ffmpeg Lanczos 放大到 1440×2560 就进入下一段，导致逐段退化。

因此：交接图必须先确认成片分辨率不低于原片，再做高清重建、曝光直方图检查与发丝/面部/服装/产品四区域细节检查，并登记独立 SHA 与单一职责声明。`image_gen` 对含塑身裤的真人图会返回 `moderation_blocked (sexual)`，重建改走同平台图片模型（如 `doubao-seedream-5-0-pro`）。

### 跨模型失败回退

同一模型终态失败后不得再次运行原节点。只有当前批次已经包含用户明确授权的 `modelFallbackPlan` 时，才允许按顺序切换到下一模型；每个模型都要重新编译 prompt/package/media 指纹、重新做 clean-zero-context PASS，并派生一次新的单次许可。每次提交独立计数，共享项目视频失败上限。用户口述模型名必须先经 `libtv model search` 匹配；没有匹配则保留为 `UNRESOLVED_ALIAS`，不得自行猜测。

多个段落采用“一次人工父批准 + 每段自动派生精确许可”，不是逐段找用户批准。父批准只授权段落清单、LibTV 执行器、总任务数、每段一次尝试，以及非 GPT 审核的单次/整批美元上限；连续镜头的后段资产依赖上一段成片，待真实输入形成后再绑定精确指纹。

```bash
node src/cli.js approve-batch-generation --project "$PROJECT" --input "$PROJECT/reviews/batch-generation-approval-input.json"
```

LibTV CLI 当前没有可验证的人民币或积分消耗字段，因此批量预算只接受 `tasks`，不能把估算金额伪装成实际消费。每段必须用 LibTV 专用 dry-run 固定执行合同；该指纹包含 `provider=libtv`、`transport=official_cli`、画布 UUID、节点名、`Seedance 2.0 VIP`、modeType、时长、画幅、分辨率和声音参数。不得把默认 RunningHub dry-run 的指纹用于 LibTV 审核或派生许可：

```bash
node src/cli.js generate-libtv-video --project "$PROJECT" --segment segment-001 \
  --libtv-project "$LIBTV_PROJECT_UUID" --node-name segment-001-seedance-video --dry-run \
  > "$PROJECT/preflight-segment-001-libtv.json"
PREFLIGHT_ID=$(node -e 'const f=require(process.argv[1]); process.stdout.write(f.preflightId)' "$PROJECT/preflight-segment-001-libtv.json")
```

该 dry-run 只写本地预检证据，不上传、不创建节点、不运行节点、不产生视频费用。随后必须由真实的 Kimi、Qwen 或 Claude 全新零上下文任务审查这份固定指纹，保存报告及签章；GPT、继承制作上下文或缺失 provider task ID 的签章会被拒绝：

先无成本核对 OpenCodex 审核计划；dry-run 不会调用模型：

```bash
node src/cli.js external-audit --project "$PROJECT" --prompt "reviews/segment-001-audit-brief.md" --model "claude-ocx-anthropic--claude-opus-4-8" --max-budget-usd 0.4 --dry-run
```

编排器可随时只读计算下一步，不调用模型、不运行视频节点：

```bash
node src/cli.js batch-next --project "$PROJECT" --batch-approval batch-generation-approval-001
```

`fast_dag_v1` 一次返回所有独立段的 ready/waiting/blocked 集合，`canonical_open` 与 `editorial_cut` 可并行准备，`continuous_proxy_handoff` 仍等待紧邻前段 Gate 5。默认可做安全影子回放，也可执行严格限定的本地免费准备；两种模式都不执行外部审核、不进入用户画布、不提交视频：

```bash
node src/cli.js batch-next --project "$PROJECT" --batch-approval batch-generation-approval-001 --fast-dag-v1
node src/cli.js batch-run --project "$PROJECT" --batch-approval batch-generation-approval-001 --fast-dag-v1 --dry-run
node src/cli.js batch-run --project "$PROJECT" --batch-approval batch-generation-approval-001 --fast-dag-v1 --execute-free-prep
```

`--execute-free-prep` 只执行 `CREATE_VIDEO_PREFLIGHT` 与 `PREPARE_PRE_GENERATION_AUDIT_BRIEF`，并使用节点级 task checkpoint 记录 queued/running/succeeded/failed/blocked、输入指纹与输出 SHA。相同输入恢复时复用已成功节点；免费幂等失败受次数上限约束，付费或非幂等节点不能自动重新 claim。相同视频包指纹会复用已有 READY preflight；图片重任务执行器内部最多允许 2 路并发。未完成合格的 60 秒以上样本验收前，禁止给 `fast_dag_v1` 传 `--live`。

批量批准还必须固定 LibTV 画布 UUID 和唯一非 GPT 审核模型。当前默认的自治循环器只执行到生成前预检和独立审核，然后返回 `USER_CANVAS_GENERATION` 等待用户在画布内审核并点击视频节点；它不得替用户提交视频：

```bash
node src/cli.js batch-next --project "$PROJECT" --batch-approval batch-generation-approval-001
```

循环器现在还会在 `USER_CANVAS_GENERATION` 状态退出：这是正常的门4停车点，不是失败。其他退出状态仍包括全部段落完成、机器/外部审核 FAIL、外部提交不确定或正在等待已提交任务终态。它不会把 STOP 当 PASS，也不会自动提交视频。

只有编排器返回 `RUN_PRE_GENERATION_EXTERNAL_AUDIT` 或 `RUN_POST_GENERATION_EXTERNAL_AUDIT` 时才允许执行相应审核 live。视频节点 live 不属于默认编排路径；只有用户在当前对话明确授权助手代提交时，才可走后文的例外命令。审核 live 会先持久化唯一 session claim，再通过 OpenCodex 启动全新只读会话；实际单次上限不得超过父批准的 `externalAuditBudget.perCallLimit`，所有已完成审核加上本次最坏预留不得超过 `totalLimit`。进程中断或返回身份/用量证据不完整时记录为 `UNCERTAIN`，禁止自动重调。

```bash
node src/cli.js attest-external-audit --project "$PROJECT" --input "$PROJECT/reviews/segment-001-external-audit.json" --report "reviews/segment-001-external-audit-report.md"
node src/cli.js derive-paid-generation --project "$PROJECT" --segment segment-001 --preflight "$PREFLIGHT_ID" --batch-approval batch-generation-approval-001 --external-audit segment-001-external-audit
```

上面的 `derive-paid-generation` 只在用户当前对话明确授权助手代提交视频时使用；默认门4不派生付费许可，停在画布。若获得该明确授权，派生许可仍一次性绑定父批准、当前 preflight 指纹和非 GPT `pre_generation` PASS。下一段还要求上一段存在非 GPT `post_generation` PASS；任何 FAIL 都立即阻断余下尚未提交的付费段落。外部审查器未配置时硬停止，不得降级成 GPT。

LibTV 视频 live 使用 `generate-libtv-video`：节点创建和付费运行严格拆开，许可 claim 后只允许一次 `node --run`。若生成已经成功但下载中断，只运行 `--resume-download`，严禁重跑节点：

```bash
node src/cli.js generate-libtv-video --project "$PROJECT" --segment segment-001 --paid-approval review-derived-id --live
node src/cli.js generate-libtv-video --project "$PROJECT" --resume-download libtv-video-run-id
```

下载并记录 SHA 后，本地生成覆盖整段的审片包；尺寸、时长、音轨、黑帧或长冻结触发 veto 会直接停批。机器 PASS 后才把关键帧及报告交给非 GPT 后审：

```bash
node src/cli.js prepare-video-audit --project "$PROJECT" --run libtv-video-run-id
```

命令发布审片包时会先把报告路径与 SHA 写回对应 `SUCCESS` run，发布成功后再自动、fail-open 地登记该生成输出时长。自动观察失败不会把机器 PASS/FAIL 改写成另一结论，也不会重跑或重新付费；应在 `ledger-status` 中把缺失观察当成覆盖缺口处理。

### 单段人工批准兼容路径

默认视频路径为官方 LibTV CLI：使用 `Seedance 2.0 VIP`、`mixed2video`、锁定包内媒体顺序与 SHA。先创建并连线视频节点但不运行；最终批准后仅执行一次 `libtv node "<节点名>" --run`，等待 CLI 返回包含 `taskId`、终态 `status=2` 和视频 URL 的 JSON，再用 `libtv download` 下载并记录本地 SHA。节点创建成功不等于生成成功，不得因此重复 `--run`。

以下 RunningHub 流程仅在用户明确选择 RunningHub 时使用：

提示词和所有引用资产完成后，先创建一个全新的独立智能体，必须使用空上下文启动。它独立观看当前段原片，检查主要动作的前/中/后细节，并逐张核对角色、场景、产品、站位、调度和故事板。完整要求见 `docs/independent-creative-audit-gate.md`。

独立智能体输出 Markdown 报告和机器 JSON。机器 JSON 按 `schemas/independent-creative-audit.schema.json` 记录 `clean_zero_context`、agent task ID、PASS/FAIL、提示词/生成包/媒体/报告 SHA。将 JSON 登记为 `independent_creative_audit` artifact；FAIL 必须 reject 并返工，PASS 才能按普通人工证据流程锁定。

```bash
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/reviews/segment-001-independent-audit-v2.artifact.json"
node src/cli.js submit-review --project "$PROJECT" --artifact independent-audit-segment-001-v2
node src/cli.js approve --project "$PROJECT" --artifact independent-audit-segment-001-v2 --note "已核对零上下文独立审核PASS及全部SHA绑定"
```

`generate-video --dry-run` 会重新验证最新审核修订；缺失、FAIL、未锁定、报告被改动或任何提示词/包/媒体 SHA 漂移都会拒绝。

无成本预检不读取 API Key、不上传文件、不访问网络；它会持久化当前 Seedance 包、提示词和全部媒体 SHA 指纹：

```bash
node src/cli.js generate-video --project "$PROJECT" --segment segment-001 --dry-run > "$PROJECT/preflight-segment-001.json"
PREFLIGHT_ID=$(node -e 'const f=require(process.argv[1]); process.stdout.write(f.preflightId)' "$PROJECT/preflight-segment-001.json")
```

输出必须显示与 Gate 2 当前生成单元一致的 `ratio`、`resolution`、`duration` 和声音策略，并显示 `videoInputs: []`（除非当前任务已取得视频输入专项授权）与 `mutatesRunningHub: false`。低成本能力测试可使用 `9:16 / 480p / 15 秒 / 生成音频开启`，正式项目不得把这组基线冒充交付规格。随后把当前精确指纹、提示词和媒体绑定到 LibTV/立布 TV 画布的视频节点。到这里门4只完成“准备并展示”，由用户在画布内审核并点击“生成视频”；助手不得自动执行付费批准或 live 提交。

默认停在画布。下面的 `approve-paid-generation` 与 `--live` 仅是用户在当前对话明确授权助手代提交时的例外路径，不能由“继续”“批准审核包”或批处理自动触发：

```bash
node src/cli.js approve-paid-generation --project "$PROJECT" --segment segment-001 --preflight "$PREFLIGHT_ID" --note "批准当前指纹的 RunningHub 付费生成" > "$PROJECT/approval-segment-001.json"
APPROVAL_ID=$(node -e 'const f=require(process.argv[1]); process.stdout.write(f.id)' "$PROJECT/approval-segment-001.json")
```

批准记录绑定 segment、dry-run evidence、Seedance package SHA、提示词 SHA 和每个输入媒体 SHA。任何文件变化都会让批准失效；批准只能由一个 RunningHub run 原子消费一次。

API Key 只放在未提交的 `$PROJECT/.env.local` 或进程环境：

```bash
export RUNNINGHUB_API_KEY="从安全位置读取的实际密钥"
node src/cli.js generate-video --project "$PROJECT" --segment segment-001 --live --paid-approval "$APPROVAL_ID"
```

Harness 在上传与提交前先持久化唯一的 `SUBMITTING` run 和 submit owner，再消费批准。并发 live 看到同一批准已有 owner 时会停止，不会第二次 submit。submit 返回 taskId 后，Harness 会先把 taskId 写入同一 `runs/<run-id>.json`，再轮询和下载。live 成功后视频立即下载到 `outputs/segment-001/`；运行档案保存 taskId、指纹、本地输出路径和 SHA，不把临时 URL 当交付物。

外部 submit 与本地 taskId 落盘之间无法做跨系统原子事务。若 submit 抛错或进程在该窗口崩溃，run 会保持 `SUBMITTING` 且 `taskId: null`。这是 uncertainty gate：任何 live、resume 和新付费批准都会停止，绝不自动重提。人工必须先在 RunningHub 控制台核实。

若控制台已有任务，把核实后的 taskId 附加到同一 run，再 resume：

```bash
node src/cli.js reconcile-video-submit --project "$PROJECT" --run runninghub-实际run-id --task-id task-控制台核实值 --note "已在 RunningHub 控制台核实同一任务"
node src/cli.js generate-video --project "$PROJECT" --segment segment-001 --resume runninghub-实际run-id
```

若控制台确认根本没有创建任务，人工标记 `--confirmed-not-submitted`。只有完成该标记后，才能重新 dry-run、创建新的付费批准并 live；旧批准永远不会重新消费：

```bash
node src/cli.js reconcile-video-submit --project "$PROJECT" --run runninghub-实际run-id --confirmed-not-submitted --note "已核实 RunningHub 中没有对应任务"
node src/cli.js generate-video --project "$PROJECT" --segment segment-001 --dry-run
```

若提交后进程中断，读取运行档案中的 run ID，恢复同一 taskId；恢复不会再次 upload 或 submit：

```bash
node src/cli.js generate-video --project "$PROJECT" --segment segment-001 --resume runninghub-实际run-id
```

只有状态为 `SUBMITTED` 或 `INTERRUPTED` 且已有 taskId 的非终态 run 可以 resume。`SUCCESS`、失败终态和 `CONFIRMED_NOT_SUBMITTED` 都会拒绝 resume。认证、网络、平台 FAILED 或轮询超时会保留部分证据并停止，不无限重试。

## 8. 视频人工审核与真实视频交接

根据 live 输出中的实际 `path` 登记视频，不要假设固定文件名：

```json
{"id":"video-segment-001","type":"video_segment","segmentId":"segment-001","revision":1,"status":"draft","path":"outputs/segment-001/result-1.mp4"}
```

```bash
node src/cli.js register-artifact --project "$PROJECT" --input "$PROJECT/video-segment-001.artifact.json"
node src/cli.js submit-review --project "$PROJECT" --artifact video-segment-001
node src/cli.js quality-review --project "$PROJECT" --input reviews/video-segment-001-quality-input.json
node src/cli.js prepare-handoff --project "$PROJECT" --artifact video-segment-001
```

质量审核输入必须逐维打分并记录 veto。总分达到阈值仍不够：任一关键维度低于最低分，或触发 veto，都会计算为不合格。人工决定如果与计算结果相反，必须填写 `overrideReason`；退回必须填写 `correction`：

> 审片诊断可用 `knowledge/replication-library/reverse-and-diagnose.md`（B 部分）逐项体检脸/动作/光/质感/氛围/声音/衔接。质量 rubric 建议增设 `followability`（可跟随性 / 意图是否落成物理动作）维度并设为 `critical`（讲戏门 spec §5）。

```json
{
  "artifactId": "video-segment-001",
  "rubricId": "rubric-v2",
  "decision": "approved",
  "scores": {
    "identity_state": 90,
    "product_fidelity": 90,
    "spatial_continuity": 85,
    "motion_physics": 82,
    "camera_story": 84,
    "visual_style": 86
  },
  "evidenceByDimension": {
    "identity_state": {"observation":"全段主体识别点稳定","timestampsOrRegions":["00:00-00:15"],"anchorIds":["canonical-subject"],"anchorSha256ById":{"canonical-subject":"0000000000000000000000000000000000000000000000000000000000000000"}},
    "product_fidelity": {"observation":"产品几何与英雄帧锚点一致","timestampsOrRegions":["00:11.2-00:15"],"anchorIds":["canonical-product"],"anchorSha256ById":{"canonical-product":"0000000000000000000000000000000000000000000000000000000000000000"}},
    "spatial_continuity": {"observation":"切点前后轴线与屏幕方向连续","timestampsOrRegions":["00:04.1/00:04.2"],"anchorIds":["canonical-space"],"anchorSha256ById":{"canonical-space":"0000000000000000000000000000000000000000000000000000000000000000"}},
    "motion_physics": {"observation":"接触、张力与动作终点可辨","timestampsOrRegions":["00:05.0-00:10.8"],"anchorIds":["locked-action-contract"],"anchorSha256ById":{"locked-action-contract":"0000000000000000000000000000000000000000000000000000000000000000"}},
    "camera_story": {"observation":"景别变化与动作接力切点按 Shotlist 实现","timestampsOrRegions":["全段切点"],"anchorIds":["locked-shotlist"],"anchorSha256ById":{"locked-shotlist":"0000000000000000000000000000000000000000000000000000000000000000"}},
    "visual_style": {"observation":"材质、光向和禁止项逐帧可验","timestampsOrRegions":["代表帧与高风险区域"],"anchorIds":["locked-visual-contract"],"anchorSha256ById":{"locked-visual-contract":"0000000000000000000000000000000000000000000000000000000000000000"}}
  },
  "triggeredVetoIds": [],
  "note": "人工逐项检查后通过",
  "correction": null,
  "overrideReason": null
}
```

`prepare-handoff` 会读取真实视频时长并从最后几秒提取 6 个候选帧，不机械取最后一帧。人工检查候选帧后，在项目内创建 observed handoff input JSON：每个字段必须带 `basis` 和实际 `timestamps`，推断只能用 `multi_frame_inference`。先通过公开命令生成绑定输入 SHA、prepared handoff SHA、源视频 SHA、人工决定和备注的审核记录，再应用该审核：

```bash
node src/cli.js review-handoff --project "$PROJECT" --input reviews/segment-001-handoff-input.json --decision approved --note "已核对人物站位、朝向、镜头和产品状态" > "$PROJECT/reviews/segment-001-handoff-approval.json"
HANDOFF_REVIEW_ID=$(node -e 'const f=require(process.argv[1]); process.stdout.write(f.id)' "$PROJECT/reviews/segment-001-handoff-approval.json")
node src/cli.js record-handoff --project "$PROJECT" --input reviews/segment-001-handoff-input.json --review "$HANDOFF_REVIEW_ID"
```

只有视频已 approved 且 observed handoff 已 locked，`segment-002` 的调度资产才可编译。上一段“结尾站位交接图”和下一段“本段人物—镜头调度图”必须是两张职责独立的图。

## 9. 失败、规则学习与恢复

视频不通过时用 `reject` 保存错误位置、表现和改进方法，不进入下一段。把人工反馈 JSON 转成候选规则：

```bash
node src/cli.js rules create --project "$PROJECT" --feedback "$PROJECT/reviews/rule-feedback.json"
node src/cli.js rules apply --project "$PROJECT" --rule rule-001 --run runninghub-rework-001
node src/cli.js rules review --project "$PROJECT" --rule rule-001 --input "$PROJECT/reviews/rule-repair-review.json"
node src/cli.js rules verify --project "$PROJECT" --rule rule-001 --review review-rule-repair-001
```

候选规则只有在相关修复实际成功并由人工批准后才能升级为 hard。修复仍失败时使用 `rules revise`，保持 candidate，不得强行升级。查看当前上下文适用规则：

```bash
node src/cli.js rules list --project "$PROJECT" --context "$PROJECT/segments/segment-001-rule-context.json"
node src/cli.js rules list --project "$PROJECT" --status hard --context "$PROJECT/segments/segment-001-rule-context.json"
```

进程中断后不要重新初始化或删除输出，直接读取持久状态：

```bash
node src/cli.js doctor --project "$PROJECT"
node src/cli.js next --project "$PROJECT"
node src/cli.js status --project "$PROJECT"
node src/cli.js ledger-status --project "$PROJECT"
node src/cli.js ledger-portfolio --projects-root "$PWD/projects"
find "$PROJECT/runs" "$PROJECT/reviews" -type f -print
```

`doctor` 只读检查 Node、ffmpeg、LibTV 登录、RunningHub Key 是否存在、事务、项目锁、未知提交和锁定产物完整性；不会输出密钥。`next` 只从持久证据计算下一合法动作。未知 RunningHub submit、待恢复事务、项目锁和缺失 observed handoff 会优先阻断下游生成。

`ledger-status` 是独立的只读执行漏斗：它校验账本事件、head 与 projection，但不会自动恢复待完成事务，也不会重建文件。`not_observed` 不能解释为失败；历史项目只保证从 `ledger.bootstrap` 观察点之后的事件可追溯。相同状态也可在 Harness Studio 的“执行漏斗”标签查看。

`ledger-portfolio` 是跨项目只读观察基线：它只汇总已初始化且 `consistency=consistent` 的账本事件，旧项目无账本时单列为“未覆盖”，状态不可读、待恢复或账本不一致时单列为未知/需处理，并从事件总数与漏斗排除。它不会用事件数推导成功率。Harness Studio 首页显示相同基线，团队成员只会看到自己有权访问的项目集合。

复盘旧项目不能只依赖账本。用历史离线重放按结构化证据时间戳筛选“在时间窗内创建或继续推进”的项目，并同时读取项目状态、产物、审核、运行记录和账本：

```bash
node src/cli.js historical-replay-baseline \
  --projects-root "$PWD/projects" \
  --from 2026-08-10 \
  --through 2026-08-24 \
  --time-zone-offset +08:00 \
  --report-dir "/absolute/path/to/reports"
```

该命令只向显式 `report-dir` 写 JSON 与 Markdown 报告，不修改任何项目、恢复事务或补建账本。指标是“时间窗活动项目集合的项目全生命周期证据”，不是只统计窗内新增文件。报告严格区分已登记产物、SHA 可验证的机器视频 PASS、最终剪辑字节、Gate 5 人审和最终交付；`not_observed` 不等于失败。历史提示词/资产错误没有与付费审批包稳定一对一绑定时，硬错误率保持 `unknown`，不得用文件数量制造百分比。

若要进一步判断哪些旧记录可以被新系统读取，运行只读证据适配器：

```bash
node src/cli.js legacy-evidence-adapter \
  --projects-root "$PWD/projects" \
  --from 2026-08-10 \
  --through 2026-08-24 \
  --report-dir "/absolute/path/outside-projects-root"
```

适配器只输出 `verified / partial / invalid` 候选，不写 ExecutionLedger。`provider_task` 必须有真实 `taskId`；已确认未提交或无 taskId 的旧 run 只能进入 `generation_run_record`。生成结果还必须验证输出文件 SHA，机器视频审计必须同时验证 report、run 反向引用和视频 SHA，Gate 5 必须绑定正式 human quality review 与对应媒体 artifact。`partial` 继续保持未知，不能自动补账。

在适配器之上运行只读影子漏斗，可看到真实断点而不回填旧账本：

```bash
node src/cli.js shadow-funnel-projection \
  --projects-root "$PWD/projects" \
  --from 2026-08-10 \
  --through 2026-08-24 \
  --report-dir "/absolute/path/outside-projects-root"
```

漏斗固定区分：已验证审批包、已消费审批、真实 provider task、SHA 已验证输出、机器 PASS、Gate 5 接受媒体、Gate 5 接受最终剪辑和最终交付。每级只接收与上一级反向绑定的 verified 候选；重复语义身份、断链 verified、partial 和 invalid 全部排除并单列原因。上一级为零时转化率保持 `null`，不会制造 0% 或 100%。该命令不恢复事务、不写项目、不创建账本，也不触发生成。

需要比较机器执行、平台排队、人工等待、实际费用、成片时长或失败根因时，必须先登记一份 v2 观察回执：

```bash
node src/cli.js record-execution-observation \
  --project "$PROJECT" \
  --input "$PROJECT/reviews/execution-observation-input.json"
```

回执必须是 `execution_observation_evidence` v2，且 `evidencePath` 指向回执自身；`sourceReferences` 中每个来源都必须位于项目内并绑定当前 SHA。实际、推导和估算费用分栏，不同单位不换算；只有具备实际费用和最终交付时长双证据的项目才进入“实际成本 / 成片分钟”。缺少观察回执表示未知，不表示零。完整字段、类别和模板见 `docs/execution-ledger.md` 与 `templates/project/execution-observation-input.json`。

若来源已经是声明完整覆盖的 execution trace、SHA 绑定的视频审计报告、`COMPLETE` 最终交付回执、成功独立外审费用 run 或不可变生成失败记录，优先先做受信自动派生预检：

```bash
node src/cli.js derive-execution-observation \
  --project "$PROJECT" \
  --input "$PROJECT/derivation-input.json" \
  --dry-run
```

预检只读；去掉 `--dry-run` 后才原子写入派生证据、v2 回执和账本。trace 没有 `metadata.authoritativeObservation` 完整覆盖声明时必须拒绝，不能把默认 0 当实测 0。`leaf_spans` 汇总全部叶子，`declared_spans` 只汇总显式 `spanIds` 并拒绝祖先/后代重复选择。视频入场与 Fast DAG 免费准备会在 trace 成功落盘后自动、fail-open 地派生观察；视频审计包发布后自动登记生成输出时长，最终交付事务完成并释放项目锁后自动登记最终成片时长；独立外审成功发布后只登记其验证过的 USD/Credits 分类；严格治理的新失败写入不可变记录后登记规范根因。派生故障不能改变原业务结果，重复调用按来源指纹幂等复用。时间按 stage 分桶，生成准备基线不能混入 intake。LibTV/RunningHub 实际扣费、退款、付费重试和未覆盖历史仍保持未知，不会触发付费、生成或历史批量回填；外审费用不等于完整项目成本。请求字段见 `schemas/execution-observation-derivation.schema.json` 与 `templates/project/execution-observation-derivation-input.json`。

`pendingHumanGate` 是下一处人工审核；`blockedReason` 是需要处理的技术阻塞。处理原因后从该步骤重跑，旧版本和失败证据继续保留。

Gate 5 锁定 `video_segment` 后会自动生成轻量 `segment-summary`；失败时不回滚已经完成的人审。后续默认用 `segment-context` 读取当前段与前段摘要，不再加载前段完整 artifact 历史。手工 `segment-summary` 只用于修复旧项目或缺失摘要；`prepare-external-audit-brief`、`record-generation-failure` 和 `approve-gpt-fallback-generation` 仍只在对应边界调用。

### 9.1 定期做“系统瘦身”只读审计

当命令、DLC、规则或项目记录越来越多时，先用只读审计找证据，不要凭感觉删流程：

```bash
node src/cli.js audit-harness --project "$PROJECT"
```

它会列出未被生产代码引用的命令模块、没有进入能力路由的文件、疑似重复帮助函数、从未应用的候选规则、重复 SHA 记录、缺少分段摘要的已完成片段，以及最大的上下文文件。结果中的 `automaticAction` 永远是 `none`：任何条目都只是复核候选，不会自动删除、归档、升级规则或修改项目。无项目参数时只审计 Harness 自身：

```bash
node src/cli.js audit-harness
```

## 10. 最终交付检查

### 10.1 KOC 复刻确定性执行链

选择 `koc_remake` 后使用以下专用命令，不再复制项目临时 FFmpeg 脚本：

```bash
node src/cli.js koc-source-ledger --input "$LEDGER_INPUT"
node src/cli.js koc-media-prepare --project "$PROJECT" --input "$MEDIA_JOB" --dry-run
node src/cli.js koc-media-prepare --project "$PROJECT" --input "$MEDIA_JOB" --execute
node src/cli.js koc-remake-plan --input "$PROJECT/work/koc-media/koc-remake-plan-input.json"
node src/cli.js koc-canvas-batch --project "$PROJECT" --input "$CANVAS_BATCH_JOB" --dry-run
node src/cli.js koc-canvas-batch --project "$PROJECT" --input "$CANVAS_BATCH_JOB" --execute
node src/cli.js koc-reinsert --project "$PROJECT" --input "$REINSERTION_JOB" --dry-run
node src/cli.js koc-reinsert --project "$PROJECT" --input "$REINSERTION_JOB" --execute
```

`koc-media-prepare` 与 `koc-reinsert` 只处理本地媒体；`koc-canvas-batch --execute` 只允许上传素材和创建节点。三者都不得触发视频生成。画布节点必须保持 480P、有声、无独立音频绑定，并由当前逐段审核包及其 SHA 锁定。回插时，每个 A-roll 段必须完全由已接受的视频或已登记可用子段覆盖；其余时间线来自原片，并由解码帧 SHA256 复核。最终音轨直接复制源片完整音频流并核对 SHA256。

分段视频审核通过只是中间状态，不等于成片交付。单段项目可以直接核验该段；多段项目必须先完成最终剪辑，并登记一份 current locked `final_edit`：它要精确绑定全部 canonical 分段视频，记录画面锁定、声音混合、色彩连续性和段间连续性复核。字幕、口播、音乐和音效是否需要，由项目的创意 brief 与最终剪辑合同决定，不能用“分段生成成功”替代编辑决策。

最终审核仍复用门5，不新增人工审批门，但必须把两类结论分开：

- 技术交付：解码、分辨率、时长、音画、SHA、run/package 指纹与分段完整性；
- 创意交付：人物身份和产品结构、表演因果、Must-see 证据、节奏、段间连续性，以及故事或复刻目标是否真正成立。

使用交付验证器从 canonical segmentation 与 current 产物链核验：

```bash
node src/cli.js verify-delivery --project "$PROJECT"
npm run verify
```

只有 `deliverable` 数组中的段才可进入最终交付。每段必须同时具备：canonical locked 分段、唯一 current locked 视频及其人工 SHA 审核绑定、当前 Seedance package 指纹、同指纹的唯一 RunningHub `SUCCESS` run、与视频路径及 SHA 一致的 run output，并且项目无 blocker。多段项目还必须具备有效的 current locked `final_edit`。失败、篡改、旧 package、缺失审核、缺失最终剪辑或歧义项只进入 `blocked`，不算完成。
# Audit-only external review authorization

When a non-GPT independent pre-generation audit is required before any video preflight, use a separate `external_audit_only_approval`. It must bind the exact audit brief, prompt, compiled package, and every media SHA; set `maxCalls` to `1`; set the per-call and total limits in one explicit unit (`USD` or `CREDITS`); and explicitly deny automatic retries, image generation, video generation, and external messages.

The approval must also bind a unit-matched `executionPolicy`. USD mode requires `actual_billed_usd`, verified USD input/output prices, and `worstCaseUsd`. Token Plan mode normally requires `actual_consumed_credits`, verified Credits input/output conversion, and `worstCaseCredits`. When the user explicitly authorizes the compatibility fallback `usage_derived_consumed_credits`, the adapter computes Credits from the returned `input_tokens`/`output_tokens` and the approved rates, records `receiptAvailable: false`, and labels the result as usage-derived rather than a provider receipt. Both modes require per-turn token ceilings and machine-compute the worst-case exposure across all allowed turns. Live execution performs a no-model CLI capability check before claiming the approval. If the executor cannot enforce both `max_turns` and `max_output_tokens`, the verified worst case exceeds the approved limit, or the returned evidence does not match the approved accounting mode, the command stops or records the consumed call as `UNCERTAIN`. Token Plan must run through an officially permitted programming/Agent tool; custom HTTP scripts are forbidden.

```bash
node src/cli.js approve-external-audit-only --project "$PROJECT" --input "$APPROVAL_JSON"
node src/cli.js independent-external-audit --project "$PROJECT" --approval "$APPROVAL_ID" --live
```

The command claims the approval before calling the external model. Any interrupted, identity-mismatched, unverifiable-cost, or over-budget result becomes `UNCERTAIN` and must never be retried. Non-zero process results retain a redacted JSON envelope when parseable, plus stdout SHA/byte count, exit code, and bounded stderr evidence. API list-price equivalents are recorded separately and never accepted as actual billing receipts. A successful model call creates a draft `independent_creative_audit` payload; register it and send it through normal human review before it can be locked or used downstream. This approval path never creates a paid image or video generation approval.
