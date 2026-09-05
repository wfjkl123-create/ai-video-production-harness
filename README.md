# AI Video Production Harness

一个本地优先、可审计的 AI 视频生产 Harness。它把需求路由、原片事实、导演决策、素材职责、提示词、生成前检查和人工验收保存在项目目录中，并以 SHA-256 绑定关键输入与输出。

## 公开脱敏版范围

本仓库包含 Harness 核心、项目级 KOC/审片 Skill、完整公开发行的融合版 Seedance 提示词 Skill、图片/导演/审查/研究/教学等全局 Skill、项目初始化时自动复制的 KOC 全头匿名化工具，以及版本化环境/Skill 清单。它**不包含**任何真实项目、人物或产品素材、视频/音频、生成结果、平台运行记录、工作台数据库、本机路径、密钥或历史 Git 对象。

这不是“把我当前 Mac 的登录状态打包出去”：账号、付费额度、提供方协议、浏览器会话、Keychain、项目 UUID 和模型权重都必须由每位操作者自行持有与配置。仓库会明确检查这些边界，缺失时阻止把环境称为生产就绪。

除各 Skill 内保留的第三方许可证外，Harness 和由仓库作者授权公开的 Skill 采用 Apache-2.0；详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。第三方来源、版权和未打包的外部集成见 [第三方声明](THIRD_PARTY_NOTICES.md) 与 [Skill 清单](manifests/skills.lock.json)。它与 LibTV、Seedance、RunningHub、OpenAI 和 ByteDance 均无隶属关系。

## 本地运行

最小步骤：

```bash
npm run configure-template -- --write-env
npm test
npm run check
npm run doctor:environment
npm run studio
```

`npm test` 使用仓库内的合成 Prompt Skill 夹具。`doctor:environment` 会实际检查 Node、FFmpeg 功能、LibTV 登录、OpenCodex、Skill 文件和可选 RunningHub 配置，但不会输出任何密钥或账号资料。第一次运行预期会因尚未安装的生产组件而失败；请按 [生产启动手册](docs/PRODUCTION-BOOTSTRAP.md) 完成配置。

实际项目默认使用随仓库提供、已锁定 SHA 的公开融合版 `seedance2-prompt-fusion`；它保留导演、提示词、连续性、审查和失败诊断方法，但已去除原项目、产品和本机证据。MIT 的 Seedance 2.0 v6.7 baseline 同时随仓库提供，供融合 Skill 追溯上游方法。首次配置后通过 `npm run harness --` 启动 CLI，确保本地
`.env.local` 被加载：

```bash
npm run harness -- intake-video --project <project-dir> --request '<project request>' --inputs-json '<inputs-json>'
```

如果你要把它换成另一个 canonical Skill，必须先在
`manifests/skills.lock.json` 固定其 SHA 并更新本地
`HARNESS_CANONICAL_PROMPT_SKILL_ROOT`；不得把未审计的项目资料混入公开发行物。

随后通过确定性入口创建项目：

```bash
npm run harness -- intake-video --project <project-dir> \
  --request '<project request>' \
  --inputs-json '[{"id":"source-001","mimeType":"video/mp4","path":"/absolute/path/to/source.mp4"}]'
```

完整命令和 Gate 契约见 [操作手册](docs/operator-runbook.md)。

深度视频是可选的离线路线：`tools/monocular_depth_video_runner.py` 只接受本机模型目录、强制离线运行且不下载权重。使用它还需要 Python、OpenCV、NumPy、PyTorch、Transformers 和你已获许可的本地模型权重；这些权重不随仓库分发。完整的当前 Skill 闭包、可再分发状态与未解决旧 Skill ID 见 [skills.lock.json](manifests/skills.lock.json)。

## 安全与验收边界

- 不手改 `project-state.json`；状态变化必须由 Harness 命令和交易记录产生。
- 不使用未锁定的产物作为下游输入；失败证据只可追加、不可伪造或静默覆盖。
- 任何付费或外部生成都必须绑定当前精确指纹；一次授权不自动变成重试授权。
- 机器检查通过、任务完成或视频可播放，都不等同于人工创意验收。
- 先用 `.env.example` 创建本地 `.env.local`；不要提交它或任何媒体、项目目录、运行日志和导出物。
