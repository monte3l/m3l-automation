# Work log — `core/storage` submodule (2026-07-02)

This log covers implementing the `storage` Core submodule
(`M3LFtsIndex`, an FTS5-backed full-text search index over `better-sqlite3`)
end-to-end through the `implementing-submodules` hub-and-spoke TDD pipeline:
contract seed → RED → GREEN → five-spoke review → fix round → re-review →
provenance + `/syncing-docs`. It records what shipped, what matched the plan,
the divergences and their root causes, and the durable lessons.

Plan of record: [`docs/plans/storage-submodule-implementation.md`](../plans/storage-submodule-implementation.md)

## Summary

- **Shipped:** `M3LFtsIndex` — an embedded, synchronous FTS5 full-text search
  index wrapping `better-sqlite3`. Two search modes (full-text: MATCH + BM25 +
  `snippet()`; literal: case-insensitive substring scan for punctuated tokens),
  `upsert`/`upsertMany`/`delete`/`deleteMany` (batch ops in a single
  transaction), `search`, `getDatabase`, `stats`, and `close`.
- **Public surface (11 symbols), all via the Core namespace barrel** (the
  three-entry `exports` map is unchanged → additive **minor**): `M3LFtsIndex`,
  `M3LFtsIndexError`, `M3LFtsIndexErrorCode`, and 8 types (`M3LFtsIndexConfig`,
  `M3LFtsIndexDocument`, `M3LFtsIndexSearchMode`, `M3LFtsIndexSearchOptions`,
  `M3LFtsIndexSearchResult`, `M3LFtsIndexStats`, `M3LSqliteDatabase`,
  `M3LSqliteStatement`).
- **New runtime dep** (approved at the gate): `better-sqlite3@^12.11.1` +
  `@types/better-sqlite3@^7.6.13` (dev). Build script allowlisted in
  `pnpm-workspace.yaml`.
- **Tests:** 77 storage tests; full suite 1039 passing. Coverage —
  `M3LFtsIndex.ts` 96.5% stmt / 100% fn / 100% br; `M3LFtsIndexError.ts` and
  `types.ts` 100% across the board.
- **Gates, all green:** `typecheck`, `lint`, `format:check`, `build`,
  `test:coverage`, `check:exports` (publint + attw), `check:scaffold`,
  `check:scaffold-seam`, `check:api`, `check:provenance`, `check:doc-counts`,
  `check:doc-exports`, `check:impl-counts` (10 of 22), `gen:index`/`check:index`
  (22 modules, 119 symbols), `knip`, `lint:md`.
- **Review verdicts:** code-reviewer — 2 Must-fix (resolved); spec-conformance —
  conformant; security — PASS, no Must-fix (both DDL interpolation points
  provably validated, all query/filter values parameter-bound); type-design — 1
  Must-fix + aggregate ~6/10 (resolved); silent-failure-hunter — no Must-fix, 2
  Should-fix (resolved). Focused re-review after fixes: conformant, all five
  prior findings resolved, no new logic defect.
- **Commits:** `7222a3c` build(deps), `105e76a` feat(storage), `d808a47` docs
  (count bump 9 → 10 of 22 + provenance re-stamp + index regen).

## What went as planned

- **RED failed for the right reason** — `Cannot find module
'../src/core/storage/index.js'` at import time, not a logic/type error in the
  test bodies.
- **Dependency gate honored** — paused for explicit approval before `pnpm add`;
  then allowlisted the native build script (`pnpm allowBuilds`) and smoke-tested
  the compiled binding (FTS5 `snippet()` + `bm25()`) before any code leaned on
  it.
- **GREEN logic landed first pass** — 62 storage tests + typecheck green on the
  first implementer turn; only lint had three findings (complexity, magic
  number, named-default import), cleared in a short resume.
- **Security surface clean first pass** — the tokenizer/identifier validation
  and parameter-binding were correct as written; the reviewer found no injection
  or leakage defect.
- **`/syncing-docs` behaved as designed** — `check:impl-counts` caught the
  deferred `9 → 10` bump and named all six sites; the reference-index
  regeneration and provenance re-stamp ran clean.

## What didn't go as planned, and why

### 1. Implementer over-exported the error surface (12 symbols, one rule-violating)

