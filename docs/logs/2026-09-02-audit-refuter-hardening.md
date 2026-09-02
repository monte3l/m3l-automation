# Work log — audit-refuter-hardening (2026-09-02)

This log covers a resumed, in-flight harness change on
`fix/audit-fanout-refuter-hardening`: hardening `audit-fanout.js`'s Verify
phase (a previously untyped, unguarded refute agent), fixing a verify-budget
starvation bug and unbounded digest sizing, and surfacing silently-dropped
facets. It also records a second, unplanned fix discovered by the session's
own mandated live acceptance run: `detect-spoke-truncation.mjs` was flagging
every schema-dispatched agent as truncated, 100% of the time, regardless of
outcome.

Plan of record: session plan-mode file `sunny-scribbling-bengio.md` (not
archived to `docs/plans/` — a resume/verification tail on already-drafted
code, not a fresh design).

## Summary

Four originally-uncommitted files plus two produced this session:

- **`.claude/agents/audit-refuter.md`** (new) — typed read-only refute spoke,
  `claude-sonnet-5`/`medium`, `disallowedTools: Agent`, closing a guard gap:
  the Verify phase previously dispatched with an inline `model`/`effort`
  override but no `agentType`, so it ran outside both
  `guard-readonly-bash.mjs`'s read-only Bash block (which exits 0 when
  `agent_type` is absent) and `check:agents`' depth-1 no-nesting invariant.
- **`.claude/workflows/audit-fanout.js`** — Verify phase now dispatches
  `agentType: "audit-refuter"`; verify-budget allocation replaced
  `findings.slice(0, VERIFY_MAX)` (which starved every facet after the first
  whenever early facets alone exceeded the budget) with `allocateRoundRobin`,
  spreading the 15-finding budget evenly across facets; `DIGEST_SCHEMA` gained
  `maxItems`/`maxLength` caps (worst-case-per-facet accounting corrected from
  ~40 KB, which only counted `reportMarkdown`, to ~22 KB including the
  previously-unbounded `items` array); a finder returning `null` is now
  surfaced in a new `missingFacets` array instead of silently shrinking the
  facet count.
- **`.claude/skills/auditing/SKILL.md`** — documents the new return shape
  (`missingFacets`, round-robin allocation, `evidence`/`note` fields) and adds
  a Step-3 instruction to re-dispatch any facet in `missingFacets` rather than
  proceeding with fewer facets than planned.
- **`docs/contributing/model-selection.md`** — MODEL-MATRIX gained an
  `agent`/`audit-refuter` row and dropped the now-obsolete
  `workflow-script`/`audit-fanout.js:verify` row; R8a prose updated with the
  untyped-agent history.
- **`.claude/hooks/detect-spoke-truncation.mjs`** (unplanned, this session) —
  new exported `hadStructuredOutputCompletion(transcriptPath)`, called before
  the truncation heuristic concludes a spoke was cut off. See "What didn't go
  as planned" below.
- **`bin/tests/detect-spoke-truncation.test.ts`** — 8 new tests for
  `hadStructuredOutputCompletion` (15 → 23 total), written by `test-author`.

`pnpm verify`: **57/57 passed, 10 appropriately skipped** (push-only GitHub
checks). Two live acceptance runs of the `audit-fanout` Workflow tool
confirmed the fix in production: Verify-phase agents dispatched as
`audit-refuter` (not untyped), every `confirmed`/`refuted` entry carried
`evidence`, `missingFacets` was present and empty on a healthy run.

Skills used: starting-work, auditing (workflow invoked directly, not the full
skill, to inspect the raw return value), writing-work-logs.

Spoke incidents: **0 genuine truncations / 0 stalls / 0 resumes.**
`tmp/session-incidents.jsonl` holds 6 lines, all recorded _before_ the fix
below landed, and all confirmed false positives by direct transcript
inspection (4 from the first acceptance run, 2 from the debug-capture probe)
— this file's contents are the exact bug this session fixed, not evidence of
real incidents. One `test-author` dispatch ran clean with no incident.

Compaction events: **0 within this session.** One prior-session
`PreCompact`/`SessionStart` handoff (ADR-0078) was present at session start
and matched current git state exactly on re-verification — no state was lost
across that boundary.

## What went as planned

- **The four originally-drafted files needed no correction.** Re-deriving
  their intent from a cold read (git diff, not memory) confirmed the
  untyped-agent fix, round-robin allocation, and digest caps were all sound;
  `allocateRoundRobin` was hand-exercised against five edge cases (starvation
  shape, under-budget, empty groups, `max: 0`) before the live run and held
  conservation (`selected + remainder === total`) in every case.
- **Clean rebase onto `origin/main`.** 8 commits ahead on the remote, none
  touching the 4 in-flight files — no conflicts.
- **All static gates green before the live run**, matching the file-list
  scope exactly: `check:agents` (10→11 spokes), `check:workflows` (matrix row
  swap, count held at 1), `check:workflows-doc`, `check:hooks`,
  `check:skill-evals`, `check:context-budget`, `check:index`, `format:check`.
