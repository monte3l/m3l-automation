# Work log — trim-oversized-rule-files (2026-09-05)

This log covers H13/issue #1022: trimming the four `.claude/rules/*.md` files
that sat at zero headroom against `check:context-budget`'s ratchet ceiling
(`RULE_CEILING_BYTES = 10,000`). One PR per file, ascending by size —
`subagent-dispatch.md` → `scripts.md` → `tests.md` → `library-src.md` — plus
this close-out session (ROADMAP flip, plan archive, `sync:hub`).

Plan of record: [`solve-issue-1022-twinkling-coral.md`](../plans/archive/2026-09-05-trim-oversized-rule-files.md)

## Summary

Four sequenced PRs, each: rewrite the rule file bullet-by-bullet per the
plan's trim contract (keep the bolded headline, keep the imperative and
shortest surviving _why_, delete incident narrative with no remaining home,
relocate genuinely unique reasoning into the canonical doc, collapse anything
`style-guide.md`/an Accepted ADR already covers to a pointer), re-baseline via
`node bin/check-context-budget.mjs --update`, `pnpm verify`, an async
`docs-consistency-reviewer` dispatch scoped to the two changed files, then
`creating-prs`.

| PR    | File                   | Before → after                                        |
| ----- | ---------------------- | ----------------------------------------------------- |
| #1026 | `subagent-dispatch.md` | 16,845 B → under ceiling (dropped from baseline)      |
| #1033 | `scripts.md`           | 19,334 B → under ceiling (dropped from baseline)      |
| #1036 | `tests.md`             | 24,851 B → 9,981 B                                    |
| #1040 | `library-src.md`       | 31,479 B → 17,158 B (re-baselined lower, not dropped) |

All four `pnpm verify` runs passed cleanly (59 steps / 10 skipped, including
`check:context-budget`, `check:review-size`, `check:test-counts`). Every
`docs-consistency-reviewer` dispatch came back clean. No `src/`, test, or
`exports`-map changes in any of the four — zero semver impact throughout.
`docs/ROADMAP.md`'s H13 row flips to `Done`, `pnpm sync:hub -- --apply` closes
issue #1022.

Skills used: starting-work, writing-commits, creating-prs, syncing-docs,
finishing-work, writing-work-logs (this log).

Spoke incidents: none — each `docs-consistency-reviewer` dispatch returned a
clean PASS on the first pass, no truncations or stalls.

Compaction events: this task spanned at least one hub-session compaction
between PR2 and PR3 (the transcript summary at the start of the PR3 segment
confirms a `/compact` occurred); the ADR-0078 handoff recovered the branch,
last commit, and in-progress step correctly — no state was lost.

## What went as planned

- **The trim contract generalized cleanly across all four files.** The same
  five-step disposition (keep headline → keep imperative+why → delete
  incident narrative → relocate unique reasoning → collapse to pointer)
  applied without modification from PR1 through PR4, despite the four files
  having very different unique-vs-duplicate content ratios.
- **`docs-consistency-reviewer` caught real content-coverage claims
  accurately.** For `library-src.md` specifically, it verified all eleven
  topics named in the new opening pointer bullet actually exist in the cited
  `style-guide.md` Part 1 sections, and confirmed the ADR-0072-quoted phrase
  ("never validate a caller value and then let something else re-read it")
  survived verbatim despite heavy trimming around it.
- **`claude-pr-review.yml`'s review check passed cleanly on all four PRs** —
  no repeat of an earlier false-positive class seen on a prior, unrelated PR
  in this repo's history.
- **The plan's own prediction about file ordering held.** It explicitly
  called `subagent-dispatch.md`/`scripts.md` "best pilots" (more restatement
  to cut) and `library-src.md` "most unique detail, least duplication" —
  confirmed exactly: the first three files dropped entirely under the
  10,000 B ceiling, while `library-src.md` only reached 46% reduction and
  stayed above it, needing a re-baseline rather than a ceiling drop.

## What didn't go as planned, and why

### 1. `EnterWorktree` cannot enter a sibling-directory worktree created by `pnpm worktree:new`

