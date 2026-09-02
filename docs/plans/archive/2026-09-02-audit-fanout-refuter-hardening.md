# `audit-fanout` refuter typing, verify-budget fairness, and a truncation-detector fix

**Status: shipped** — branch `fix/audit-fanout-refuter-hardening`.

## Context

Resumed uncommitted, in-flight work found at session start (linked worktree,
0 commits ahead of `main`, matching the `PreCompact`/`SessionStart` handoff
exactly): `audit-fanout.js`'s Verify phase dispatched its adversarial refute
agent with an inline `model`/`effort` override but no `agentType`, so it ran
outside both `guard-readonly-bash.mjs`'s read-only Bash block (which exits 0
when `agent_type` is absent) and `check:agents`' depth-1 no-nesting
invariant — a real guard gap on a spoke doing genuine investigative Bash
work. The same in-flight diff also fixed a verify-budget starvation bug
(`findings.slice(0, VERIFY_MAX)` drained early facets first, leaving later
facets wholly unverified whenever earlier ones alone exceeded the 15-finding
budget) and an unbounded digest-items schema.

## Approach / Decisions

- New typed spoke `.claude/agents/audit-refuter.md` (`claude-sonnet-5`/
  `medium`, `disallowedTools: Agent`) closes the guard gap; `audit-fanout.js`
  dispatches it via `agentType: "audit-refuter"` instead of the inline
  override. MODEL-MATRIX gained an `agent` row and dropped the now-obsolete
  `workflow-script`/`audit-fanout.js:verify` row.
- `allocateRoundRobin` replaces the slice-based verify-budget allocation,
  spreading the 15-finding budget evenly across facets instead of draining
  them in facet order; hand-exercised against five edge cases (starvation
  shape, under-budget, empty groups, `max: 0`) before the live run.
- `DIGEST_SCHEMA` gained `maxItems`/`maxLength` caps, correcting the
  worst-case-per-facet accounting from ~40 KB (which only counted
  `reportMarkdown`) to ~22 KB including the previously-unbounded `items`
  array; a finder returning `null` now surfaces in a new `missingFacets`
  array instead of silently shrinking the facet count.
- `.claude/rules/harness-artifacts.md` requires a live acceptance run for any
  workflow-script change (static gates can't see runtime behavior) — two live
  `Workflow` tool invocations of `audit-fanout` confirmed the fix: Verify
  agents dispatched as `audit-refuter`, `evidence` present on every
  `confirmed`/`refuted` entry, `missingFacets` present and empty on a healthy
  run.
- The first live run's `tmp/session-incidents.jsonl` recorded a truncation
  for all 4 dispatched agents despite clean, well-formed results — a second,
  unrelated bug in `detect-spoke-truncation.mjs`. A raw stdin capture (a
  disposable debug probe run) showed schema-dispatched agents omit
  `last_assistant_message` from the `SubagentStop` payload entirely (not an
  empty string — the key is absent), so `looksTruncated(undefined)` fired
  100% of the time regardless of outcome. Fixed with
  `hadStructuredOutputCompletion(transcriptPath)`, which reads the spoke's
  own transcript and checks for the tool-runner's structured-output
  confirmation as the last line before concluding truncation — verified
  against all 4 real transcripts from the first run and a battery of
  synthetic edge cases.

## Outcome

One PR, `pnpm verify` 57/57 passed. Full account, including the debug-probe
methodology and the false-positive-count caveat for `tmp/session-incidents.jsonl`:
[`docs/logs/2026-09-02-audit-refuter-hardening.md`](../../logs/2026-09-02-audit-refuter-hardening.md).
