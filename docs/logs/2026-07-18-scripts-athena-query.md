# Work log — `athena-query` script (2026-07-18)

This log covers PR 2 of the `aws/athena` + `athena-query` chain: the
`scripts/athena-query` consumer script, built via the `scaffolding-scripts` →
`implementing-scripts` pipeline once PR 1 (`aws/athena`, the `M3LAthenaClient`
library wrapper, #162) had merged to `main`. It records what shipped, what
matched the plan, what diverged, and durable lessons for the next
`implementing-scripts` run.

Plan of record: [`docs/plans/archive/2026-07-18-aws-athena-wrapper-and-athena-query-script.md`](../plans/archive/2026-07-18-aws-athena-wrapper-and-athena-query-script.md)

Skills used: `starting-work`, `scaffolding-scripts`, `implementing-scripts`,
`syncing-docs` (this log is written before `creating-prs` runs next).

## Summary

`scripts/athena-query` runs a single Amazon Athena query via
`AWS.M3LAthenaClient` (never `@aws-sdk/client-athena` directly, ADR-0029/T6)
and exports the results to JSON or CSV, with checkpointed resume:
`startQuery()` checkpoints the in-flight `queryExecutionId` before
`awaitResults()` polls to completion, so `--resume true` can reattach instead
of re-issuing the query after an interruption or a terminal failure. Steps:
`resolve-settings` (typed config narrowing), `checkpoint`
(read/write/delete the `<output>.checkpoint.json` sidecar), `export-results`
(format-dispatched list exporters), `run-athena-query` (the orchestrator).

Built in worktree `m3l-automation-athena-query`, branch `feat/athena-query`.
The hub authored both documentation artifacts directly
(`docs/reference/scripts/athena-query.md`, the contract; `scripts/athena-query/README.md`,
run instructions) before dispatching RED — precedent was unambiguous from the
`cloudwatch-logs-insights` sibling and the already-shipped `aws/athena`
wrapper contract, so no user check was needed per the pipeline's "settle
before writing tests" step. RED (`test-author`): 4 test files, 27 tests
failing for the right reason (missing modules / config-schema mismatch).
GREEN (`code-implementer`): 48/48 tests passing on first pass, typecheck/lint/
format clean, full workspace build green.

Review fan-out — `code-reviewer`, `security-reviewer`, `silent-failure-hunter`,
all three dispatched in parallel in one message, each scoped to an explicit
file list: **security** clean (2 nits — path-containment rests on
`M3LPaths.resolveOutput()`, a future `onAfterConfigLoad` hook must not log
`queryString`); **silent-failure-hunter** clean (2 nits — confirmed the
checkpoint delete-on-success/preserve-on-failure invariant holds structurally
in the code path itself, not just in the tests); **code-reviewer** clean with
one Should-fix (settings-narrowing bundled unexported inside the orchestrator,
where the sibling factors it into its own step) — applied via a follow-up
`code-implementer` dispatch, a pure behavior-preserving extraction that left
all 48 tests passing unmodified.

`pnpm knip` (the anti-hollow gate for scripts) flagged 2 unused exports
(`EMPTY_CHECKPOINT`, `AthenaSettingsError`) — both were extraneous public
surface, used only within their own module — fixed by dropping `export`. Two
stale TSDoc/test-docstring comments left over from the `resolve-settings.ts`
extraction ("no resolve-settings step is needed") were fixed via two more
tiny bounded spoke dispatches. A pre-existing doc bug in
`docs/reference/aws/athena.md` from the already-merged PR 1 (`script.aws.athena`
should read `script.aws.clients.athena`) was fixed directly by the hub.

Final state: 48 tests across 4 files; full workspace suite 3464 tests
passing; build/typecheck/lint/format/`check:script-scaffold`/`knip` all
green; a no-config smoke run confirmed clean composition-root wiring
(`M3LConfigMissingError` on the required `aws.profile` parameter, no AWS call
attempted). `/syncing-docs` passed all 14 steps — scripts carry no provenance
sidecar, but the reference index/consumer-scripts catalog picked up the new
script (6 consumer scripts now, was 5). `docs/ROADMAP.md`'s W4 row was split
into 3 per-script rows (see divergence 3) and `docs/plans/IMPLEMENTATION.md`'s
`athena-query` bullet flipped to done. Single commit `f0bfd71`
(`feat(scripts): add athena-query consumer script`) — scaffold, implement,
should-fix refactor, and the doc fixes all bundled together, since nothing
was committed incrementally during this session's TDD loop (unlike PR 1's
multi-commit granularity).

## What went as planned

- **RED failed for the right reason on the first pass** — every one of the
  27 initially-failing tests failed on a missing module or a config-schema
  mismatch against the placeholder scaffold, not a logic error in the test
  itself.
- **GREEN was clean on first pass** — `code-implementer` delivered
  typecheck-clean, lint-clean, 48/48-passing code without a re-dispatch,
  including correctly composing `startQuery`/`awaitResults` (not the
  convenience `runQuery()`) so `queryExecutionId` could be checkpointed
  before polling.
- **The review fan-out converged fast with no stalls** — all three spokes
  (dispatched in parallel, each with an explicit bounded file list) returned
  clean or near-clean results well inside normal turnaround, in sharp
  contrast to PR 1's three-of-five-spoke, 60+-minute stall. See Lessons
  learned.
- **The checkpoint preserve-on-failure invariant held on first implementation** —
  `silent-failure-hunter` confirmed structurally (no try/catch wraps the
  `awaitResults`/`exportResults`/`deleteCheckpoint` sequence in
  `run-athena-query.ts`, so any throw from `awaitResults` unwinds before
  either downstream call runs) rather than needing a fix.
