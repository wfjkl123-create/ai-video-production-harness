# Lavish 检查点审核模板

五个人工检查点的网页审核模板。所有人工审核必须通过这些页面进行，不在纯文本对话里要批准。

## 模板

- `checkpoint-creative.html` — 检查点 1：创意、时长、分段与并行策略审核
- `checkpoint-story.html` — 检查点 2：剧本、人物圣经、分镜表或一镜到底计划审核
- `checkpoint-assets.html` — 检查点 3：资产图批量审核
- `checkpoint-preflight.html` — 检查点 4：生成前付费审核
- `checkpoint-video.html` — 检查点 5：视频审片

## 使用流程（代理执行）

1. 复制对应模板到 `.lavish/<项目>-<段>-<类型>-review/index.html`
2. 替换所有 `{{...}}` 占位符为真实值
3. 把需要展示的图片/视频/关键帧复制到同目录，用相对路径引用（不要加 `/` 前缀）
4. `lavish-axi <html-file>` 打开页面
5. `lavish-axi poll <html-file>` 长轮询等待用户决定（不要中途杀掉）
6. 根据 poll 返回的选择执行对应 CLI：
   - 创意 A → `checkpoint-approve --checkpoint checkpoint_creative`
   - 故事与镜头 A → `checkpoint-approve --checkpoint checkpoint_story`
   - 资产 A → `checkpoint-approve --checkpoint checkpoint_assets`
   - 生成前 A → `approve-paid-generation`（绑定当前指纹）
   - 视频 A → `checkpoint-approve --checkpoint checkpoint_video`
   - 任何 B/C → 对应 `reject` + rework，不得付费生成

## 设计约定

- 深色 luxury 风格，与既有 709/xingzhiliang 审核页一致
- 每个页面必须包含：边界说明（本次批准授权什么、不授权什么）、SHA 证据、明确的选择表单
- 表单通过 `window.lavish.queuePrompt` 提交，poll 返回后代理才能执行状态变更
