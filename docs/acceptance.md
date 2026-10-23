# 0.3.0 验收记录

## 流程变化

宿主会话中不再逐轮提交学习信号。hooks 只做 SessionStart 提示和用户明确“记住”时的写入；后台按计划任务扫描 Claude / Codex 会话记录，Jev 先筛掉明显不是文档的会话，其余交给整理模型提炼经验，程序校验引文与范围后编译成核心 / 类型 / 单份文档三层手册。跨文档重复出现的经验生成晋升提案，经用户在提问工具中确认后才晋升。

## 已验证行为

- 迁移：旧库备份到 `backups/` 后迁移，82 条旧规则中 74 条按新范围保留，其余归档并保留证据。
- 整理：引文必须逐字出自用户消息；校验失败带错误重试 3 次，仍失败的会话一天后再试一次，再次失败放弃。新经验默认限定文档或类型。
- 晋升：用户经提问工具确认一条核心晋升和两组合并；晋升只替代不强于结果的来源经验，更强的类型层 required 保留。经验全部晋升后，旧案例文件改写为说明，不残留失效条目。
- 提问捕获：Claude AskUserQuestion、codeg ask_user_question、Codex request_user_input（含 `user_note` 补充说明）的回答都能作为确认来源。
- Jev：通过本机 magpie System One 网关调用 `jev-latest`，真实整理报告显示判断层 `jev:jev-latest@gateway`。`jev-latest` 与 `jev-preview` 当前都解析到 jev-1.14.0，6 个样例均判断正确，选用稳定别名。
- 人工复核：codeg:36、codeg:40 的有效经验逐条对照原话，范围与内容一致。

## 证据

- Windows：68 项程序测试、包检查与示例通过；GitHub Actions 在 Windows、macOS、Linux 上通过。
- 本机个人库：有效经验 72 条、归档 70 条、个人技能 2 个；手册发布到绑定的个人技能仓库。
- 未重新生成或盲评历史文档，不宣称成稿质量提高。

## 宿主状态

- Claude：hooks 已触发。自动模式会拦截 `install --schedule`（计划任务）和写入权限设置，需用户手动执行，README 首次使用清单已列出。
- Codex：用户在 `/hooks` 信任后已观察到真实 SessionStart 回调，诊断报告 `active`。程序不写信任记录；只有信任记录、没有回调时报告 `record-present-unverified`。
