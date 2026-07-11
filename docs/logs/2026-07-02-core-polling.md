# Work log — `core/polling` submodule (2026-07-02)

This log covers implementing the `core/polling` submodule end-to-end through the
hub-and-spoke TDD pipeline (contract → RED → GREEN → 4-spoke review → doc sync).
It records what shipped, what matched the plan, the divergences (several
truncated spoke returns and a coverage/type-design convergence on one field),
and the durable lessons — most of which confirm existing rules rather than add
new ones.

Plan of record: [`docs/plans/polling-submodule-implementation.md`](../plans/archive/polling-submodule-implementation.md)

## Summary

Shipped `core/polling` with exactly **13 public exports**, surfaced through the
`core` namespace barrel (no `exports`-map change → **minor**, not breaking):
`M3LPoller`, `M3LRetryRunner`, `M3LBackoff`, `M3LPollingPolicies`,
`M3LPollCheckFn`, `M3LPollDecision`, `M3LRetryClassifier`, `M3LRetryDecision`,
`M3LRetryAdvice`, `combineClassifiers`, `awsThrottlingClassifier`,
`awsNetworkClassifier`, `httpRetryAfterClassifier`. Internal error classes
(`M3LPollFailureError`, `M3LPollExhaustedError`, `M3LPollingInvalidOptionError`)
and the backoff-strategy/option interfaces are intentionally unexported to hold
the 13-symbol surface.

- **Tests:** 90 polling test blocks; full suite 1052 passing / 18 files, 0
  unhandled rejections.
- **Coverage (per-file, `perFile: true` @ 80%):** all polling src ≥80% on every
  metric — `core/polling` ~97.8%; `M3LBackoff`, guards, errors, `M3LRetryRunner`
  at/near 100% after backfill.
- **Gates:** `typecheck` ✓, `lint` ✓, `build` ✓ (`dist/core/polling/` emitted
  `.js` + `.d.ts`), `check:api` ✓ (exports map unchanged), `check:provenance` ✓,
  `check:doc-counts`/`impl-counts`/`doc-exports`/`index` ✓, `lint:md` ✓.
- **Review verdicts:** spec-conformance **conformant**; code-reviewer
  **APPROVE**; type-design **no Must-fix** (1 Should-fix); silent-failure-hunter
  **PASS** (1 MEDIUM Should-fix). No Must-fix from any spoke. All accepted
  Should-fixes applied.
- **Deps:** none (dep-free as specced).
- **Status transitions:** ❌ → 🧪 → 🟢 → ✅.

## What went as planned

- **Contract extraction was exact** — `spec-conformance-reviewer` in
  contract-producer mode confirmed all 13 symbols, the 16 canonical AWS
  throttling names (arch:319), backoff formulas, and dep-free status up front,
  and surfaced two doc-underspecified decisions for hub ratification (internal
  error classes; `httpRetryAfterClassifier` non-retriable-4xx → `"fatal"`).
- **RED failed for the right reason** — `Cannot find module
'../src/core/polling/index.js'`, not a test-logic error; 0 tests ran.
- **The core implementation logic was correct on first pass** — the terminal
  error paths, per-call backoff isolation (state in the `poll()`/`run()` call
  frame, not the instance), classifier purity, and `cause` preservation all held
  through review with zero Must-fix findings.
- **Doc sync was clean** — `/syncing-docs` re-stamped 10 sidecars, bumped the
  implemented count to 10 of 22 across all six sites, regenerated the reference
  index (22 modules, 121 symbols), and passed markdown lint in one pass.

## What didn't go as planned, and why

### 1. The `submodule-implementer` returned truncated mid-thought — twice

The GREEN spoke hit its turn budget mid-run on two separate dispatches. The
first return ended mid-sentence reasoning about a TypeScript cast; the second
ended "Let me simplify the guard first." — and had left `M3LRetryRunner.ts`
**broken**, calling an un-imported `assertPositive` (plus a `Number.NaN` hack)
while importing the unused `assertPositiveInteger`. Neither truncated report
mentioned the incomplete state. Both were caught by reading the spoke's journal
file and running `tsc`/`eslint`/coverage directly, then resuming the **same**
spoke via `SendMessage` with the specific gap.