- **`test-author`'s dispatch converged in one round.** Given the exact
  function body, target file, and 8 case names up front, it wrote clean
  tests, ran its own verification (vitest + typecheck + eslint + prettier),
  and reported accurately — confirmed by re-diffing the file and re-running
  vitest myself per the "never trust a final report at face value" rule.

## What didn't go as planned, and why

### 1. `detect-spoke-truncation.mjs` flagged every schema-dispatched agent as truncated, 100% of the time

`.claude/rules/harness-artifacts.md` requires a live acceptance run for any
workflow-script change, since static gates can't see runtime behavior. The
first live run (2 facets, "worktree tooling docs") returned a well-formed
result — but `tmp/session-incidents.jsonl` recorded a truncation for **all
four** dispatched agents (2 `Explore` finders, 2 `audit-refuter` verifiers),
despite the run producing two `confirmed` findings with full evidence and no
`unverified` entries. Direct transcript inspection (`agent-*.jsonl` under the
run's subagent directory) showed each agent's actual final content was a
clean, complete sentence followed by a `StructuredOutput` tool call — nothing
resembling a truncated turn.

To find the real cause rather than guess, I instrumented the hook with a
one-line debug `appendFileSync` of its raw stdin, ran a second minimal
1-facet probe workflow to trigger a fresh `SubagentStop` event, and inspected
the captured payload directly. For the `Explore` and `audit-refuter` agents,
`last_assistant_message` was not an empty string — the **key was absent from
the payload entirely**. `looksTruncated(undefined)` returns `true` by design
(this is the correct signature for a genuinely cut-off text-completing
spoke), so every schema-dispatched agent tripped it unconditionally,
regardless of outcome. The payload does carry `agent_transcript_path` in
every case, so I added `hadStructuredOutputCompletion(transcriptPath)`: read
the spoke's own transcript and check whether its last JSONL line is the
tool-runner's `"Structured output provided successfully"` confirmation — a
marker only a genuinely completed dispatch can produce. Verified against all
4 real transcripts from the first run (all `true`, correctly suppressing the
false positive) and against synthetic edge cases (undefined/empty/nonexistent
path, empty file, malformed last line, mid-turn `tool_use` as last line, all
correctly `false`).

**Why it happened:** the hook's payload-shape assumption
(`last_assistant_message` is always populated on a clean stop) held for every
spoke type that existed when the hook was written — none of them used
`schema:`. `audit-fanout.js`'s Verify phase gaining an `agentType` (this same
PR) was the first time a _typed_ schema-dispatched agent existed in the
roster in a form `check:agents`/`guard-readonly-bash.mjs` could see — but the
truncation detector's blind spot for schema dispatch predates this PR
entirely; it already affected every `Explore`-typed Find-phase dispatch, the
live acceptance run just happened to be the first time anyone looked at
`tmp/session-incidents.jsonl` closely enough to notice all four entries were
wrong.

**Fix for future:** when a hook's payload-shape assumption is written against
one spoke shape (plain text completion), test it against every dispatch
_mode_ a spoke can use (schema-constrained included), not just every spoke
_type_ — a new `agentType` can expose an old blind spot without being its
cause. _(promoted → .claude/rules/harness-artifacts.md)_

## Lessons learned

- **A live acceptance run can surface a bug in the harness's own tooling, not
  just in the change under test** — `detect-spoke-truncation.mjs` had nothing
  to do with this PR's actual scope (refuter typing, verify-budget
  allocation), but the live run's own advisory tooling was the thing that
  turned out to be broken. Don't scope a live-run inspection to only the
  fields the plan predicted would change; read what the run's own
  side-effects (here, `tmp/session-incidents.jsonl`) actually recorded.
- **When a heuristic's live behavior contradicts a plausible-sounding
  hypothesis, capture the real payload before writing the fix.** The first
  hypothesis (a non-string `last_assistant_message`) was wrong in its
  specifics — the field wasn't present as a non-string value, it was absent
  as a key entirely, and the _visible_ transcript text was actually clean and
  complete. A five-minute instrumented probe run settled it definitively
  instead of shipping a fix against a guessed payload shape.
- **`tmp/session-incidents.jsonl`'s claimed "authoritative" status has an
  exception: entries recorded before a fix to the detector itself are not
  evidence of real incidents.** `writing-work-logs` treats the file as
  authoritative for the "Spoke incidents" line; this session is the first
  case where the file's own entries were the bug being fixed, not a report of
  a fixed bug. Don't propagate a stale/known-wrong count into a work log
  just because the file says so — cross-check against what generated it when
  the fix and the read happen in the same session.
- **A false-positive rate of 100% on an entire spoke _mode_ (not spoke type)
  can hide as "just some noise."** Six recorded false positives across two
  runs, zero real truncations, is not a rounding error — it means the signal
  was worthless for every schema-dispatched agent in the repo until fixed,
  silently, since the mechanism first shipped.
