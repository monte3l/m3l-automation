# Work log — subagent-statusline (2026-09-03)

This log covers PR #930 (`feat/subagent-statusline`, merged
2026-09-03T06:59:47Z, squash commit `c9be3caf`) — PR 2 of a 3-PR sequence
redesigning the Claude Code statusline, following PR 1 (#916,
`docs/logs/2026-09-03-statusline-redesign.md`). It migrates spoke in-flight
visibility from a hand-rolled `tmp/spoke-lifecycle.jsonl` tracker to Claude
Code's native `subagentStatusLine` setting, and retires the tracker in the
same change. It ran through `starting-work` → hub research (live doc fetch
against `code.claude.com/docs/en/statusline`) → hub-authored non-protected
files + parallel `code-implementer`/`test-author` dispatch from one locked
contract → `pnpm verify` → `code-reviewer`/`silent-failure-hunter` review →
`creating-prs` → a genuine ADR-number collision resolved via
`resolving-merge-conflicts` → `docs-consistency-reviewer` → merge →
`finishing-work`. Records what shipped, one real divergence (the ADR
collision), and durable lessons — including one already promoted into
`docs/adr/README.md`'s own conventions by a sibling PR that landed first.

Plan of record: `~/.claude/plans/the-recently-developed-statusline-cheeky-seal.md`
(session-local, not committed to `docs/plans/`; Sections 5–6 for this PR).
Archival remains deferred until all 3 PRs in the sequence land.

## Summary

- **Files changed**: `.claude/hooks/subagent-statusline.mjs` (new, ~190
  lines), `.claude/hooks/statusline-context-pressure.mjs` (edited — removed
  the retired in-flight-spoke tracking code, wired-but-unused since PR 1 by
  design), `.claude/hooks/track-inflight-spokes.mjs` (deleted),
  `.claude/hooks/rotate-session-incidents.mjs` (edited — dropped the
  `spoke-lifecycle.jsonl` rotation step), `.claude/settings.json` (edited —
  removed `SubagentStart`/`SubagentStop` tracker wirings, added
  `subagentStatusLine`), `bin/check-hooks.mjs` (edited — added
  `subagentStatusLine.command` recognition), `bin/tests/subagent-statusline.test.ts`
  (new, 49 tests), `bin/tests/statusline-context-pressure.test.ts` (edited —
  365 lines removed, 5 describe blocks for retired exports), `bin/tests/track-inflight-spokes.test.ts`
  (deleted), `bin/tests/check-hooks.test.ts` (edited — 5 new tests mirroring
  the existing `statusLine` coverage), `docs/adr/0090-subagent-statusline-supersedes-lifecycle-tracker.md`
  (new — see divergence #1 for why it's 0090, not the originally-drafted
  0089), `docs/adr/README.md`, `docs/contributing/hooks-reference.md`,
  `docs/contributing/subagent-context-management.md` (doc corrections). 14
  files, 814 insertions / 819 deletions.