**Why it happened:** Bounded-I/O rework in a single spoke turn is token-heavy;
long implementer runs can exhaust the turn before writing a completion summary.

**Fix for future:** Already encoded in the `implementing-submodules` skill —
never trust the writer spoke's final report; read its journal and verify created
files, the barrel re-export, and `typecheck`/`lint`/`test` yourself, and resume
the same spoke on a concrete gap rather than re-dispatching fresh.

### 2. Runtime tests were green while `tsc` typecheck was red

The implementer reported "59/59 pass" and the test-author reported clean, but
`tsc --noEmit` failed on a test-file cast — `Object.keys(options as
Record<string, unknown>)` (TS2352, the union lacked an index signature). Vitest
transforms via esbuild, which **strips types without checking them**, so a
type-only error is invisible to the runtime run.

**Why it happened:** "Tests pass" (vitest) and "types are sound" (`tsc`) are two
different gates; the former does not imply the latter.

**Fix for future:** Treat `pnpm typecheck` / `tsc --noEmit` as the authoritative
type gate on every phase, independent of a green vitest run — never conclude
GREEN from the test runner alone.

### 3. IDE/LSP diagnostics were repeatedly stale and false

Across the run, injected IDE diagnostics kept showing an impossible
`Cannot find module '../src/core/polling/index.js'` at lines 51/58 **after** the
module existed and tests passed, plus false type errors on freshly-edited lines
(a `setTimeout`-spy "error", a `ReturnType`-as-value "error") that `tsc` did not
reproduce. Trusting the CLI over the LSP resolved the contradiction correctly
every single time.

**Why it happened:** The LSP lagged behind concurrent spoke edits and ran a
different resolution/TS state than the project `tsc`.

**Fix for future:** Already the project rule (CLI over IDE/LSP); this run is
another confirmation. When diagnostics and a fresh `tsc`/`eslint` disagree,
believe the CLI.

### 4. `perFile` coverage hard-failed on backoff math and guard paths

The full suite passed but `test:coverage` (`perFile: true` @ 80%) failed on
`M3LBackoff.ts` (**branches 0%** — tests only ever used `constant`), `guards.ts`,
and `errors.ts`. These were genuine gaps in documented behavior, not dead code:
the `exponential`/`exponentialJittered` schedules and the invalid-option guard
paths were never exercised. The `test-author` backfilled black-box schedule
assertions (spying on `setTimeout` delay args, pinning `Math.random`) and
invalid-option failure tests, lifting all three to ≥80%.

**Why it happened:** The initial RED suite proved the primitives worked with a
trivial backoff and valid inputs but skipped the numeric behavior and boundary
guards the contract explicitly required.

**Fix for future:** When the contract specifies formulas and "guard numeric
params," the RED suite must include the backoff schedule math and each guard's
failure path from the start — `perFile` coverage will demand them anyway.

### 5. Two independent reviewers converged on `M3LRetryAdvice.delayMs`

`type-design-analyzer` flagged that `M3LRetryAdvice` (`{ decision; delayMs? }`)
let `delayMs` co-exist with a `fatal`/`unknown` decision (an unrepresentable-
should-be illegal state); `silent-failure-hunter` independently flagged that the
same `delayMs`, taken from an untrusted `Retry-After` via
`httpRetryAfterClassifier`, flowed unvalidated into `delay()` — a `NaN` fires
immediately (defeating backoff), an `Infinity` **hangs `run()` forever**. The
fixes were complementary: a discriminated union
(`{ decision: "retriable"; delayMs? } | { decision: "fatal" | "unknown" }`) plus
a runtime `assertPositive(advice.delayMs)` guard at the point of use. A third
finding (code-reviewer) in the same spot — the override seeding the next
attempt's jitter, contradicting "for that one attempt" — was fixed by only
updating `prevDelay` on the backoff branch.

**Why it happened:** A single weakly-constrained public field (`delayMs?`) fed
by external input is both a type-design smell and a silent-failure vector; the
two lenses catch the same hazard from different angles.

