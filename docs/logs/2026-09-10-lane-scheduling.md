# Work log — `lane-scheduling` (2026-09-10)

P3.5 of the adaptive-host-budgeting wave (Stage 3, Phase 2 tuning candidate 5):
named `--isolated`/`--concurrent` lane-concurrency modes for
`bin/verify-all.mjs`, and switched `bin/setup-host-resources.mjs`'s
`lefthook-local.yml` serial-pre-push decision from a static 20 GiB RAM
threshold to the same host-derived lane budget (`deriveBudget(detectHostProfile())`)
the `verify` script's own `--jobs` default already resolves to. Records what
shipped, the design clarification round that preceded implementation, the
post-push bot finding the pre-push review missed, and the resulting insights.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

- `bin/verify-all.mjs`: new exported `resolveJobsMode(argv, defaultJobs)`.
  `--isolated` forces `jobs=1` unconditionally (wins over an explicit
  `--jobs=N`); `--concurrent` is a documented no-op synonym for the existing
  host-derived default. Wired into `main()` in place of the direct
  `parseJobsArg` call.
- `bin/setup-host-resources.mjs`: `shouldSerializePrePush` and
  `buildLefthookLocalOverride` changed signature from a raw `totalMemGiB`
  number to a `HostBudget` object; step 7 now computes
  `deriveBudget(detectHostProfile({ sessions: opts.sessions }))` and decides
  serial-vs-parallel on `concurrentLaneWorkers <= 1` instead of a fixed RAM
  threshold. Removed the now-dead `SERIAL_PREPUSH_MEM_THRESHOLD_GIB`
  constant.
- `docs/contributing/host-resources.md`: updated the `lefthook-local.yml` row
  to describe the derived-budget trigger.
- `bin/lib/command-catalog.mjs`: `verify` script description mentions the two
  new flags.
- **Live-verified on the real host** (23.4 GiB RAM, 4 cores) before any test
  was written: `--sessions=2` (the default) now correctly forces serial
  pre-push (`concurrentLaneWorkers=1`), where the old RAM-only check
  (23.4 GiB ≥ 20 GiB) would have wrongly left it parallel — a genuine
  behavior fix, not just a refactor. `--sessions=1` confirmed parallel stays
  enabled (`concurrentLaneWorkers=2`). `resolveJobsMode`'s precedence
  (`--isolated` > explicit `--jobs=N` > `--concurrent`/default) verified
  directly via a one-off Node script before dispatching tests.
- Tests: `bin/tests/verify-all.test.ts` (`resolveJobsMode`, 6 cases) and
  `bin/tests/setup-host-resources.test.ts` (`shouldSerializePrePush`/
  `buildLefthookLocalOverride` rewritten around `HostBudget` fixtures) — 2
  files, 63/63 passing, `tsc -p bin/tsconfig.json` clean, ESLint clean.
- `pnpm verify`: 72 passed / 10 skipped (push-only/e2e) / 0 failed, on both
  the implementation push and the should-fix-ack follow-up push.
- PR #1172, opened, reviewed, merged 2026-09-10T20:58:39Z.

**Skills used:** starting-work, resolving-pr-comments, writing-work-logs.

**Spoke incidents:** none — `tmp/session-incidents.jsonl` absent; both the
`test-author` and `code-reviewer` dispatches completed in a single clean pass
with no truncation, stall, or `SendMessage` resume.

**Compaction events:** none during this task.

## What went as planned

- **The terse plan-doc row's ambiguity was resolved before any code was
  written.** P3.5's landing-plan row ("lane scheduling (`--concurrent` vs
  `--isolated`, lefthook seam)") had no fuller design detail recoverable from
  disk — a `grep` across `docs/plans/` and ADR-0080 turned up nothing beyond
  the row itself. Two rounds of targeted `AskUserQuestion` calls (flag scope,
  what the "lefthook seam" should actually change, whether `lefthook.yml`'s
  command structure itself should change, what should replace the RAM
  threshold) converged on a coherent, minimally-scoped design before the
  first edit, rather than guessing and rediscovering scope mid-implementation.
- **`resolveJobsMode`'s precedence logic was correct on the first
  implementation** — live-verified via a one-off Node script (isolated wins
  over an explicit `--jobs`, concurrent is a true no-op) before any test was
  written, per the harness-artifacts.md discipline, and every case reproduced
  exactly in the tests afterward.
- **`test-author`'s backfill-mode dispatch was clean** — both source files
  were already implemented and live-verified when the test-author was
  dispatched to write/rewrite the covering tests; it needed no correction
  round, delivered 63/63 passing plus clean `tsc`/ESLint on the first pass.
