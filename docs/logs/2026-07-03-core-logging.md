# Work log — `core/logging` submodule (2026-07-03)

This log covers implementing the `core/logging` submodule of
`@m3l-automation/m3l-common` end-to-end through the `implementing-submodules`
TDD + hub-and-spoke pipeline (contract → RED → GREEN → multi-spoke review →
doc sync → PR). It records what shipped, what matched the plan, the seven
divergences that shaped the run, and the durable lessons — most notably a
dependency whose real API contradicted the plan, repeated spoke-turn
truncations, a security-review-driven rewrite of the redaction surface, and a
31-commit rebase caused by four submodules landing in parallel during the run.

Plan of record: [`docs/plans/logging-submodule-implementation.md`](../plans/archive/logging-submodule-implementation.md)

## Summary

Shipped `core/logging` — structured, multi-handler logging surfaced through the
`Core` namespace barrel. **11 public exports:** `M3LLogger`, `M3LLogEvent`,
`M3LLogEventCategory`, `M3LConsoleLoggerHandler`, `M3LFileLoggerHandler`,
`M3LJsonLoggerHandler`, `M3LTableFormatter`, `M3LTableOptions`, `M3LTableColumn`,
`redactSensitiveLogText`, `redactSensitiveLogValue` (plus the supporting
`M3LFileLoggerHandlerOptions`; the handler interface `M3LLoggerHandler` is kept
internal). Split across 9 files with a pure re-export `index.ts`.

- **Tests:** 141 logging tests; full suite 1670 passing (26 files). Per-file
  coverage ≥80% on every logging file (most 100%; `M3LTableFormatter.ts` 93.75%
  branch, `redact.ts` 97.1% branch).
- **Gates:** `typecheck`, `lint`, `build`, `test:coverage`, `check:api`
  (exports map untouched — no semver event), `check:provenance`,
  `check:doc-exports`, `check:impl-counts` (18 of 22), `check:index`,
  `lint:md` — all green.
- **First runtime dependency:** `string-width@^8` (ANSI-aware table width),
  added via the dependency gate.
- **Review verdicts:** spec-conformance — conformant, no must-fix.
  code-reviewer — 2 must-fix (JSON envelope clobber, redaction leaks) + 3
  should-fix. security-reviewer — 3 must-fix (M1 envelope, M2/M3
  proto-pollution) + 1 should-fix (S1 leaks). type-design — no must-fix, 1
  should-fix (enum → const-object). silent-failure — file-write observability
  - failure-path test. Focused security **re-review** of the rewritten surface
    — M1/M2/M3/S1 all confirmed, plus 2 residual leaks (N1 fixed, N2 documented).
    All must-fixes applied and regression-tested.
