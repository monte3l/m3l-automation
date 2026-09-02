# Work log — statusline-widgets (2026-09-02)

This log covers issue #879: broadening `.claude/hooks/statusline-context-pressure.mjs`
from a single `ctx NN%` segment into a 4-line, multi-widget statusline. It ran
through `starting-work` → parallel `test-author`/`code-implementer` spokes →
`code-reviewer`/`silent-failure-hunter` review → a fix-batch round → `pnpm
verify` → `syncing-docs` → `creating-prs` → `finishing-work`. Records what
shipped, what matched the plan, three divergences (two gate-command misses, a
stale type-checking claim in this repo's own rules, and a real push-vs-auto-merge
race during close-out), and durable lessons.

Plan of record: `~/.claude/plans/on-issue-879-dreamy-pearl.md` (a session-local
plan-mode file, not committed to `docs/plans/` — this task's scope didn't clear
the archival bar for a durable `docs/plans/archive/` entry).

## Summary

- **Files changed**: `.claude/hooks/statusline-context-pressure.mjs` (+534),
  `bin/tests/statusline-context-pressure.test.ts` (+708), `.claude/settings.json`
  (`refreshInterval: 30`), `docs/contributing/hooks-reference.md`,
  `docs/contributing/host-resources.md`. 5 files, 1255 insertions / 55 deletions.
- **New exports**: 18 pure formatter functions (`formatContextBar`,
  `formatModelSegment`, `formatEffortSegment`, `formatTokenCount`,
  `formatSessionUsage`, `formatDuration`, `formatResetCountdown`,
  `formatWeeklyReset`, `formatCacheWidget`, `parseHeadRef`,
  `parseGitdirPointer`, `resolveBranch`, `formatBranch`, `formatWorktreeAndPr`,
  `formatAgentSegment`, `formatOriginRepo`, `formatFreeMemory`) plus
  `buildLine1`–`buildLine4`, 12 exported color constants, and `SEGMENT_JOIN`.
  All 5 pre-existing exports kept their exact signature/behavior;
  `renderStatusLine(payload, env = {})` gained an optional second parameter.
- **Tests**: 123 (up from 113 pre-existing), every new export covered on
  happy/absent/failure paths, plus 9 regression tests added for the fix-batch
  round.
- **Gates**: `pnpm verify` — 57 passed, 10 skipped (push-only/CI-only), 0
  failed, on the second full run (first run caught a Prettier formatting miss
  and a `tsc` error, both fixed — see divergence #1).
- **Follow-up filed**: issue #889 (deferred `/usage`-API weekly-usage
  widgets).
