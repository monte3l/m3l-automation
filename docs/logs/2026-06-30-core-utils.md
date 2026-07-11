# Work log — `core/utils` submodule (2026-06-30)

This log covers the TDD implementation of the `core/utils` submodule through
the full hub-and-spoke pipeline: Contract → RED → GREEN → Review → review-fixes
→ provenance sidecar → PR → bot-review fix. It records what shipped, what
matched the plan, where the pipeline diverged and why, and the durable lessons
extracted for future submodule work.

Plan of record: [`docs/plans/utils-submodule-implementation.md`](../plans/archive/utils-submodule-implementation.md)

## Summary

**Symbols shipped:** 36 of 39 spec'd symbols. The three `M3LPaths` cluster
symbols (`M3LPaths`, `M3LPathType`, `M3LPathEnvironmentVariables`) are deferred
pending the `environment` submodule.

**Phases A–C implemented:**

- **26 type guards** (`isNullish` through `hasMessage`) — all `(v: unknown) =>
v is T`, no `any`, with `isEnoentError` narrowing to
  `NodeJS.ErrnoException & { code: "ENOENT" }`
- **`safeJsonStringify`** — circular-safe (`WeakSet`), depth-limited (default
  10, `M3LError` on invalid depth), BigInt/Symbol/Function/Map/Set handled,
  never throws for valid input
- **`valueToString`** — human-readable serialization, never throws
- **`M3LDateTokens.expand`** — `{YYYY}`, `{MM}`, `{DD}` tokens via native
  `Date` (no `luxon` runtime dep)
- **`M3LConcurrencyPool`** — FIFO bounded async pool, fail-fast, validates
  `concurrency` at construction
- **7 formatting helpers** — `formatBytes`, `smartTruncate`, `truncatePath`,
  `truncateText`, `isPath`, `formatConfigValueDisplay`,
  `formatConfigSourceDisplay`; all boundary inputs validated with `M3LError`

**Tests:** 236 in `utils.test.ts` (including 11 failure-path tests added after
review); 401 total across 5 test files.

**Coverage (V8):** 93.4% branches · 95.78% statements · 100% functions · 96.52%
lines. No per-file threshold failures (gate: 80% per metric per file).

**Quality gates:** `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test:coverage`
✅ · `pnpm build` ✅ · `pnpm check:api` ✅ (exports map unchanged) ·
`pnpm check:provenance` ✅ · `pnpm check:scaffold` ✅ · `pnpm knip` ✅ ·
`pnpm lint:md` ✅

**Review spokes:**

- `spec-conformance-reviewer` — conformant; 1 must-fix (valueToString TSDoc
  orphaned)
- `code-reviewer` — 4 must-fix items (TSDoc orphan, truncatePath budget bug,
  M3LConcurrencyPool constructor, safeJsonStringify dead fallback)
- `type-design-analyzer` — 3 must-fix items (isEnoentError literal precision,
  M3LConcurrencyPool constructor, safeJsonStringify depth validation); rated
  7–9/10 on encapsulation/usefulness, 5–6/10 on invariant enforcement before
  fixes
- `silent-failure-hunter` — 5 must-fix items (opaque catch blocks, missing
  boundary guards on numeric params); all resolved

**Bot review (claude-pr-review):** FAIL → 1 finding (formatConfigValueDisplay
TSDoc orphaned by `jsonOrFallback` helper) → fixed in commit `88ed3bc` →
resolved.

