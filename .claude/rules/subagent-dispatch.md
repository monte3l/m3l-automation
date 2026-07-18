---
paths:
  - ".claude/skills/**"
  - ".claude/agents/**"
---

# Subagent dispatch rules (truncation prevention & recovery)

> Canonical rationale + full incident history:
> [`docs/contributing/subagent-context-management.md`](../../docs/contributing/subagent-context-management.md).
> This file is the terse checklist consulted when dispatching or resuming a
> spoke. No natural path-glob covers "dispatching a subagent," so this rule is
> also linked from `CLAUDE.md`'s Agent Operating Model section and from the
> dispatching skills — read it there too.

Subagent mid-turn truncation (a spoke hitting `maxTurns: 40` or an output-token
cap mid-thought) is this repo's most-recurring build divergence — 20+ logged
occurrences. The checklist:

- **Decompose before you dispatch.** Scale the dispatch to task complexity —
  a module/script spanning many files gets split into bounded sub-dispatches
  up front, not handed to one spoke as an indivisible turn. Don't rely on
  journaling to make an oversized turn safe.
- **Hand writer spokes (`test-author`, `code-implementer`) an explicit journal
  path** in the dispatch prompt. `.claude/hooks/guard-writer-dispatch-journal.mjs`
  warns (non-blocking) when one is missing.
- **Never trust a "final" report at face value.** A mid-thought fragment
  (`"Now the config module —"`) is the signature of a truncated turn, not a
  benign quirk — verify on-disk state yourself (the spoke's journal, `git
status`/`git diff`, re-run `tsc`/`eslint`/`vitest`/coverage) before deciding
  what's actually done.
- **Resume the SAME spoke via `SendMessage`**, never a fresh `Agent`/`Task`
  dispatch — a fresh agent has no memory of the prior exploration and restarts
  the whole budget from zero. Hand it a scoped punch-list of exactly what's
  left, not a full re-explanation.
- **Review spokes return a bounded digest**, not an open-ended report — long
  findings spill to a scratchpad file; the return is a capped Must-fix/
  Should-fix/Nits summary plus the file path. Applies to `code-reviewer`,
  `security-reviewer`, `silent-failure-hunter`, `type-design-analyzer`,
  `spec-conformance-reviewer`, and any `auditing`/fan-out Explore dispatch.
- **Don't raise `maxTurns` as the fix.** More context/turns is not free —
  Anthropic's context-rot finding says accuracy degrades as token count grows.
  Scoping, journaling, and pacing are the preferred levers.
- **Run `bin/spoke-recovery.mjs` (or the `mcp__m3l__spoke_recover` tool)
  first** when recovering a truncated/ambiguous spoke — it automates the
  journal-parse + on-disk-verification step so you judge from a structured
  recommendation instead of re-deriving state by hand.
