# Seedance 2.5 官方目录覆盖矩阵

> 用途：审计 Skill 是否覆盖官方在线手册的全部目录项。日常写提示词不加载本文件；新增或修改 2.5 能力时必须运行覆盖验证。机器合同见 `seedance25-coverage-contract.json`。

## 覆盖口径

- 在线目录：33 项；官方正文叶子记录：1,338 条。
- 静态图片：220 个 image token，198 个唯一 SHA；全部已目视。
- 视频：142 个节点，126 个唯一 SHA；全部已逐秒联系表和末帧目视。
- 提示词/代码案例：72 个锚点。
- 47 个行内评论线程和 1 个全文评论容器与官方正文分离，不作官方方法证据。
- “覆盖”要求不是出现关键词，而是相应功能具备入口、输入/参数、步骤、公式、短例、失败和验收。

## 33 项逐项映射

| # | 官方目录 | 主要 Skill 落点 | 状态 |
|---:|---|---|---|
| 0 | 使用手册标题 | refs 11、15 | covered |
| 1 | 正式上线 | refs 11、15 | covered |
| 2 | 怎样更好使用 | refs 16、17 | covered |
| 3 | 参数设定 | ref 16 §2 | detailed |
| 4 | 功能交互 | ref 16 §3–6、ref 19 | detailed |
| 5 | 提示词建议 | refs 12、21 | detailed |
| 6 | 基础提示词 | ref 12 | detailed |
| 7 | 真人人物 | ref 12 | detailed |
| 8 | 30 秒长视频 | refs 13、16 §3 | detailed |
| 9 | 超长视频 | refs 13、16 §4 | detailed |
| 10 | 视频延长 | ref 17 | detailed |
| 11 | 智能/高级/视频编辑写法 | refs 16 §6、18 | detailed |
| 12 | 编辑可填写内容 | ref 16 §6 | detailed |
| 13 | 圈选/标记功能 | ref 16 §6.3–6.4 | detailed |
| 14 | 白模怎么写 | ref 19 | detailed |
| 15 | 亮点预览 | refs 15、21 | covered |
| 16 | 视频延长亮点 | ref 17 | detailed |
| 17 | 超长最长 180 秒 | refs 13、16 §4 | detailed |
| 18 | 时间戳控制 | ref 16 §7 | detailed |
| 19 | 跨语言 | refs 16 §8、21 | detailed |
| 20 | 去字幕与 BGM | refs 16 §8、18 §2 | detailed |
| 21 | 基础生成优化 | refs 12、21 | detailed |
| 22 | 多模态参考优化 | ref 18 | detailed |
| 23 | BGM 分离/移除 | ref 18 §2 | detailed |
| 24 | 迁移创意 | ref 18 §3 | detailed |
| 25 | 局部消除与编辑 | ref 18 §4 | detailed |
| 26 | 空间视角修改 | ref 18 §5 | detailed |
| 27 | 音色参考 | ref 18 §6 | detailed |
| 28 | 多人参考 | ref 18 §7 | detailed |
| 29 | 绿幕编辑 | ref 18 §8 | detailed |
| 30 | 专业白模控制 | ref 19 | detailed |
| 31 | 两段视频无缝转场 | refs 18 §10、17 | detailed |
| 32 | 多宫格分镜 | ref 20 | detailed |

## 覆盖验证

```bash
python3 scripts/validate_seedance25_coverage.py \
  --outline /absolute/path/to/online-text-images/outline.json
```

期望：

```text
COVERAGE_VALIDATION=PASS
OUTLINE_COVERED=33/33
MANDATORY_MANUALS=7/7
DETAILED_CONTRACTS=22
```

其中 `MANDATORY_MANUALS` 的当前期望值是 `7/7`。脚本从 coverage contract 动态读取全部十四个字段，并按每个目录项绑定的独立 `[CONTRACT:*]` 区块检查；不会再把同文件其他章节的关键词借给当前功能。它仍不能替代人工核对语义质量和案例画面。
