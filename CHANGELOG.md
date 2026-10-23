# Changelog

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
