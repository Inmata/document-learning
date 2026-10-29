# Document Learning

[简体中文](README.md) | English

A local plugin for Codex and Claude Code. The flow is "record automatically → consolidate in batches → compile handbooks". Hooks only register sessions. A background job periodically scans the host's session logs, decides which sessions are document tasks, extracts lessons backed by the user's own words, merges duplicate evidence, and compiles everything into handbooks ordered by level. When writing a document, the model reads the handbook; ordinary chat and coding need no learning commands. The public project contains only the program and fictional examples. Each user's sessions, preferences, cases and skills stay on their own computer.

Lessons are extracted from the user's own words and kept in that language; the handbooks and command output are in Simplified Chinese.

## Installation

### First-time checklist

You need to run the steps below yourself once. Steps that involve scheduled tasks or host permissions are usually blocked when the model tries them in the host's auto mode.

| Step | Command or action | Required? |
| --- | --- | --- |
| 1. Install dependencies | Run `npm install` in the plugin directory | Required |
| 2. Configure host hooks and the skill entry | `node bin/document-learning.mjs install`, then check with `doctor` | Required |
| 3. Create the background consolidation task | On Windows, run `node bin/document-learning.mjs install --schedule` in an **administrator** PowerShell | Required (otherwise checks only run at session start/end) |
| 4. Trust hooks in Codex | Open a new Codex session, review and trust this plugin's hooks as prompted | Required with Codex |
| 5. Allow questions in Codex default mode | Add `default_mode_request_user_input = true` under `[features]` in `~/.codex/config.toml` | Required in Codex default mode (promotion confirmation uses questions) |
| 6. Allow in Claude auto mode | `node bin/document-learning.mjs install --agent claude --allow-claude-signal` | Recommended with Claude auto mode |
| 7. Consolidation model and gateway | Edit `config.json` in the data directory: `consolidate.model`, `effort`, `baseUrl`, `apiKey` | Optional; defaults follow Claude Code settings |
| 8. Jev judge credentials | Set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, or point `judge.baseUrl` at a local gateway | Optional; without it the consolidation model judges alone |
| 9. Consolidate past sessions | Back up `state.json` in the data directory, then run `consolidate --all-existing` | Optional; the first scan only queues the last 7 days |

When done, open a new session; `doctor` should show `ready`. When promotion proposals are waiting, the model asks for your consent with the question tool after the session starts; just answer.

### Details

Requires Node.js 24 or later. The only runtime dependency is a pinned `@jkudish/jev-agent-tools` (the Jev judge layer, which can be turned off in the config). Run `npm install` before first use.

In the project directory:

```powershell
node bin/document-learning.mjs install
node bin/document-learning.mjs doctor
```

By default this configures user-level hooks for both Codex and Claude Code (SessionStart, UserPromptSubmit, PostToolUse, SessionEnd), installs the skill entry, and writes a commented default config file if none exists. Existing hooks and settings are kept; reinstalling does not stack duplicate entries. Open a new session afterwards to verify.

The background consolidation scheduled task is created only after you confirm. `install` lists the `schtasks` commands it would run; after confirming, run:

```powershell
node bin/document-learning.mjs install --schedule
```

On Windows this creates two scheduled tasks, one every `schedule.intervalMinutes` minutes and one at logon (`schedule.runAtLogon`). Both only run the `consolidate --if-due` due check. `uninstall` deletes them once all hosts are removed. The tasks start node through `conhost.exe --headless`, so no terminal window pops up and foreground focus (a full-screen game, for example) is not taken. Tasks created by early versions show a window; run `install --schedule` once more to update them. Creating the logon task needs administrator rights. A non-administrator terminal reports "Access is denied"; the interval task may already be updated while the logon task still has the old command, so rerun in an administrator PowerShell. Other systems get cron or launchd config to add yourself. Rerun `install --schedule` after changing `schedule`. Hooks also trigger a due check in the background at the start and end of every session.

Claude Code's auto mode reviews commands and question-tool calls issued by the model, so a user's "remember this", promotion questions and confirmations can all be blocked. To avoid that, grant permission explicitly:

```powershell
node bin/document-learning.mjs install --agent claude --allow-claude-signal
```