- **PR**: [#892](https://github.com/monte3l/m3l-automation/pull/892) — merged
  (squash). This work log and the `tests.md` correction (this very commit)
  landed too late to make that PR — GitHub's auto-merge fired against #892's
  first-push state before the second `git push` (carrying this commit)
  completed, so they ship instead via a follow-up PR — see divergence #3.
- **Skills used**: starting-work, writing-commits, creating-prs, syncing-docs,
  writing-work-logs, finishing-work.
- **Spoke incidents**: none — `tmp/session-incidents.jsonl` absent (no
  truncations), no review-spoke stall over 15 min (longest was ~5.5 min), no
  `SendMessage` resumes needed. 6 spokes dispatched total: 2×`test-author`,
  2×`code-implementer`, `code-reviewer`, `silent-failure-hunter`,
  `docs-consistency-reviewer` (7, correcting the count above).
- **Compaction events**: none.

## What went as planned

- **Parallel test-author/code-implementer dispatch from one locked contract
  converged cleanly.** Both spokes were given the identical, fully-specified
  function contract (exact algorithms, ANSI codes, example outputs) and told
  explicitly not to wait on or read each other's work. `test-author` reported
  landing second and finding the contract already implemented — GREEN
  instead of the expected RED — with zero behavioral drift between the two
  independently-authored halves. The precision of the shared spec, not
  sequencing, is what made this work.
- **Live-run verification caught nothing new**, because the contract given to
  both spokes already specified defensive behavior (fail-soft on absent/null
  fields) in detail. The `harness-artifacts.md`-mandated live run against the
  documented full-schema payload, a near-empty `{}` payload, an early-session
  null-fields payload, and malformed JSON all rendered correctly and quietly
  on the first try.
- **The rebase in `creating-prs` Step 2 was a genuine no-op modulo history.**
  3 commits behind `origin/main`, clean rebase, no conflicts, signature
  intact, `post-integrate-regen` reported nothing to reconcile.
- **`syncing-docs`'s composite `pnpm sync:docs` passed all 13 steps** with a
  zero-diff working tree after — this PR touches no submodule/export surface,
  so the reconciliation was purely confirmatory.

## What didn't go as planned, and why

### 1. `pnpm verify` failed twice after the fix-batch round, for reasons the spoke prompts didn't anticipate

After the two fix-batch spokes (`code-implementer` patching three review
findings, `test-author` adding regression tests) both reported clean, the
first full `pnpm verify` run failed at Format check: the `code-implementer`
fix-batch edit had left `.claude/hooks/statusline-context-pressure.mjs`
Prettier-dirty (the spoke's instructions said "run `node --check`" but not
"run Prettier"). Fixed with `prettier --write` and re-verified tests still
green. The second `pnpm verify` run then failed at Type-check:
`bin/tests/statusline-context-pressure.test.ts:644` called
`resolveBranch(readFile, null)` to test the non-string-`startDir` path, but
`resolveBranch`'s JSDoc typed `startDir` as `string`, so a real `tsc -p
bin/tsconfig.json` error surfaced (TS2345). Fixed by widening the JSDoc to
`@param {unknown} startDir` — correct, not a workaround, since the function
genuinely handles non-string input by design.

**Why it happened:** Both fix-batch spoke prompts specified `node --check`
(syntax only) as the verification step, not the actual gates (`prettier
--check`, `tsc`) that `pnpm verify` runs. Neither spoke was told those gates
exist for this file, because the hub hadn't yet re-derived that `bin/tsconfig.json`
type-checks `bin/tests/**` (see divergence #2) at the time those prompts were
written.

**Fix for future:** A fix-batch or implementation spoke prompt for anything
under `.claude/hooks/**` or `bin/**` should specify the exact local commands
that mirror the real gates (`pnpm exec prettier --check <file>`, and if the
change touches a `.mjs`'s exported JSDoc signature, `pnpm typecheck`) rather
than a syntax-only proxy like `node --check`. The hub caught both misses at
its own `pnpm verify` gate before push, so nothing shipped broken — but two
avoidable round-trips were spent on it.

### 2. `.claude/rules/tests.md`'s claim that `bin/tests/**` "is not type-checked by any gate" is stale

That rule file states, verbatim: "`bin/tests/**` is not type-checked by any
gate. `pnpm typecheck` runs `tsc` per package via turbo, and no `tsconfig`
includes `bin/tests`, so a real type error there passes CI silently." This
was directly contradicted mid-session: `pnpm typecheck` (`package.json`'s
script is `turbo run typecheck && tsc -p bin/tsconfig.json`) DOES type-check
`bin/tests/**/*.ts` via `bin/tsconfig.json`'s `include: ["tests/**/*.ts",
"**/*.mjs"]` — confirmed by the real TS2345 error in divergence #1 above,
which `pnpm typecheck` caught cleanly.

**Why it happened:** The rule was presumably accurate when written (perhaps
before `bin/tsconfig.json` existed or before its `include` was extended to
cover `tests/`), and nothing re-verifies a rule file's claims against current
`package.json`/`tsconfig` state — rules are trusted prose, not gated
assertions.

**Fix for future:** Corrected in this same change set —
`.claude/rules/tests.md` now states that `bin/tsconfig.json` DOES type-check
`bin/tests/**/*.ts` via the top-level `pnpm typecheck` script's
non-turbo `tsc -p bin/tsconfig.json` invocation (with `checkJs: false` on the
`.mjs` internals it also includes), so a real type error there is caught, not
silent — and that a per-package `turbo run typecheck` alone won't see it.
Originally deferred to a separate docs-only PR per ADR-0072's docs-vs-code
split discipline; the user asked for it to land in the same PR as the feature
instead of a later follow-up (#892 at the time) — it ended up in a genuine
follow-up PR anyway, but because of the race in divergence #3, not by design.

### 3. The second push (carrying this commit) lost a race with GitHub auto-merge, then compounded when the worktree was removed mid-hook

After committing the work log and `tests.md` correction, `git push` was
backgrounded (branch `feat/statusline-widgets`, PR #892 already open with
auto-merge presumably enabled). While that push's pre-push hook was still
running its multi-minute `lint`/`typecheck`/`test` lanes, the user reported
"#892 got auto-merged" — GitHub had merged the PR against its state as of the
_first_ push, before the second push's commit ever reached the remote. The
`finishing-work` close-out then ran `pnpm worktree:remove statusline-widgets`,
which deleted the linked worktree directory — the same directory the still-running
backgrounded push's pre-push hook was executing inside. `node_modules`
vanished out from under `eslint`/`vitest`/`tsc` mid-run
(`Cannot find module '../package.json'`, then `chdir: no such file or
directory` for the `test`/`typecheck` lanes), and the push failed outright.
Recovery: the commit was never lost (it lived in the local git object
database, reachable from the kept — not deleted — local branch pointer;
`worktree:remove` only removes the _worktree_, not the branch when `git
branch -d` refuses it as unmerged-by-ancestry). Rebuilt as a fresh branch off
the now-current `main` (which already contained the squash-merged first
commit) and cherry-picked the orphaned commit onto it — clean, no conflicts,
signature intact.

**Why it happened:** Two independent assumptions broke at once. First,
backgrounding a `git push` and then immediately treating "the user says it
merged" as license to run destructive cleanup (`finishing-work`'s worktree
removal) without first confirming the _backgrounded push itself_ had finished
— the skill's own Step 1 verifies the PR merged, but nothing in the flow
checks whether an unrelated in-flight background job depends on the very
directory a later step is about to delete. Second, GitHub auto-merge acts on
whatever HEAD a PR has _at the moment its required checks pass_, not
necessarily the latest commit the author intended to include before merge —
a second push made after opening the PR is not guaranteed to land before an
armed auto-merge fires.

**Fix for future:** Before running any destructive `finishing-work`/cleanup
step on a worktree or branch, check for a still-running backgrounded command
scoped to that same directory (this session had no ready-made way to query
that; treat any recent `run_in_background` Bash call touching the target path
as a hold until it reports done, exactly like the `Agent`-tool background
convention). Separately: once a PR has GitHub auto-merge armed, a further
`git push` to update it is racing the merge, not safely queued behind it — if
a follow-up commit must land in the _same_ PR, either disable auto-merge
first, or accept upfront that it may miss the window and need a follow-up PR
instead of treating that as a failure.

## Lessons learned

- **A locked, fully-specified contract lets parallel writer spokes converge
  without coordination.** Giving `test-author` and `code-implementer` the
  identical algorithm-level spec (not just "implement X") meant a genuine
  landing race produced zero drift — worth doing again whenever a feature's
  design is settled enough to write exact function bodies before dispatch,
  not just after.
- **Fix-batch spoke prompts need the real gate commands, not a syntax-only
  proxy.** `node --check` catches parse errors, not Prettier formatting or
  `tsc` type errors — both of which `pnpm verify` gates on. Name the actual
  `pnpm exec prettier --check`/`pnpm typecheck` commands in any spoke prompt
  that edits a file under a real CI gate, even a `.claude/hooks/**` script
  most contributors assume is ungated.
- **A rule file's claim about what "is/isn't gated" needs periodic
  re-verification against `package.json`, not just trust.** `.claude/rules/tests.md`'s
  "bin/tests/** is not type-checked by any gate" was wrong by the time this
  task hit it — see divergence #2 above. _(promoted → .claude/rules/tests.md)_
- **`ScheduleWakeup` is redundant for harness-tracked background work.**
  Twice in this session a wakeup was scheduled to "check on" a running Agent
  or backgrounded `git push`, both of which already deliver an automatic
  task-notification on completion — both wakeups were immediately cancelled
  as unnecessary. The tool's own guidance says this explicitly; worth a
  conscious pause before calling it for anything already tracked by the
  harness.
- **Widening a JSDoc `@param` type to match what the function actually
  defends against (not narrowing the test to match a too-strict type) is the
  correct fix when a defensive function's real contract is broader than its
  annotation.** `resolveBranch`'s body already checked `typeof startDir !==
"string"`; the type annotation was simply behind the implementation.
- **A backgrounded push can lose the race against both GitHub auto-merge and
  a later `finishing-work` cleanup step in the very same session.** "The PR
  merged" only confirms the PR merged — not that every command this session
  started against that branch/worktree has finished. `pnpm worktree:remove`
  deleted the directory a still-running backgrounded push's pre-push hook was
  executing inside, crashing it mid-lane; the commit survived (git object
  database + kept branch pointer) but had to be rebuilt as a follow-up PR via
  cherry-pick. See divergence #3. _(promoted → .claude/skills/finishing-work/SKILL.md)_
