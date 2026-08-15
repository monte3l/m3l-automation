# Work log — ADR-0034 cognitive-complexity refactor (2026-08-15)

This log covers issue #335: a dedicated test-safety-net-first refactor of the
two functions ADR-0034 accepted as cognitive-complexity debt —
`M3LAWSCredentialsManager.retryWithRelogin` (`aws/credentials/manager.ts`) and
`M3LRetryRunner.run` (`core/polling/M3LRetryRunner.ts`) — closing the gap
`sonarjs/cognitive-complexity` flagged since the ADR-0034 lint-gate rollout.
Records what shipped, what matched the plan, what diverged, and durable
lessons for the next complexity-debt refactor.

Plan of record: [`on-issue-335-peppy-whale.md`](https://github.com/monte3l/m3l-automation/pull/432)
(plan-mode file, not archived — see Step 4 below for why).

## Summary

- **`retryWithRelogin`**: cognitive complexity 20 → 3 (allowed 15). Extracted
  a module-private `profileSuffix` helper (collapsing a duplicated ternary)
  and a private `reloginOrThrow` method (absorbing the catch body's
  error-classification/relogin logic). Public signature and TSDoc unchanged.
- **`M3LRetryRunner.run`**: cognitive complexity 17 → 9 (allowed 15).
  Introduced a module-private `ResolvedRetryAction` discriminated union +
  `resolveAction` function, eliminating two `as` casts previously justified
  only by branch ordering; then extracted a module-private `DelayProgression`
  class (per-`run()`-call-scoped) owning the backoff-vs-override delay
  selection. A should-fix review finding added an exhaustiveness tripwire
  (`const _exhaustive: never = advice.decision`) to `resolveAction`.
- Both `eslint-disable-next-line sonarjs/cognitive-complexity` suppressions
  deleted — `reportUnusedDisableDirectives: "error"` makes this
  machine-verified, not just claimed.
- 20 characterization tests landed **before** any `src/` edit: 10 in
  `credentials.test.ts` (64 → 74), 11 in `polling.test.ts` (125 → 136).
- Final state: 11 commits (2 test, 5 refactor, 4 docs), `pnpm verify` 37/37
  runnable steps green, both files individually clear the coverage gate
  (manager.ts 100%/97.1%/85.2% fn/stmt/br; M3LRetryRunner.ts 100%/100%/100%),
  positive-control eslint runs confirmed the exact predicted scores (3, 3, 9).
  ADR-0034 amended, `IMPLEMENTATION.md` tracker row flipped `Deferred` →
  `Done`. PR #432 opened, `MERGEABLE`.
- Skills used: starting-work (via `/starting-work` command), syncing-docs
  (×3), creating-prs, writing-work-logs.
- Spoke incidents: none (0 truncations / 0 stalls / 0 resumes — every
  dispatched agent returned a complete report on its first run).

## What went as planned

- **The Explore fan-out + Plan-agent design pass produced load-bearing
  arithmetic.** Three parallel Explore agents (per-function source, per-file
  tests, refactoring/agent-model conventions) plus one Plan agent modeled
  SonarJS's cognitive-complexity scoring by hand and reproduced both reported
  baseline scores (20 and 17) exactly before any code was touched. Every
  later positive-control eslint run matched the plan's predicted numbers
  (3, 3, 9) precisely — the arithmetic held up against the real tool.
- **Concurrent test-author dispatch on two independent files caused zero
  contention.** Both characterization-test spokes wrote to
  `credentials.test.ts` and `polling.test.ts` in the same working tree at the
  same time with no worktree isolation, and no file collision occurred.
- **Concurrent code-implementer dispatch for the two independent refactors
  (manager.ts vs. M3LRetryRunner.ts) produced clean, non-tangled commit
  history.** Both spokes ran `git add <their file>` + `git commit` in the
  same shared working tree concurrently; `git log`/`git show --stat`
  afterward confirmed every commit touched exactly one file with no
  cross-contamination.
- **The 6-way parallel review round (3 reviewers × 2 diffs) returned 5 clean
  passes and exactly one legitimate should-fix**, with no reviewer
  manufacturing a nit to have something to say. The one real finding
  (`resolveAction`'s missing exhaustiveness tripwire) matched an idiom
  already used in 8 other places in the codebase, cited by file/line.
- **RED-phase characterization tests were green on the first run** against
  unmodified source in both files (74/74 and 136/136) — no wrong-assertion
  debugging loop was needed before the refactor could begin.
- **GREEN was clean on every implementer dispatch.** All five refactor
  commits (profileSuffix, reloginOrThrow, ResolvedRetryAction/resolveAction,
  DelayProgression, exhaustiveness tripwire) passed lint/typecheck/tests on
  first delivery — no re-dispatch for a broken build was needed.

## What didn't go as planned, and why

### 1. Splitting a single shared doc-count file across two independent test commits required manual patch surgery

The plan called for commit 1 (credentials tests) to bump only the
`credentials` row's test count in `docs/implementation-status.md`, and commit
2 (polling tests) to bump only the `polling` row — but both test-author
spokes independently edited the same file's different rows, leaving both
edits in the working tree together. `git add -p` has no clean non-interactive
equivalent for a two-hunk file where each hunk is one enormous single-line
table row, so committing them separately required hand-splitting the full
diff into two patch files and applying each with `git apply --cached`
(validated first against the index with `--check`, since a working-tree
`--check` fails once the tree already has both changes applied).

**Why it happened:** `docs/implementation-status.md` is a single append-only
table shared by every submodule, so two parallel spokes touching different
rows of the same file is structurally unavoidable when the plan wants two
separate atomic commits and `check:test-counts` requires the doc bump to land
in the same commit as its test file.

**Fix for future:** When dispatching two parallel test-author spokes that
must each bump a different row of the same shared doc file for separate
commits, expect to hand-split the doc diff via `git apply --cached` on
per-hunk patch files rather than a plain `git add <path>` — plan for this
step explicitly instead of discovering it live.

### 2. A downstream reviewer caught a subtly inaccurate code comment introduced by an earlier fix

The should-fix commit (exhaustiveness tripwire) added a comment claiming an
off-vocabulary `decision` value from an untyped JS caller "degrades to
`unknown` at runtime, exactly as before." `spec-conformance-reviewer`,
dispatched later in the `creating-prs` pre-push fan-out, traced the
pre-refactor code path by hand and found the claim was not literally true:
the old code let a raw out-of-vocabulary string leak into a
`retry:scheduled` payload's `classification` field, whereas the new code
normalizes it through `unknownDecision` — a behavior _improvement_ at that
edge case, not an exact match. A one-line comment-only fix commit corrected
the claim.

**Why it happened:** The should-fix dispatch prompt described the desired
runtime behavior (preserve the fallback) precisely but not the _comparison
claim_ to make in the comment; the implementer wrote a plausible-sounding
"exactly as before" without independently re-deriving the pre-refactor
fallthrough path for an off-vocabulary value.

**Fix for future:** When a dispatch prompt asks an implementer to add a
comment characterizing "old vs. new" behavior at an edge case, either supply
the exact old-path trace in the prompt or explicitly flag the claim as
needing independent verification — a plausible equivalence claim is easy to
write and easy to get subtly wrong for a path no test exercises.

## Lessons learned

- **Model the lint tool's scoring algorithm by hand before promising a
  target number.** Reproducing SonarJS's exact complexity arithmetic during
  the design pass (not just estimating "should be lower") meant every later
  positive-control eslint run matched the prediction exactly, with zero
  surprise mid-refactor. Worth doing for any numeric lint/coverage gate a
  refactor plan commits to hitting.
- **Two spokes writing to different files (or different rows of one shared
  file) in the same working tree concurrently is safe for source, risky for
  a single shared doc file.** `credentials.test.ts`/`polling.test.ts` and
  `manager.ts`/`M3LRetryRunner.ts` split cleanly with zero contention; the
  shared `docs/implementation-status.md` needed manual patch-splitting to
  commit each row independently. Plan for the doc-file case explicitly.
- **`reportUnusedDisableDirectives: "error"` turns "delete the suppression"
  into a forced same-commit step, not an optional cleanup.** This made the
  commit sequencing decision (extraction + suppression removal must be one
  commit, never split) mechanically enforced rather than a style choice —
  worth calling out explicitly in any future plan that removes a lint
  suppression under this config. _(promoted → .claude/rules/refactoring.md)_
- **A late-pipeline conformance/consistency reviewer is a good backstop for
  "old vs. new behavior" claims baked into comments by an earlier fix.**
  `spec-conformance-reviewer`'s independent re-derivation of the pre-refactor
  code path caught an inaccurate comparison claim that three earlier
  reviewers (scoped to the code's correctness, not comment accuracy) had no
  reason to check.
- **Positive-control gate checks (deliberately lowering a threshold to
  confirm the tool still sees the target) are cheap and worth the extra
  command.** Three separate `--rule` overrides confirmed the exact measured
  scores matched the plan's arithmetic and that the suppression removal
  wasn't accidentally masked by some other config — cheap insurance for a
  refactor whose entire point is a numeric gate.
