# Work log — `core/files` submodule (2026-07-03)

This log covers the end-to-end implementation of the `core/files` submodule
through the hub-and-spoke TDD pipeline (`implementing-submodules`): Contract →
RED → GREEN → four-spoke parallel review → doc reconciliation (`/syncing-docs`)
→ commits. It records what shipped, what matched the plan, the divergences
(most of them surfaced by the review fan-out), and the durable lessons.

Plan of record: [`docs/plans/files-submodule-implementation.md`](../plans/files-submodule-implementation.md)

## Summary

Shipped `M3LFileCopier` and the execution-directory file-archival surface —
register files during a run, then `finalizeRegisteredFiles()` copies them into
the `M3LPaths` output directory with a per-file `M3LFileCopyResult` and an
aggregate `M3LFileCopyReportSummary`.

- **9 exports** through the Core namespace barrel (the documented 8 plus a
  justified `M3LFileCopyError`): `M3LFileCopier`, `M3L_FILE_COPIER_DEFAULTS`,
  `getDefaultSubdirForPathType`, `M3LFileCopierOptions`, `M3LFileCopyResult`,
  `M3LFileCopySkipReason`, `M3LFileCopyReport`, `M3LFileCopyReportSummary`,
  `M3LFileCopyError`. The 3-entry `exports` map is unchanged (surfaced via the
  barrel, not a new subpath).
- **Dep-free** (`node:fs/promises` + `node:path`). `M3LPaths` (output dir) and
  `M3LPrompt` (large-file confirm) are injected **structurally** via
  `M3LFileCopierOptions` (anonymous port shapes) and constructed lazily, so the
  import graph stays shallow and tests inject plain-object fakes.
- **60 tests** in `tests/files.test.ts`; full suite **1263 tests** across 21
  files, all green. Coverage (full-suite v8): 96.51% stmts / 93.05% branch /
  99.38% funcs / 96.9% lines; every `core/files/**` and `internal/files/**`
  file ≥ 80% per-file (guards / subdirs / manifest / error / helper 100%;
  `M3LFileCopier` 92.5%/85.71% br; `copyExecution` 91.89%/90% br).
- **Gates**: `build`, `typecheck`, `lint`, `test`, `check:provenance`,
  `check:doc-counts`, `check:doc-exports`, `check:impl-counts`,
  `check:test-counts`, `gen:index`/`check:index`, `lint:md`, `format:check` —
  all pass.
- **Review verdicts**: spec-conformance **CONFORMANT** (no drift; exports map
  untouched); type-design **STRONG** (model discriminated union; two items
  consciously deferred — see below); silent-failure **PASS** after 4 Must-fix
  resolved; code-reviewer **APPROVED** after 2 Must-fix + should-fixes resolved.
- **Commits**: `feat(files)` `8e687e4` + `docs: re-stamp provenance` `8ab2640`,
  both signed. Implemented count moved **12 → 13 of 22**.

## What went as planned

- **Section 0 prerequisite gate cleared immediately** — `utils.M3LPaths` and
  core `prompt` were both already implemented and barrel-exported, so `files`
  could consume them directly (no stubbing, no decoupling callback).
- **RED failed for the right reason** — `Cannot find module
'../src/core/files/index.js'`, i.e. missing module, not a logic error in the
  tests.
- **The contract spoke front-loaded the hard decisions** — it pinned the
  discriminated-union result shape, the four skip-reason literals, the
  structural `paths`/`prompt` injection points, and flagged `M3LFileCopyError`
  as a needed 9th export up front, so the doc page was extended before RED and
  spec-conformance came back CONFORMANT with zero drift.
- **The public surface stayed locked at exactly 9 named exports** through every
  round — the barrel never grew, the `exports` map never changed, so the whole
  change is a clean `feat:` minor.
- **The writer-never-reviewer split did its job** — the implementer correctly
  refused to edit tests when it found a broken fixture, and the test-author
  correctly refused to edit `src/**` when it found src-side lint; both reported
  the cross-boundary issue back to the hub for routing.

## What didn't go as planned, and why

### 1. Stale plan premises — prerequisites already shipped and the count was 12→13, not 5→6

The plan's Context and Section 0 predicted the prerequisite gate would **fail**
(`M3LPaths` deferred, `prompt` not-started) and that the implemented count would
move 5 → 6. In reality the base branch was much further along: `M3LPaths` (utils
Phase D) and `prompt` had both shipped, 12 submodules were done, and shipping
`files` moved the count **12 → 13**. The plan's note about pre-existing README
count drift ("3/22", "2/22") was also stale — the count sites were consistently
at 12.