- **The pre-push `code-reviewer` spoke correctly caught one real Should-fix**
  (stale `docs/contributing/host-resources.md` prose describing the just-removed
  RAM threshold) with zero Must-fix items, and correctly confirmed the
  `--sessions=N` semantics weren't silently regressed by the `HostBudget`
  refactor.
- **`pnpm verify` passed cleanly on both pushes** — no gate had to be
  re-run or debugged.

## What didn't go as planned, and why

### 1. The post-push bot caught a doc-comment overclaim the pre-push reviewer missed

`code-reviewer`'s pre-push pass verified the mechanism was correct (the
`--sessions=N` semantics, the precedence logic, no dangling references to the
removed constant) and returned a clean verdict on that front. After push,
`claude-pr-review.yml`'s bot found a different problem in the same code: the
JSDoc on `shouldSerializePrePush` and the step-7 header comment both claimed
the pre-push serialization decision and `pnpm verify`'s `--jobs` default
"can never disagree" because they read the same derived signal — but they
don't share the same _input_. `bin/setup-host-resources.mjs` budgets for
`opts.sessions` (default 2, an explicit "plan for N sessions" value via
`--sessions=N`), while `bin/verify-all.mjs`'s own default calls
`detectHostProfile()` with no override, so it falls back to the _live_
process count. On a host running a different number of sessions than the
planned budget, the two decisions can genuinely diverge. This triggered
`should-fix-ack` (ADR-0097) on the PR; resolved via `/resolving-pr-comments`
— weakened both comments to describe the actual relationship (same formula,
different session-count semantics) instead of overclaiming exact agreement,
verified with `pnpm verify`, committed with an `Acknowledged-Should-Fix:`
footer, and pushed.

**Why it happened:** the pre-push review verified code _correctness_
(does the mechanism work) but did not independently re-derive the _strength_
of a comment's own claim by tracing both call sites' actual arguments —
"same signal" is true, "can never disagree" is a stronger claim that needed
checking against each caller's actual inputs, not just the shared formula.

**Fix for future:** when writing a doc comment that asserts two
independently-computed values will always agree (or "can never disagree"),
explicitly trace each call site's actual inputs before asserting equivalence
— a shared formula does not imply shared inputs, and a reviewer verifying
mechanism correctness can pass over an overclaim in the surrounding prose
unless prompted to check the claim's wording specifically.

### 2. First landing-plan row edit used a status token outside this table's vocabulary

While filling in P3.5's `Branch` column after opening the PR, the first draft
also set `Status` to `In review (PR #1172)` — but every other row in this
wave's landing-plan table uses only `Done`/`Landed (PR #NNNN)`/`To Do`, never
an in-between "In review" state (and `In review` is explicitly called out
elsewhere in this repo's tooling, `bin/lib/project-hub.mjs`, as a
non-recognized board-side token for a _different_ tracker's vocabulary).
Caught before committing by re-checking the table's existing rows; reverted
to `To Do` (matching how P3.1–P3.4 stayed `To Do` until their post-merge
log-landing PR flipped them to `Landed`), keeping only the `Branch` column
fill-in in that commit.

**Why it happened:** reached for a natural-sounding GitHub-style status label
without first checking the table's own established, narrower vocabulary.

**Fix for future:** before writing a status cell in a landing-plan or tracker
table, read the neighboring rows' actual values first rather than choosing
the most descriptive-sounding label — these tables have their own closed
vocabularies enforced or implied elsewhere in the repo, not free text.

## Insights

- **A shared formula is not a shared guarantee.** A doc comment claiming two
  independently-computed values "can never disagree" needs each call site's
  actual inputs traced, not just confirmation they call the same underlying
  function — this exact overclaim reached a pushed PR past a full pre-push
  review round and was only caught by the post-push bot reading the same
  code with fresh eyes. _(promoted → .claude/agents/code-reviewer.md)_
- **Two-round `AskUserQuestion` clarification before implementing a terse
  plan-doc row paid off directly.** The wave's landing-plan table intentionally
  keeps rows terse ("full design detail lives in the plan-mode transcript");
  when that transcript isn't actually recoverable, resolving scope via
  targeted questions before the first edit avoided discovering an
  architecture mismatch mid-implementation.
- **Landing-plan and tracker status cells have closed vocabularies, not free
  text.** Check neighboring rows' actual values before writing a new status
  cell — a plausible-sounding label like "In review" can be wrong for a
  specific table even when it's a reasonable English description of the
  state.
- **Pre-push and post-push review are genuinely complementary, not
  redundant.** This task is a concrete instance of `resolving-pr-comments`'
  own framing (a post-push finding is "new information," not
  re-litigation) — the two review passes caught different, non-overlapping
  issues in the identical diff.
