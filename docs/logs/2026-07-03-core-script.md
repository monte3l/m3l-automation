# Work log — `core/script` submodule (2026-07-03)

This log covers implementing `core/script` — the CLI / Lambda entry-point
framework — end-to-end through the `implementing-submodules` TDD hub-and-spoke
pipeline (audit → contract → RED → GREEN → 6-spoke review → round-2 re-review →
docs reconciliation → PR). It records what shipped, what matched the plan, the
divergences (a rotted source plan, repeated spoke truncation, two rounds of real
must-fixes including one the first fix introduced), and the durable lessons.

Plan of record: [`docs/plans/script-submodule-implementation.md`](../plans/script-submodule-implementation.md)

## Summary

Shipped `core/script` with exactly the **11 documented public symbols** —
`M3LScript`, `M3LScriptOptions`, `M3LScriptMetadata`, `M3LScriptLifecycleHooks`,
`M3LScriptHookContext`, `M3LScriptConfigLoader`, `M3LScriptPresetLoader`,
`M3LPresetUnknownKeysError`, `installProcessGuards`, `serializeError`,
`setProcessGuardRequestId` — surfaced through the `Core` namespace barrel (the
three-entry `exports` map is unchanged, so this is a **minor** bump, not
breaking).

`M3LScript` composes `environment`/`config`/`logging`/`prompt`/`files`/`utils` to
drive the 9-stage `run()` lifecycle and `createLambdaHandler<TEvent, TResult,
TContext = unknown>()` with per-invocation reset. **AWS coupling is deferred
behind a fail-loud internal seam:** stage 5 throws an internal, unexported
`M3LAWSUnavailableError` when an `aws.profile` parameter is declared and is a
strict no-op otherwise; the `script.aws.clients` facade (guide-only, not in the
11-symbol reference contract) is intentionally omitted. Preset loading reuses the
existing `yaml` dependency — **no new runtime dependency**.

- **Tests:** 76 for `script` (full suite 1746), per-file coverage ≥80% on all
  four V8 metrics (`M3LScript.ts` 100%/94.4%/100%/100%; loaders/guards/internal
  helpers ≥80%).
- **Gates:** `pnpm build`, `typecheck`, `lint`, `test:coverage`, `knip`, and the
  full `/syncing-docs` stack (provenance, doc-counts, doc-exports, impl-counts,
  test-counts, reference index, markdown lint) all green.
- **Review:** 6-spoke fan-out (code / spec-conformance / type-design /
  silent-failure / security) → spec-conformance PASS, security PASS,
  type-design 1 Must-fix, silent-failure 2 Must-fix, code 3 Must-fix. After
  fixes, a 3-spoke round-2 re-review (code / silent-failure / security) →
  silent-failure PASS, security PASS, code found 1 new Must-fix (introduced by
  the archival fix), which was fixed and regression-locked.