**Why it happened:** The plan was authored against an earlier repo state; base
`main` advanced (prompt PR #44, utils Phase D, network, etc.) between authoring
and execution. A stored plan is a hypothesis, not ground truth.

**Fix for future:** Re-validate every count, "already exists", and
"deferred/not-started" premise against the live repo before acting on it —
exactly the `implementing-submodules` Step 2 re-validation — and delegate the
count reconciliation to `/syncing-docs`/`check:impl-counts` rather than trusting
the plan's numbers.

### 2. Two RED-phase test-fixture bugs surfaced only at GREEN

After GREEN, one runtime test failed and four typecheck errors remained — all in
the test file. (a) The "summary math" fixture was **unsatisfiable**:
`maxFileSizeBytes: 100` with `largeFilePromptThresholdBytes: 150` meant a
151-byte "declined" file was skipped `size-too-large` before the prompt could
ever run (size-skip pre-empts prompt), so `declined-by-prompt` was unreachable
and two files landed as `size-too-large`. (b) The `expectTypeOf`
`.toMatchObjectType<{…}>()` assertions used **mutable** expected shapes against
the (correctly) `readonly` impl types, and one `.not.toHaveProperty("reason", ""
as never)` carried a RED-only second argument. The implementer correctly did not
touch the tests; the hub routed all three back to the test-author.

**Why it happened:** Tests written before the implementation exists encode
guesses about type-checker arg-count behavior (which resolves differently once
`any` becomes a real type) and can encode logically impossible option
combinations that no happy-path assertion catches until the real behavior runs.

**Fix for future:** When authoring RED type-level tests, match the documented
`readonly`-ness of the target types in the expected shapes, and treat any
`expectTypeOf` matcher whose arg-count depends on a mismatch as provisional
until GREEN. For behavioral fixtures that combine thresholds, sanity-check the
combination is satisfiable (`promptThreshold < maxFileSizeBytes` for a
prompt-declined outcome to be reachable).

### 3. Real `core → internal → core` import cycle, hidden behind dead code

The code-reviewer caught that `internal/files/subdirs.ts` imported
`M3LFileCopyError` from `core/files`, while `core/files/getDefaultSubdirForPathType.ts`
imported `subdirs.ts` — an inverted-layering cycle. Its only cause was an
**unreachable** `default: throw` branch in an exhaustive `switch` (the
`M3LPathType` union is closed and all five cases returned). Removing the dead
throw both deleted the dead code and broke the cycle.

**Why it happened:** A defensive `default: throw` was added to a `switch` that
was already exhaustive, and the throw needed an error type — pulling a `core/`
import down into an `internal/` leaf.

**Fix for future:** Internal helpers must be leaves — they may be imported by
`core/`, never import back up into it. For an exhaustive map over a closed
union, prefer a `Record<Union, T>` lookup (see item 5) so there is no
unreachable branch demanding an error import in the first place.

### 4. Path-traversal write-escape on `subdir` and `manifestFileName`

`sourcePath` was defended with `path.basename(...)`, but the caller-supplied
`subdir` and `manifestFileName` were `path.join`-ed raw, so `subdir: "../../x"`
or `manifestFileName: "../../escape.json"` could write **outside** the output
directory. The asymmetry (one path input defended, two not) was itself the tell
that it was unintentional. Fixed with a shared `isSafeRelativeSegment` guard
(rejects absolute paths and any `..` segment after `path.normalize`) wired at
both boundaries, throwing `M3LFileCopyError`; documented in `files.md`.

**Why it happened:** The output-dir containment invariant was enforced for the
filename component but not for the directory-hint or manifest-name components —
the boundary-validation rule was applied unevenly.

**Fix for future:** Validate **every** external path-shaped input at the public
API boundary (reject absolute / `..` after normalization), not just the obvious
one. When one path input is sanitized and a sibling isn't, treat the asymmetry
as a bug, not a decision.

### 5. errno-conflation swallowed infrastructural failures as `source-unreadable`

The silent-failure-hunter found `tryStatSize`/`pathExists` used bare `catch {
return undefined/false }` around `stat()`, folding genuine infra errors
(`EMFILE`, `EIO`, `ELOOP`) into the same benign per-file skip as `ENOENT`. A
transient FD exhaustion mid-batch would mislabel every remaining file as
"missing" with no signal. Fixed by narrowing to an errno allowlist
(unreadable/absent codes → recorded skip) and rethrowing anything else as a
batch-fatal `M3LFileCopyError` chaining `cause`; the batch-fatal paths were also
differentiated by phase (`output-dir` / `copy` / `manifest`) with
partial-progress context.

**Why it happened:** A catch-all is the easy way to turn "file missing" into a
skip, but it silently captures every other failure mode of the same call.

**Fix for future:** Never wrap a fallible `fs` call in a bare `catch` that
returns a benign sentinel. Inspect `err.code` and only treat the specific
expected codes as recoverable; rethrow the rest (chained with `cause`) so a real
infrastructural failure surfaces instead of masquerading as an expected skip.

### 6. Exhaustiveness-vs-coverage: the `never` default branch is uncoverable

Converting item 3's `switch` still left the classic tension — an exhaustive
`switch` with a `default: { const _: never = x }` guard has a branch no test can
reach (you can't pass an invalid `M3LPathType`), so `subdirs.ts` sat at 75%,
under the 80% per-file gate. Solved by replacing the switch with a
`Readonly<Record<M3LPathType, string>>` lookup: still compile-time exhaustive (a
missing key is a compile error), but with **no** unreachable branch — 100%
coverable.

**Why it happened:** The exhaustiveness idiom (`never` default) and the per-file
coverage gate pull in opposite directions for a static closed-union map.

**Fix for future:** For a static map keyed by a closed union, reach for
`Record<Union, T>` rather than a `switch` — it gives the same exhaustiveness
guarantee with no dead default branch to erode coverage.

### 7. GREEN-spoke returns were repeatedly truncated mid-thought

Several long implementer/test-author turns returned a truncated fragment
("Let's check `MismatchArgs`…", "Clean. Let's format…") instead of a completion
summary. Each time, the hub verified actual state directly — read the spoke's
journal, listed created files, grepped the barrel, and ran
`vitest`/`tsc`/`eslint` itself — rather than trusting the report, and caught the
still-open items (test bugs, then lint, then coverage) that the truncated
summaries omitted.

**Why it happened:** Token-heavy rework runs (bounded-I/O, type-level debugging)
hit the turn limit and returned a mid-thought.

**Fix for future:** Treat any truncated spoke return as "state unknown" — read
the journal file and re-run the gates yourself before deciding the phase is
done. The journal path handed to each spoke is what makes this cheap; keep
handing it out.

### 8. Pre-existing `prompt` test-count drift surfaced by the gate

`check:test-counts` failed on `prompt` (recorded 80, actual 81) — unrelated to
`files`, but a gate the PR must pass. Corrected the Notes column to 81.

**Why it happened:** A `prompt` test was added (or the original count was
off-by-one) without updating the status-file Notes; the drift lay dormant until
another run of `/syncing-docs` re-ran the gate.

**Fix for future:** Expect `/syncing-docs` to surface pre-existing count drift in
adjacent rows; fix the flagged Notes value as part of reconciliation rather than
treating it as out of scope — it blocks the same CI gate.

## Lessons learned

- **Re-validate stale plan premises** — a stored plan is a hypothesis; verify
  every count, "already exists", and "deferred" claim against live `main` before
  acting, and delegate count reconciliation to `/syncing-docs`.
- **Internal helpers are leaves** — modules under `internal/` may be imported by
  `core/` but must never import back up into it; an inverted import is a cycle
  even when nothing runs at module-eval time yet.
- **`Record` over `switch` for closed-union maps** — a `Readonly<Record<Union,
T>>` lookup is compile-time exhaustive with no unreachable `default: never`
  branch, so it satisfies both the exhaustiveness idiom and the per-file
  coverage gate (the `switch` `never` default cannot).
- **Sanitize every path-shaped external input** — reject absolute / `..`-segment
  values at the public API boundary for _all_ path inputs; a lone unsanitized
  sibling next to a defended one is a traversal bug, not a trust decision.
- **Never bare-`catch` a fallible `fs` call** — inspect `err.code`, treat only
  the specific expected errno codes as a recoverable skip, and rethrow the rest
  chained with `cause`, so an infra failure (`EMFILE`/`EIO`) never masquerades as
  an expected "missing file" skip.
- **RED type-tests must match `readonly`-ness** — `expectTypeOf`
  `.toMatchObjectType` expected shapes must carry the same `readonly` modifiers
  as the target types, and any matcher whose arg-count depends on a mismatch is
  provisional until GREEN resolves the real type.
- **Sanity-check fixture satisfiability** — a multi-threshold fixture can be
  logically impossible (here `promptThreshold > maxFileSizeBytes` made
  `declined-by-prompt` unreachable); verify the intended outcome is actually
  reachable given the precedence rules.
- **Truncated spoke return ⇒ state unknown** — verify via the journal + re-run
  the gates yourself; never mark a phase done on a mid-thought summary.
- **A justified extra export must land in the doc + provenance in the same
  change set** — `M3LFileCopyError` (the 9th export, beyond the spec's 8) was
  added to `files.md` and the provenance sidecar before review, so conformance
  saw no drift.
- **Deferred type-design calls, recorded deliberately** — byte thresholds stay
  plain `number` with a runtime `M3LFileCopyError` guard (a brand would be
  friction without a mixup risk), and the flat `writeManifest` +
  `manifestFileName` pair is kept (idiomatic, contract-locked, non-corrupting)
  rather than collapsed; both are conscious tradeoffs, not oversights.