The implementer introduced a typed `M3LFtsIndexError` (correct, and pre-blessed
by the plan) but exported **three** error symbols: the class, the
`M3LFtsIndexErrorCode` union, and `M3LFtsIndexErrorOptions`. Both type-design
and code-reviewer flagged the options interface as a Must-fix — every other
`M3LError` subclass in the repo keeps its options interface module-private, and
`.claude/rules/library-src.md` states the rule explicitly ("never export
error-constructor options interfaces"). It was un-exported at review; the
surface settled at 11 (the class + the code union, which earns its export via
five-way `switch` narrowing).

**Why it happened:** The rule is auto-loaded into the implementer via
`library-src.md`, but "add a typed error subclass" was read as license to export
all of its supporting types. The distinction (export the code union; keep the
options bag private) was not front-loaded into the hand-off.

**Fix for future:** When a module adds a typed error, state in the implementer
prompt: export the class and (if it has multiple codes) the `code` union, but
keep the `…ErrorOptions` interface module-private.

### 2. Two writer turns returned truncated mid-thought

Both the GREEN turn and the review-fix turn ended on a mid-sentence line ("Let
me replace these prepares.") rather than a completion summary. Rather than trust
the (absent) summary, the hub read the spoke journal, listed created files,
grepped the barrel for the re-export, and ran typecheck/lint/test directly —
which surfaced that lint was not yet clean after GREEN, and the same for the fix
round. Each was resolved by resuming the writer with the specific gap.

**Why it happened:** Bounded, rework-heavy implementer runs are token-heavy and
hit the turn limit before wrapping up.

**Fix for future:** The truncation guard did its job — keep verifying writer
state directly (journal + hub-run gates), never the summary, and resume the same
spoke with the concrete gap.

### 3. `format:check` was red while `lint` was green

After the fix round the implementer reported lint + typecheck + tests clean, but
`prettier --check` failed on three spots in `M3LFtsIndex.ts` — the code-reviewer
caught it. `format:check` is a distinct CI gate from ESLint; running `pnpm lint`
does not format. The hub ran `pnpm format` to clear it.

**Why it happened:** "Lint clean" was treated as equivalent to "format clean."
The writer spokes run `pnpm lint` in their loop but not `pnpm format:check`.

**Fix for future:** Writer spokes must run `pnpm format:check` (or
`prettier --write` their own files) before reporting done — it is a separate CI
gate ESLint does not cover.

### 4. Plan premises had drifted since authoring

The plan's Context said "5 of 22 implemented" and pointed at
`implementation-status.md:46`; the live repo was at 9 of 22 with the storage row
at line 47. Re-validated at Step 1; approach unchanged. The `5 → 6` count edit
list in the plan was stale (the real bump was `9 → 10`), but this was deferred to
`/syncing-docs`, which derived the count from the filesystem and named every site
— so the stale numbers never mattered.

**Why it happened:** The plan was authored several submodules earlier; counts and
line numbers rot between authoring and execution.

**Fix for future:** Always re-validate a stored plan's counts and line refs
against the live repo before acting (already a pipeline rule), and keep deferring
count reconciliation to `/syncing-docs` rather than a hand-written edit list.

### 5. Atomicity test coupled to a raw bind error

The RED `upsertMany` atomicity test forces a mid-batch failure with a poison
document whose `content` is a non-string cast through `unknown` — it throws at
SQL bind time inside the transaction. If the implementer had added runtime
`content` coercion/validation before the transaction, the trigger would not fire
and the test would silently stop exercising rollback. The hub front-loaded this
caveat into the implementer prompt, so it held.

**Why it happened:** The test depends on an implementation detail (a raw bind
error inside the transaction) that a defensive coercion would pre-empt.

**Fix for future:** When a test's failure trigger depends on the implementation
_not_ adding a guard, state that coupling explicitly in the implementer hand-off
(done here).

## Lessons learned

- **Lint clean ≠ format clean** — writer spokes run `pnpm lint` but not
  `pnpm format:check`; the two are separate CI gates. Run `format:check` (or
  `prettier --write` your files) before reporting done.
  _(promoted → .claude/agents/submodule-implementer.md, .claude/agents/test-author.md)_
- **Export the error class + code union, never the options interface** — the
  `library-src.md` rule exists but was missed; a typed error's `…ErrorOptions`
  bag stays module-private while its multi-member `code` union is worth
  exporting for exhaustive `switch` narrowing. Front-load this in the implementer
  hand-off whenever a module adds a typed error.
- **Verify writer state directly on truncation** — two writer turns returned
  mid-thought; the journal plus hub-run `typecheck`/`lint`/`test` (not the
  summary) revealed an unfinished lint pass both times. The truncation guard is
  load-bearing, not ceremony.
- **New public types land in the `.md` + provenance in the same change set** —
  adding `M3LFtsIndexError`/`M3LFtsIndexErrorCode` beyond the 9-symbol spec meant
  editing the storage.md Public API table and the provenance sidecar in the same
  commit, so `spec-conformance` and `check:doc-exports` stay clean instead of
  reading it as drift.
- **Defer count-prose bumps to `/syncing-docs`** — `check:impl-counts` derived
  `9 → 10` and named all six count sites (two READMEs badge+prose, docs/README,
  status intro); hand-bumping mid-implementation risks missing one, and the
  gate is CI-authoritative anyway.
- **Native-dep gate + smoke test before building on it** — approve before
  `pnpm add`, allowlist the build script in `pnpm-workspace.yaml`
  (`allowBuilds:`), and smoke-test the compiled binding (here FTS5 `snippet()` /
  `bm25()`) so a broken native install fails fast rather than mid-GREEN.
