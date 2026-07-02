# Work log — `core/exporters` submodule (2026-07-03)

This log covers implementing the `core/exporters` submodule of
`@m3l-automation/m3l-common` through the hub-and-spoke TDD pipeline
(contract → RED → GREEN → four-spoke review → doc reconciliation). It records
what shipped, what matched the plan, the divergences (a worktree/tooling
mismatch, a stale test stub, a TypeScript handler gotcha, and the review
must-fixes), and the durable lessons.

Plan of record: [`docs/plans/exporters-submodule-implementation.md`](../plans/exporters-submodule-implementation.md)

## Summary

Shipped the `exporters` submodule — streaming + batch file export for CSV,
JSON/JSONL, HTML, and binary/whole-file outputs. Committed as `8297b83` (signed)
on `feat/core-exporters`.

- **9 surfaced symbols + option/event/payload types**: the `M3LListExporter<TItem>`
  contract and its synchronous `M3LListExporterStreamWriter<TItem>`; three
  event-emitting list exporters (`M3LCSVListExporter`, `M3LJSONListExporter`,
  `M3LHTMLListExporter`) extending `M3LEventEmitterBase`; four whole-file exporters
  (`M3LFileExporter`, `M3LJSONFileExporter`, `M3LBinaryFileExporter`,
  `M3LFileListExporter`); plus `ColumnConflictStrategy`, `M3LListExporterEvents`
  (+ started/completed/error payloads), and each exporter's `*Options`.
- **Dependency**: `csv-stringify@^6.8.0` (CSV path only; added via `pnpm --filter`,
  lockfile updated). Non-CSV exporters use Node built-ins.
- **Surface**: wired through the Core namespace barrel; the 3-entry `exports` map
  (`.`, `./core`, `./aws`) is unchanged — a **minor** `feat:`.
- **Tests**: 74 module tests; full suite 1036 passing. Per-file coverage ≥80% on
  every metric (`internal/writeStreamLifecycle.ts` and `internal/onceErrorEmitter.ts`
  at 100%; `core/exporters` aggregate 96.8% stmt / 92% branch / 100% fn / 98.3% line).
- **Gates**: `typecheck` / `lint` / `build` / `test` green; `check:api` (exports map
  unchanged), `check:provenance` (10 sidecars), `check:doc-counts` (22),
  `check:doc-exports` (10 implemented), `check:impl-counts` (10 of 22),
  `check:index` (130 symbols), `check:scaffold` all ✓.
- **Review verdicts** (four spokes): spec-conformance **conformant, zero findings**
  (doc Public API ↔ barrel matched 1:1); code-reviewer and silent-failure-hunter
  each returned a first-pass **FAIL** whose must-fixes were fixed and then
  **re-verified PASS**; type-design-analyzer: no must-fix, two should-fix folded in.

## What went as planned

- **Contract-first was clean.** `spec-conformance-reviewer` in contract mode
  enumerated all 9 symbols, verified the real event-base export name
  (`M3LEventEmitterBase`) and that `errors` exports only `M3LError` (no
  subclasses), and flagged the spec's underspecified areas up front so the hub
  could rule on them before RED.
- **RED failed for the right reason** — `Cannot find module '../src/core/exporters/index.js'`
  (barrel absent), not an assertion or logic error.
- **spec-conformance passed on the first post-GREEN review** with no drift —
  the implementer's decision to name the concrete option/event types and update
  `exporters.md`'s Public API in the same change set kept doc and barrel in sync.
- **Coverage-driven test rounds converged quickly** — handing the test-author the
  exact uncovered line numbers from `coverage-final.json` (not the v8 text table)
  made each round land ≥80% per file without flailing.

## What didn't go as planned, and why

### 1. A sibling worktree was incompatible with the primary-rooted spoke pipeline

