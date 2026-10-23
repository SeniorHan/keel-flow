# Changelog

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
