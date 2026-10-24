# Changelog

## [1.8.1] — tmux 端到端压测收尾 (2026-10-24)

### Fixed
- 状态行多 run 聚合从「N 后台」改为「N 运行中」——已结算的 ✓/✗/⊘ 行不再被计成「后台」,措辞与实际一致。
- 结算历史快照补终态 `durationMs`(`finishAdopted` 落账):对话框列表里已结算行不再显示「—」时长。

## [1.8.0] — crew 式两层对话框导航 (2026-10-24)

### Added

- **`/workflow` 交互对话框**:无参调用在交互 TUI 下打开 crew 式覆盖层(`ctx.ui.custom`),两层导航——列表层按 `⏵ 运行中(registry)+ ✓/✗ 已结算(结算历史倒序)` 列行,`↑↓`/`j/k` 选择,`Enter` 进详情,`Esc`/`q` 关闭;详情层复用 `renderWorkflowView`(结构树+挂死预警+日志流),运行中每 1s 重渲染,`Esc` 只回列表不退出;已结算行显示终态快照并提示 `/workflow export wf-N`。空列表显示「没有后台工作流」仍可关闭。headless(print/RPC)保持原有 notify 列表;`view`/`cancel`/`export` 子命令全部保留。
- `src/workflow-dialog.ts`:纯函数 `handleKey(state,key)`/`renderDialogLines(items,selected)` 可单测;`openWorkflowDialog(ctx, {registry, history, exportRun})` 为胶水入口(exportRun 由 `/workflow export` 子命令共用,详情层不绑导出快捷键)。

## [1.7.1] — HTML 运行报告导出 (2026-10-24)

### Added

- **`/workflow export wf-N`**: 将已结束的后台工作流导出为自包含静态 HTML 运行报告(`os.tmpdir()/keel-flow-wf-N.html`)——时间轴甘特(按 phase 泳道、状态色条、错误可展开、子代理尾巴)+ 汇总卡 + 执行结构树 + 运行结果 JSON。零外部资源(无 CDN/字体/脚本),断网可开;数据源为结算历史(最近 8 个 run 的终态快照,`background: true` 与 tap-to-background 均落入)。
- `exportRunHtml(snapshot, {id?, now?})` 纯函数从 `src/export-html.ts` 导出;`WorkflowAgentSnapshot.endedAt`/`transcriptTail` 喂给甘特与尾巴渲染。

## [1.7.0] — 围观视图、执行结构树、挂死预警 (2026-10-24)

### Added

- **执行结构树**: `parallel()`/`pipeline()` 压入执行上下文栈,agent 记录 `parentId`;`renderStructureTree` 渲染 `▾/└─/├─` 树——parallel 节点 `▶ 名称 · 4 thunk(运行 2 · 排队 2)`(limiter 队列深度),pipeline 节点 `▶ 管线 名称 · 1/3 完成` + item 行 `● item 1 阶段 1/2`;无结构节点时回退 phase 分组。结构随节点创建与 agent 生命周期(onAgentStart/End)经 `onStructure` 增量上报。
- **围观视图**: `renderWorkflowView(snapshot, {now?,width?,maxLogs?})` 纯函数——头行(状态·进度·elapsed·疑似挂死)+ 左侧执行结构/回退树 + 右侧最近日志流(时间戳)+ 挂死预警(running agent 距 `lastEventAt` >30s 行尾 `⚠ 静默 Ns`,头行 `· 疑似挂死`,恢复自动消除);`/workflow view <id>` 渲染到 aboveEditor 大 widget,结束后自动清除。
- **`now` 选项**: `WorkflowDisplayOptions.now` 驱动 elapsed 与静默计算(纯函数可测);`renderWorkflowLines` 的 agent 行(含未分组回退)也接挂死后缀。
- `WorkflowAgentSnapshot.lastEventAt`、`StructureNode`、`PipelineItemState`、`WorkflowSnapshot.nodes/pipelineItems/queuedCount`;agent 事件经 `onAgentEvent` 外露(环形缓冲由扩展层持有)。

