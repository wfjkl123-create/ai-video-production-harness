# Seedance 2.0 v6.7 全量融合与冲突路由

本文件把 `seedance-20` v6.7.0 的完整能力并入 `seedance2-prompt`。原始发行包的 187 个文件保存在 `seedance20-v67/`，所有原 `SKILL.md` 已改名为惰性的 `MODULE.md`，因此它们是本 Skill 的内部知识模块，不是第二套提示词入口。逐文件源路径、源 SHA、合并路径与合并后 SHA 见 `seedance20-v67/integration-manifest.json`。

## 1. 合并总则

1. `seedance2-prompt/SKILL.md` 是唯一入口、路由器和最终提示词正文作者。
2. refs 28–39 是原 references/01–26 与 v6.7 模块逐主题深度比较后的默认执行层；refs 40–43 是用户提供的 Higgsfield 方法经冲突裁决后的空间光学专项层。来源文件只作证据，所有最终正文仍由本 Skill 编译，不得退回“同时加载但不裁决”的松散拼接。
3. 完全同义的内容只执行一次；互补内容合并执行；不同但都成立的方法保留为可选择模式。
4. 平台、模型、时长、素材数量、端点和 UI 等事实发生冲突时，以当前模型版本、当前 surface 和当次核验证据为准。v6.7 的平台数字只适用于 Seedance 2.0，不能外推给 2.5。
5. 创作规则冲突时按以下顺序裁决：安全与授权 → 已验证的 surface 限制 → 用户明确要求 → 素材职责 → 连续性 → 物理因果与可读性 → 摄影与剪辑 → 风格 → Skill 默认值。不能静默牺牲用户要求。
6. 内部合同、Director's Read 字段、状态字段、审计标签和解释不得进入生成模型正文；它们必须翻译成镜头可见或可听的载体。

## 2. 每次任务的统一前置门

- 先判 `Seedance 2.0 / Seedance 2.5 / 未知版本`，再判 surface 与 operation；未知时只写通用导演内容，不编造平台能力。
- 再判 `narrative / non_narrative`：人物目标、阻力、选择、关系、反应或价值变化属于 narrative；纯展示、材质、功能演示、抽象变化或无人物能动性的产品镜头属于 non_narrative。
- narrative 同时运行原 ref 01 的十项导演预演和 v6.7 `seedance20-v67/references/directors-read.md` 的十字段判断；重叠项合并，新增的隐藏目标、阻碍/策略、潜台词、压住的可见行为、不可替换细节与拒绝的俗套解法必须保留。
- non_narrative 只记录可见的用途目标和“不得虚构戏剧/人格化”的拒绝项，不为了填字段制造人物心理。
- 有素材时建立逐维度权威表：人物身份、产品、服装、场景、姿态、动作、摄影、时间、声音、首帧、尾帧分别只能有一个主权威；每个素材同时写明允许迁移与禁止迁移。
- 长故事、多段、继续、延长、修尾或跨生成连续性任务必须进入 sequence/continuation 状态，不得一次性把全故事塞进当前生成。

## 3. 深度融合稿默认路由

| 当前任务 | 默认先读的统一稿 | 原文何时补读 |
|---|---|---|
| 人物、关系、对白表演 | ref 28 | 查微表情词库、角色案例或 v6.7 character 细则 |
| 模糊愿望、需求访谈、提示词编译与压缩 | ref 29 | 查 interview 话术、prompt compiler 或原八要素细目 |
| 导演预演、故事、类型和长弧线 | ref 30 | 查原场面调度表、genre library 或具体案例 |
| 摄影、光线、色彩、风格、UGC 介质 | ref 31 | 查焦段/光位词库、STYLE DNA 或后期色彩细则 |
| Higgsfield、FOV/焦段冲突、狭小空间、强角度、首帧揭示或创意镜头装置 | ref 40，再按命中条件读 refs 41–43 | 查当前 surface 的已验证能力；来源 Skill 不直接写正文 |
| 动作、产品、物理、VFX、首尾帧变化 | ref 32 | 查特效词库、model mechanics 或 I2V/FLF 细则 |
| 声音、对白、音乐、口型与同步 | ref 33 | 查音频语法、实测 protocol 或 30 秒对白账本 |
| 素材权威、人物身份、多角色和多模态 | ref 34 | 查 surface 输入合同、2.5 专项或资产制作细则 |
| 多段、延长、继续、剪辑、宫格与动画连续性 | ref 35 | 查 project-state schema、operation 手册或严格 QC |
| 去 AI 味、失败诊断、返工与 retake | ref 36 | 查 failure atlas、词库或具体失败案例 |
| 专业制作、后期、交付、发布/投放前质量 | ref 37 | 查 2.5 14 字段合同、codec/color/audio/subtitle 细则 |
| 多语言、版权、安全、证据与版本能力 | ref 38 | 查六语种词库、source registry 或当次官方证据 |