This adds `Bash(node "<absolute plugin path>/bin/document-learning.mjs" remember *)`, `proposals` and `promote *` for the same path, and the question tools `AskUserQuestion` and `mcp__codeg-mcp__ask_user_question`. No other subcommands are allowed. promote only accepts the user's answer in a question tool as confirmation, so the allow rules cannot bypass user consent. Reinstalling keeps the grants; uninstalling removes only the rules the plugin added and keeps your existing allow/ask/deny. Explicit deny/ask rules and managed policies are still enforced by the host. See [Claude Code permission rules](https://code.claude.com/docs/en/permissions).

Codex's native question tool `request_user_input` (including `_async`) is recognized too, and answers are matched to questions by question id. In default mode, enable `default_mode_request_user_input = true` under `[features]` in `~/.codex/config.toml`.

To use an existing skill repository as a read-only learning source:

```powershell
node bin/document-learning.mjs install --source-repository 'D:\your-skills-repo'
```

A source repository (`--source-repository`) is read-only. By default, new skills are written to `skills/` in the personal library, and personal entries are created for the installed Codex and Claude; a hand-made entry with the same name is kept and reported as a conflict.

To manage document skills in your own private Git repository and sync long-term document lessons across devices, choose one of these:

1. **Initialize a new repository for document skills and long-term lessons** (optionally importing document skills from an old repository; coding skills and `notes/` are excluded automatically):

```powershell
node bin/document-learning.mjs init-skill-repo --output 'D:\git-repo\document-skills' --import-from 'D:\git-repo\skills' --bind
```

2. **Bind an existing personal document skill repository** (or bind after cloning it on another computer):

```powershell
node bin/document-learning.mjs bind --skill-directory 'D:\git-repo\document-skills'
node bin/document-learning.mjs sync-skills
```

After binding `--skill-directory`, document skills (including the generated `README.md` inside each skill) and long-term document lessons (`knowledge/index.md`, `cases/index.md`, `knowledge/memory.json`) are kept in that Git repository for cross-device sync. Per-machine session state (`sessions`), transaction snapshots (`versions/`) and large raw logs (`history/`) stay local in `%LOCALAPPDATA%\DocumentLearning`, so ordinary non-document chat does not dirty the Git working tree.

To link the skill repository to a remote and push (commit, create or reuse the remote, and push the current branch in one step):

```powershell
node bin/document-learning.mjs publish-repo
```

`publish-repo` uses the bound `--skill-directory` by default. Pass `--remote <url>` for an existing remote, or `--name repo-name [--owner account] [--visibility private]` to have GitHub CLI create a private repository. Uncommitted changes are committed first; turn that off with `--no-commit`.

A binding belongs to the current user and is shared by all workspaces. Without a binding, a separate personal library is created automatically. If a binding exists but its path is missing or unreadable, an error is reported and pending state is kept; a second library is never created silently.

Default data location: `%LOCALAPPDATA%\DocumentLearning` on Windows, `$XDG_DATA_HOME/document-learning` or `~/.local/share/document-learning` elsewhere. Use `DOCUMENT_LEARNING_HOME` or `--home` to choose another location. Upgrading or uninstalling the plugin never deletes the personal library.

```powershell
node bin/document-learning.mjs bind --library 'D:\personal\document-lessons' --source-repository 'D:\your-skills-repo'
node bin/document-learning.mjs uninstall
```

`bind` switches the binding explicitly and does not migrate or overwrite the old library. To move to another computer, copy the personal data and bind again.

The project can also be installed through the host's native plugin mechanism: the root `plugin.json` uses the Agent Plugins/OpenAI format, with compatible manifests for Codex and Claude Code. Choose either a native plugin install or the user-level hook install above, not both. Codex handles hook trust itself and the installer never edits trust records. Codex records trust by the position and content of each group in `hooks.json`; on reinstall this plugin's group keeps its position, so no new trust is needed while the plugin path and hook settings stay the same. After the path or settings change, review again. A native plugin install still needs to be enabled in the host, with hook trust confirmed. Source hooks must be executable on the local machine; distribution through GitHub does not mean listing in an official public plugin directory.

### Upgrading

Upgrading never deletes the personal library or overwrites the config file. Run it once on each computer, after closing running Codex and Claude Code sessions. The commands below assume the plugin is at `D:\git-repo\document-learning` and the personal skill repository at `D:\git-repo\document-skills`; replace the paths if yours differ.

