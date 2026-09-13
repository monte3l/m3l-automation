# Work log — `x8c-cleanup-errno` (2026-09-13)

X8c (issue #1058): `runCleanup`'s `context.failures[].errno` reported the
wrapping `M3LConsoleError`'s own code instead of the real underlying cause
for any cleanup driver that wraps its failure. This log covers the fix, its
two `claude-pr-review.yml` rounds (one real Should-fix found and fixed, one
deliberately left unaddressed), and the process incidents along the way —
a rebase across an in-flight upstream migration, a should-fix-ack/review-round
tradeoff, and a mid-session compaction that dropped worktree ownership.

Plan of record: [`docs/plans/archive/2026-09-13-x8c-cleanup-errno.md`](../plans/archive/2026-09-13-x8c-cleanup-errno.md)

## Summary

Shipped as PR #1236 (squash-merged `fd48d36d`), closing issue #1058 via
`pnpm sync:hub`. `packages/m3l-console-server/src/errors/errno.ts` gains
`underlyingErrnoCodeOf`: it walks a caught value's `.cause` chain, skips
every `Core.M3LError` link, and returns `errnoCodeOf` of the first non-M3L
link — so the audit-trail driver now reports `ENOTDIR` and the telemetry
driver reports the store's own code (e.g. `ERR_SQLITE_ERROR`), instead of
both repeating `ERR_CONSOLE_INTERNAL`. The walk is bounded at ten links (the
caught value itself plus up to nine causes) and never throws. `cleanup.ts`
also gained `consoleErrorCodeOf`, the same guard applied to
`toCleanupFailure`'s own `instanceof M3LConsoleError` read. The `cleanup`
CLI (`bin/m3l-console-server.mjs`) now prints one stderr line per failure
(`driver`, `code`, `errno`), which it never did before — a gap the tracker
row didn't name but the fix closed anyway, recorded in ADR-0070's
2026-09-13 Update.

Final state: `pnpm verify` passed twice on the branch (73 steps, 10
push-only skipped, each time); the package suite reached 126 files / 3218
tests after round 1's hardening. Two `claude-pr-review.yml` rounds both
verdicted PASS. Three PR-scoped review dispatches ran locally before each
push (`code-reviewer`, `silent-failure-hunter`, `spec-conformance-reviewer`
on the original fix; `code-reviewer` + `silent-failure-hunter` again on the
hardening round) — all found no Must-fix.

Skills used: starting-work, syncing-docs (×3), creating-prs,
resolving-pr-comments, finishing-work, writing-work-logs.

Spoke incidents: 1 truncation / 0 stalls / 0 resumes. The first
`test-author` dispatch (RED tests for the original fix) stopped at its
40-turn limit with a partial report; rather than `SendMessage`-resuming it,
its actual on-disk output was verified directly (ran the tests, read the
diff) and found complete and correct, so the task continued without a
resume.

Compaction events: 1 compaction, partially recovered via handoff. Mid-session,
the model identity switched (Opus 5 → Sonnet 5) and the git-commit attribution
instructions changed with it — ordinary conversation context carried through
cleanly (the session picked the PR-comment/should-fix-ack flow back up with
no loss of decision history). What did **not** survive: `EnterWorktree`'s
ownership tracking for the linked worktree entered earlier in the session —
`ExitWorktree({action: "remove"})` refused post-compaction with "this session
is not the owner," forcing the documented `keep` + manual
`git checkout main && pnpm worktree:remove` fallback.

## What went as planned

- **RED failed for the right reason, both rounds.** The original fix's RED
  tests failed on `underlyingErrnoCodeOf is not a function`
  (import/type-level, not logic) plus two `errno`-value assertions failing
  with the pre-fix duplicate `ERR_CONSOLE_INTERNAL`; the hardening round's
  hostile-link tests failed with the actual raw "hostile" error escaping
  uncaught — exactly the defect each was written to lock.
- **GREEN was clean on both implementer passes.** Neither `code-implementer`
  dispatch needed a re-dispatch after its own verify step; both landed
  eslint/prettier/typecheck-clean on the first report.
- **All local review spokes returned no Must-fix**, across five dispatches
  (three on the original fix, two on the hardening round).
- **The doc-provenance and ADR-provenance re-stamping (`pnpm sync:docs`)
  never needed a manual fix** — three runs across the PR's lifetime, all
  15/15 steps green, only stamp fields (blob SHAs, `verifiedAt`) ever
  changed.
- **The squash-merge branch-deletion refusal was anticipated, not a
  surprise.** `git branch -d`/`pnpm branch:cleanup` both correctly refused
  (a squash commit is never a literal ancestor), and the tree-diff check
  (`git diff origin/main <branch>` — empty) confirmed nothing would be lost
  before force-deleting.

## What didn't go as planned, and why

### 1. A clean rebase across an in-flight upstream specifier migration broke typecheck with no conflict reported

Mid-PR, `origin/main` picked up #1234 (a separate PR migrating
`m3l-console-server` off the transitional `@m3l-automation/m3l-common`
alias onto `@monte3l/m3l-common`). Rebasing this branch onto it produced
**zero conflicts** — git saw no overlapping lines, because this branch's
new code (`errno.ts`, `errno.test.ts`) used the old specifier only on lines
this branch itself had added, which #1234 never touched. Typecheck then
failed with `TS2307: Cannot find module '@m3l-automation/m3l-common'` on
both files. Two spokes (`code-implementer` for `src/`, `test-author` for
the test) fixed the three import lines in parallel.

