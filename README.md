# 文档持续学习

面向 Codex 和 Claude Code 的本地插件。安装后，在文档任务开始前检索适用经验，在每轮完成前自动整理有依据的反馈、维护个人技能。公开项目只包含程序和虚构示例；每个使用者的会话、偏好、案例和技能分别保存在自己的电脑上。

## 安装

需要 Node.js 24 或以上。没有运行时 npm 依赖。

在项目目录运行：

```powershell
node bin/document-learning.mjs install
node bin/document-learning.mjs doctor
```

默认同时配置 Codex 和 Claude Code 的用户级 hooks，并安装技能入口。保留原有 hooks 和设置；重复安装不会叠加本插件。安装后新开会话验证。`doctor` 分别显示配置是否存在、是否收到真实 SessionStart、是否还有未完成回执。

已有技能仓库作为只读学习来源时：

```powershell
node bin/document-learning.mjs install --source-repository 'D:\自己的技能仓库'
```

来源仓库（`--source-repository`）只读。默认情况下，新技能写入个人库的 `skills/`，再为已安装的 Codex、Claude 建立个人入口；同名人工入口保留并报告冲突。

如果希望用自己的 Git 私有仓库统一管理文档技能并跨设备同步长期文档经验，可以选用以下两种方式之一：

1. **一键初始化新的纯文档技能与长期经验仓库**（可同时从旧仓库导入文档技能，自动排除编程技能与 `notes/`）：

```powershell
node bin/document-learning.mjs init-skill-repo --output 'D:\git-repo\document-skills' --import-from 'D:\git-repo\skills' --bind
```

2. **绑定已有的个人文档技能仓库**（或在另一台电脑克隆该仓库后绑定）：

```powershell
node bin/document-learning.mjs bind --skill-directory 'D:\git-repo\document-skills'
node bin/document-learning.mjs sync-skills
```

绑定 `--skill-directory` 后，文档技能（含自动生成的技能内 `README.md`）与长期文档经验（`knowledge/index.md`、`cases/index.md`、`knowledge/memory.json`）保存在该 Git 仓库中供跨端同步；单机每轮聊天产生的临时会话状态（`sessions`）、事务快照（`versions/`）和原始大日志（`history/`）继续留在本地 `%LOCALAPPDATA%\DocumentLearning`，平时非文档聊天不会弄脏 Git 工作区。

把该技能仓库关联到远端并推送（一键提交、创建或复用远端、并推送当前分支）：

```powershell
node bin/document-learning.mjs publish-repo
```

`publish-repo` 默认使用已绑定的 `--skill-directory`。已有远端时传 `--remote <地址>`；需要由 GitHub CLI 新建私有仓库时传 `--name 仓库名 [--owner 账号] [--visibility private]`。工作区有未提交改动时先自动提交，可用 `--no-commit` 关闭该行为。

绑定属于当前用户，其他工作区使用同一个绑定。没有绑定时自动建立独立个人库。绑定已存在但路径丢失或无权读取时报告错误，保留待处理状态；不会悄悄建立第二个库。

默认数据位置：Windows 为 `%LOCALAPPDATA%\DocumentLearning`，其他系统为 `$XDG_DATA_HOME/document-learning` 或 `~/.local/share/document-learning`。可用 `DOCUMENT_LEARNING_HOME` 或命令行 `--home` 指定其他位置。插件升级、卸载不删除个人库。

```powershell
node bin/document-learning.mjs bind --library 'D:\个人资料\文档经验库' --source-repository 'D:\自己的技能仓库'
node bin/document-learning.mjs uninstall
```

`bind` 用于明确切换绑定，不自动迁移或覆盖旧库。跨电脑迁移时复制个人数据后重新绑定。

也可以通过宿主原生插件机制安装本项目：根 `plugin.json` 提供 Agent Plugins/OpenAI 格式，另有 Codex 与 Claude Code 兼容清单。原生插件安装与上述用户级 hooks 安装选择一种。Codex 的 hook 信任由宿主处理，安装程序不修改信任记录；原生插件安装后仍需在宿主中启用并确认 hook 信任。源码 hooks 需要在本机可执行，GitHub 分发不等于进入官方公共插件目录。

## 实际工作过程