- **New exports**: `ELAPSED_WARN_THRESHOLD_SEC`, `ELAPSED_HIGH_THRESHOLD_SEC`,
  `parseStartTime`, `formatElapsed`, `elapsedColor`, `formatTokenFraction`,
  `formatEffort`, `formatSubagentRow` on `subagent-statusline.mjs`. No
  exported-library-symbol changes (`.claude/`, `bin/`, `tmp/` are harness
  tooling, not the published package's public API).
- **Tests**: 49 new (`subagent-statusline.test.ts`), 5 new
  (`check-hooks.test.ts`, 40 total up from 35), 168 remaining in
  `statusline-context-pressure.test.ts` after removing exactly the 5 retired
  describe blocks (verified via a stash-based before/after diff — 196 tests
  before, 28 failing because the underlying `.mjs` symbols were already
  gone, 168 passing after, an exact match).
- **Gates**: `pnpm verify` — 58 passed, 10 skipped, 0 failed. `pnpm check:hooks`
  — 28 wired hooks valid (the one remaining warning, `statusline-layout.mjs`
  unwired, is an accepted pre-existing false positive for a pure sibling
  library module).
- **Review-size**: 57,581 reviewable chars — under the 75,000 ADR-0072 soft
  target.
- **PR**: [#930](https://github.com/monte3l/m3l-automation/pull/930) —
  merged (squash, `c9be3caf`).
- **Skills used**: starting-work, syncing-docs, writing-commits (inline, via
  `creating-prs`), creating-prs, resolving-merge-conflicts, finishing-work,
  writing-work-logs.
- **Spoke incidents**: none. `tmp/session-incidents.jsonl` was absent for
  this session (no truncations recorded); no review-spoke stall (>15 min)
  or `SendMessage` resume was observed across the four dispatched spokes
  (2× writer-spoke pair, `code-reviewer`, `silent-failure-hunter`,
  `docs-consistency-reviewer`).
- **Compaction events**: 1 compaction / 1 recovered via handoff. A `/compact`
  fired between this session's PR 1 close-out and the "proceed with PR 2"
  instruction; `write-compact-handoff.mjs` ran successfully and the
  reinjected context (branch/PR state, plan file location, PR 2/3 scope)
  was complete and accurate on resume — no state loss observed.

## What went as planned

- **Researching the live `subagentStatusLine` contract before writing any
  code paid off immediately.** A `WebFetch` against
  `code.claude.com/docs/en/statusline` confirmed the exact `tasks[]` field
  set, the `{"id","content"}` NDJSON output shape, and the `effort`/
  `contextWindowSize` version floors (v2.1.214/v2.1.205) before the locked
  contract was drafted — no spoke round-trip was needed to correct a
  guessed API shape, unlike PR 1's own history with unverified Nerd Font
  codepoints.
- **The locked-contract pattern from PR 1 repeated cleanly.** Both
  `code-implementer` and `test-author` converged on the exact same function
  signatures, ANSI-composition approach (self-contained
  `${color}text${RESET}` per segment, joined with a neutral separator — no
  double-reset bug), and CLI-entry shape, matching the contract byte-for-byte
  on first contact.
- **`pnpm verify` was clean on the first full run** after all three spoke
  dispatches landed — no fix-batch round was needed, unlike PR 1.
- **`code-reviewer` + `silent-failure-hunter`'s two Should-fix findings were
  both real and cheap to fix** — a broken plan-path citation and a
  too-narrow `try/catch` guard, neither requiring a spoke re-dispatch since
  both files were non-protected paths.
- **`docs-consistency-reviewer` independently verified the ADR renumber was
  clean** (divergence #1) — confirming no stale `0089` reference survived
  across the 6 touched files, which was exactly the kind of drift a rushed
  renumber could have left behind.

## What didn't go as planned, and why

### 1. A genuine ADR-number collision surfaced at rebase time

The new ADR was drafted as `0089-subagent-statusline-supersedes-lifecycle-tracker.md`
— the next free number at drafting time. By the time this branch rebased
onto `origin/main` (after `pnpm verify` and the first review round), a
sibling PR had already merged its own, unrelated ADR-0089 ("Skill invocation
stance, the listing-budget ceiling, and where routing guidance lives"). The
rebase stopped on a real content conflict in `docs/adr/README.md`'s index
table — not a resolvable "different row" case, since both branches had
written a genuinely different ADR under the identical number.

Resolved by aborting the rebase, renumbering this branch's ADR to `0090`
(`git mv` plus a `grep -rl "0089"` sweep across the repo to find and fix
every cross-reference — 6 files: the ADR file's own header, `docs/adr/README.md`,
`docs/contributing/hooks-reference.md`, and three `.claude/hooks/*.mjs`
header comments), amending the still-unpushed commit, then retrying the
rebase — which now hit only a trivial table-position conflict (both rows
correctly numbered, just needing sequential ordering), resolved directly.

**Why it happened:** ADR numbers are provisional until pushed, and two
branches drafted in the same window both picked "next free number" from
their own point-in-time view of `main`. Neither branch could have known
about the other's in-flight ADR.

**Fix for future:** None needed beyond what already exists —
`docs/adr/README.md`'s own "Conventions" section already documents this
exact scenario verbatim ("A drafted-but-unpushed ADR number is provisional,
not reserved... re-check `ls docs/adr/*.md | tail -1` and `git fetch origin
main` right before the final push"), added by a prior session that hit the
same collision (`docs/logs/2026-09-02-session-naming-convention.md`). This
occurrence confirms the documented fix works as written — followed it
directly with no new process gap to close.

## Lessons learned

- **Research the live third-party contract before drafting a spoke
  contract, not after.** Fetching Anthropic's own `subagentStatusLine` docs
  first (field names, output shape, version floors) meant the locked
  contract handed to `code-implementer`/`test-author` was correct on first
  write — no guessed-API rework, unlike PR 1's Nerd Font glyph history. This
  generalizes beyond statusline work: any spoke contract touching an
  external platform surface should be drafted from a freshly-fetched source,
  not from memory or a stale plan-file quote.
- **An ADR-number collision is expected, not exceptional, on a repo landing
  several PRs per session — the documented recovery already works.** This
  is the second time this exact collision has hit this repo
  (`docs/logs/2026-09-02-session-naming-convention.md` was the first); both
  times the fix was the same mechanical renumber-and-cross-reference-sweep,
  and both times it resolved cleanly. No new rule needed — this confirms the
  existing one in `docs/adr/README.md`'s Conventions section is sufficient
  and already promoted; recording the confirmation here rather than
  re-promoting an unchanged rule.
- **A hub-authored gate extension (check:hooks) needs its own dispatched
  test coverage, tracked as explicitly as the feature it protects.** The
  hub designed and wrote the `subagentStatusLine` recognition block in
  `bin/check-hooks.mjs` directly (non-protected path) but initially
  dispatched test-author only for the feature's own test files, not for
  `bin/tests/check-hooks.test.ts` — caught by the hub itself re-checking
  test coverage before running `pnpm verify`, not by a review spoke. A
  hub-authored change to shared gate logic is easy to treat as "small enough
  not to need a tracked test task" precisely because it's small — track it
  with the same explicitness as a feature file's test dispatch, every time.
