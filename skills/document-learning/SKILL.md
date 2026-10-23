---
name: document-learning
description: "用于制作、修订或审阅文档时读取个人文档经验手册，以及用户明确要求记住文档经验、确认经验晋升或管理个人文档经验时。普通编程、插件设计讨论和只提到文档名称不启动文档流程。"
---

# 文档持续学习

经验由后台批量整理：宿主会话结束后，插件扫描会话记录，判断哪些是文档任务，提炼经验并编译成手册。当前会话不需要逐轮提交任何学习信号，也不在最终回答中展示学习过程。

## 写文档前

1. 读取个人库手册目录下的 `knowledge/core.md`（所有文档通用的核心经验）。
2. 按文档类型读取 `knowledge/<kind>.md`，kind 取 experiment-report（实验报告）、instruction（操作说明）、site-report（现场报告）、presentation（演示文稿）、markdown 等；使用了某个技能或工序时，看对应的“技能 X”“工序 Y”小节。没有对应手册就跳过。
3. 修订已做过的文档时，再看 `cases/<文档标识>.md` 中这份文档自己的偏好和参数。

手册目录：绑定个人技能仓库时在该仓库的 `knowledge/`、`cases/`，否则在个人库目录（`doctor` 输出的 library）下。条目格式为 `- [强度·N份文档] 经验`：required 必须遵守，default 默认采用，suggestion 可参考。当前用户的明确要求始终优先于手册。

## 用户明确要求记住时

只有用户明确说“记住”“以后都这样”“记下来”等时才运行，不要主动记录：

```
node "<hook 给出的脚本路径>" remember --session <hook 给出的会话> --text "经验正文" --quote "用户逐字原话" [--kind 类型 | --task 文档标识 | --scope '{"kind":"..."}'] [--category method|preference|constraint] [--strength suggestion|default|required]
```

- `--quote` 必须逐字摘自用户本轮消息；问答工具的回答用 hook 返回的 source，加 `--source <id>`。
- 范围按用户原话：只说这份文档用 `--task`；说这类文档用 `--kind`；说所有文档且原话含“所有/一律/默认”等时不加范围并加 `--scope-basis explicit`。
- 写入后会立即更新手册。后台整理时，同一要求的后续证据会并入这条经验。

## 经验晋升提案

SessionStart 提示有待确认的晋升提案时，在不打断当前工作的时机：

1. 运行 `proposals` 查看提案（来源经验、目标范围、覆盖文档数）。
2. 用提问工具（Claude 的 AskUserQuestion / ask_user_question，Codex 的 request_user_input）请用户确认是否晋升，选项写清目标范围。提问被宿主拦截时告诉用户原因，不改用普通对话代替确认。
3. 用户同意后，用 hook 返回的该回答 source 运行 `promote --id <提案> --confirm-source <source>`。用户拒绝或未回答就不执行。晋升只替代不强于结果的来源经验，更强的类型层 required 会保留。

## 其他

- 后台整理状态、配置和计划任务用 `doctor` 查看；需要立即整理时运行 `consolidate --now`。
- 历史补学、回放和技能管理见插件 README。
