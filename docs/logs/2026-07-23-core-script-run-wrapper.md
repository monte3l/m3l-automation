# Work log — `core/script` runScript() wrapper, ADR-0035 phase 4a (2026-07-23)

This log covers ADR-0035 phase 4a (A4a): the `runScript()` composition-root
wrapper that finally makes the exit-code registry observable, plus dry-run, the
`M3LScript` accessors the run report needs, and the internal
`M3LPollFailureError` context. It ran through the full hub-and-spoke pipeline
(`starting-work` → RED → GREEN → four-spoke review → fix rounds →
`syncing-docs` → `writing-commits` → `creating-prs` → this log) and records what
shipped, what matched the plan, what diverged, and the durable lessons.

Plan of record: an in-session plan file (not tracked in the repo). Shipped as
[ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md) phase 4a via PR
[#216](https://github.com/monte3l/m3l-automation/pull/216).

## Summary

Shipped `runScript`, `M3LRunScriptOptions`, `M3LScriptRunOptions` through the
`core` barrel (no `exports`-map change — verified by `check:api`). `M3LScript`
gained `metadata`, `correlationId`, `getLastFailureStage()`; `run()` gained an
optional `{ dryRun }` argument; `M3LScriptHookContext` gained a **required**
`dryRun: boolean`. Internal: `M3LPollFailureError` carries the failing attempt
as `context`; the forced second-signal exit code (`5`) is scoped depth-safely.

`runScript` ships from `core/script`, **not** `core/diagnostics` where the spec
documented it — ADR-0009 Zone B forbids `core/* → core/script`, and
`check:doc-exports` resolves a symbol's reference page from the barrel it leaves
by, so the contract moved to `script.md`. `import-x/no-cycle` was extended to
`core/script` for the new `core/script → core/diagnostics` edge.

- **Tests:** `script.test.ts` 133 → 213; `polling.test.ts` +2 (→124); workspace
  4319 → 4483, all green.
- **Coverage:** exit 0, per-file ≥80%; `run-script.ts` 100/86.36/100/100,
  `signalHandlers.ts` branches 100%, `internal/polling/errors.ts` 100%.
- **Gates:** typecheck (11/11), lint, format, build, and all 17 `check:*`
  (incl. `check:test-counts`) green; `knip`/`lint:md` clean.
- **Semver:** `feat:` minor, additive except the required-`dryRun` carve-out
  (recorded in the ADR).

Skills used: starting-work, syncing-docs, writing-commits, creating-prs,
writing-work-logs.

Spoke incidents: 4 truncations / 0 stalls / 1 resume. Three writer spokes (RED-1,
GREEN-1, the first fix round) and one earlier returned mid-sentence; in every
case I verified disk state directly. Only GREEN-1 needed a `SendMessage` resume
(one file of four left undone); the other three had actually completed their
substantive work and only the final report was cut.

## What went as planned

- **RED failed for the right reason** on both sub-dispatches — every failure
  traced to a missing symbol (`runScript is not a function`,
  `setForcedSignalExitCode is not a function`, `TS2339`/`TS2554` for the new
  members), never a logic error in the tests. Classifying the failures with a
  `grep | sort | uniq -c` on the reason lines made this a one-command check.
- **The `hookContext()` compile error was the intended forcing function.**
  Adding required `dryRun` to `M3LScriptHookContext` surfaced every construction
  site — exactly as the plan predicted — and the only in-`src` site was
  `hookContext()` itself.
- **`check:api` stayed green throughout.** Three new barrel symbols with an
  unchanged three-entry `exports` map is a non-event for the snapshot, as
  planned.
- **The type reviewer confirmed the phase-2 defect class did not recur.** It
  verified by data flow (not by types) that no `Omit`/`Pick`/`Parameters`
  derivation of the changed types widened — the specific `wrapError` failure
  mode from A2.
- **Splitting A4 into A4a/A4b up front** kept the wrapper from being held
  hostage to the log-level chain's unresolved constructor-timing problem.

## What didn't go as planned, and why

### 1. The plan's "additive for consumers" claim was wrong — required `dryRun` is source-breaking

The plan asserted `M3LScriptHookContext` is "additive for consumers, who only
ever _receive_ this type." `pnpm typecheck` disproved it immediately: seven
in-repo consumer scripts construct the context by hand in a `fakeHookContext`
test helper, so requiring `dryRun` broke all seven. Surfaced as a decision
(keep required + fix the seven, vs. optional); kept required because the whole
point is `if (ctx.dryRun)` without a `?? false` dance, and the package is
internal/unpublished so every consumer is fixed atomically.

**Why it happened:** "consumers only receive this type" was true of production
hook code but false of test fakes, which the plan didn't account for. The
required-vs-optional call is a genuine semver event that reading the type in
isolation hides.

**Fix for future:** before calling an options/context type change "additive,"
grep the whole repo — `scripts/**` included — for hand-construction of that
type, not just consumption. A required field added to a type anyone constructs
is source-breaking, full stop.

### 2. CRITICAL: a throwing `trail.entries()` made a real failure exit 0 (success)

The silent-failure reviewer flagged it as a static trace; I reproduced it
against built `dist/`. `buildFailureInput`/`buildSuccessInput` were evaluated as
function _arguments_ — outside `persistBestEffort`'s try — so a throwing
`options.trail.entries()` escaped the catch, skipped
`process.exitCode = mapErrorToExitCode(error)`, and was then absorbed by the
`uncaughtException` guard `runScript` itself installs (which only logs). A
genuine `ERR_CONFIG_MISSING` failure that should exit `2` exited **`0`** —
success — to the shell. Fixed by making `persistBestEffort` take a thunk
(construction + persist share one guarded region) and assigning `process.exitCode`
immediately after `errorFrom`, before any report work. Confirmed exit `2` on the
rebuilt `dist/`.

**Why it happened:** the guard-installs-then-swallows interaction is
counter-intuitive — installing an `uncaughtException` handler _suppresses_
Node's default crash, so the very safety net turns a lost-exit-code bug into a
silent success. The builder-as-argument evaluation order is invisible unless you
trace it or execute it.

**Fix for future:** in a top-level catch whose contract is "always set the
scheduler signal," assign the exit code FIRST — before any work that could
throw. And any best-effort wrapper must guard the _construction_ of its payload,
not just the I/O call; the input is as fallible as the write.

### 3. The CRITICAL fix introduced a MEDIUM (depth-unsafe signal restore)

The first fix restored the forced signal exit code via a plain
capture-then-restore around the run. The confirmation re-review showed that two
overlapping `runScript` calls interleave such that the inner captures the
outer's already-overridden value as its baseline, leaving the override stuck at
`5` permanently. Fixed with a depth-aware `pushForcedSignalExitCode` returning
an idempotent release; baseline captured only at the outermost entry, restored
only at the outermost release.

**Why it happened:** module-global save/restore composes fine sequentially and
the first fix + its tests only exercised sequential calls, so the concurrency
hole was invisible until a reviewer reasoned about `Promise.all`.

**Fix for future:** any save/restore of process-global state exposed through a
public entry point must be depth/stack-aware, not single-slot — a public API
cannot assume its callers serialize.

### 4. Two late test additions re-triggered the #215 `check:test-counts` trap

Twice a post-review fix added tests _after_ `sync:docs` had reconciled the
count: the coverage-gap round (script → 208) and the signal-scope coverage round
(script → 213). Each left `check:test-counts` failing until re-reconciled. This
is the identical sequencing failure that broke CI on #215.

**Why it happened:** `sync:docs` reconciles counts at the moment it runs; any
test added afterward invalidates them, and the count gate is easy to forget
because the suite itself still passes.

**Fix for future:** run `check:test-counts` as the _very last_ gate before
commit, after the final test lands — never reconcile counts before coverage is
finalized. (The plan called this out explicitly and it still bit twice, which
argues for a `pre-push` addition — see below.)

### 5. A test was writing into the real `data/output/`

The coverage run's stderr showed one `runScript` test reaching the real
`M3LPaths` and attempting to write `data/output/<timestamp>/run-report.json`; it
only survived because the timestamped subdir doesn't exist locally. On a machine
where it did, the test would commit a real artifact into the repo. Found in
stderr, not from any assertion. Fixed by stubbing `persist`.

**Why it happened:** the isolation was implicit (relying on a missing directory)
rather than explicit (a stub), and a green suite gives no signal about
filesystem side effects.

**Fix for future:** any test exercising `runScript`/`M3LRunReporter` must stub
`persist` or redirect `M3LPaths` to a temp dir — never rely on a missing
`data/output/` subpath. Watch coverage-run stderr for `run-report-persist`
diagnostics as the tell.

## Lessons learned

- **Grep the whole repo before calling a type change "additive."** A required
  field on any type that test fakes or scripts _construct_ is source-breaking,
  even when production code only receives it. Reading the type in isolation
  hides the semver event. _(promoted → .claude/rules/library-src.md)_
- **In a top-level catch, set the scheduler signal first.** Assign
  `process.exitCode` before any report/log work that could throw; a best-effort
  wrapper must guard payload _construction_, not just the I/O — the input is as
  fallible as the write. This is the CRITICAL's root cause.
  _(promoted → .claude/rules/library-src.md)_
- **Installing a process guard can mask the very bug it's near.** An
  `uncaughtException` handler suppresses Node's default crash, so a lost
  exit-code becomes a silent exit-0 success. Execute the failure path in a real
  child process and read the shell's `$?` — `process.exitCode` set in-process
  proves nothing about what a scheduler sees.
- **Save/restore of process-global state through a public API must be
  depth-aware.** Single-slot capture-then-restore leaks under overlapping calls;
  a public entry point cannot assume its callers serialize.
- **Run `check:test-counts` dead last.** Any test added after `sync:docs`
  invalidates the count while the suite still passes — this bit #215 and twice
  more here. Reconcile counts only after the final test lands.
- **Executed probes beat read-throughs for correctness bugs.** Every
  critical/must-fix defect across ADR-0035 phases 2–4a was found by running
  built `dist/`, not by reading the diff; reviewers reading code found the
  design issues, probes found the wrong answers. The silent-failure reviewer's
  own CRITICAL was a _static_ trace it flagged as unverified — executing it
  confirmed it and corrected the mechanism (uncaughtException, not an escaping
  reject).

## Follow-ups filed

- **A4b** (ADR-0035, pending) — the log-level precedence chain deferred from
  phase 3: the default logger is built in the `M3LScript` constructor before
  config loads, and `M3LLogger`'s floor is fixed at construction, so the
  config-file tier needs new API. Recorded in `IMPLEMENTATION.md`/`ROADMAP.md`.
- **Candidate:** move `check:test-counts` into the `pre-push` lane (it runs only
  in CI today). It cost ~8s and would have caught the #215-shaped drift locally
  three times now. Not filed as a tracker item yet — flagging here for the next
  hooks/cadence pass.