- **The behavior-preserving refactor (Should-fix) needed zero test changes** —
  extracting `resolve-settings.ts` out of the orchestrator left all 48
  existing tests passing unmodified, confirming the extraction was a pure
  reshape.

## What didn't go as planned, and why

### 1. `pnpm knip`'s anti-hollow gate is easy to forget for a script

`pnpm knip` flagged two unused exports (`EMPTY_CHECKPOINT` in `checkpoint.ts`,
`AthenaSettingsError` in `resolve-settings.ts`) only after the full gate
sequence (`typecheck`/`lint`/`test`/`build`) had already reported clean. Both
symbols were used only within their own module and had no reason to be
`export`ed; the fix was a one-line `export` removal each.

**Why it happened:** `pnpm test`/`pnpm lint`/`pnpm build` all passed before
`knip` ran, because none of them checks for unused-but-technically-referenced
exports — that check only exists in `knip`, which is not wired into the
`implementing-submodules` pipeline at all (submodules are governed by the 80%
coverage gate instead, ADR-0022 §8 exempts scripts from it). It is easy to
treat "typecheck/lint/test/build all green" as "done" for a script and skip
straight to docs sync.

**Fix for future:** Treat `pnpm knip` as a mandatory step-7 gate for every
`implementing-scripts` run, run immediately after `build`, not as an optional
extra. It is cheap (a few seconds) and catches drift the coverage gate would
have caught on a submodule.

### 2. Extracting a step after review left two stale cross-referencing comments

Applying code-reviewer's Should-fix (extracting `resolve-settings.ts` out of
`run-athena-query.ts`) left two comments elsewhere in the tree — a TSDoc block
in `config.ts` and a docstring in `run-athena-query.test.ts` — that explicitly
asserted "no resolve-settings step is needed," written during RED/GREEN when
that was still true. Both needed a follow-up one-line fix.

**Why it happened:** The original contract (`docs/reference/scripts/athena-query.md`)
explicitly called out the absence of a `resolve-settings` step as a deliberate
simplification versus the `cloudwatch-logs-insights` sibling, and that framing
got echoed into source/test comments during GREEN/RED. When a later review
finding reversed that specific design decision, nothing flagged the now-stale
echoes — they don't affect behavior or tests, so no gate catches them.

**Fix for future:** When a review Should-fix reverses an explicit
design-rationale statement made earlier in the same pipeline (not just "fix
this bug" but "actually do the thing the contract said not to do"), grep the
tree for the specific phrase that stated the old rationale (here,
`"no resolve-settings"` / `"resolve-settings step is needed"`) before
considering the fix complete — a stale rationale comment is invisible to every
automated gate.

### 3. `docs/ROADMAP.md`'s W4 row was already stale before this session touched it

The W4 row bundled three scripts (`athena-query`, `eks-ops`,
`api-gateway-client`) under one `pending` status. `api-gateway-client` had
already shipped (#157, merged before this session started) but the row was
never updated — a pre-existing tracker-drift this session's edit surfaced
rather than caused.

**Why it happened:** The table's row-per-wave granularity (rather than
row-per-script, as W2 already used) makes a partial-completion state
unrepresentable without a manual split; nothing forces that split to happen
at merge time for a bundled row.

**Fix for future:** When a wave-bundled row's item ships, check whether the
_other_ items in that same row are already done and the row was never split —
`grep`-check the row's item names against recent merged-PR titles/commit
messages before writing the status update, not just the single item just
shipped. Prefer per-script rows (the W2 convention) over bundled multi-item
rows for any wave with more than one item, so future partial completion
doesn't require a retroactive split.

## Lessons learned

- **Proactive narrow review-scoping held up as the default, not just a
  stall-recovery tactic.** PR 1 discovered tight per-spoke file-list scoping
  as a fix _after_ three of five review spokes stalled for over an hour. This
  session applied the same scoping proactively from the very first dispatch
  (three spokes, one message, each with an explicit small file list and
  checklist) and saw zero stalls — every spoke converged well inside normal
  turnaround. One data point, but it's the expected direction: bounding scope
  removes the open-ended-exploration failure mode before it can start, rather
  than only recovering from it.
- **`pnpm knip` is a mandatory, easy-to-skip gate for `implementing-scripts`.**
  It is not part of `typecheck`/`lint`/`test`/`build` and scripts are exempt
  from the coverage gate that would otherwise catch this class of drift on a
  submodule — run it explicitly as its own step 7 check, every time.
  _(promoted → .claude/skills/implementing-scripts/SKILL.md, .claude/rules/scripts.md)_
- **A review Should-fix that reverses an earlier design-rationale statement
  needs a stale-comment sweep, not just the code change.** Grep for the exact
  phrase that stated the old rationale across both `src/` and `tests/` before
  considering the fix complete; no gate catches a stale rationale comment.
  _(promoted → .claude/agents/code-implementer.md)_
- **A wave-bundled tracker row hides partial completion.** Splitting a
  multi-item wave row (like W2 already does) into one row per script, at the
  point the first item in the row ships, avoids a future editor having to
  reconstruct which items are actually done from commit history.
- **Hub-authored contract pages for a well-precedented script are efficient
  and safe.** With a clear sibling (`cloudwatch-logs-insights`) and an
  already-shipped library contract (`docs/reference/aws/athena.md`) to draw
  from, writing the script's contract page and README directly (rather than
  looping the user or a spoke in first) cost no rework this run — the
  contract held up unchanged through RED, GREEN, and review, needing only the
  post-refactor step-table/prose update in divergence 2's aftermath.