**Fix for future:** When a public optional field is populated from external
input and consumed by a side-effecting call, expect both a
make-illegal-states-unrepresentable tightening and a runtime boundary guard —
apply them together.

### 6. The context-bag Should-fix was initially over-engineered into dead branches

Adding a structured `context: { attempts }` bag to the exhaustion error (a
silent-failure Nit) was first implemented with a shared `M3LPollingErrorOptions`
options bag and conditional `context`/`cause` spreads on all three internal
error classes. Because those classes are internal and each is constructed with a
fixed shape, half of every conditional branch was **unreachable via the public
API** — dropping `errors.ts` branch coverage to 58.3%. The correct fix was to
**simplify** (give each error the exact fixed constructor shape its call sites
use, dropping the unused `cause`), which removed the dead branches and reached
100% — not to write tests for unreachable code.

**Why it happened:** The implementer generalized the error constructors
speculatively (mirroring the `M3LConfigParseError` conditional-spread pattern),
but that pattern only earns its branches where callers genuinely vary
context/cause — which these fixed internal sites do not.

**Fix for future:** For internal error classes with fixed construction shapes,
forward exactly what the call sites pass; do not copy the varying-caller
conditional-spread pattern, and never add tests to cover branches that are
unreachable through the public surface — remove the branch instead.

### 7. Pre-existing bug discovered: `check-test-counts.mjs` validates nothing

During doc sync, `pnpm check:test-counts` reported "No ✅ submodules with
recorded test counts found — nothing to check" despite many ✅ rows recording
"N tests." Its column model (`bin/check-test-counts.mjs:76-81`) omits the table's
`Planned` column, so `STATUS_COL = 4` reads the Symbols cell (never `✅`) and the
gate skips every row — passing vacuously. This is on `main`, unrelated to
polling; flagged as a separate task (`task_1b2be6a9`) to fix the indices and
reconcile any surfaced count drift.

**Why it happened:** The validator's hard-coded column indices were written
against a table shape that later gained a `Planned` column; nothing re-checked
the mapping.

**Fix for future:** Column-positional Markdown-table validators should assert
their expected header row (or key off header names) rather than hard-coding
indices, so a table-shape change fails loudly instead of silently no-op'ing.

## Lessons learned

- **Verify spoke state, never trust the report** — long writer runs truncate
  mid-thought and hide broken state (an un-imported symbol, a missing barrel
  line); read the journal and run `tsc`/`eslint`/`test` yourself, then resume the
  same spoke on the concrete gap. _(already in
  .claude/skills/implementing-submodules/SKILL.md)_
- **`tsc` is the type gate, vitest is not** — esbuild strips types, so runtime
  tests pass while `tsc --noEmit` fails on a type-only error; run typecheck every
  phase independently of the test run.
- **CLI over IDE/LSP, every time** — stale/false diagnostics (impossible
  module-not-found, phantom errors on fresh edits) lose to a fresh `tsc`/`eslint`
  run whenever they disagree. _(already in .claude/rules/library-src.md and the
  spoke agents)_
- **Contract formulas and guards are RED obligations** — if the spec states a
  backoff formula or "guard numeric params," the first test suite must exercise
  the math and each failure path, or `perFile` coverage fails after GREEN on
  branches like an untested backoff strategy (0% branches on `M3LBackoff`).
- **One external-fed optional field, two review lenses** — a public `delayMs?`
  populated from an untrusted header drew both a type-design tightening
  (discriminated union) and a silent-failure guard (`assertPositive` before a
  side-effecting `delay()`, else `Infinity` hangs the loop); apply both together.
- **Simplify internal errors, don't test dead branches** — internal error
  classes have fixed construction shapes, so a varying-caller conditional-spread
  pattern creates branches unreachable through the public API; forward exactly
  what call sites pass and delete the branch rather than writing test theater.
- **Positional table validators fail silently on shape drift** — a hard-coded
  column index (`check-test-counts.mjs`) silently skipped every row after the
  table gained a column; such validators should assert their header or key off
  column names.

## Follow-ups

- `task_1b2be6a9` — fix `bin/check-test-counts.mjs` stale column indices and
  reconcile any recorded test-count drift it then surfaces.