Every worktree in this session (`pnpm worktree:new <slug>`) creates a sibling
directory (`../m3l-automation-<slug>`), not a subdirectory under
`.claude/worktrees/`. Calling `EnterWorktree(path: "<that sibling path>")`
was rejected outright: "is not under .../.claude/worktrees. Switching from
this session is limited to worktrees managed by Claude Code." This affected
every one of the four PR worktrees plus the close-out worktree.

**Why it happened:** the repo's own worktree tooling (ADR-0013/0014) and the
harness's `EnterWorktree` tool encode two different worktree-location
conventions, and nothing in this repo's skills currently reconciles them —
`starting-work`'s Step 5 instructs exactly the `EnterWorktree path:
../m3l-automation-<slug>` call that the harness tool rejects for this repo's
sibling-directory layout.

**Fix for future:** until the two conventions are reconciled, treat every
`pnpm worktree:new`-created worktree as **not** enterable via `EnterWorktree`
in this repo, and use plain `Bash` with an explicit `cd <worktree-path> &&`
prefix on every command instead — accepting that the harness resets the
shell's cwd back to the launch directory after each call. This is a
structural mismatch worth its own tracker row if it keeps costing setup time
across sessions.

### 2. A worktree can branch from a stale `origin/main` if another PR merges mid-session

The `library-src.md` (PR4) worktree was created immediately after confirming
PR3 (#1036) had merged, but `bin/context-budget-baseline.json` on disk still
showed `tests.md: 24851` (its pre-trim value) — the worktree had branched
from an `origin/main` one merge behind. This was caught only by noticing the
stale baseline value before committing. A rebase (`git rebase origin/main`)
was needed, with a manual conflict resolution on
`bin/context-budget-baseline.json` (not covered by the `merge=m3l-generated`
driver). The same thing then happened **again**, one commit later — another,
unrelated PR (#1035) landed on `main` between the first rebase and the
first push attempt, caught by `git log main...HEAD --oneline` unexpectedly
showing that unrelated commit. A second rebase plus a `--force-with-lease`
re-push resolved it.

**Why it happened:** `pnpm worktree:new` snapshots `origin/main` at creation
time; it does not re-fetch on a schedule, and there is no gate warning that a
worktree's base has moved before the first commit or push. In a session
running four sequential PRs against a fast-moving `main`, the window for a
concurrent merge is real.

**Fix for future:** always `git fetch origin main && git rev-list --count
HEAD..origin/main` immediately before the first commit in a fresh worktree,
not just before the push (as `creating-prs` Step 2 already does) — and treat
`context-budget-baseline.json`'s on-disk value as a cheap tripwire: if it
doesn't match what the immediately-prior merged PR should have produced, the
worktree is stale.

## Lessons learned

- **`EnterWorktree` and `pnpm worktree:new` disagree on worktree location.**
  A sibling-directory worktree can never be entered via the harness's
  `EnterWorktree` tool; fall back to `cd`-prefixed `Bash` calls for the
  worktree's lifetime instead of retrying `EnterWorktree`.
- **Re-check worktree staleness before the first commit, not just before
  push.** A worktree created moments after a merge can still be one or more
  commits behind if another PR lands in the gap; a stale ratchet-baseline
  value on disk is a cheap, specific tripwire for this in this repo.
- **A trim contract generalizes better than a percentage target.** Trimming
  "to what the content honestly supports" across four files with very
  different duplication ratios (0% dropped from baseline for the two most
  duplicative files, 46% reduction while staying above ceiling for the
  least duplicative) produced a defensible, content-preserving result in
  every case — a fixed target would have forced either under-trimming the
  first two or over-cutting the last one.
- **`context-budget-baseline.json` needs manual conflict resolution on
  rebase.** It is not tagged `merge=m3l-generated` in `.gitattributes`,
  unlike `catalog.json`/`symbol-map.json`/`pnpm-lock.yaml` — a rebase that
  touches it while `origin/main` has also moved it (e.g. another rule file's
  own trim PR merging concurrently) needs a manual three-way resolution,
  which is easy to get right (keep the newer/lower value per file) but easy
  to fumble under time pressure.