**Why it happened:** A conflict-free rebase only proves the two branches
didn't edit the same lines — it says nothing about whether a cross-cutting
rename/specifier migration on one side invalidates code the other side
added independently. Git's merge algorithm has no way to know the two
changes are semantically related.

**Fix for future:** After any rebase that crosses a cross-cutting
migration PR (specifier renames, symbol renames, API moves) — not just when
git reports a conflict — run the affected package's `typecheck` before
trusting "successfully rebased" as sufficient. This recurred later in the
same PR (see item 2) and was caught the same way both times.

### 2. The same clean-rebase-breaks-typecheck pattern recurred on the second rebase

Before pushing the hardening-round commit, the branch was rebased onto
`origin/main` again (one new, unrelated docs-only commit had landed).
Having already been burned once by item 1, `pnpm --filter
./packages/m3l-console-server typecheck` was run proactively after this
rebase even though the new upstream commit touched no shared files — it
passed clean this time, but the check was a five-second cost against a
repeat of item 1's failure mode.

**Why it happened:** Same root cause as item 1 — the fix for item 1 was
"add this check as standard practice going forward," and this is that
practice actually being followed.

**Fix for future:** Already captured in item 1's fix; no new action needed.
This item exists to record that the practice held under a repeat.

### 3. Round 2 of the PR review surfaced a real, non-trivial Should-fix that round 1 missed

Round 1's Should-fix ("`errno.ts`'s bound reads one wasted extra `.cause`")
was small and mechanical. Fixing it introduced `inspectCauseLink`, a new
helper doing per-link `instanceof`/`errnoCodeOf` checks — round 2 then
found that helper's own checks were unguarded: a hostile cause-chain value
(a throwing `code` getter, or a Proxy with a throwing `getOwnPropertyDescriptor`
or `getPrototypeOf` trap) could make `underlyingErrnoCodeOf` itself throw,
escaping through `runCleanup`'s unguarded `failures.map(toCleanupFailure)`
and replacing the sweep's own `ERR_CONSOLE_INTERNAL` with the raw hostile
error. This was fixed with a per-link `try`/`catch` (`inspectCauseLink`)
plus the same guard one layer up in `cleanup.ts` (`consoleErrorCodeOf`),
locked by four new hostile-link unit tests and two new `runCleanup`-level
tests — one of which required finding the one driver seam
(`pruneRunOutputs`' `repository.get`) that propagates a raw, unwrapped
error, since every other driver already wraps its failures cleanly.

**Why it happened:** Round 1's fix added new code (the bound-precision
change) whose own new failure surface (unguarded per-link checks) only
became reviewable once it existed — round 1 couldn't have found a defect in
code that round 1's own fix was about to introduce.

**Fix for future:** When a Should-fix's correct fix is itself a refactor
extracting new logic (here, a new per-link inspection loop), treat that new
logic as a fresh review surface, not merely a corrected version of the old
one — a second review round finding something in the fix's own fix is not a
process failure to prevent, but the expected shape of iterative hardening.

### 4. Round 2's remaining Should-fix (CLI-wrapper test coverage) required a real design call, not a line fix

Round 2 verdicted PASS but flagged that `bin/m3l-console-server.mjs`'s new
`context.failures` stderr-printing block has no test coverage anywhere in
the package. Investigating confirmed: no test in this repo spawns a
package's own `bin/*.mjs` entry point (checked `m3l-cli`'s bin too — same
gap), and this package's tests never build `dist`. Closing the gap needs
either new build-coupled spawn-test infrastructure, or extracting the print
formatting out of the deliberately-thin `.mjs` wrapper into `src/` — both
are design decisions, not targeted fixes, and this exact tradeoff had
already been named as a deliberate, known limitation in the PR's original
body under "Known gaps." Per the `resolving-pr-comments` skill's Boundary
rules, a Should-fix requiring a structural change is skipped rather than
guessed at — it was left unaddressed and documented in a PR comment instead.