一个任务可同时加载多份统一稿，例如“多角色剧情延长”读 ref 28 + 30 + 34 + 35；但不因跨主题而全量打开 187 文件。下表保留原文来源映射，用于深查与审计，不再作为默认的双文件并排执行方式。

## 4. 主题级证据与细节矩阵

| 任务主题 | 原 Skill 必读 | v6.7 内部模块必读 | 合并后的新增价值 |
|---|---|---|---|
| 模糊愿望、需求访谈 | `../SKILL.md`、ref 26 | `seedance20-v67/MODULE.md`、`seedance20-v67/skills/seedance-interview/MODULE.md`、`seedance20-v67/skills/seedance-interview-short/MODULE.md`、`seedance20-v67/references/interview-starters.md`、`seedance20-v67/references/intent-vs-precision.md` | 区分硬缺口与导演可自主补足项，保留短问诊和完整问诊两条路径 |
| 普通提示词、短提示词与压缩 | `../SKILL.md` 的八要素、控制等级与输出格式 | `seedance20-v67/skills/seedance-prompt/MODULE.md`、`seedance20-v67/skills/seedance-prompt-short/MODULE.md`、`seedance20-v67/references/prompt-compiler.md`、`seedance20-v67/references/prompt-examples.md`、`seedance20-v67/references/quick-ref.md` | 先保留导演判断和可见载体，再按 surface 字符预算压缩；短不等于删掉因果、素材职责和末态 |
| 导演预演、故事、剧情 | refs 01、05、26 | `seedance20-v67/references/directors-read.md`、`seedance20-v67/references/directing-engine.md`、`seedance20-v67/references/directing-engine-genre-library.md`、`seedance20-v67/references/storytelling-framework.md`、`seedance20-v67/references/genre-guides.md` | 将关系/价值翻转补成目标、阻力、策略、潜台词、权力变化和可见载体 |
| 活人感、角色、微表演 | ref 02、ref 09、ref 28 | `seedance20-v67/skills/seedance-characters/MODULE.md`、`seedance20-v67/skills/seedance-motion/MODULE.md`、`seedance20-v67/references/directors-read.md`、`seedance20-v67/references/directing-engine.md`、`seedance20-v67/references/event-density.md` | 统一到 ref 28：有事可做、压住的行为、异步反应、动作落地与改变后的末态 |
| 摄影、镜头语言 | refs 01–03、05 | `seedance20-v67/skills/seedance-camera/MODULE.md`、`seedance20-v67/references/cinematography-shot-language.md`、`seedance20-v67/references/multishot-grammar.md`、`seedance20-v67/references/shot-list-continuity.md` | 摄影机由事件和意图驱动，补齐起点、路径、终点与剪辑关系 |
| 光线、色彩、风格 | refs 02、05、09 | `seedance20-v67/skills/seedance-lighting/MODULE.md`、`seedance20-v67/skills/seedance-style/MODULE.md`、`seedance20-v67/references/color-pipeline-aces.md`、`seedance20-v67/references/directing-engine-genre-library.md` | 将美学名词落实为动机光、材质反应、色彩进程与交付边界 |
| 动作、物理、舞蹈 | refs 01–03、26 | `seedance20-v67/skills/seedance-motion/MODULE.md`、`seedance20-v67/references/model-mechanics.md`、`seedance20-v67/references/event-density.md`、`seedance20-v67/references/continuity-qc.md` | 补充质量/力量/后果/恢复，明确一个主要动作及可见终点 |
| 声音、对白、音乐 | refs 02、05、10、25 | `seedance20-v67/skills/seedance-audio/MODULE.md`、`seedance20-v67/references/audio-guide.md`、`seedance20-v67/references/audio-post-delivery.md`、`seedance20-v67/references/sync-budget-protocol.md` | 区分画内声、生成音频与后期声，声音和动作逐事件配对 |
| 素材引用、多模态 | refs 03、05、07、11–24 | `seedance20-v67/references/reference-workflow.md`、`seedance20-v67/references/reference-transfer-contract.md`、`seedance20-v67/references/surface-prompt-profiles.md`、`seedance20-v67/references/first-last-frame-guide.md` | 每个维度唯一权威，显式 transfer/ignore，标签逐字节保留 |
| 多段、长故事、连续性 | refs 03、13、17、20、25 | `seedance20-v67/skills/seedance-sequence/MODULE.md`、`seedance20-v67/references/sequence-project-state.md`、`seedance20-v67/references/sequence-worked-trace.md`、`seedance20-v67/references/prompt-compiler.md` | 全局规划、局部生成；scene 重锚定；完成/当前/未来节拍防火墙 |
| 继续、延长、修尾 | refs 03、10、13、17 | `seedance20-v67/skills/seedance-continuation/MODULE.md`、`seedance20-v67/references/continuation-handoff.md`、`seedance20-v67/references/first-last-frame-guide.md` | 接受的真实末态覆盖计划末态；拒绝的成片不进入 canon；漂移时重锚定 |
| 多镜、宫格、动画 | refs 03、14、19、20 | `seedance20-v67/references/dense-storyboard-mode.md`、`seedance20-v67/references/multishot-grammar.md`、`seedance20-v67/references/2d-anime-grammar.md`、`seedance20-v67/skills/seedance-recipes/MODULE.md` | 宫格语义、镜间交接、动画语法和当前镜头职责分离 |
| 产品、对象与 VFX | refs 05–08、18–20 | `seedance20-v67/skills/seedance-vfx/MODULE.md`、`seedance20-v67/references/i2v-guide.md`、`seedance20-v67/references/first-last-frame-guide.md`、`seedance20-v67/references/examples-by-mode.md` | 产品身份与变化解耦，变化具有阶段、环境反馈和稳定终态 |
| 去 AI 味、反空话 | refs 02、04、05、09、26 | `seedance20-v67/skills/seedance-antislop/MODULE.md`、`seedance20-v67/references/anti-slop-lexicon.md`、`seedance20-v67/references/field-observed-tips.md`、各语言 `seedance20-v67/references/vocab/*.md` | 空形容词必须兑换成动作、镜头、光、材质或声音证据；不删除用户真正想要的感受 |
| 失败诊断、返工 | refs 04、21、24 | `seedance20-v67/skills/seedance-troubleshoot/MODULE.md`、`seedance20-v67/references/failure-atlas.md`、`seedance20-v67/references/retake-protocol.md`、`seedance20-v67/references/eval-rubric.md` | 先按可见失败找根因，再选择后期修、编辑、重抽或重写；一次返工只改主要变量 |
| 专业交付与管线 | refs 10–24 | `seedance20-v67/skills/seedance-pipeline/MODULE.md`、`seedance20-v67/references/pro-filmmaking-standards.md`、`seedance20-v67/references/aspect-ratio-delivery.md`、`seedance20-v67/references/delivery-qc.md`、`seedance20-v67/references/subtitles-localization.md`、`seedance20-v67/references/color-pipeline-aces.md` | 把生成、声音、字幕、色彩、交付和 QC 分层，不把后期职责塞进提示词 |
| 多语言与词汇 | 原中文自然导演语言规则 | `seedance20-v67/skills/seedance-vocab-*/MODULE.md`、`seedance20-v67/skills/seedance-examples-*/MODULE.md`、`seedance20-v67/references/vocab/*.md`、`seedance20-v67/references/multilingual-community-examples.md`、`seedance20-v67/references/multilingual-native-review.md` | 保留六语种精确词汇与各语言空话陷阱；参考标签永不翻译或改写 |
| 安全、版权、过滤 | 原任务边界 | `seedance20-v67/skills/seedance-copyright/MODULE.md`、`seedance20-v67/skills/seedance-filter/MODULE.md`、`seedance20-v67/references/filter-vocab.md` | 只作为安全与授权门，不替代创作方法，也不主动收束普通创意阶段 |

