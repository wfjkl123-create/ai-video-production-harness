# AI Video Production Harness

一个本地优先、可审计的 AI 视频生产 Harness。它把需求路由、原片事实、导演决策、素材职责、提示词、生成前检查和人工验收保存在项目目录中，并以 SHA-256 绑定关键输入与输出。

## 公开脱敏版范围

本仓库只包含通用实现、模式、Schema、模板和合成测试夹具。它**不包含**任何真实项目、人物或产品素材、视频/音频、生成结果、平台运行记录、工作台数据库、本机路径、私有提示词、密钥或历史 Git 对象。

该仓库公开可读，但尚未授予复用许可；除非另行添加许可证，保留全部权利。它与 LibTV、Seedance、RunningHub、OpenAI 和 ByteDance 均无隶属关系。

## 本地运行

前提：Node.js `>=22`，以及按需安装的 `ffmpeg`/`ffprobe` 和官方媒体 CLI。

```bash
npm test
npm run check
npm run studio
```

`npm test` 使用仓库内的合成 Prompt Skill 夹具。实际项目应在受控环境设置：

```bash
export HARNESS_CANONICAL_PROMPT_SKILL_ROOT=/absolute/path/to/approved-prompt-skill
export RUNNINGHUB_API_KEY=your-key-if-needed
```

随后通过确定性入口创建项目：

```bash
node src/cli.js intake-video --project <project-dir> \
  --request '<project request>' \
  --inputs-json '[{"id":"source-001","mimeType":"video/mp4","path":"/absolute/path/to/source.mp4"}]'
```

完整命令和 Gate 契约见 [操作手册](docs/operator-runbook.md)。

深度视频是可选的离线路线：`tools/monocular_depth_video_runner.py` 只接受本机模型目录、强制离线运行且不下载权重。使用它还需要 Python、OpenCV、NumPy、PyTorch、Transformers 和你已获许可的本地模型权重；这些权重不随仓库分发。

## 安全与验收边界

- 不手改 `project-state.json`；状态变化必须由 Harness 命令和交易记录产生。
- 不使用未锁定的产物作为下游输入；失败证据只可追加、不可伪造或静默覆盖。
- 任何付费或外部生成都必须绑定当前精确指纹；一次授权不自动变成重试授权。
- 机器检查通过、任务完成或视频可播放，都不等同于人工创意验收。
- 先用 `.env.example` 创建本地 `.env.local`；不要提交它或任何媒体、项目目录、运行日志和导出物。
