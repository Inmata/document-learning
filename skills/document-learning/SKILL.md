---
name: document-learning
description: "用于制作、修订或审阅文档时的经验检索和持续整理，以及明确要求管理个人文档经验、回访会话历史时。普通编程、插件设计讨论和只提到文档名称不启动文档流程。"
---

# 文档持续学习

插件 hooks 先提供当前 session、turn、token；判断实际任务是否属于文档工作。未提供这些字段时，显式使用本技能可运行插件的 `doctor` 检查安装或按用户要求运行历史功能。

## 在当前任务中

向 `bin/document-learning.mjs signal` 的 stdin 提交 JSON。该命令只打印结构化信号，宿主的 PostToolUse hook 才执行个人库写入，因此计划模式无需修改工作区。不要在用户的最终回答中展示治理记录。

简单判断也可使用 hook 给出的 `--session --turn --token --document false`；文档任务改为 true 并加 `--task --kind`。无新经验的完成信号用相同标识及 `--phase complete`。

Windows PowerShell 5.1 的原生 stdin 管道可能损失中文；复杂信号用 `--base64`，参数值由 `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(单引号here-string中的JSON))` 生成。POSIX 可直接传 UTF-8 stdin。引文必须保留原文。

开始时提交：

```json
{"session":"hook给出的值","turn":"hook给出的值","token":"hook给出的值","phase":"begin","document":true,"context":{"task":"当前文档的稳定标识","kind":"instruction","purpose":"现场操作"}}
```

context 只填已知条件。可用 task、kind、purpose、audience、customer、template、format、process、object、workspace、skill；当前明确选择可放 requirements（经验 key 到 value 的映射）。同一文档的后续修订沿用 task，新文档另建。非文档任务 document=false 即完成本轮。

根据 hook 返回的适用经验和技能制定计划。当前需求优先；明确调用的技能仍需当前任务授权。一般偏好自动应用，只在无法推断且显著影响结果的取舍处补齐信息；不逐条请求记录或晋升批准。只读当前匹配的技能和必要资源。

实际使用了某个文档技能时，在 context.skill 中记录其标识，完成前判断本次反馈是否应更新该技能。局部偏好、事实可留在个人库；可复用的流程改进通过 skills 提案自动维护原技能的管理区。没有值得迭代的变化也可提交空回执。skillCandidates 是检索目录，核对范围后再采用；避免因措辞不同重复创建同一能力。

完成前提交相同 session/turn/token，phase=complete，以及 rules、observations、retire、skills；没有新经验可全部为空数组。证据引用 hook 给出的原始用户 source ID 和逐字引文，不能自行添加 sources。

## 整理经验

- rule 字段：key（稳定英文标识）、value（选择）、text、category、strength、scope、evidence。
- category：method、preference、fact、constraint、policy；strength：suggestion、default、required。
- evidence：`[{"source":"原始消息ID","quote":"用户原话"}]`。助手总结、用户沉默、自动提交和回放输出不构成新的用户证据。
- 偏好默认限定当前 task。用户明确表达更广范围时才使用 scopeBasis=explicit，并引用表达该范围的原话。可信程度提高不自动扩大范围或变为强制要求。可机械检查的要求也有适用条件。
- 一次反向选择先作为当前任务的条件或例外。未知原因如实保留；相交范围的相反选择交给当前需求决定，不以频次或最近出现自动覆盖。
- fact 保留原 task，参数由新任务资料决定。共享方法按用途条件存储，可供不同对象的操作说明使用。
- 无法形成可靠规则的反馈放 observations：text、scope、evidence。只有明确撤销原范围要求时才提交 retire（id、scope、evidence）。

## 自动维护技能

已有完整且独立可执行的制作流程时提交 skills；普通偏好、单页调整和一个名称不需要新技能。优先匹配已有能力；共享方法单独存储。单个清洗案例不证明通用 SOP 能力。

技能提案包含 name、title、description、body、scope、evidence、positive、negative、ruleIds。正反例是任务条件对象，包含相近的不适用场景；正文自包含，不引用另一技能文件，不固化案例参数。系统自动验证范围和证据、发布管理区。检测到手动修改时保留用户版本，并根据新版本重新整理；不询问是否允许学习。

## 历史功能

运行方式和后端配置见插件 README。历史补学可以综合当前资料；按时间回放仅使用当前消息前缀和初始技能快照。旧反馈评价历史纠正是否被吸取，不充当新生成文档的用户评价。记录消息缺失；缺少文档版本时不声称版式改善。
