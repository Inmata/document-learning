# 文档持续学习

简体中文 | [English](README.en.md)

面向 Codex 和 Claude Code 的本地插件。流程是“自动记录 → 批量整理 → 编译手册”：hooks 只登记会话；后台定期扫描宿主会话记录，判断哪些是文档任务，提炼有原话依据的经验，合并重复证据，再编译成按层级排序的经验手册。写文档时模型读手册即可，普通聊天和编程不需要执行任何学习命令。公开项目只包含程序和虚构示例；每个使用者的会话、偏好、案例和技能都保存在自己的电脑上。

## 安装

### 首次使用清单

以下步骤需要使用者自己执行一次；涉及计划任务和宿主权限的步骤，宿主的自动模式通常不允许模型代为执行。

| 步骤 | 命令或操作 | 是否必需 |
| --- | --- | --- |
| 1. 安装依赖 | 在插件目录运行 `npm install` | 必需 |
| 2. 配置宿主 hooks 与技能入口 | `node bin/document-learning.mjs install`，然后 `doctor` 检查 | 必需 |
| 3. 创建后台整理计划任务 | Windows 上在**管理员** PowerShell 中运行 `node bin/document-learning.mjs install --schedule` | 必需（否则只在会话开始/结束时检查） |
| 4. Codex 确认 hook 信任 | 新开 Codex 会话，按提示审核并信任本插件的 hooks | 使用 Codex 时必需 |
| 5. Codex default 模式允许提问 | 在 `~/.codex/config.toml` 的 `[features]` 加 `default_mode_request_user_input = true` | 使用 Codex default 模式时必需（晋升确认要靠提问） |
| 6. Claude 自动模式放行 | `node bin/document-learning.mjs install --agent claude --allow-claude-signal` | 使用 Claude 自动模式时建议 |
| 7. 整理模型与网关 | 编辑数据目录下的 `config.json`：`consolidate.model`、`effort`、`baseUrl`、`apiKey` | 可选，默认跟随 Claude Code 设置 |
| 8. Jev 判断层凭据 | 设置环境变量 `TYPESAFE_API_KEY` 或 `OPENROUTER_API_KEY`，或在配置中填 `judge.baseUrl` 指向本机网关 | 可选，没有时由整理模型独立判断 |
| 9. 整理历史会话 | 先备份数据目录的 `state.json`，再运行 `consolidate --all-existing` | 可选，首次扫描默认只排队最近 7 天 |

完成后新开一个会话，`doctor` 显示 `ready` 即可。有待确认的晋升提案时，模型会在会话开始后用提问工具征求同意，回答即可。

### 详细说明
需要 Node.js 24 或以上。运行时依赖只有固定版本的 `@jkudish/jev-agent-tools`（Jev 判断层，可在配置中关闭）；首次使用先运行 `npm install`。

在项目目录运行：

```powershell
node bin/document-learning.mjs install
node bin/document-learning.mjs doctor
```

默认同时配置 Codex 和 Claude Code 的用户级 hooks（SessionStart、UserPromptSubmit、PostToolUse、SessionEnd），安装技能入口，并在缺失时写入带注释的默认配置文件。保留原有 hooks 和设置；重复安装不会叠加本插件。安装后新开会话验证。

后台整理的计划任务需要确认后创建。`install` 会列出将执行的 `schtasks` 命令；确认后运行：

```powershell
node bin/document-learning.mjs install --schedule
```

Windows 上创建两个计划任务：每 `schedule.intervalMinutes` 分钟一次、登录时一次（`schedule.runAtLogon`），都只运行 `consolidate --if-due` 到期检查；`uninstall` 移除全部宿主后删除它们。任务通过 `conhost.exe --headless` 启动 node，不弹出终端窗口，也不抢占前台焦点（例如全屏游戏）；早期版本创建的任务会弹窗，重新运行一次 `install --schedule` 即可更新。创建登录时任务需要管理员权限，非管理员终端会报“拒绝访问”，此时间隔任务可能已更新而登录任务仍是旧命令，请在管理员 PowerShell 中重新运行。其他系统输出 cron 或 launchd 配置，由用户自行添加。修改 `schedule` 后需重新运行 `install --schedule`。另外，每次会话开始和结束时 hooks 也会在后台触发一次到期检查。