`starting-work` created a linked sibling worktree (`m3l-automation-core-exporters`),
but the very first spoke Write into it (the RED test file) was hard-blocked by
`guard-branch-isolation.mjs` reporting "HEAD is `main`", even though the worktree
was on `feat/core-exporters`. The hook resolves the branch by running `git
rev-parse` with no `cwd`, so it reads the **process cwd's** HEAD — and the spoke
Bash cwd resets to the primary checkout (on `main`) every call — rather than the
repo that owns the target file. We abandoned the worktree, switched the primary
checkout to `feat/core-exporters` in place (`git switch`), and flagged the hook
gap as follow-up task `task_7a00a254`.

**Why it happened:** `guard-branch-isolation.mjs`'s `defaultGit()` calls
`execFileSync("git", …)` with no `cwd`, so a primary-checkout-rooted session that
writes into a _different_ worktree is judged against the primary checkout's
branch, not the target file's.

**Fix for future:** Don't drive a sibling-worktree pipeline from a
primary-checkout-rooted session — either root the session _inside_ the worktree,
or (simpler for a single non-concurrent pipeline) use an **in-place** feature
branch (`git switch -c`). Reserve worktrees for genuinely concurrent pipelines,
per the `starting-work` guidance. The hook itself should resolve the branch from
the target file's repo (`task_7a00a254`).

### 2. A stale test stub hung the streaming happy path

First GREEN passed 44/47, with 3 streaming tests timing out (including two
happy-path CSV/JSON streaming tests). The implementation's `write()` correctly
used the real Node `fs.WriteStream.write(chunk, callback)` contract, but the
test's `stubWriteStream.write(chunk)` never invoked the callback, so the write
promise never resolved and `append()` hung to a 5s timeout.

**Why it happened:** The stub modeled `write(chunk): boolean` (backpressure
signal) but omitted the callback the impl awaits — a mock that no longer matches
the impl's I/O primitive silently intercepts nothing.

**Fix for future:** When a stream/IO stub backs an exporter/importer, model the
**callback** form of the primitive (`write(chunk, cb)` → invoke `cb()` on
success, `cb(err)` on failure), not just its return value. This is the
already-documented "update the mock the moment the impl's I/O primitive changes"
rule from `.claude/rules/refactoring.md`.

### 3. `void | Promise<void>` handler return type broke a common test idiom

