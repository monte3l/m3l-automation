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
- **Bound review-spoke INPUT scope too, not just output.** The above bullet
  covers writer turns; review fan-outs need the same discipline on the other
  side. Give each review spoke a tight per-spoke file list (2–5 files) and
  split a Phase-4 review dispatch **by concern** once the diff exceeds ~3–4
  files or a few hundred lines, rather than handing one reviewer the whole
  diff plus "explore the repo" latitude — an unbounded scope stalled 3 of 5
  review spokes for 60+ minutes in `docs/logs/2026-07-18-aws-athena.md` and a
  single oversized `code-reviewer` dispatch for over an hour in
  `docs/logs/2026-07-18-aws-eventbridge.md`, both fixed by narrowing the file
  list. Every review-spoke prompt also carries a **converge and report**
  instruction — stop once its checklist is answered rather than re-verifying
  indefinitely; a spoke that never converges is indistinguishable from a
  stalled one.
- **Re-review every substantive fix round, bounded.** Must-fix fixes are new
  writer code with no reviewer between them and the commit; post-review fix
  batches introduced fresh Must-fix defects in at least four pipelines
  (`2026-07-02-core-text.md`, `2026-07-03-core-script.md`,
  `2026-07-03-core-importers.md`, `2026-07-13-dynamo-crud.md`). Dispatch a
  focused confirmation pass — the reviewer(s) whose findings drove the fixes,
  scoped to the changed files only, not a fresh full fan-out — before declaring
  the review loop closed.
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
  `spec-conformance-reviewer`, `docs-consistency-reviewer`, and any
  `auditing`/fan-out Explore dispatch.
- **A `SubagentStop` hook (`detect-spoke-truncation.mjs`) now flags a
  suspicious-looking return automatically** — treat its stderr reminder as a
  prompt to apply the "never trust a final report" step below, not as a
  replacement for it; it's a heuristic over prose, not a parse of the SDK's
  actual truncation signal.
- **Don't raise `maxTurns` as the fix.** More context/turns is not free —
  Anthropic's context-rot finding says accuracy degrades as token count grows.
  Scoping, journaling, and pacing are the preferred levers.
- **Run `bin/spoke-recovery.mjs` (or the `mcp__m3l__spoke_recover` tool)
  first** when recovering a truncated/ambiguous spoke — it automates the
  journal-parse + on-disk-verification step so you judge from a structured
  recommendation instead of re-deriving state by hand.