Claude Code 自动模式会审查模型发出的命令和提问工具调用，用户要求的“记住”、晋升提问与确认都可能被拦截。如希望不被拦截，可显式授权：

```powershell
node bin/document-learning.mjs install --agent claude --allow-claude-signal
```

该选项添加 `Bash(node "<本插件绝对路径>/bin/document-learning.mjs" remember *)`、同一路径的 `proposals` 与 `promote *`，以及提问工具 `AskUserQuestion`、`mcp__codeg-mcp__ask_user_question`，不授权其他子命令。promote 只接受提问工具中的用户回答作确认，放行命令不会绕过用户同意。重复安装保留授权，卸载只移除插件新增的规则，保留原有 allow/ask/deny；显式 deny/ask 或托管策略仍由宿主执行。参见 [Claude Code 权限规则](https://code.claude.com/docs/en/permissions)。

Codex 的原生提问工具 `request_user_input`（含 `_async`）同样被识别，答案按问题 id 对回问题；default 模式下需在 `~/.codex/config.toml` 的 `[features]` 中开启 `default_mode_request_user_input = true`。

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

也可以通过宿主原生插件机制安装本项目：根 `plugin.json` 提供 Agent Plugins/OpenAI 格式，另有 Codex 与 Claude Code 兼容清单。原生插件安装与上述用户级 hooks 安装选择一种。Codex 的 hook 信任由宿主处理，安装程序不修改信任记录；Codex 按 `hooks.json` 中分组的位置和内容记录信任，重装时本插件的分组保持原位置，插件路径和 hook 设置不变时无需重新信任；路径或设置变化后需要重新审核。原生插件安装后仍需在宿主中启用并确认 hook 信任。源码 hooks 需要在本机可执行，GitHub 分发不等于进入官方公共插件目录。

### 升级

升级不删除个人库，也不覆盖配置文件。每台电脑各执行一次，先关闭正在运行的 Codex 和 Claude Code 会话。以下命令假设插件在 `D:\git-repo\document-learning`、个人技能仓库在 `D:\git-repo\document-skills`，路径不同时替换成实际目录。

1. 更新代码和依赖，重新安装 hooks（hook 命令和分组可能随版本变化，重新安装才会更新）：

```powershell
cd D:\git-repo\document-learning
git pull
npm install
node bin/document-learning.mjs install
```

之前用过 `--schedule` 或 `--allow-claude-signal` 的，在**管理员** PowerShell 中带上同样的选项再运行一次，更新计划任务和放行规则：

```powershell
cd D:\git-repo\document-learning
node bin/document-learning.mjs install --schedule --allow-claude-signal
```

2. 绑定了个人技能仓库时，先拉取其他电脑推送的手册和经验，再重新绑定。绑定会合并 `knowledge/memory.json` 中本机没有的经验，以及其他电脑撤销的经验：

```powershell
cd D:\git-repo\document-skills
git pull
cd D:\git-repo\document-learning
node bin/document-learning.mjs bind --skill-directory D:\git-repo\document-skills
```

3. 检查状态，`doctor` 显示 `ready` 即可：

```powershell
node bin/document-learning.mjs doctor
```

4. 新开 Codex 会话。提示 hooks 有变化时，审核后重新信任一次。

手册仓库只在本机自动提交、不自动推送。希望另一台电脑拿到本机的新经验或撤销，先在本机的个人技能仓库运行 `git push`，再到另一台电脑执行第 2 步。撤销状态的跨机同步从 0.1.2 开始支持，所以要先完成第 1 步再执行第 2 步。

各版本的变化见 GitHub Releases。

## 配置文件

位于数据目录下的 `config.json`（Windows 为 `%LOCALAPPDATA%\DocumentLearning\config.json`）。缺少的字段使用默认值，以 `_` 开头的键只是说明；无效值会报错并指出字段，`doctor` 显示生效配置。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `schedule.intervalMinutes` | 120 | 计划任务的检查间隔（分钟），修改后需重新 `install --schedule` |
| `schedule.runAtLogon` | true | 登录时也检查一次 |
| `consolidate.minSessions` | 3 | 待整理会话达到该数量才调用模型 |
| `consolidate.maxWaitHours` | 24 | 有待整理会话且距上次整理超过该小时数时也整理 |
| `consolidate.maxSessionsPerRun` | 20 | 单次整理最多处理的会话数 |
| `consolidate.model` | null | 整理模型；null 使用 Claude Code 当前默认模型 |
| `consolidate.effort` | `high` | 整理模型的推理强度：low、medium、high、xhigh、max |
| `consolidate.baseUrl` / `consolidate.apiKey` | null | 只给整理进程使用的 Anthropic 兼容网关（如本机 magpie `http://127.0.0.1:3425`）；null 跟随 `~/.claude/settings.json`。apiKey 明文保存，只适合本机网关的占位值 |
| `sources.claude` / `sources.codex` | true | 是否扫描 `~/.claude/projects` / `~/.codex/sessions` |
| `sources.excludePaths` | `*codeg-acp*`、`*workflow*`、`*\Temp\*` | 按完整路径或工作目录排除的通配模式 |
| `judge.provider` | `jev` | `jev` 先用 Jev 筛掉明显不是文档的会话并合并同义经验；`none` 全部交给整理模型 |
| `judge.documentThreshold` | 0.85 | Jev 自动判定所需的最低概率 |
| `judge.model` | `jev-latest` | Jev 模型；`jev-latest` 是稳定别名，`jev-preview` 为预览版 |
| `judge.baseUrl` / `judge.apiKey` | null | 兼容 System One 接口的网关（如本机 magpie `http://127.0.0.1:3425`，key `magpie`）；null 时直连 TypeSafe 并读环境变量。apiKey 明文保存，只适合本机网关的占位值 |
| `manual.maxChars` | 3000 | 单个手册的最大字数，超出按排序截断并注明省略条数 |
| `hooks.documentSkills` | docx、pptx、xlsx、pdf、officecli、doc-coauthoring 等 | 进入这些文档技能时，PostToolUse 提醒先读个人经验手册；个人技能目录下的技能自动识别，`document-learning` 自身不提醒 |
| `promotion.minDocsForType` / `minDocsForCore` | 2 / 3 | 晋升到文档类型层 / 核心层所需的最少文档数 |

Jev 的凭据默认只从环境变量读取（`TYPESAFE_API_KEY`、`OPENROUTER_API_KEY` 等，见该包文档），插件不输出；配置了 `judge.baseUrl` 时改走该网关，只对 Jev 调用设置 `TYPESAFE_BASE_URL` 和 `TYPESAFE_API_KEY`。没有凭据或调用失败时自动回退为整理模型独立判断，并在整理报告中注明。

## 实际工作过程

1. 会话中，hooks 只登记当前请求和问答工具的用户回答（供 `remember` 和晋升确认引用），并提示一行：需要立即记住时运行 `remember`，写文档前读手册目录的 `core.md` 及对应类型手册。进入文档技能（Claude 的 `Skill` 工具，或 Codex 读取 `<技能>/SKILL.md`）时，PostToolUse 会给出 `core.md` 和实际存在的类型手册的绝对路径；本会话读过手册后不再提醒。宿主自身的后台模型调用不建立会话。
2. 后台整理（`consolidate --if-due`）增量扫描宿主会话文件：按文件记录水位，未变化的文件不读取，被截断或重建时从头开始；排除路径和整理器自身的会话不进入收件箱。首次扫描只排队最近 7 天的会话。
3. 收件箱中待整理会话达到 `minSessions`，或非空且超过 `maxWaitHours` 时才调用模型；否则不产生任何模型请求。整理持有独占锁，已有整理在运行时直接退出。
4. Jev 先丢弃高置信的非文档会话；其余会话连同全部有效经验交给整理模型（`claude --bare -p`，无工具、无 hooks、无技能）。模型判断文档会话及其 task、kind，逐字引用用户原话提炼经验；与已有经验相同的改为合并证据，同一要求出现在多份文档时提出晋升提案。程序校验引文和范围，不通过时带错误重试最多 3 次；仍失败的这批会话推迟一天再试一次，再次失败就放弃（移出待整理队列，会话之后有新消息才重新排队），其他会话照常整理。新经验至少限定文档或类型，除非用户原话明确说所有文档；所有文档通用的经验通常经晋升产生。
5. 写入后编译手册，并在 `history/consolidations/<运行标识>/` 保存输入、模型结果和 `report.md`。只有被经验引用的用户消息会存入个人库。
6. 超过 3 天没有整理而仍有待处理会话时，SessionStart 会提示运行 `doctor` 检查计划任务。

```powershell
node bin/document-learning.mjs consolidate --now           # 立即整理，不看阈值
node bin/document-learning.mjs consolidate --all-existing  # 迁移：反复整理直到收件箱清空，并复核已有经验
```

### 经验层级与手册

- 核心层：没有条件（或只限工作区）的经验，进 `knowledge/core.md`。
- 文档类型层：限定 kind、技能、工序等但不限单份文档，进 `knowledge/<kind>.md`，按“通用 / 技能 X / 工序 Y”分节；不限 kind 的进 `knowledge/conditional.md`。
- 单份文档层：限定 task 的偏好、参数和事实，只进 `cases/<task>.md`，不出现在手册中。

手册按 required → default → suggestion 排序，同强度按覆盖的不同文档数、证据条数排序，格式为 `- [required·3份文档] 经验`。`knowledge/index.md` 列出全部层级和完整范围。绑定个人技能仓库时，手册写入该仓库，个人技能的管理区只保留一行指向对应类型的手册。

### 记住与晋升

用户明确要求记住时，模型运行 `remember`，引用本轮用户原话立即入库并更新手册：

```powershell
node bin/document-learning.mjs remember --session <hook给出的会话> --text "实验报告的结论段先写数据" --quote "用户原话" --kind experiment-report
```

晋升把多份文档中的同一条局部经验合并为更宽范围的一条：范围必须更宽，覆盖至少 `minDocsForType`（核心层为 `minDocsForCore`）份文档，强度不高于来源经验，且需要用户确认。确认只认提案提出之后用户在提问工具中的回答，不能引用来源经验自身的证据。新经验的证据是来源经验的并集，来源经验标为已替代（superseded），之后的重复反馈并入新经验，不会复活旧条目。

```powershell
node bin/document-learning.mjs proposals
node bin/document-learning.mjs promote --id <提案> --confirm-source <用户确认回答的source>
```

有待确认提案时 SessionStart 提示一行；模型用提问工具征得同意后再执行 `promote`。

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

误收的经验用 `retire` 撤销，可一次给多个 `--id`。撤销会记录原因并留下回退版本，同 id 的新反馈不会让它复活；手册随后重新生成。另一台电脑同步手册仓库的 `memory.json` 后，本机仍有效的同 id 经验会跟着撤销：

```powershell
node bin/document-learning.mjs retire --id '经验ID' --id '另一个经验ID' --reason '撤销原因'
```

扫描宿主会话时，Codex 子代理会话（自动审批 guardian、派生线程）和 `# AGENTS.md instructions for <目录>` 这类项目说明注入都不当作用户反馈。workflow 管理的项目照常学习：只有用户粘贴的 workflow 项目对齐协议这一条消息被去掉，同一会话里对文档本身的反馈仍会整理；整理模型也被要求不把 AI 工具或插件的协作协议当成文档经验。

个人技能目录自身处于 Git 仓库中时，发布前目标文件干净且索引可写，就只提交本次管理的文件，保留其他已暂存内容。默认使用个人快照和技能备份；不自动初始化 Git、执行仓库 hooks 或推送。

直接打开手册目录的 `knowledge/core.md`、`knowledge/<kind>.md` 和 `knowledge/index.md` 查看有效经验；`cases/` 保存单份文档经验、案例事实与已替代的历史记录；`skills/` 是实际可调用技能。`catalog` 命令可重新生成全部手册。

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

测试覆盖偏好冲突、跨对象复用、证据伪造、范围扩大、重复记录、会话增量扫描、到期判断与锁、批量整理的校验重试、经验晋升确认、手册编译、安装卸载、手动修改、技能停用及回退、混合提交、未来信息隔离和中断恢复。演示采用明确标注的虚构记录与固定后端，仅展示程序链路。

宿主当前依据：[Codex hooks](https://learn.chatgpt.com/docs/hooks?site_variant=chatgpt&translationFallback=zh-Hans)、[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)、[Claude Code hooks](https://code.claude.com/docs/en/hooks)、[Claude Code 插件清单](https://code.claude.com/docs/en/plugins-reference)。兼容性以本机诊断和新会话实测为准。