Event handlers written as `exporter.on("export:started", () => events.push("started"))`
failed `typecheck` with TS2322 ("Type 'number' is not assignable to type
'void | Promise<void>'"). `Array.push` returns a `number`, and a **union**
return type that includes `void` does **not** get the "a void-returning callback
may return anything" ergonomic that a bare `void` return type gets.

**Why it happened:** The `M3LEventHandler` return type is `void | Promise<void>`
(to allow async handlers). TypeScript's void-callback leniency applies only to a
return type of exactly `void`, not to a union containing it.

**Fix for future:** In tests, brace any event-handler body whose expression
returns a value (`() => { events.push("x"); }`) rather than relying on implicit
return, whenever the handler type is `void | Promise<void>`.

### 4. Two review must-fixes: error-context consistency and an unconstrained generic

code-reviewer and silent-failure-hunter both FAILed the first pass. **M1**: the
three list exporters constructed `M3LError` with only `code`/`cause`, dropping the
`context: { filePath }` the four whole-file exporters already attached (a ruling-H3
inconsistency). **M2**: the list exporters were declared `class …<TItem>` and then
cast `item as Record<string, unknown>` internally, so `new M3LCSVListExporter<number>()`
type-checked and then silently produced an empty file. Fixed M1 by threading
`filePath`, M2 by constraining the **row** exporters to `TItem extends object`.
Three should-fixes were folded into the same round: S1 (`export:error` payload
typed `M3LError`, not `unknown`), S3 (a one-shot `onceErrorEmitter` so
`export:error` fires at most once per writer), S4 (backpressure — `await 'drain'`
when `fs.WriteStream.write()` returns `false`).

**Why it happened:** The spec underspecified the error shape and the item generic;
the implementer picked locally-reasonable choices that diverged from the
whole-file exporters' (correct) pattern and left the generic unconstrained.

**Fix for future:** When several sibling classes share an error/emit pattern,
state the reference pattern (here: the whole-file exporters' `M3LError` with
`code` + `context: { filePath }` + `cause`) in the implementer hand-off so all
siblings match. For a row-shaped generic, constrain it (`extends object`) rather
than casting internally — but avoid `extends Record<string, unknown>`, which
rejects declared `interface` item types (no implicit index signature).

### 5. Spec gaps needed explicit hub rulings before RED

`exporters.md` did not state how JSON array-vs-JSONL mode is chosen, the exact
whole-file exporter method shapes, the error type, or whether the item generics
are constrained. Left to the spokes, the test-author would have over-constrained
and the implementer under-constrained. The hub issued five rulings (H1–H5) and
front-loaded them verbatim into both the RED and GREEN hand-offs.

**Why it happened:** The reference page describes behavior in prose but does not
pin every API shape — normal for a spec written before implementation.

**Fix for future:** Have the contract spoke explicitly list "ambiguities requiring
a decision," then resolve each as a numbered hub ruling and paste those rulings
into every downstream hand-off — so test-author and implementer build against the
same resolved contract.

### 6. The implementer spoke returned truncated mid-thought three times

`submodule-implementer` hit its turn limit on token-heavy rework and returned a
mid-sentence fragment (not a completion summary) three times. Its summaries would
have hidden a **missing Core-barrel re-export** and an **un-done `exporters.md`
Public-API update**. Reading its journal plus direct state verification (`grep`
the barrel, `ls` the files, run coverage) caught both, and resuming the _same_
spoke via `SendMessage` closed them.

**Why it happened:** Long bounded-IO rework is token-heavy; a spoke can exhaust
its turn before writing its final report.

**Fix for future:** Never trust a writer spoke's final summary — verify state
directly (barrel `grep`, file `ls`, `pnpm test`/coverage) and read its journal to
find where it stopped. This is the "verify the writer spoke directly" rule already
in the `implementing-submodules` playbook; it paid off three times here.

## Lessons learned

- **Worktree vs. session root** — a linked sibling worktree only works if the
  driving session (and its spokes' cwd) is rooted _inside_ it; from a
  primary-checkout-rooted session, `guard-branch-isolation.mjs` judges writes
  against the primary branch and blocks them. Use an in-place branch for a
  single pipeline; reserve worktrees for concurrent ones. (Hook fix tracked as
  `task_7a00a254`.)
- **Mock the callback, not just the return** — a stream/IO stub must model the
  callback form of the primitive the impl awaits (`write(chunk, cb)`), or the
  happy path hangs. Already covered by the stale-mock rule in
  `.claude/rules/refactoring.md`.
- **Brace void-union handlers in tests** — when a handler type is
  `void | Promise<void>`, an arrow whose body returns a value (`() => arr.push(x)`)
  fails typecheck; wrap the body in braces. The void-callback leniency applies
  only to a return type of exactly `void`. _(promoted → .claude/rules/tests.md)_
- **State the reference pattern for sibling classes** — when N classes share an
  error/emit shape, name the canonical one (whole-file exporters' `M3LError` with
  `code` + `context: { filePath }` + `cause`) in the implementer hand-off so all
  siblings match and review doesn't have to catch the drift.
- **`extends object`, not `Record<string, unknown>`, for row generics** — the
  latter rejects declared `interface` item types (no implicit index signature),
  a worse DX regression than the internal cast it removes; `extends object` still
  closes the primitive footgun. _(promoted → .claude/rules/library-src.md)_
- **Resolve spec gaps as numbered hub rulings before RED** — have the contract
  spoke list ambiguities, rule on each, and paste the rulings into every
  hand-off so test-author and implementer build the same contract.
- **Verify the writer spoke, never its summary** — reading the journal plus
  direct state checks (barrel `grep`, `ls`, coverage) caught a missing barrel
  re-export and an un-done doc edit across three truncated returns. Already in the
  `implementing-submodules` playbook; confirmed load-bearing.
- **Read coverage from `coverage-final.json`** — handing the test-author exact
  uncovered line numbers (not the v8 text table, which hides 100% files) made the
  coverage rounds converge in one pass each.