1. SessionStart 连接个人库；压缩和恢复时读取已保存的状态。宿主自身的后台模型调用（ambient 建议生成、审批复核等）不建立会话、不建轮、不注入指导；插件只汇总忽略次数，由 `doctor` 的 `backgroundIgnored` 显示。会话状态按容量修剪，只淘汰全部轮已终结且不参与恢复的旧会话。
2. 新需求到达，当前模型先判断是否实际进行文档工作。普通编程和插件设计讨论不会加载整套文档经验。
3. 文档任务提交用途、读者、格式等已知条件，检索结果在计划前返回；冲突和条件未知分别展示给模型。
4. 模型实施当前任务。明确要求自动应用；普通偏好在条件匹配时参考；缺少关键用途信息时才补问具体取舍。
5. 完成前提交经验与技能提案，以及 `skillDecision` 的创建、更新、停用或不变理由。程序核对原始来源、引文、范围、正反例和当前文件指纹，自动写回个人目录。
6. 没有新经验也提交空数组和技能覆盖判断。Stop 最多补偿一次；未完成就保留真实失败状态。中断、会话关闭或后续轮次把它保留为待补学，新需求到达时从全部会话认领一项恢复。票据绑定会话、轮次和十分钟租期；只补学，不继续旧业务操作，不循环续轮。

实时路径使用当前会话模型，不默认另开后台模型。非文档任务仍有一个简短判断与信号调用的开销；显式加载入口技能会增加该技能正文的上下文。匹配经验以摘要返回，完整引文按需查看。

信号命令只读取输入并输出 JSON，由 PostToolUse hook 保存结果，计划模式不需要模型修改工作区文件。Windows PowerShell 5.1 的复杂中文 JSON 建议使用 `--base64`，避免原生管道编码损失。技能入口包含协议说明。

计划模式只保存私有学习记录与候选，不发布技能文件。判定依据是显式声明的模式：宿主上报的 `permission_mode`，或模型在 begin 时提交的 `context.mode`（`--mode plan` 或 `--plan`）。Codex/Codeg 在计划模式下 `permission_mode` 可能仍是 `default`，此时必须由模型显式声明；插件不根据 `update_plan` 或工具名推断，也不接受 `planning`、`readonly` 等近似写法。下一次同一文档处于可实施模式时，模型对照当前资料重新整理再提交；不会在另一个任务中执行旧计划。`doctor` 显示尚未发布的候选数量。

## 经验如何保持边界

经验独立记录 `category`、`scope`、`strength`、来源与例外。可信程度、适用范围和执行强度独立变化。

- 一百次喜欢某个版式，不覆盖另一份报告中明确相反的要求。当前要求决定当前成果，旧选择保留原范围。
- 同范围相反反馈无法解释时，记录冲突。不会用次数、沉默或最后出现时间替用户解释喜好。
- 用户明确表达“以后所有文档默认如此”时可以保存个人默认；单份文档的例外不会撤销它。
- 能机械检查的要求也需要依据。例如图注可以检查是否存在，但并非所有图片都必须有图注。
- 不同清洗对象可以复用操作顺序、图片与实物对应等方法。清洗剂、时间、对象等案例事实保留在原任务，新的工艺参数来自新资料。
- 仍限旧任务的方法，只有用途条件明确匹配时才作为少量 `transfer` 类比候选；只有 task、缺少可迁移边界的方法不推荐给所有文档。它们不成为新任务的强制要求，偏好和事实不走这条迁移路径。
- 相同条件得到不同任务的证据支持时，成熟度可以提高；范围和强度保持原值。已有共享要求与局部相反选择通过例外关联。
- 用户明确把同一条规则改为建议或强制要求时，可以单独修订强度并保留来源；重复次数不会触发这种修改，其他文档的例外也不能改写旧范围。

只有形成独立可执行流程才创建技能。正例和相近反例用于验证匹配边界，它们是程序测试输入，不是新的用户认可。新技能默认可自动匹配；已有技能的调用政策保留，尤其不会把明确调用的报告技能改成隐式调用。

程序只更新自己的管理区，保留其他正文。文件有手动修改时先返回新指纹，模型读取新版本、基于该指纹重新整理后才能继续更新。明确停用的技能退出自动匹配，并保留文件与来源。知识有事务快照，技能正文和元数据有单独备份。

查看一条经验的完整来源：

```powershell
node bin/document-learning.mjs show-rule --name 经验ID
```

回退经验库使用 `state.json` 中事件的 `rollback` 标识；回退技能使用备份文件名的 SHA-256 指纹：

```powershell
node bin/document-learning.mjs rollback --version '版本标识'
node bin/document-learning.mjs skill-rollback --name '技能标识' --version '文件指纹'
```

经验库回退和技能文件回退分别执行，避免一次操作覆盖无关手动修改。程序不推送远程仓库。

个人技能目录自身处于 Git 仓库中时，发布前目标文件干净且索引可写，就只提交本次管理的文件，保留其他已暂存内容。默认使用个人快照和技能备份；不自动初始化 Git、执行仓库 hooks 或推送。

## 查看学习产物与当前资料补学

直接打开个人库的 `knowledge/index.md` 查看有效经验、条件和原始引文；`cases/index.md` 保存案例事实及旧记录；`skills/` 是实际可调用技能。`catalog` 命令可重新生成阅读目录。

当前补学与时间回放分开。当前会话可以综合完整用户日志、当前技能及 references、调用配置和后续差异，按学习 schema 整理 JSON 后执行：

