# Work log — statusline-palette-hardening (2026-09-03)

This log covers PR #939 (`feat/statusline-palette-hardening`, merged
2026-09-03T08:12:30Z) — PR 3 of 3 in the statusline redesign sequence,
following PR 1 (#916, `docs/logs/2026-09-03-statusline-redesign.md`) and PR 2
(#930, `docs/logs/2026-09-03-subagent-statusline.md`). It expands the
statusline colour palette (`BLUE`/`MAGENTA`, formalizing a
session-location-identity axis and a turn-configuration axis alongside the
existing alarm/semantic-state ramps), hardens `check:hooks` to enforce
ADR-0080's "no subprocess, no network" invariant mechanically instead of only
in prose, and rewrites `hooks-reference.md`'s statusline documentation for
the current five-row layout. It ran through `starting-work` → hub-authored
non-protected edits (colour wraps, `check:hooks` hardening, docs rewrite) →
a single locked-contract dispatch to `test-author` for the three protected
test files → `pnpm verify` → `/syncing-docs` → `creating-prs` (rebase, full
gate pipeline, `docs-consistency-reviewer`) → push → merge → plan archival →
`finishing-work`. This is the closing PR of the sequence: the plan of record
is archived in this same PR, not deferred further.

Plan of record: [`docs/plans/archive/2026-09-03-statusline-redesign.md`](../plans/archive/2026-09-03-statusline-redesign.md)
(archived in this PR; previously session-local at
`~/.claude/plans/the-recently-developed-statusline-cheeky-seal.md`, Sections
7–9 for this PR).

## Summary

- **Files changed**: `.claude/hooks/statusline-context-pressure.mjs` (edited
  — added `BLUE`/`MAGENTA` constants, colour-wrapped 8 segments:
  `formatBranchSegment`'s non-`main` case, `formatWorktreeSegment`,
  `formatOriginRepoSegment` in blue; `formatEffortSegment`,
  `formatThinkingSegment`, `formatFastModeSegment`, `formatOutputStyleSegment`,
  `formatVimModeSegment` in magenta), `.claude/hooks/subagent-statusline.mjs`
  (edited — imported `MAGENTA`, wrapped the effort segment in
  `formatSubagentRow`), `bin/check-hooks.mjs` (edited — new
  `validateStatuslineShape`, `FORBIDDEN_STATUSLINE_PATTERNS`,
  `scanStatuslineScriptForForbiddenPatterns`, `STATUSLINE_SETTINGS_KEYS`
  exports, wired into the main execution block),
  `bin/tests/statusline-context-pressure.test.ts` (edited — 8 existing
  `describe` blocks' colour-wrap assertions updated), `bin/tests/subagent-statusline.test.ts`
  (edited — effort-segment assertion updated), `bin/tests/check-hooks.test.ts`
  (edited — new coverage for both new functions, 40 → 71 tests),
  `docs/contributing/hooks-reference.md` (edited — full `statusLine`/
  `subagentStatusLine` section rewrite for the five-row layout plus a
  colour-legend table), `docs/plans/archive/2026-09-03-statusline-redesign.md`
  (new — condensed 3-PR narrative), `docs/plans/README.md` (edited — new
  Archive row). 9 files across two commits (feature + archival), well under
  the ADR-0072 soft review-size target (24,163 reviewable chars).
- **New exports**: `BLUE`, `MAGENTA` on `statusline-context-pressure.mjs`;
  `STATUSLINE_SETTINGS_KEYS`, `validateStatuslineShape`,
  `FORBIDDEN_STATUSLINE_PATTERNS`, `scanStatuslineScriptForForbiddenPatterns`
  on `bin/check-hooks.mjs`. No published-library exported-symbol changes —
  `.claude/`/`bin/` are harness tooling, not the package's public API.
- **Tests**: `bin/tests/statusline-context-pressure.test.ts` 168 passed
  (existing tests, updated assertions, no new cases), `bin/tests/subagent-statusline.test.ts`
  49 passed (same), `bin/tests/check-hooks.test.ts` 71 passed (up from 40 —
  31 new tests across two new `describe` blocks, several via `test.each`).
  288 total across the three files.
- **Gates**: `pnpm verify` — 58 passed, 10 skipped, 0 failed (both before and
  after the `creating-prs` rebase). Full `lint`/`typecheck`/CLI-build/
  `test:coverage`/`build` pipeline clean. `pnpm check:hooks` — 28 wired hooks
  valid (same accepted `statusline-layout.mjs` false-positive as PR 1/2).
- **Review-size**: 24,163 reviewable chars — well under the 75,000
  ADR-0072 soft target.
- **PR**: [#939](https://github.com/monte3l/m3l-automation/pull/939) —
  merged.
- **Skills used**: starting-work, syncing-docs, writing-commits (inline, via
  creating-prs), creating-prs, finishing-work, writing-work-logs.
- **Spoke incidents**: none. `tmp/session-incidents.jsonl` was absent for
  this session (no truncations recorded); no review-spoke stall (>15 min) or
  `SendMessage` resume observed across the two dispatched spokes
  (`test-author`, `docs-consistency-reviewer`).
- **Compaction events**: none this PR (the session's one compaction earlier
  happened during PR 2's close-out, recorded in that PR's own log).

## What went as planned

- **The false-positive check in the new source scanner was caught before
  commit, not by a review spoke.** Running `node bin/check-hooks.mjs`
  against the live repo — the exact "known-good input" discipline
  `.claude/rules/harness-artifacts.md` calls for — immediately surfaced that
  the initial `exec*`/`spawn` regex matched `.exec(` on
  `RegExp.prototype.exec` calls already present in both statusline scripts
  (they parse `.git/HEAD` with one each). Fixed with a negative dot-lookbehind
  before any spoke or reviewer ever saw the bug.
- **The locked-contract dispatch to `test-author` converged cleanly on the
  first pass** — 8 existing colour-wrap assertions updated correctly across
  two files, 31 new tests for the two `check:hooks` functions (including the
  `.exec(`-guard case explicitly), all green, no re-dispatch needed.
- **`pnpm verify` was clean on both the pre-rebase and post-rebase runs** —
  no fix-batch round needed despite the branch being 3 commits behind
  `origin/main` at rebase time.
- **The stale-`main` detection in `creating-prs`' pre-push review worked
  exactly as documented.** Other sessions had landed unrelated PRs on
  `origin/main` during this session, so a plain `git diff main...HEAD`
  would have pulled in ~20 unrelated `packages/m3l-console-server/**` files;
  checking `git rev-parse main origin/main` first and diffing against
  `origin/main` instead kept the review spoke correctly scoped to this
  branch's own 9 files.
- **`docs-consistency-reviewer` returned zero findings** across all 6
  requested checkpoints (colour-legend-vs-code accuracy, hook-count
  re-derivation, archive-file PR/commit spot-check, `check:hooks`
  self-consistency, PR-2-era stale-prose sweep, markdown formatting) — the
  first review pass in this 3-PR sequence with no findings at all, Must-fix
  or otherwise.

## What didn't go as planned, and why

Everything within this PR's own scope executed as planned; the one
divergence worth recording happened in this session but in the prior PR's
close-out, not in PR 939 itself.

### 1. A git-stash indexing mistake during the prior PR's `finishing-work` cleanup

While cleaning up an unrelated pre-existing `.claude/settings.json` local
diff before pulling `origin/main` (during PR #934's close-out, immediately
preceding this PR in the same session), a `git stash list | grep -n <tag> |
cut -d: -f1 | sed 's/^/stash@{/;s/$/}/'` pipeline had an off-by-one error:
`grep -n`'s 1-indexed line number was used directly as the 0-indexed
`stash@{N}` reference, so `stash@{1}` was dropped instead of `stash@{0}`.
The dropped entry was a different session's unrelated WIP stash
(`WIP on feat/cli-new-lambda-scaffold`, dated 2026-08-27), not the one just
created. Caught immediately by re-running `git stash list` and comparing
SHAs; the dropped commit object was still reachable (not yet garbage
collected), so it was recovered onto a new branch
(`recovered-stash-1f9b207f`) rather than left dangling, and the correct
entry (`stash@{0}`) was then dropped properly.

**Why it happened:** Piping `git stash list`'s human-readable index through
`grep -n` and treating the resulting _line_ number as the stash _index_
skipped the 0-based/1-based conversion. `git stash list` and `grep -n` count
from different bases and nothing in the pipeline reconciled them.

**Fix for future:** Never derive a `stash@{N}` reference by piping
`git stash list` through `grep`/`cut`/`sed` arithmetic. Use
`git stash list --format='%H %gs'` to get the stash's SHA directly (as this
session did immediately afterward, successfully), and address it by that SHA
for `apply`/`show`, or re-run a plain `git stash list` immediately before a
`drop` and read the `stash@{N}` token verbatim off that fresh listing —
never recompute it from a filtered/piped view. This matters more on a shared
stash stack (this repo's worktrees share one stash stack across concurrent
sessions per this repo's own git-safety protocol) than in a single-user repo,
since a wrong index there drops someone else's in-progress work, not your own.

## Lessons learned

- **A source-pattern scanner needs live-fire validation against the exact
  files it will gate, before commit, not just against synthetic test
  cases.** The `exec*`/`spawn` forbidden-pattern regex was logically
  reasonable in isolation but broke on real code (`RegExp.prototype.exec`)
  the moment it ran against this repo's own statusline scripts. Running the
  new gate against known-good live input first — per
  `.claude/rules/harness-artifacts.md` — turned a would-be false-positive
  incident into a two-line regex fix with zero blast radius.
- **When other sessions are landing PRs concurrently, diff against
  `origin/main`, not local `main`, before dispatching a pre-push review
  spoke.** A linked worktree's local `main` ref is fixed at worktree-creation
  time and never fast-forwards; in a multi-session repo it goes stale within
  the hour. `creating-prs`' own documented staleness check
  (`git rev-parse main origin/main`) caught this correctly here — confirming
  the existing guidance is sufficient, not proposing a new one.
- **Never derive a `stash@{N}` index from a piped/filtered `git stash list`
  — recompute the index from a fresh, unpiped listing immediately before
  acting, or address the entry by its SHA instead.** A wrong index on a
  shared stash stack (this repo's worktrees share one stack across
  concurrent sessions) risks dropping another session's unrelated work, not
  just your own — recorded here from a mistake this session made and
  recovered from, but the underlying pattern (index arithmetic through a
  text pipeline) is exactly the kind of off-by-one that recurs unless named
  explicitly.