1. Update code and dependencies, then reinstall hooks (hook commands and groups can change between versions and are only updated by reinstalling):

```powershell
cd D:\git-repo\document-learning
git pull
npm install
node bin/document-learning.mjs install
```

If you used `--schedule` or `--allow-claude-signal` before, run once more with the same options in an **administrator** PowerShell to update the scheduled tasks and allow rules:

```powershell
cd D:\git-repo\document-learning
node bin/document-learning.mjs install --schedule --allow-claude-signal
```

2. With a bound personal skill repository, first pull the handbooks and lessons pushed from other computers, then bind again. Binding merges lessons from `knowledge/memory.json` that this machine lacks, as well as lessons retired on other computers:

```powershell
cd D:\git-repo\document-skills
git pull
cd D:\git-repo\document-learning
node bin/document-learning.mjs bind --skill-directory D:\git-repo\document-skills
```

3. Check status; `doctor` should show `ready`:

```powershell
node bin/document-learning.mjs doctor
```

4. Open a new Codex session. If it reports changed hooks, review and trust them again.

The handbook repository is committed locally but never pushed automatically. To get this machine's new lessons or retirements onto another computer, run `git push` in this machine's personal skill repository first, then do step 2 on the other computer. Cross-machine sync of retirements is supported from 0.1.2, so finish step 1 before step 2.

Changes in each version are listed in GitHub Releases.

## Configuration file

`config.json` in the data directory (`%LOCALAPPDATA%\DocumentLearning\config.json` on Windows). Missing fields use defaults, and keys starting with `_` are comments only. Invalid values raise an error naming the field; `doctor` shows the effective config.

| Field | Default | Meaning |
| --- | --- | --- |
| `schedule.intervalMinutes` | 120 | Check interval of the scheduled task (minutes); rerun `install --schedule` after changing |
| `schedule.runAtLogon` | true | Also check once at logon |
| `consolidate.minSessions` | 3 | The model is called only once this many sessions are waiting |
| `consolidate.maxWaitHours` | 24 | Also consolidate when sessions are waiting and this many hours have passed since the last run |
| `consolidate.maxSessionsPerRun` | 20 | Maximum sessions handled in one run |
| `consolidate.model` | null | Consolidation model; null uses Claude Code's current default |
| `consolidate.effort` | `high` | Reasoning effort: low, medium, high, xhigh, max |
| `consolidate.baseUrl` / `consolidate.apiKey` | null | Anthropic-compatible gateway used only by the consolidation process (for example a local magpie at `http://127.0.0.1:3425`); null follows `~/.claude/settings.json`. apiKey is stored in plain text, suitable only for a local gateway placeholder |
| `sources.claude` / `sources.codex` | true | Whether to scan `~/.claude/projects` / `~/.codex/sessions` |
| `sources.excludePaths` | `*codeg-acp*`, `*workflow*`, `*\Temp\*` | Glob patterns excluding sessions by full path or working directory |
| `judge.provider` | `jev` | `jev` uses Jev to drop sessions that are clearly not about documents and to merge synonymous lessons; `none` leaves everything to the consolidation model |
| `judge.documentThreshold` | 0.85 | Minimum probability for Jev to decide on its own |
| `judge.model` | `jev-latest` | Jev model; `jev-latest` is a stable alias, `jev-preview` the preview |
| `judge.baseUrl` / `judge.apiKey` | null | Gateway compatible with the System One API (for example a local magpie at `http://127.0.0.1:3425`, key `magpie`); null connects to TypeSafe directly using environment variables. apiKey is stored in plain text, suitable only for a local gateway placeholder |
| `manual.maxChars` | 3000 | Maximum characters per handbook; overflow is cut in sort order with the number of omitted items noted |
| `hooks.documentSkills` | docx, pptx, xlsx, pdf, officecli, doc-coauthoring and others | When one of these document skills is entered, PostToolUse reminds the model to read the personal handbooks first; skills under the personal skill directory are recognized automatically, and `document-learning` itself never triggers the reminder |
| `promotion.minDocsForType` / `minDocsForCore` | 2 / 3 | Minimum number of documents to promote to the document-type level / core level |