## [1.6.0] — 中文标签全套: transcript blocks, status line, background widget, notify, /workflow (2026-10-24)

### Changed

- 全套中文标签。Transcript blocks: running header `工作流运行中` / completed `工作流已完成`; detached runs freeze their block under `工作流已转后台 (wf-N)` and background: true starts under `工作流已后台启动 (wf-N)` (new `header` option in `WorkflowDisplayOptions`, driven by `details.detached`); detach/background body copy is Chinese. The `◆ 工作流:` tree, phase rows (`N 运行中`/`N 错误`/`N 跳过`), `… N 更早的子代理` and `日志:` lines are Chinese; agent icons unchanged.
- Status line rewritten as the exported pure `renderStatusLine(snapshot, completed, { backgroundId?, peers? })`: foreground `workflow <名> ● N 运行中, D/T 完成 · Ns`, background `workflow <名> ⏵ wf-N · D/T 完成 · Ns`, terminal `workflow ✓ <名> D/T · Ns` / `workflow ✗ <名> D/T · N 错误`; with >1 background runs it collapses into `workflow: N 后台 · wf-2 ⏵ · wf-1 ✓` (fold `…+1`; peers combine the live registry with recently settled runs).
- Background runs now attach a live widget (belowEditor) at detach / background start and clear it after the terminal render on settle; foreground runs keep `showWidget: false`.
- Settlement notify is Chinese with 80-char error truncation: `wf-2 (名) ✓ 完成 · 4 个子代理 · 76.3s` / `✗ 失败: …` / `⊘ 已取消 · 12.0s 后`; `settlementText` likewise.
- `/workflow` and the `workflow_cancel` tool answer in Chinese; the list line shows live progress: `wf-2  tui_showcase  ⏵ 运行中  1/4 · 47s` (new optional `BackgroundWorkflow.progress` getter wired from the tool snapshot).

## [1.5.0] — TUI wiring: running status line, settlement finish + notify, /workflow command (2026-10-24)

### Added

- Running status line for both sync and background runs: the tool now passes the real `ctx` to `createToolUpdateWorkflowDisplay` (`showStatus: true, showWidget: false` — footer status only, no widget), the sync progress callbacks were extracted into a shared `makeCallbacks` helper and are now also attached to `background: true` runs (previously zero progress), and snapshots carry `startedAt` so `renderWorkflowLines` appends `· Ns` to the header while running.
- Settlement finish: `adoptRun` takes an `onDone` callback (runs after `cleanup`, before `registry.settle`); both adoption sites recompute the snapshot and call `display.complete` so detached/background runs visibly finish instead of leaving a stale status line.
- Settlement TUI notify: extensions pass a `uiRef`; `execute` stores `ctx.ui` in it and `onSettle` calls `notify(settlementNotifyLine(settlement))` — one-liners like `wf-1 (name) ✓ completed · 3 agents · 1.2s` / `✗ failed: …` / `⊘ cancelled after …s`, fixing invisible background settlements.
- `/workflow` slash command: no args lists running background workflows (`wf-N (name) · Ns elapsed`), `/workflow cancel wf-N` requests cancel, anything else prints usage.

## [1.4.0] — tap-to-background: user input detaches in-flight sync workflows (2026-10-24)

### Added


- Tap-to-background for synchronous workflow runs, mirroring keel-bash v0.6.0 (`abacc30`): a message queued during a sync run (`steer`) detaches every in-flight sync run — the run is adopted into `BackgroundRegistry` (shared `adoptRun` helper, same settlement path as `background: true`) and the tool call resolves immediately with the detached text, so the turn frees up to answer the user. Settlement is still reported automatically via `onSettle`.

- `extensions/workflow.ts` eavesdrops via `pi.on("input")` (returns `{ action: "continue" }` — queueing pipeline untouched; `followUp` waits do not detach) and sends a hidden wake message per detached run. The message warns that this is NOT a bash task — `bash_output`/`bash_tasks`/`bash_kill` will not find `wf-N`; cancellation is `workflow_cancel`.