## 5. 完整库的补充路由

以下 v6.7 文件没有被上表逐一展开，但仍是已吸收的可调用知识：

- 平台与证据：`seedance20-v67/references/api-status.md`、`seedance20-v67/references/api-workflow.md`、`seedance20-v67/references/capability-map.md`、`seedance20-v67/references/model-name-map.md`、`seedance20-v67/references/platform-constraints.md`、`seedance20-v67/references/platform-surface-matrix.md`、`seedance20-v67/references/source-registry.md`、`seedance20-v67/references/research-2026-05-30.md`、`seedance20-v67/references/community-source-methodology.md`。
- 架构与验证：`seedance20-v67/references/agent-compatibility.md`、`seedance20-v67/references/allocation-model.md`、`seedance20-v67/references/json-schema.md`、`seedance20-v67/references/progressive-disclosure.md`、`seedance20-v67/references/quick-ref.md`、`seedance20-v67/references/prompt-examples.md`、`seedance20-v67/references/eval-rubric.md`，以及安装运行包内的 `seedance20-v67/scripts/` 与 `seedance20-v67/validation/`。GitHub 开发仓库的 CI 和 `tests/` 不在当前下载的安装运行包内，不得宣称已经嵌入。
- 专项生产：`seedance20-v67/references/pro-filmmaking-standards.md`、`seedance20-v67/references/frontend-design-system.md`、`seedance20-v67/references/examples-by-mode.md`、`seedance20-v67/references/surface-prompt-profiles.md`。
- 示例与反例：按任务加载 `seedance20-v67/examples/golden-prompts/`、`seedance20-v67/examples/standalone-clip/` 或 `seedance20-v67/examples/sequence-airport-arrival/`；示例只证明写法，不证明当前 surface 能力或生成结果。上游 `examples/sequence-mixed-lane/project-state.json` 缺少两个 latest take 对应的 sibling take-review，严格连续性检查会失败；修复上游 fixture 前不得把它当成有效生产范例。
- 上游所有 README、Quickstart、多语言文档、数据、图形资产、许可证、变更记录和安装元数据也保存在快照并登记哈希；它们用于来源追踪或维护，不作为每次提示词的强制上下文。