- **Commits:** `8baa4e6` build(deps) string-width · `f1815c2` feat core/logging
  · `0dcac98` docs reconcile (post-rebase count 17→18). PR
  [#49](https://github.com/monte3l/m3l-automation/pull/49), `MERGEABLE`.

## What went as planned

- **Dependency gate honored.** `string-width` was surfaced with a rationale and
  approved before any `pnpm add` — the first runtime dep landed deliberately.
- **RED failed for the right reason** — `Cannot find module '../src/core/logging/index.js'`,
  not a logic error in the tests.
- **Exports map never touched.** The submodule surfaced entirely through the
  `Core` namespace barrel; `check:api` stayed green throughout (no accidental
  semver event).
- **Strict writer/reviewer separation held.** The hub never wrote `src`/tests;
  every must-fix routed back to the correct spoke (implementer for `src`,
  test-author for tests), and no spoke edited another's file.
- **Contract ratification up front paid off.** The contract spoke isolated the
  underspecified points (redaction key list, event field names, enum values)
  into an explicit list; ratifying them before RED meant tests were not built on
  guesses and rarely needed rework.

## What didn't go as planned, and why

### 1. The file-handler dependency's real API contradicted the plan

The plan (§1/§3) assumed `M3LFileListExporter` extended an `M3LListExporter`
base / `M3LEventEmitterBase` and streamed. The actual class is a whole-file JSON
writer: `export(items)` serializes the entire list and **overwrites** the file
each call — no base class, no streaming, no append. `M3LFileLoggerHandler` had
to accumulate events in memory and re-export the whole list on each emit, with
an internal sequential write-queue serializing the overwriting writes.

**Why it happened:** The plan described the dependency's internals from an
earlier design assumption that had rotted; nobody had re-read the shipped
`M3LFileListExporter.ts` before authoring the plan.

**Fix for future:** Before front-loading contract nuances into spokes, read the
_actual_ source of any dependency the module delegates to. Treat a plan's claims
about a dependency's internals as a hypothesis to verify, not ground truth.

### 2. Implementer spoke turns repeatedly truncated on long runs

The GREEN implementer's turn was cut off mid-response ("Connection closed") more
than once, and twice returned a truncated or absent summary. Direct filesystem
verification found real gaps the report never mentioned: `redact.ts` and the
module `index.ts` barrel were never written, and `src/core/index.ts` was not
wired. Recovery was to resume the **same** spoke via `SendMessage` with the
precise remaining work and re-verify state directly (`ls`, barrel `grep`,
`typecheck`) after each resume.

**Why it happened:** Bounded-I/O-heavy implementation work is token-heavy;
long turns hit connection/turn limits. A truncated turn returns a mid-thought,
not a completion summary.

**Fix for future:** Never trust a writer spoke's final report — verify the
filesystem directly (created files, barrel re-export line, `typecheck`/`test`).
On truncation, resume the same spoke with the specific gap rather than
re-dispatching fresh, and read its journal to locate exactly where it stopped.
(Already encoded in the `implementing-submodules` skill; this run confirms it.)

### 3. A typecheck failure lived in the test file, not the implementation

After GREEN, `pnpm typecheck` failed with 14 errors — all in
`tests/logging.test.ts` (`FakeHandler`'s bare `vi.fn()` mocks were inferred too
wide to satisfy the handler signature; and `expectTypeOf` enum assertions). The
implementer correctly flagged these as out-of-scope (it cannot edit tests) and
they were routed to the test-author.

**Why it happened:** Runtime tests pass without a type-check; `pnpm typecheck`
(tsc over the whole project including tests) surfaces test-side type errors the
runtime never sees. The mock typing was a test-authoring gap.

**Fix for future:** Run `pnpm typecheck` — not just `vitest run` — as part of
GREEN verification; a green runtime suite can still hide test-file type errors.
Type `vi.fn()` mocks with an explicit signature (`vi.fn<(e: T) => void>()`) when
they must satisfy a concrete interface under strict TS.

### 4. Security review drove a substantial rewrite of the redaction surface

The security spoke found three real must-fixes: caller `data` keys clobbering
the JSON envelope (`category`/`message` spoofing), and prototype-pollution in
both the JSON scalar-promotion loop and the `redactSensitiveLogValue` clone —
plus redaction leaks (bearer tokens, hyphenated and JSON-quoted keys). The
proto-pollution fixes reused `core/security`'s `isDangerousKey`. Because the
redaction surface was substantially rewritten, a focused security **re-review**
ran (writer ≠ reviewer for the new code) and found two more residual leaks: N1
(a sensitive `key=value` embedded in a non-sensitive field's value — URLs,
cookies) and N2 (unquoted values with internal spaces / single quotes). N1 was
fixed with an additive third pass; N2 was documented as a best-effort limitation.

**Why it happened:** Free-form-text redaction is fundamentally best-effort —
every regex has a bypass. The initial contract only specified two examples, so
the first implementation missed common real-world shapes.

**Fix for future:** For any net-new security-sensitive surface, run a **second**
review of the rewritten code (never let the fix ship on the strength of the same
pass that requested it). Reuse `isDangerousKey` for prototype-pollution guards
whenever building an object from untrusted keys (JSON promotion, clone loops) —
this does **not** conflict with a "don't reuse the secret list" rule, because
the clone-safety guard and the sensitive-key list solve different problems.

### 5. The S1 redaction fix introduced an over-capture regression

Fixing the bearer-token leak ("redact the whole value") over-broadened and made
`token=abc123 user=alice` swallow `user=alice`. The implementer caught it via a
failing test but was truncated before fixing.

**Why it happened:** "Redact the whole value after a sensitive key" is correct
for `Authorization: Bearer <tok>` (the credential spans a space) but wrong for a
space-delimited `key=value other=value` line.

**Fix for future:** Model the value capture as an optional auth-scheme prefix
plus a single token — `(?:(?:Bearer|Basic|Digest|Token)\s+)?[^\s,;]+` — so a
scheme-prefixed credential is consumed as a unit while a plain value still stops
at whitespace. Always regression-test the "adjacent unrelated pair survives"
case when widening a redaction pattern.

### 6. `M3LLogEventCategory` was the only `enum` in the codebase

The type-design spoke flagged that the module shipped a TS `export enum` — the
only one in `src` — where the codebase convention (documented on
`M3LConfigParameterType`) is a `const`-object + literal-union. It was converted.
This rippled into the test's type-level assertions (an enum member used as a
_type_ no longer compiles under the const-object form), which the test-author
fixed.

