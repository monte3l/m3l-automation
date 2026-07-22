# Work log — `core/importers` submodule (2026-07-03)

This log covers the end-to-end implementation of the `core/importers`
submodule through the `implementing-submodules` hub-and-spoke TDD pipeline
(contract → RED → GREEN → multi-reviewer fan-out → doc reconciliation). It
records what shipped, what matched the plan, the divergences (a twice-truncated
writer spoke, a runtime-green-but-typecheck-red test file, and two rounds of
security-guard asymmetry caught only by re-review), and the durable lessons.

Plan of record: [`docs/plans/importers-submodule-implementation.md`](../plans/archive/importers-submodule-implementation.md)

## Summary

Shipped `core/importers` — streaming + batch file parsing for CSV, JSON/JSONL,
and text sources — as **13 public exports** surfaced through the `Core`
namespace barrel (the 3-entry `exports` map is unchanged, so this is a minor):

- **Contract types:** `M3LListImporter<TItem>` (batch `import()` +
  `importStream()` async generator), `M3LListImporterEvents` (5-event map),
  `M3LListImporterResult`.
- **CSV:** `M3LCSVListImporter` (+ `Options`), `M3LCSVFormatAdapter`,
  `M3LCSVAdapterFactory` — `csv-parse`-backed pipeline (column mapping →
  defaults → validator → transformer).
- **JSON/JSONL:** `M3LJSONListImporter` (+ `Options`), `M3LJSONFileImporter` —
  array-vs-JSONL dispatch via the reused `M3LJSONFormatDetector`, dot-notation
  field paths via the reused `M3LJSONFieldExtractor`.
- **Whole-file readers:** `M3LFileImporter`, `M3LTextFileImporter`,
  `M3LFileListImporter`.

**Runtime dep:** `csv-parse@7.0.0` (approved at the dependency gate,
exact-pinned like `yaml`). **Tests:** 76 importers tests; full suite 1038;
coverage ≥80% on every importers file (most 100%, `resolveSource.ts` 100%).
**Gates:** `typecheck`, `lint`, `build`, `check:exports` (publint "All good!" +
attw esm-only clean), `check:doc-exports`, `check:provenance`,
`check:doc-counts`, `check:impl-counts`, `check:index`, `lint:md` — all green.

**Review fan-out (5 spokes):** code-reviewer — FAIL→clean (2 must-fix);
spec-conformance — conformant, exactly 13 symbols after fixing a leaked 14th;
silent-failure-hunter — 1 CRITICAL (fixed, re-verified CLOSED); type-design —
no must-fix, type surface within rules; security-reviewer — no must-fix, 3+2
boundary should-fixes all sealed. Independent re-review of the fix round
confirmed closure and caught one MEDIUM + two residual guard asymmetries.

**Commits (branch `feat/importers`, linked worktree):**
`b4b7daf` chore(csv-parse dep) · `642af15` feat(importers) · `ace87cb`
docs(sync provenance/index/counts).

## What went as planned

- **Prerequisite gate cleared up front** — the plan's blocking §0 (json must be
  implemented, exporting `M3LJSONFormatDetector`) was verified before any code:
  json was ✅, so importers was unblocked immediately.
- **Dependency gate worked as designed** — paused on `csv-parse`, got explicit
  approval, added it exact-pinned, committed it as its own focused `chore:`
  before implementation so later `git status` diffs showed only spoke work.
- **RED failed for the right reason** — 57 tests, 44 failing with
  `Core.M3LXxx is not a constructor` / `TS2307` (missing module), not broken
  assertions.
- **Maximal reuse, no reimplementation** — extended `M3LEventEmitterBase` for
  handler isolation, reused `M3LJSONFormatDetector` / `M3LJSONFieldExtractor`,
  `M3LError` + `cause`, and the security module's `isDangerousKey`. No detection,
  field-path, or event machinery was rewritten.
- **Held the 13-symbol contract** — surfaced through the namespace barrel only;
  the `exports` map was never touched.
- **Doc reconciliation via `/syncing-docs`** — count bump flowed entirely from
  `check:impl-counts` output (5 sites, 9→10), not a hand-picked edit list.

## What didn't go as planned, and why

