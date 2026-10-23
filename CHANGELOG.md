# Changelog

## [1.1.0] — keel fork (2026-10-23)

Local fork of Michaelliv/pi-dynamic-workflows v1.0.1 (SeniorHan/keel-flow). Not published upstream.

### Changed

- Model-facing text rewritten per the keel naming/description constitution:
  - meta-header rule, agent()-once, parallel-thunk, globals list, and opts.schema schema rule now stated **once each**, in the `script` parameter description (the canonical, argument-adjacent spot).
  - `promptGuidelines` reduced 14 → 8; the repeated "For workflow," prefix removed; telegraph style (Chinese), with new guidance separating deterministic gated execution plans (workflow) from exploratory steerable delegation (interactive subagent tools).
  - Tool description and promptSnippet reduced to one line each, cross-referencing the `script` parameter description.

### Kept

- Runtime behavior, tool name `workflow`, script semantics, display, and the public API untouched (24/24 tests).