**Why it happened:** A string `enum` is a reasonable default in isolation, but
it is nominal — a value-identical `"success"` read back from a JSON log line
needs a cast to satisfy the enum. For a category the JSON handler serializes,
that hurts round-trip usability, and it broke codebase consistency.

**Fix for future:** For any closed string set, use the `const`-object +
`(typeof X)[keyof typeof X]` union (match `M3LConfigParameterType`), not a TS
`enum` — especially when the values are serialized and may round-trip.

### 7. The branch was 31 commits behind `main` by PR time (parallel merges)

Over a multi-hour run, four other submodules — `importers`, `network`,
`storage`, `files` — merged to `main`, moving the implemented count from 13 to 17. The pre-PR rebase conflicted on `package.json`/`pnpm-lock.yaml` (other deps
vs. `string-width`), and on every count-prose and index artifact. `src/core/index.ts`
and `catalog.json` auto-merged cleanly.

**Why it happened:** A long pipeline runs concurrently with other feature
branches that all touch the same shared metadata (dependency list, barrel,
`N of 22` counts, reference index).

**Fix for future:** Resolve **derived artifacts by regeneration, not hand-merge**
— take `main`'s dependency block and re-run `pnpm install` for the lockfile;
take `main`'s doc-count files and let `gen:index` + `check:impl-counts` derive
the authoritative count (here 18 of 22). Re-stamp the module's provenance to the
_live_ feature commit, since the pre-rebase commit ref is rebased away. This is
the repo's established "reconcile counts and index after rebasing onto main"
pattern.

## Lessons learned

- **Verify a dependency's real API** — before front-loading contract nuances,
  read the shipped source of anything the module delegates to; a plan's claims
  about a dependency's internals rot and mislead the contract.
- **Never trust a truncated spoke report** — verify the writer spoke's
  filesystem state directly (`ls`, barrel `grep`, `typecheck`); on a cut-off
  turn, resume the same spoke with the precise gap rather than re-dispatching.
- **`typecheck`, not just `vitest run`, gates GREEN** — a green runtime suite
  hides test-file type errors (mock typing, `expectTypeOf` misuse) that only
  `tsc` over the project surfaces.
- **Re-review rewritten security code** — when a fix substantially rewrites a
  security-sensitive surface, run a second independent review; the pass that
  requested the change should not also bless it. Free-form-text redaction is
  best-effort; `redactSensitiveLogValue` (structured) is the robust path.
- **`isDangerousKey` is the clone-safety guard** — reuse it whenever building an
  object from untrusted keys (JSON promotion, clone loops); this is distinct
  from, and does not conflict with, a redaction secret-key list.
- **Widen redaction patterns carefully** — model a value as optional
  scheme-prefix + single token so bearer credentials redact whole while
  adjacent `key=value` pairs survive; always regression-test the survivor case.
- **Closed string sets use const-object unions, not `enum`** — match
  `M3LConfigParameterType`; nominal enums force casts on serialized values that
  round-trip.
- **Resolve rebase conflicts on derived artifacts by regeneration** — take
  `main`'s deps/counts and re-run `pnpm install` / `gen:index` /
  `check:impl-counts` to derive the authoritative state; never hand-merge a
  lockfile, reference index, or `N of 22` count. Expect these conflicts on any
  long-running branch. _(promoted → .claude/skills/creating-prs/SKILL.md)_