Jev credentials are read only from environment variables by default (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` and others, see that package's docs), and the plugin never prints them. When `judge.baseUrl` is set, calls go through that gateway, and `TYPESAFE_BASE_URL` and `TYPESAFE_API_KEY` are set only for Jev calls. Without credentials, or when a call fails, the consolidation model judges alone and the consolidation report says so.

## How it works

1. During a session, hooks only register the current request and the user's answers in question tools (cited by `remember` and promotion confirmation), and show one line: run `remember` to record something immediately, and read `core.md` plus the matching type handbook before writing a document. When a document skill is entered (Claude's `Skill` tool, or Codex reading `<skill>/SKILL.md`), PostToolUse gives the absolute paths of `core.md` and the type handbooks that actually exist; once the handbook has been read in the session, no further reminders are shown. The host's own background model calls do not create sessions.
2. Background consolidation (`consolidate --if-due`) scans host session files incrementally. A watermark is kept per file; unchanged files are not read, and truncated or recreated files are read from the start. Excluded paths and the consolidator's own sessions never enter the inbox. The first scan only queues the last 7 days of sessions.
3. The model is called only when the inbox holds `minSessions` sessions, or is non-empty and older than `maxWaitHours`; otherwise no model request is made. Consolidation holds an exclusive lock and exits at once if another run is in progress.
4. Jev first drops sessions that are confidently not about documents. The remaining sessions, together with all valid lessons, go to the consolidation model (`claude --bare -p`, no tools, no hooks, no skills). The model identifies document sessions with their task and kind and extracts lessons by quoting the user's words verbatim. A lesson matching an existing one becomes merged evidence; the same requirement across several documents becomes a promotion proposal. The program validates quotes and scopes and retries with the errors up to 3 times. A batch that still fails is postponed for a day and tried once more; if it fails again it is dropped (removed from the queue, and requeued only when the session gets new messages), while other sessions are consolidated as usual. New lessons are scoped at least to a document or a kind, unless the user's words explicitly say all documents; lessons for all documents usually come from promotion.
5. After writing, handbooks are compiled, and the input, model result and `report.md` are saved under `history/consolidations/<run id>/`. Only user messages cited by a lesson are stored in the personal library.
6. When nothing has been consolidated for over 3 days and sessions are still waiting, SessionStart suggests running `doctor` to check the scheduled task.

```powershell
node bin/document-learning.mjs consolidate --now           # consolidate now, ignoring thresholds
node bin/document-learning.mjs consolidate --all-existing  # migration: repeat until the inbox is empty, and re-review existing lessons
```

### Lesson levels and handbooks

- Core level: lessons without conditions (or limited only to a workspace), in `knowledge/core.md`.
- Document-type level: lessons limited by kind, skill, procedure and so on but not to a single document, in `knowledge/<kind>.md`, split into "general / skill X / procedure Y" sections; lessons not limited by kind go to `knowledge/conditional.md`.
- Single-document level: preferences, parameters and facts limited to a task, only in `cases/<task>.md`, never in handbooks.

Handbooks are ordered required → default → suggestion; within the same strength, by number of distinct documents covered, then by number of evidence items. The format is `- [required·3份文档] lesson` (`份文档` means "documents"). `knowledge/index.md` lists every level with full scope. With a bound personal skill repository, handbooks are written into that repository, and each personal skill's managed block keeps only one line pointing to the handbook for its kind.

### Remembering and promotion

When the user explicitly asks to remember something, the model runs `remember`, quoting the user's words from this turn; the lesson is stored immediately and the handbook updated:

```powershell
node bin/document-learning.mjs remember --session <session from the hook> --text "In experiment reports, put the data first in the conclusion" --quote "the user's words" --kind experiment-report
```

Promotion merges the same local lesson from several documents into one with wider scope. The scope must be wider, covering at least `minDocsForType` documents (`minDocsForCore` for the core level), the strength cannot exceed the source lessons, and the user must confirm. Confirmation only counts the user's answer in a question tool after the proposal was made; the source lessons' own evidence cannot be cited. The new lesson's evidence is the union of the sources, the sources are marked superseded, and later repeated feedback is merged into the new lesson without reviving old entries.

```powershell
node bin/document-learning.mjs proposals
node bin/document-learning.mjs promote --id <proposal> --confirm-source <source of the user's confirming answer>
```

When proposals are waiting, SessionStart shows one line; the model asks for consent with a question tool before running `promote`.

## How lessons keep their boundaries

Each lesson records `category`, `scope`, `strength`, sources and exceptions separately. Trust, scope and strength change independently.

- Liking a layout a hundred times does not override an explicit opposite request in another report. The current request decides the current output; old choices keep their original scope.
- Opposite feedback in the same scope that cannot be explained is recorded as a conflict. Counts, silence or the most recent occurrence are never used to interpret the user's taste for them.
- When the user clearly says "from now on, all documents should do this", a personal default can be saved; an exception in one document does not revoke it.
- Mechanically checkable requirements still need evidence. For example, the presence of a caption can be checked, but not every image must have one.
- Methods such as cleaning order or matching images to physical objects can be reused for different cleaning targets. Case facts such as cleaning agent, time and object stay with the original task; new process parameters come from new material.
- A method still limited to an old task becomes a small number of `transfer` analogy candidates only when its usage conditions clearly match. A method with only a task and no transferable boundary is not recommended for all documents. These never become mandatory for a new task, and preferences and facts never take this transfer path.
- When the same conditions are supported by evidence from different tasks, maturity can rise while scope and strength stay the same. Shared requirements and opposite local choices are linked through exceptions.
- When the user explicitly changes a rule to a suggestion or a requirement, strength can be revised on its own with sources kept. Repetition never triggers such a change, and exceptions in other documents cannot rewrite the old scope.

A skill is created only when an independent, executable procedure forms. Positive examples and close counterexamples test the matching boundary; they are program test inputs, not new user approval. New skills match automatically by default. The invocation policy of existing skills is kept; in particular, an explicitly invoked report skill is never switched to implicit invocation.

The program updates only its own managed blocks and keeps the rest of the text. When a file was edited by hand, it first returns the new fingerprint; the model must read the new version and reconsolidate on that fingerprint before continuing. A skill that was explicitly disabled stops matching automatically, with files and sources kept. Knowledge has transaction snapshots; skill text and metadata have separate backups.

To see the full sources of a lesson:

```powershell
node bin/document-learning.mjs show-rule --name lesson-id
```

Roll back the library with the `rollback` id of an event in `state.json`; roll back a skill with the SHA-256 fingerprint in the backup file name:

```powershell
node bin/document-learning.mjs rollback --version 'version-id'
node bin/document-learning.mjs skill-rollback --name 'skill-id' --version 'file-fingerprint'
```

Library rollback and skill file rollback run separately, so one operation never overwrites unrelated hand edits. The program never pushes to a remote.

Retire a wrongly collected lesson with `retire`; several `--id` can be given at once. Retirement records the reason and leaves a rollback version, new feedback with the same id cannot revive it, and handbooks are regenerated. After another computer syncs `memory.json` from the handbook repository, a still-valid lesson with the same id on that machine is retired too:

```powershell
node bin/document-learning.mjs retire --id 'lesson-id' --id 'another-lesson-id' --reason 'reason'
```

When scanning host sessions, Codex subagent sessions (the auto-approval guardian, spawned threads) and project instruction injections such as `# AGENTS.md instructions for <directory>` are not treated as user feedback. Projects managed by [workflow](https://github.com/Inmata/workflow) are still learned from: only the user's pasted workflow project alignment protocol message is removed, and feedback about the document itself in the same session is still consolidated. The consolidation model is also told not to treat collaboration protocols of AI tools or plugins as document lessons.

When the personal skill directory is itself in a Git repository, and the target files are clean and the index is writable before publishing, only the files managed this time are committed, and other staged content is kept. Personal snapshots and skill backups are used by default; the program never initializes Git, runs repository hooks or pushes.

Open `knowledge/core.md`, `knowledge/<kind>.md` and `knowledge/index.md` in the handbook directory to see valid lessons. `cases/` holds single-document lessons, case facts and superseded history; `skills/` holds the skills that can actually be invoked. The `catalog` command regenerates all handbooks.

Current backfill is separate from time replay. The current session can combine full user logs, current skills and references, invocation config and later differences, write JSON in the learning schema, and run:

```powershell
node bin/document-learning.mjs backfill --input 'full-dataset.json' --decision 'learning-json-from-this-session.json' --job 'my-backfill'
node bin/document-learning.mjs sync-skills
```

The program validates every original quote and skill boundary, then publishes and generates a readable report. `--replace-history old-job-id` archives records from a given old replay that were not revised by hand, keeping the original evidence and rollback snapshots; archiving does not pretend to be a user retirement. Current backfill does not claim to be free of future information, and is not a judgment of layout quality.

Backfill uses the current session by default and does not send private material elsewhere. `--provider` is passed only when another model backend is explicitly chosen; confirm that backend's data destination and authorization first. JSONL import excludes environment, injected skill text and routing metadata, and keeps the original user, time and tool sources. DOCX template differences are parsed from the actual XML, including headers with non-standard names; structural checks cannot replace visual checks.

## History import and replay

Supports JSON exported from the Codeg session API, Codex/Claude Code JSONL, and JSON sessions with `messages`. Multiple `--input` files are processed in the given session order, with messages kept in their original order. When only session-level times exist, no exact relation to a particular commit is inferred.

```powershell
node bin/document-learning.mjs history-import --input 'session-1.json' --input 'session-2.jsonl' --repository 'D:\your-skills-repo' --output 'D:\personal\history-dataset.json'
node bin/document-learning.mjs replay --input 'D:\personal\history-dataset.json' --merge
```

By default, after the replay finishes and passes the boundary checks provided, the personal library and the skill directory in it are backfilled automatically. The source repository is read-only. Existing current choices are kept, and opposite historical records become observations with sources. Tasks that fail the checks are not backfilled automatically. Use `--replay-only` to run only the experiment, then backfill later with `reconcile --input replay-job-directory`.

Git import finds document skills from their descriptions, splits mixed commits by file, and saves an exclusion list of unrelated files; shared files need related changes. A candidate change is not a correct lesson, and a commit is not treated as user approval. Binary resources only record availability; layout effects are not guessed from commit titles.

In time replay, the learner's input is only the initial skill entry, the prefix of the current session and earlier learning results. Detailed entries and history windows carry explicit truncation markers. The final commit, the current formal library and hidden evaluation answers never enter the learning request. The default history backend uses Claude Code's bare mode with tools, other skills, hooks, memory and document auto-discovery disabled; the workspace's full Git history is never handed to it.

The default backend uses the model and API route from the local Claude Code config. History analysis sends the necessary fragments to that configured model; there is no extra cloud memory service. In environments that only log in with OAuth, where bare mode cannot authenticate, you can configure your own JSON command backend:

```json
{"type":"command","command":"absolute path to your executable","args":["argument"],"timeout":120000}
```

Save the config in a personal directory and use it with `replay --provider config-file`. The backend reads JSON with `instructions/schema/input` from stdin and returns only schema-conforming JSON on stdout. It should be a trusted adapter without tool access. Normal real-time learning does not depend on this history backend.

Each step saves an input digest, sources, automatic correction records, changes and checkpoints. A job pins the plugin code and protocol fingerprints, the initial snapshot, inputs and model config; when any of these change, old checkpoints are refused and a new job id should be used. Rerunning under the same conditions resumes from the point of interruption. Invalid structure or evidence is corrected automatically once; if it still fails, the failure position is saved.

Reports list frozen-initial, automatic evolution and actual maintenance references separately. Actual maintenance history is only a reference by default; without hidden expectations, no accuracy is invented. Without historical documents or images, no layout improvement is claimed. Replay output is never learned again as new user evidence.

`--expectations hidden-expectations-JSON` can supply evaluation data, mapping `document`, `requiredRules` and `forbiddenRules` by original message ID; rule lists use keys. Hidden expectations are used only for evaluation after output and never enter the learning request. Invalid proposals of the frozen baseline are kept as evaluation results; they do not block valid changes on the evolution branch and are not fixed automatically to improve the baseline's score.

## Development and verification

```powershell
npm test
npm run check
npm run demo
claude plugin validate .
```

Tests cover preference conflicts, reuse across objects, forged evidence, scope widening, duplicate records, incremental session scanning, due checks and locks, validation retries in batch consolidation, promotion confirmation, handbook compilation, install and uninstall, hand edits, skill disabling and rollback, mixed commits, isolation of future information, and resuming after interruption. The demo uses clearly labeled fictional records and a fixed backend, and only shows the program flow.

Host references: [Codex hooks](https://learn.chatgpt.com/docs/hooks?site_variant=chatgpt), [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code plugin manifest](https://code.claude.com/docs/en/plugins-reference). Compatibility is decided by local diagnostics and tests in new sessions.