**Why it happened:** The original implementation design (keep `bin/*.mjs`
thin and untested, put all testable logic in `src/`) was a deliberate,
already-reviewed tradeoff from before the PR was even opened. A later
review round re-surfacing the same known gap as a fresh Should-fix doesn't
mean the earlier decision was wrong — it means the bot has no memory of a
PR body's own "Known gaps" section.

**Fix for future:** When a PR body already documents a deliberate,
known-and-accepted gap, expect a review bot to re-flag it anyway (it reads
the diff, not necessarily the PR body's prose in full context) — this is
not a sign the gap needs to be closed, just a sign to re-confirm the
original reasoning still holds and acknowledge it explicitly rather than
silently re-litigate the design each round.

### 5. Landing the round-2 acknowledgment required weighing a scarce-resource tradeoff, resolved by asking

`should-fix-ack` (a non-required, dogfood-period check) went red the moment
round 2's Should-fix posted with no acknowledgment commit yet. The
mechanical fix — push an `--allow-empty` commit with an
`Acknowledged-Should-Fix:` footer — conflicts with a documented risk from a
different skill (`creating-prs` Step 15): the PR was already
`mergeStateStatus: UNSTABLE` / `mergeable: MERGEABLE` (not `BLOCKED`), so
that push would spend the last of `MAX_REVIEW_ROUNDS: 3` review rounds
purely to clear a check that wasn't currently blocking anything — with the
documented failure mode of a third round finding something new and flipping
a cleanly mergeable PR to `BLOCKED` with no rounds left. Rather than
resolve this silently either way, the tradeoff was put to the user
directly via `AskUserQuestion`; the chosen path was to merge without the
push, documenting the skip in a PR comment instead of a commit footer.

**Why it happened:** Two governing documents (`resolving-pr-comments`'
literal Step 9 requirement, and `creating-prs`' Step 15 caution) give
opposite defaults for the identical situation — one scoped to "how does
`resolving-pr-comments` normally close a Should-fix," the other scoped to
"how does spending a review round actually behave" — and neither
explicitly resolves the conflict when both apply at once.

**Fix for future:** When `should-fix-ack` fails but `mergeStateStatus` is
already `MERGEABLE`/`UNSTABLE` and review rounds are scarce (2 of 3 or
higher already spent), this is a genuine judgment call the two skills
don't fully harmonize — treat it as a stop-and-ask case rather than picking
a default, and record the PR-comment-only acknowledgment path as the
accepted alternative when the user chooses not to spend the round.

## Insights

- **A conflict-free rebase is not a safety signal across a specifier/rename
  migration.** Git's no-conflict result only means the two branches didn't
  touch the same lines — it says nothing about whether one branch's new
  code depends on a name the other branch just renamed underneath it.
  Typecheck (or an equivalent build step) after any rebase that crosses a
  known migration PR, not just after one that reports conflicts.
  _(promoted → .claude/skills/resolving-pr-comments/SKILL.md)_
- **A Should-fix's own fix can introduce a fresh review surface.** When
  resolving a finding requires adding new logic (not just tightening
  existing logic), expect the next review round to find something in that
  new logic — this is iterative hardening working as intended, not a sign
  the first fix was incomplete.
- **A PR body's "Known gaps" section doesn't prevent a bot from re-flagging
  the same gap.** A review bot reasons over the diff, not necessarily a PR
  body's full prose context; a deliberate, already-documented limitation
  should be re-confirmed and acknowledged each time it resurfaces, not
  treated as a process failure.
- **`resolving-pr-comments`' mandatory acknowledgment-commit step and
  `creating-prs`' scarce-review-round caution can directly conflict** — a
  PR that's `MERGEABLE`/`UNSTABLE` (not `BLOCKED`) with a non-required
  `should-fix-ack` failing, on a late review round, is exactly the
  intersection neither skill's text resolves alone. This is a stop-and-ask
  case, with "acknowledge via PR comment instead of a commit footer, then
  merge" as the accepted fallback when the user declines to spend the
  round.
- **A mid-session compaction can silently drop tool-level ownership state
  (e.g. `EnterWorktree`) even when conversational context otherwise
  survives.** `ExitWorktree({action: "remove"})`'s explicit
  "not the owner" refusal — and its own documented `keep`-then-manual-cleanup
  fallback — is exactly the intended recovery path; treat the refusal as
  expected post-compaction behavior, not a bug to work around.
- **This box needed a per-command `--signingkey` for every commit** (no
  `~/.config/git/local.gitconfig`), matching CLAUDE.md's documented
  "must be created by hand on the Ubuntu/WSL box" gap. Left for the repo
  owner to fix permanently, since it's outside this task's scope.