- **Count:** implemented submodules reconciled **19 → 20 of 22**.
- Shipped as [PR #51](https://github.com/monte3l/m3l-automation/pull/51) — two
  signed commits (`feat:` + `docs:`), MERGEABLE.

## What went as planned

- **RED failed for the right reason** — the 45 initial tests failed with
  `Cannot find module '../src/core/script/index.js'`, not a logic error.
- **The contract producer front-loaded the spec-silent nuances** (weak param
  types, `TContext` default, spec-silent method names) so the test-author did not
  over-constrain the types — those assertions held through GREEN unchanged.
- **The 11-symbol public surface stayed exact** through every round — the barrel
  used named (not `export *`) re-exports, so the internal errors
  (`M3LAWSUnavailableError`, `M3LPresetLoadError`, `M3LPresetTooDeepError`),
  options interfaces, and `MAX_PRESET_STRUCTURE_DEPTH` never leaked. Both
  spec-conformance passes confirmed 11/11, no drift.
- **The AWS-seam scope decision held** — spec-conformance confirmed the reference
  page reads truthfully given the seam (stage 5 documented as conditional;
  `script.aws` never listed in the Public API), so no doc wording change was
  needed.
- **`/syncing-docs` reconciled counts cleanly** once the READMEs, `docs/README`,
  and the status intro were bumped to 20 and `script` added to each list.

## What didn't go as planned, and why

### 1. The stored implementation plan was heavily rotted

The audit target cited `docs/plans/script-submodule-implementation.md`, which
claimed only "5 of 22" submodules were implemented, asserted `config` and
`logging` "do not exist yet," and referenced the pre-rename skills
`implement-submodule` / `/sync-docs`. Its central premise — that `script` was
**blocked** until the AWS submodules landed — was false: the audit re-validated
against the live repo and found the 11 reference symbols contain **no AWS
types**, so `script` was buildable immediately with the AWS integration deferred
behind a seam.

**Why it happened:** the plan was authored when only 5 submodules existed and was
never updated as 13 more shipped and skills were renamed; a stored plan is a
hypothesis, not ground truth.

**Fix for future:** treat every factual claim in a stored `docs/plans/*.md` as
possibly rotted — re-validate counts, "what exists," and "blocked-by" premises
against the live repo before inheriting them. (Already the documented `/auditing`
and `implementing-submodules` Step 2 behavior; this run confirms the rule earns
its keep.)

### 2. The submodule-implementer spoke truncated on turn limits 5+ times

The GREEN implementer and later fix rounds repeatedly returned a mid-sentence
message instead of a completion summary (e.g. "Now let's write
`M3LPresetUnknownKeysError.ts`", "Let me re-read the file…"). Each time, the hub
verified the on-disk state directly (listed files, grepped the barrel, ran the
gates) and found concrete gaps — missing `M3LScript.ts`/`M3LScriptPresetLoader.ts`
/`process-guards.ts`/barrels, an undefined `runCleanup`/`runOnErrorBestEffort`
pair — then resumed the **same** spoke via `SendMessage` with the specific
remaining work rather than trusting the report or re-dispatching fresh.

**Why it happened:** `core/script` is the largest submodule (11 symbols, 9-stage
lifecycle, process/signal/fs surface); a full implementation plus token-heavy
rework routinely exceeds a single spoke turn.

**Fix for future:** for large submodules, never trust the spoke's final message —
verify disk state after every dispatch, and resume-via-`SendMessage` with the
exact gap. Consider splitting the initial GREEN dispatch into explicit
sub-batches (internal helpers → public files → barrel) for the biggest modules.

### 3. Review round-1 surfaced four real Must-fixes in otherwise-green code

All gates were green, but the review fan-out found: (a) **stage-9 archival was
non-functional** — it constructed a fresh `M3LFileCopier` and finalized it with
nothing registered, so it always archived zero files (a "9-stage pipeline" test
only asserted it did not throw — test theater); (b) `parsePresetFile` called
`fs.readFileSync` **outside** the try, so a missing/unreadable preset threw a raw
`ENOENT`/`EACCES` instead of an `M3LError`; (c) `run()`'s `onError` hook was
unguarded, so a throwing hook discarded the original error and skipped cleanup;
(d) `M3LScriptHookContext.config` exposed the **mutable** `M3LConfig` (hooks could
call `.set()` mid-pipeline). All four were verified against the code and fixed.

**Why it happened:** passing gates prove compile/lint/coverage, not
error-path/behavioral correctness; a coverage-satisfying test can still assert
nothing meaningful (the archival "doesn't throw" test).

**Fix for future:** the multi-spoke review (especially silent-failure + code
reviewers) is load-bearing precisely because green gates hide non-functional or
silently-failing paths — keep running the full fan-out, and treat any test that
only asserts "doesn't throw" on a behavioral stage as a coverage gap.

### 4. The archival fix introduced a new Must-fix caught only by round-2 re-review

Fixing divergence 3(a) by hoisting `M3LFileCopier` to an instance-lifetime
`private readonly` field created a warm-Lambda regression: `resetForInvocation()`
never cleared the copier's registration queue, so across `createLambdaHandler`
invocations (the primary documented Lambda pattern) `archiveFiles()` re-registered
the same files, doubling `totalRegistered` each call. The round-2 re-review caught
it; the fix made the copier **local to `archiveFiles()`** (fresh queue per run),
storing only the resulting report for `getLastArchiveReport()`.

**Why it happened:** the round-1 fix over-corrected — it hoisted state to instance
lifetime to make archival work once, without accounting for the per-invocation
reset contract that governs every other piece of `M3LScript` state.

**Fix for future:** always run a focused re-review after a substantial fix round —
a must-fix fix is itself new code that can introduce new must-fixes. When adding
state to `M3LScript`, check it against the `resetForInvocation()` contract (reset
per invocation unless it is deliberately warm-start state like SDK clients).

### 5. A hollow "did you mean" test hid the Damerau-Levenshtein path at ~10% coverage

The preset-loader typo-suggestion test built `new M3LScriptPresetLoader()` with no
schema, so `declaredNames` was empty, `findClosestMatch(key, [])` returned
immediately, and `damerauLevenshteinDistance` was never called — leaving that
helper at ~10% coverage while the test asserted only `message.length > 0`. The
fix declared a real schema (`region`) and asserted the thrown error actually
suggests it, exercising the distance function across insertion/deletion/
substitution/transposition branches.

**Why it happened:** the test constructed the object in its simplest form, which
happened to bypass the very behavior it named; per-file coverage flagged it, the
assertion did not.

**Fix for future:** when a test names a behavior ("suggests the near-miss key"),
assert the behavior's output, not a proxy like message length — and read per-file
coverage (`coverage-final.json`), which exposes a named-but-unexercised path a
green suite hides.

### 6. `origin/main` advanced mid-implementation (aws/models shipped), requiring a rebase + count reconcile

While `core/script` was being built in its worktree, `aws/models` merged to
`main` (PR #50), moving the implemented count to 19/22 and re-stamping provenance.
The code-review flagged the branch as stale (would have reverted `aws/models`'
status-doc changes). Resolved by **rebasing** `feat/core-script` onto
`origin/main` (not merging — merging pulls GitHub web-flow commits the local
keyring cannot verify into the push range, failing `verify-signed-range`), then
reconciling the count 19 → 20 via `/syncing-docs` as a separate `docs:` commit.

**Why it happened:** long-running feature branches drift from a `main` that other
parallel submodule pipelines keep advancing.

**Fix for future:** rebase (do not merge) a long-running branch onto `origin/main`
before finalizing, and let `/syncing-docs` + `check:impl-counts` derive the
authoritative count rather than hand-guessing the numerator.

## Lessons learned

- **Re-validate a stored plan before inheriting it** — counts, "what exists," and
  "blocked-by" premises rot as the repo advances; the audit found `script` was
  never contract-blocked despite the plan asserting it. _(already in `/auditing`
  - `implementing-submodules` Step 2)_

- **Verify spoke disk state; never trust a truncated report** — the largest
  submodules exhaust a spoke turn mid-write; list files, grep the barrel, and run
  the gates yourself, then resume the same spoke via `SendMessage` with the exact
  gap. _(already in `implementing-submodules` GREEN step + `submodule-implementer`
  prompt via the core/json divergence)_

- **Green gates hide non-functional and silently-failing paths** — a
  coverage-passing test can assert nothing meaningful (the archival "doesn't
  throw" test); the silence/behavior-focused review spokes are what catch a stage
  that compiles, is covered, and still does nothing.

- **Re-review after every substantial fix round** — a must-fix fix is new code:
  hoisting the file copier to fix "archives nothing" introduced "accumulates
  across warm invocations." The focused round-2 re-review is not optional.

- **Check new `M3LScript` state against `resetForInvocation()`** — any field added
  to the script must either reset per Lambda invocation or be deliberate
  warm-start state; instance-lifetime mutable queues silently accumulate.

- **Assert the named behavior, not a proxy** — a "suggests the near-miss key" test
  must assert the suggestion appears, not `message.length > 0`; the proxy left the
  entire Damerau-Levenshtein path unexercised behind green coverage.
  _(promoted → .claude/rules/tests.md)_

- **Rebase, don't merge, a stale long-running branch** — rebasing onto
  `origin/main` keeps GitHub web-flow (unsigned-to-local-keyring) commits out of
  the push range, avoiding a `verify-signed-range` failure; reconcile counts via
  `/syncing-docs` afterward. _(already in memory: `merge-main-github-signed-commits`)_

- **Defer an out-of-contract collaborator behind a fail-loud internal seam** —
  `script`'s AWS coupling became an unexported `M3LAWSUnavailableError` (thrown
  only when `aws.profile` is declared), keeping the public surface at exactly the
  11 reference symbols and unblocking the submodule without waiting on `aws/*`.