**PR:** [#26](https://github.com/monte3l/m3l-automation/pull/26)

**Runtime deps added:** none. `M3LDateTokens.expand` uses native `Date`.

---

## What went as planned

- **Dependency gate skipped cleanly.** The plan marked Phases A–C as zero-deps.
  Confirmed at the start: `luxon` was in the architecture doc but absent from
  `package.json`. Implemented `M3LDateTokens.expand` with native `Date` and
  skipped the gate.
- **RED failed for the right reason.** The test-author produced 148 initial
  tests; the runner failed with `Cannot find module '../src/core/utils/index.js'`
  — a missing-module error, not a test logic error.
- **GREEN was near-complete on first pass.** The implementer produced all 6
  source files, wired the barrel, and reached 224/225 passing. The 1 failure was
  a test defect (`toBigInt` → `toBeBigInt`), not an implementation error.
- **All four review spokes ran in parallel** and returned structured, actionable
  findings that were consolidated into one implementer dispatch.
- **`pnpm check:api` confirmed no semver event.** The `exports` map snapshot
  matched throughout — `utils` surfaced through the existing `./core` barrel
  as intended.
- **Provenance sidecar validated on first write.** All 36 symbols resolved
  correctly against their source files.

---

## What didn't go as planned, and why

### 1. Test-author produced incorrect Vitest `expectTypeOf` API calls

The initial test file had multiple TypeScript errors: `.toBigInt()` (non-existent
method, should be `.toBeBigInt()`), `test.each` callback arity mismatches (2-element
row tuples with 1-parameter callbacks), and `.toEqualTypeOf<T>()` used where
`.toMatchTypeOf<T>()` was correct for subtype (not exact-type) assertions.
These errors appeared as IDE diagnostics and caused 1 test runtime failure.
A second dispatch to the test-author was required to fix the test file after
GREEN.

**Why it happened:** The test-author wrote against Vitest 4.x `expectTypeOf`
semantics that differ subtly from 3.x (`.toBeSymbol()`, `.toBeBigInt()` vs
older patterns). TypeScript 6.x is also stricter about `test.each` callback
parameter counts than the test-author anticipated.

**Fix for future:** Include in the test-author prompt: "Check `.toBeBigInt()`,
`.toBeSymbol()`, `.toBeFunction()` — NOT `.toBigInt()` etc. For `test.each`
with 2-element row tuples, the callback must accept both parameters: `(value,
_label) => { ... }`. For subtype narrowing assertions (type predicate where the
narrowed type is a subtype of `unknown`), use `.toMatchTypeOf<T>()` not
`.toEqualTypeOf<T>()`."

---

### 2. Review phase surfaced 9 Must-fix boundary-validation gaps not in the contract

The four review spokes (code-reviewer, silent-failure-hunter, type-design-analyzer,
spec-conformance-reviewer) collectively found 9 unique Must-fix items. Five were
boundary-validation gaps: `M3LConcurrencyPool` accepted `concurrency <= 0` silently,
`safeJsonStringify` accepted `depth <= 0` silently, and `formatBytes` / `smartTruncate`
/ `truncateText` / `truncatePath` accepted invalid numeric params without throwing.
Adding these guards introduced new branches that were previously uncovered, causing
`M3LConcurrencyPool.ts` to fall to 75% branch coverage — below the 80% threshold.
A third test-author dispatch added 11 failure-path tests to clear the gate.

**Why it happened:** The original contract (from the spec-conformance-reviewer)
described the behavioral _happy path_ in detail but did not enumerate input validation
requirements. Boundary guards are project-standard CLAUDE.md rules ("Validate all
external input at the public API boundary before use") that the review spokes apply
but the contract phase does not explicitly surface.

**Fix for future:** Have the contract phase include a "Boundary guard checklist"
section: for every exported function/constructor that takes a `number` or other
potentially invalid input, document the expected validation rule. This front-loads
the boundary guard requirements into the test-author's initial prompt, so failure-path
tests are written before GREEN rather than in a third spoke after review.

---

### 3. TSDoc orphan pattern hit twice: once in implementation, once caught by bot

The `valueToString` function and the `formatConfigValueDisplay` function each had
their TSDoc comment block orphaned by a private helper inserted between the doc block
and the `export function` declaration. `valueToString`'s orphan was caught by the
review spokes and fixed by the implementer before commit. `formatConfigValueDisplay`'s
orphan survived the review phase, was committed, and was flagged as a FAIL by the
`claude-pr-review` bot. A `resolve-pr-comments` cycle was needed to fix it and
re-push.

**Why it happened:** The implementer extracted a private helper (`jsonOrFallback`,
`primitiveValueToString`) for complexity reasons and placed it between the TSDoc block
and the export in both cases. TypeScript attaches a TSDoc block to the immediately
following declaration — an intervening unexported function absorbs it silently.

**Fix for future:** Include in the implementer prompt: "If you extract a private
helper between a TSDoc block and its export declaration, move the private helper
_above_ the TSDoc block so the doc attaches correctly. Pattern: private helper → TSDoc
block → export declaration." This is now a known anti-pattern worth calling out
explicitly.

---

### 4. `git push` rejected after bot commit to branch

After the `resolve-pr-comments` fix commit, `git push` was rejected as
non-fast-forward. The `claude-pr-review` bot had pushed an automated commit to the
same branch between the original push and the fix push. A `git pull --rebase` was
required before the fix could be pushed.

**Why it happened:** The `claude-pr-review.yml` workflow pushed to the PR branch as
part of its review process, creating a commit that the local session did not have.

**Fix for future:** After a `resolve-pr-comments` fix, run `git pull --rebase origin
<branch>` before `git push` rather than assuming the branch is up to date. This is
now standard operating procedure whenever a bot workflow may have touched the branch.

---

## Lessons learned

- **Front-load Vitest `expectTypeOf` API precision into the test-author prompt.**
  Include: use `.toBeBigInt()` not `.toBigInt()`; for `test.each` 2-tuple rows
  the callback needs both parameters; for subtype checks use `.toMatchTypeOf`
  not `.toEqualTypeOf`. These are Vitest 4.x specifics that differ from older
  patterns and cost a second test-author dispatch when omitted.

- **Add a boundary-guard checklist to the contract phase for numeric params.**
  Every exported function/constructor that accepts `number` inputs (concurrency,
  depth, bytes, maxLength) should have its validation contract documented at
  contract time so the test-author writes failure-path tests upfront. Review
  spokes catch these gaps, but the resulting third spoke (test-author for coverage)
  is avoidable.

- **Private helper extraction creates a TSDoc orphan risk.** Whenever an
  implementer extracts a private helper for complexity reasons, the extracted
  function must go _above_ the TSDoc block of the export it serves, not between
  the doc block and the export. Explicitly state this in implementer prompts for
  modules with multiple exports.

- **`git pull --rebase` before `git push` after a resolve-pr-comments fix.**
  The `claude-pr-review` bot pushes to the PR branch during review. Always rebase
  before pushing a fix commit to avoid a non-fast-forward rejection.

- **`M3LDateTokens` implemented without `luxon` despite the architecture doc.**
  The architecture doc listed `luxon` for date formatting, but the plan doc
  called Phase B "zero deps" — the plan takes precedence. Native `Date` is
  sufficient for `{YYYY}`, `{MM}`, `{DD}` token expansion. No dependency gate
  needed, no runtime dep added. Note this divergence from the architecture doc
  for future reference when `luxon` usage is reconsidered.

- **Review spokes ran cleanly and in parallel; no re-spokes needed.**
  Dispatching all four review spokes simultaneously (code-reviewer,
  spec-conformance-reviewer, type-design-analyzer, silent-failure-hunter) and
  consolidating their findings into a single implementer dispatch worked well.
  The nine Must-fix items from four spokes were resolved in one implementer pass.

---

## Phase D close-out — M3LPaths cluster (2026-06-30)

`utils` now ships all 39/39 spec'd symbols. Phase D adds:
`M3LPaths`, `M3LPathType`, `M3LPathEnvironmentVariables`, `M3LPathResolutionError`.

### Confirmed design decisions

1. **`getOutputDir()` returns the stable base `output/` dir — no auto-timestamping.**
   Callers build run-archive dirs via `Core.M3LDateTokens.expand(...)`. Keeps
   `M3LPaths` a pure resolver with no side effects.

2. **`M3LPaths` is pure resolution — no filesystem I/O.**
   All paths are snapshotted at construction time via `path.join()`. Directory
   creation belongs to the downstream `files` submodule. Aligns with the
   no-side-effects / tree-shaking rules.

3. **`getProjectRoot()` throws `M3LPathResolutionError` (code `ERR_PATH_RESOLUTION`)
   in standalone mode.** There is no monorepo root to return. Callers must guard
   standalone code paths. The error type is exported to the Public API so callers
   can discriminate via `instanceof`.

### Audit findings resolved before merge

- `deploymentMode` private field: widened to `string` by the implementer, narrowed
  back to `M3LDeploymentMode` (the companion union type) after type-design-analyzer
  flagged it. Compile-time closed-set invariant now enforced.
- `resolveStandaloneBase()`: `process.cwd()` OS throw wrapped in a try/catch so a
  deleted-cwd scenario surfaces as `M3LPathResolutionError`, not a bare Node `Error`.
  Maintains the `M3LError`-only hierarchy contract.
- `getProjectRoot()` guard: nested double-`if` collapsed to a single combined
  condition for clarity.

### Contract amendment

`M3L_CACHE_DIR` was absent from the reference doc and plan. The user chose to add
it for symmetry with the other four per-kind overrides. The reference doc, the
`M3LPathEnvironmentVariables` const-object, and the implementation were all updated
before code was written.