```powershell
node bin/document-learning.mjs backfill --input '完整数据集.json' --decision '当前会话整理的学习JSON.json' --job 'my-backfill'
node bin/document-learning.mjs sync-skills
```

程序验证每条原始引文和技能边界，然后发布并生成可读报告。`--replace-history 旧任务标识` 可归档指定旧回放中未被手动修订的记录，保留原证据和回退快照；归档不伪装成用户撤销。当前补学不宣称无未来信息回放，也不等同版式质量评价。

补学默认使用当前会话，不另外外发私人资料。明确选择其他模型后端时才传 `--provider`；须先确认该后端的数据目的地和授权。JSONL 导入排除环境、技能正文注入和路由元数据，保留原始用户、时间及工具来源。DOCX 模板差异解析实际 XML，包括非标准名称的页眉；结构检查不能代替视觉检查。

## 历史导入与回放

支持 Codeg 会话接口导出的 JSON、Codex/Claude Code JSONL，以及带 `messages` 的 JSON 会话。多个 `--input` 按提供的会话顺序处理，消息保留原顺序。只有会话级时间时，不强行推断它与某次提交的精确关系。

```powershell
node bin/document-learning.mjs history-import --input '会话一.json' --input '会话二.jsonl' --repository 'D:\自己的技能仓库' --output 'D:\个人资料\历史数据集.json'
node bin/document-learning.mjs replay --input 'D:\个人资料\历史数据集.json' --merge
```

默认在回放完成并通过已提供的边界检查后，自动回补个人库及其中的技能目录。来源仓库只读。已有当前选择保留，相反历史记录转为有来源的观察。未通过检查的任务不自动回补。使用 `--replay-only` 可以仅运行实验，之后用 `reconcile --input 回放任务目录` 回补。

Git 导入按描述发现文档技能，再按文件拆分混合提交，保存无关文件的排除清单；共享文件需要有相关变化。候选变化不等于正确经验，提交不自动视为用户认可。二进制资源只登记可用性，不根据提交标题猜测版式效果。

时间回放给学习方的输入只有初始技能入口、当前会话前缀与此前学习结果。详细入口和历史窗口有明确截断标记。最终提交、当前正式库和隐藏评估答案不进入学习请求。默认历史后端用 Claude Code 的 bare 模式，禁用工具、其他技能、hooks、记忆与文档自动发现；不会把工作区的完整 Git 历史交给它。

默认后端使用本机 Claude Code 配置中的模型及 API 路由。历史分析会把必要片段发给该已配置模型；没有额外云端记忆服务。仅使用 OAuth 登录且 bare 模式无法认证的环境，可配置自己的 JSON 命令后端：

```json
{"type":"command","command":"你的可执行文件绝对路径","args":["参数"],"timeout":120000}
```

把配置保存在个人目录，通过 `replay --provider 配置文件` 使用。后端从 stdin 读取包含 `instructions/schema/input` 的 JSON，仅在 stdout 返回符合 schema 的 JSON。它应是没有工具访问的可信适配器。正常实时学习不依赖这个历史后端。

每个步骤保存输入摘要指纹、来源、自动修正记录、变化与检查点。任务固定插件代码和协议指纹、初始快照、输入与模型配置；这些条件变化时拒绝复用旧检查点，应使用新任务标识。相同条件重新执行可继续中断位置。结构或证据不合法时自动修正一次，仍失败则保存失败位置。

报告分别列出冻结初始、自动演化与实际维护参考。实际维护历史默认是参考，未提供隐藏期望时不虚构正确率；没有历史文档或图片时，不声称版式改善。回放产物不会作为新的用户证据再次学习。

可用 `--expectations 隐藏期望JSON` 提供评估依据，按原始消息 ID 映射 `document`、`requiredRules`、`forbiddenRules`；规则列表填写 key。隐藏期望仅在输出后用于评估，不进入学习请求。冻结对照的无效提案作为评估结果保留，不阻塞演化分支的合格变更，也不会被自动修好来提高对照表现。

## 开发验证

```powershell
npm test
npm run check
npm run demo
claude plugin validate .
```

测试覆盖偏好冲突、跨对象复用、证据伪造、范围扩大、重复记录、双宿主回执、一次补偿、安装卸载、手动修改、技能停用及回退、混合提交、未来信息隔离和中断恢复。演示采用明确标注的虚构记录与固定后端，仅展示程序链路。

宿主当前依据：[Codex hooks](https://learn.chatgpt.com/docs/hooks?site_variant=chatgpt&translationFallback=zh-Hans)、[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)、[Claude Code hooks](https://code.claude.com/docs/en/hooks)、[Claude Code 插件清单](https://code.claude.com/docs/en/plugins-reference)。兼容性以本机诊断和新会话实测为准。