### 1. The GREEN implementer's turn was truncated twice mid-run

The `submodule-implementer` returned a "mid-thought" message ("Let me use
`M3LError` there instead") rather than a completion summary — twice. The first
truncation had silently left `M3LJSONListImporter.ts`, the `index.ts` barrel,
and the `export * from "./importers/index.js"` core-barrel surfacing **unwritten**
(only 8 of ~10 files existed). Directly inspecting the writer's state — read its
journal, `ls` the module dir, `grep` the barrel, run the gates — located the
exact gap each time, and resuming the **same** spoke via `SendMessage` (with the
specific missing pieces) finished it without losing context.

**Why it happened:** a bounded-I/O implementation loop is token-heavy and can hit
the turn limit before it emits a summary; the returned text is then a mid-edit
fragment, not a status report.

**Fix for future:** never trust a writer spoke's final message — verify state
directly (journal + `ls` + `grep` barrel + gates). This is the core/json
divergence-5 lesson; front-loading a **journal path** into the dispatch made
recovery precise, and `SendMessage`-resuming the same spoke beat re-dispatching a
fresh one.

### 2. Tests were runtime-green but typecheck-red / lint-red

The RED spoke reported 57/57 vitest pass, but `tsc -b` then failed with 3
`TS2322`s and `eslint` with a `no-unsafe-return`. The type errors were bare
event-handler arrows returning `Array.prototype.push`'s `number`
(`() => order.push("x")`) into the `(payload) => void | Promise<void>` handler
slot; the lint error was an untyped mock `FileHandle` widening to `any`.

**Why it happened:** Vitest transpiles with esbuild/swc, which **strips types
without checking them**, so a runtime-passing test file can still be
typecheck-invalid. The test runner is not a type gate.

**Fix for future:** a spoke that writes `tests/**` must run `tsc -b` **and**
`eslint` on the file, not just the test runner — runtime-green ≠ typecheck-green.

### 3. Review found a CRITICAL bad-record abort and a leaked 14th export

The 5-reviewer fan-out surfaced two Must-fix items, each independently confirmed
by two reviewers: (a) a throwing CSV `rowValidator` / `rowTransformer` /
`adapter.map` **escaped the async generator and aborted the entire import**
instead of emitting `import:error` + skipping the one record — a regression of a
record-level failure to source-level semantics (silent-failure-hunter +
code-reviewer); (b) `M3LCSVFormatAdapterConfig` leaked through the barrel as a
**14th public export**, breaking `check:doc-exports` — a real CI gate
(spec-conformance + code-reviewer). Fixes: a `try/catch` around the pipeline body
converting throws into bad-record outcomes; inlining the config type at its two
call sites to hold the count at exactly 13.

**Why it happened:** the happy-path CSV tests never threw from a callback, so the
escape path was uncovered; and the config type was a natural named interface that
`export *` surfaced without anyone counting it against the documented 13.

**Fix for future:** for a documented-symbol-count contract, treat any new public
type (esp. an options/config interface behind a class) as a count event —
`check:doc-exports` is the backstop but the RED tests should assert the exact
export set. For streaming/parse code, always include a throwing-callback /
bad-record test.

### 4. The security guard was asymmetric across emit paths — twice

`importers` is the declared external-input boundary, so it needed the
`isDangerousKey` write-side guard the config providers already use. The **first**
security fix guarded the JSON no-`fieldPath` branch and the CSV columnMapping
targets but **missed** two sibling paths — the JSON `fieldPath`-extracted object
(an extracted nested object can carry an own `__proto__`) and the CSV
no-`columnMapping` passthrough (a raw `constructor`/`prototype` header survives).
An independent re-review caught both. The durable fix was a **single item-level
`hasDangerousOwnKey` screen applied before ANY item is emitted**, unifying all
four paths. The same round also wrapped the raw third-party `CsvError` from
`on_skip` in an `M3LError` (one-hierarchy contract) and stopped embedding full
row content in error messages/`context`.

**Why it happened:** the guard was added per-path as each hole was reported, so
coverage tracked the findings rather than the full set of emit paths; a
read-side guard (`navigateFieldPath`) was mistaken for covering the returned
object's own keys.

**Fix for future:** enforce a cross-cutting invariant (no dangerous own-key ever
emitted) at the **single choke point** every value passes through, not at each
discovered site. Enumerate all emit/return paths first, then guard the join.

### 5. Re-reviewing the fix round (not just the original code) paid off

The fixes in items 3–4 were written by the implementer and only hub-verified. A
lean independent re-review (silent-failure + security on the _changed_ code)
caught a MEDIUM (`CsvError` not wrapped) and the two guard asymmetries that the
first fix introduced.

**Why it happened:** a fix round is new code written by the writer; without an
independent pass, "writer ≠ reviewer" is broken for exactly the change most
likely to be subtly wrong.

**Fix for future:** when a fix round makes non-trivial changes, re-run the
relevant reviewer(s) on the diff before declaring the loop closed — don't let
hub self-verification substitute for the structural writer≠reviewer separation.

### 6. Provenance stamp ordering and a rotted plan premise during doc sync

Two smaller snags in the `/syncing-docs` pass: (a) the provenance sidecar
stamps a commit hash, so it can only point to the feat commit _after_ that commit
exists — resolved by committing `feat` first, then re-stamping in a follow-up
`docs:` commit; `check:doc-provenance --update` re-stamps **all** sidecars to
HEAD, so the 9 unrelated ones were reverted to keep the PR focused and avoid
conflicts with the parallel `feat/core-exporters` branch (ADR-0013 partition
rule). (b) The plan claimed `packages/m3l-common/README.md` held a stale
"2 of 22" that was out of scope — but it actually read **9**, in sync with the
other sites, so it was part of _this_ count bump (all 5 sites 9→10).

**Why it happened:** provenance freshness is inherently a post-commit stamp; and
a stored plan is a hypothesis whose "what already exists" premises rot between
authoring and execution.

**Fix for future:** re-validate every count/premise in a stored plan against the
live repo before acting (the count sites especially), and let `check:impl-counts`
define the edit set rather than the plan's prose. Under concurrent pipelines,
revert `--update`'s incidental re-stamps of sidecars you didn't change.

## Lessons learned

- **Verify a truncated writer spoke's state directly** — a mid-thought return can
  hide unwritten files (here: the whole JSON importer + barrel + surfacing).
  Read the journal, `ls` the dir, `grep` the barrel, run the gates; resume the
  _same_ spoke via `SendMessage`. _(already in `.claude/skills/implementing-submodules/SKILL.md` + `submodule-implementer.md`)_
- **Runtime-green ≠ typecheck-green for tests** — Vitest strips types, so a
  passing test file can still fail `tsc -b`/`eslint`. A tests-writing spoke must
  run both, not just the runner.
  _(promoted → .claude/agents/test-author.md, .claude/rules/tests.md)_
- **A new options/config interface behind a class is a symbol-count event** —
  `export *` will surface it; for a documented-N-symbols contract, inline it or
  document it, and let RED assert the exact export set. `check:doc-exports` is the
  CI backstop.
- **Guard cross-cutting invariants at the single choke point** — enumerate every
  emit/return path and screen the join (one `hasDangerousOwnKey` before any item
  is emitted) instead of patching each hole as it's reported; a read-side guard
  does not cover the returned object's own keys.
- **Re-review the fix round, not just the original** — fixes are fresh writer
  code; an independent pass on the diff preserves writer≠reviewer and caught a
  MEDIUM + two residual asymmetries here.
  _(promoted → .claude/skills/implementing-submodules/SKILL.md, .claude/rules/subagent-dispatch.md)_
- **Streaming/parse code needs a bad-record + throwing-callback test** — the
  happy path hides whether one bad record is skipped-and-emitted or aborts the
  whole run. _(promoted → .claude/agents/test-author.md)_
- **Re-validate stored-plan premises, especially counts** — the plan's
  "out-of-scope stale 2 of 22" had rotted to 9; let `check:impl-counts` define
  the count-edit set. _(re-validation already in `implementing-submodules` Step 2)_
- **Under concurrent pipelines, keep provenance re-stamps scoped** — `--update`
  re-stamps all sidecars to HEAD; revert the ones you didn't change to avoid
  cross-branch conflicts (ADR-0013 partition).