- New surface: `createWorkflowTool` now returns the tool plus `syncRuns: Set<SyncRunHandle>` (in-flight sync runs only); `handle.detach()` is idempotent and a no-op with nothing in flight. Sync behavior is otherwise unchanged.

## [1.3.1] — background text hardening (2026-10-24)

### Fixed

- Background start message now states explicitly that the workflow is NOT a bash task — `bash_output`/`bash_tasks`/`bash_kill` will not find the id; cancellation is `workflow_cancel`. A live probe showed the model reaching for `bash_output` with the wf id before self-correcting.

## [1.3.0] — background workflows (2026-10-24)

### Added

- `background: true` on the `workflow` tool: the run detaches, the tool returns immediately with an id (`wf-N`), and settlement (completed/failed/cancelled) arrives as a hidden custom message (`keel-flow:update`, `display: false`) that starts the next turn — same injection pattern as keel-crew. Sync remains the default: gated fan-out-then-synthesize runs should stay synchronous.
- `workflow_cancel` tool: `workflow_cancel {}` lists running background workflows; `workflow_cancel {id}` requests cooperative cancel (abort propagates through every in-flight agent session).
- `BackgroundRegistry` (session-scoped, ids increment for the session's lifetime; settled entries removed) + `settlementText` formatting with a 4000-char result cap.
- `extensions/workflow.ts` wires the registry, the cancel tool and `pi.sendMessage` delivery.

### Notes

- Rationale for keeping sync default: the dominant workflow use case is fan-out→synthesize where the caller needs the result to continue; backgrounding would add two turn round-trips per run. Background is for long runs where the main agent has other work to do meanwhile.
- Per-agent supervision (v1.2.0) applies unchanged inside background runs; worst-case cost stays bounded.

## [1.2.1] — budget race fix (2026-10-23)

### Fixed

- Budget enforcement raced fast agents: `session.prompt` resolved before the 500ms poll tick ever saw the final assistant usage, so a single-call agent exceeding `budgetTokens` completed with a result instead of being rejected. `run()` now reconciles `sumUsage(session.messages)` synchronously after the prompt and throws on over-budget regardless of tick timing.
- `startBudgetWatch` poll callback swallows `read()` throws instead of letting them kill the interval tick.

## [1.2.0] — per-agent supervision (2026-10-23)

### Added

- `agent(prompt, opts)` supervision, aligned with keel-crew semantics:
  - `opts.timeoutMs` — report-only timer; `0`/omitted → 60s default. Fires a log event (`agent <label> timeout event after Ns: still running (report-only; not stopped)`); never stops the agent. Range 0–3,600,000.
  - `opts.budgetTokens` — input-token budget; `0`/omitted → 2,000,000 default. Over → the agent session is aborted and the call returns `null` (logged with spent vs budget). No "no cap" state exists.
- Enforcement lives in `WorkflowAgent.run` (usage polling → `session.abort()`); resolution/validation in the workflow layer (`resolveAgentTimeout`/`resolveAgentBudget`). Exposed helpers: `sumUsage`, `startBudgetWatch`.
- `script` parameter description documents the supervision semantics.

## [1.1.0] — keel fork (2026-10-23)

Local fork of Michaelliv/pi-dynamic-workflows v1.0.1 (SeniorHan/keel-flow). Not published upstream.

### Changed

- Model-facing text rewritten per the keel naming/description constitution:
  - meta-header rule, agent()-once, parallel-thunk, globals list, and opts.schema schema rule now stated **once each**, in the `script` parameter description (the canonical, argument-adjacent spot).
  - `promptGuidelines` reduced 14 → 8; the repeated "For workflow," prefix removed; telegraph style (Chinese), with new guidance separating deterministic gated execution plans (workflow) from exploratory steerable delegation (interactive subagent tools).
  - Tool description and promptSnippet reduced to one line each, cross-referencing the `script` parameter description.

### Kept

- Runtime behavior, tool name `workflow`, script semantics, display, and the public API untouched (24/24 tests).