只加载当前任务需要的模块；“全量吸收”是能力覆盖，不是每次把 187 个文件同时塞进上下文。

## 6. 实际差异合并后的裁决

- **原生标签与 Harness 稳定资产 ID**：用户或界面已经给出的 `@Image1`、`@Video1` 等标签逐字节保留；Harness 内部的 `@素材[exact-id]` 也保持稳定，直到 `compile-seedance` 按最终媒体顺序机械映射。写作者不得自行改号，两套规则不冲突。
- **导演预演与 Director's Read**：原 ref 01 负责世界、空间、轴线、构图、透视和结束状态；v6.7 补人物目标、阻力/策略、潜台词、权力变化、压住的行为、不可替换细节和俗套拒绝。两张表合并思考，只把可拍载体写进正文。
- **八要素与 Director Formula**：八要素是完整性检查，Director Formula 是信息排序。先以主体和主要变化开场，再按需要补环境、摄影、光、声音、素材职责和约束；不能写成字段填空或标签沙拉。
- **活人感与 anti-slop**：原 Skill 的呼吸、眼神、身体联动和多人异步继续保留，但必须挂到具体任务、触发、选择、反馈和末态；随机眨眼、摸头发、空泛“自然真实”不算活人感。完整规则见 ref 28。
- **多段拆分与 sequence state**：原 Skill 的段尾状态卡升级为 project/scene/clip lineage。每个 clip 只执行 `this_clip_only`；接受成片的观察末态覆盖计划末态；scene 边界和连续延长达到上限时从 canonical 资产重锚定。
- **尾帧连续性与身份权威**：真实尾帧负责瞬时姿态、站位、视线、动作阶段和摄影阶段；人物、产品、服装、场景设计仍由 canonical 资产负责。不能因为“观察优先”让漂移结果升级为身份事实。
- **生成音频与后期音频**：提示词只要求当前 operation 能生成且画面需要的对白、环境声和同步 SFX；跨片段音乐连续性、最终混音、响度、字幕和交付由后期处理，不在提示词里伪装保证。
- **2.0 与 2.5**：v6.7 的导演、表演、连续性和素材方法可迁移；它的时长、模型名、素材上限、端点和 UI 数字只属于 2.0。2.5 一律由 refs 11–25 的当前证据路线覆盖。
- **生成前与生成后**：提示词结构通过只代表“可提交草稿”；真实视频仍须播放级检查人物、产品、动作、连续性、声音和投放语境。文件存在、lint PASS 和投放可用不是同一状态。
- **Higgsfield 启发式与 Seedance 能力**：精确 FOV、镜头距离、滚转角度和秒数只有在用户测量值或当前 surface 已验证证据支持时才可作为硬值。来源文件中的经验区间用于发现矛盾，不得外推成字节官方合同或“100%匹配”承诺。

## 7. 提示词正文编译纪律

内部先完成判断、状态与权威分配，再把结果压成自然中文导演指令。最终正文至少保持：当前镜头的可见变化、明确主体和动作终点、必要空间锚、一个主摄影策略、动机光/声音、素材职责和针对性约束。不得输出隐藏目标、Director's Read、权威矩阵、状态胶囊、审计结论或“本镜意图”等内部字段名。
