# Fix the published `.d.ts` type leak (#798) and `run()` rowid truncation (#807)

**Status: shipped** — PR #814 (`7600b779`) and PR #815 (`ed798863`), both
merged 2026-08-31. Closes #798 and #807.

## Context

Two unrelated defects, both filed as `bug`, both verified against `main` at
`f5ba1275` before any code was written.

**#798 — packaging correctness.** `packages/m3l-common` publicly exports two
type aliases over `better-sqlite3` (`src/core/storage/types.ts` —
`M3LSqliteDatabase`, `M3LSqliteStatement`), reachable through the Core
namespace barrel. `better-sqlite3@13.0.3` ships **zero** declarations: no
`types`/`typings` field, no `types` condition in its `exports` map, no `.d.ts`
anywhere in the package. Those aliases therefore resolved only through
`@types/better-sqlite3`, which sat in `devDependencies`, so every consumer's
typecheck failed with `TS7016: Could not find a declaration file for module
'better-sqlite3'`. No existing gate saw it — `publint`, `attw --profile
esm-only`, `check:api` and `check:doc-exports` all passed on the broken tree,
because each validates the `exports` map's shape or the public surface, and
none resolves a declaration's _imports_ against the manifest.

**#807 — silent data corruption.** `packages/m3l-console-server`'s
`createStoreExecutor(...).run()` was the only executor method that never
called `setReadBigInts`, so it read `lastInsertRowid` as a JS number.
Inserting rowid `9007199254740993` returned `9007199254740992` — off by one,
no throw, no warning — reproduced on the pinned Node 24.20.0.

Three corrections came out of verification rather than the issue text:

1. **#798 was two symbols, not one.** The issue named only
   `M3LSqliteDatabase`; `M3LSqliteStatement` leaked identically.
2. **#798 was scoped to exactly one dependency.** Grepping the _built_
   `dist/**` showed `better-sqlite3` as the only external specifier surviving
   into an emitted declaration. The five optional peers type-imported in
   `src/core/text/*.ts` never reach a `.d.ts` and needed no change — which is
   what made a new gate cheap rather than sprawling.
3. **#807 had a second, unreported defect in the same five lines.** Statements
   are cached by SQL text, so a prior `get(sql, …, { readBigInts: true })`
   left the flag set and the next `run(sql)` on that SQL silently inherited
   it. The file's own headline TSDoc asserted this could not happen; `run()`
   was the one method breaking its own stated invariant.

## Approach / Decisions

| Decision               | Choice                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| #798 fix               | Move `@types/better-sqlite3` to `dependencies`, exact-pinned `9.6.0` (ADR-0017 forbids a range there)                            |
| #798 regression gate   | New `bin/check-dts-deps.mjs` / `pnpm check:dts-deps`, reading the **built** `dist/`, not `src/`                                  |
| Gate placement         | CI and `pnpm verify` only, **not** `pre-push` — it needs a fresh `dist/`, same reasoning as `check:deps`/`knip`/`check:licenses` |
| #807 `run()` semantics | Always `setReadBigInts(true)`, then narrow to `number` when the rowid fits the safe-integer range                                |
| Landing                | Two PRs, #798 first, B branched only after A merged                                                                              |
| Node 26                | **Dropped entirely** (maintainer decision) — the project stays on Node 24 LTS, so nothing was tested or asserted about Node 26   |

Reading `dist/` rather than `src/` is the load-bearing choice in the gate's
design: it is what distinguishes a type that genuinely escapes into the
published contract from an internal type-only import, and it is why the gate
passes on everything but the one line that was actually broken.

For #807, narrowing was chosen over adding an `M3LStoreReadOptions` parameter
to `run()` specifically so that no existing caller changes — the pre-existing
`expect(result.lastInsertRowid).toBe(1)` assertion stays green unedited.
`narrowRowid` checks **both** bounds, because SQLite's `INTEGER PRIMARY KEY`
accepts negative rowids and an upper-bound-only check would corrupt the
negative tail exactly as reading a double corrupts the positive one.

### Departures from the plan as drafted

- **Worktrees, not the shared checkout.** The plan chose the shared checkout;
  the maintainer overrode this mid-task. It proved necessary — a concurrent
  Claude session checked out its own branch in the shared checkout and the
  uncommitted work was silently discarded, with `git status` reading clean.
- **`docs/contributing/ci-cd.md` was the wrong doc target.** The plan called
  for a new row in its table, but that table is _workflow_-level
  (`check:workflows-doc` verifies it against the 10 workflow files), not
  step-level, and this work added no workflow. The rule went to
  `docs/contributing/style-guide.md` § Public-API typing (`[enforced]`) and
  its `.claude/rules/library-src.md` extract instead; the CI step list lives
  in `bin/lib/verify-steps.mjs`, machine-checked by `check:verify-parity`.
- **Dependency placement.** The plan said "alphabetically before
  `@aws-sdk/client-api-gateway`", which is self-contradictory; the entry sits
  in true alphabetical position.
- **B4 scoped to Node 24.** ADR-0003's `:57` observation line was left intact
  as a historical record and given a dated Update instead, which states the
  misattribution and real cause from what was verified on 24.20.0 and
  explicitly does not retest or restate the ADR's Node 26 claim.
- **No tracker rows to flip.** The task asked for tracker rows to be marked
  Done and the hub sync to archive the issues. Neither issue was hub-sync
  managed — no `hub-sync` label, no body marker, absent from both
  `ROADMAP.md` and `IMPLEMENTATION.md` — so there was nothing to flip. Both
  closed via `Closes #…`; `pnpm sync:hub` was run afterwards purely as drift
  verification and reported 215 untouched, zero mutations.

## Outcome

**PR #814** — types package promoted to `dependencies`, library `4.6.0` →
`4.6.1`, and `pnpm check:dts-deps` wired into all five sites (`package.json`,
`bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`, `ci.yml`, plus 39
unit tests). Verified two ways beyond the suites: the gate fails on the
pre-fix manifest naming the exact file and package and passes after, and a
scratch `tsc` against a simulated consumer install reproduces the TS7016 the
issue reports and compiles clean once the types package is present.

**PR #815** — `run()` sets the bigint flag unconditionally and narrows through
`narrowRowid`; five tests added; headline TSDoc and
`M3LStoreWriteResult.lastInsertRowid` corrected to describe the invariant that
now actually holds and the value-dependent return type.

### Lessons

- **Mutation testing caught two tests that guarded nothing.** The
  negative-rowid test first used `-42`, which narrows correctly even with the
  lower bound deleted; the flag-leak test first used _different_ SQL for
  `get()` and `run()`, which are separate cache entries, making the leak it
  claimed to test impossible. Both passed while asserting nothing. Neither
  would likely have been caught in review.
- **`earlyoom` reaps the biggest `node`, not the guilty one.** Three
  `pnpm verify` runs were SIGKILLed with no `dmesg` entry and no V8 heap
  trace — one during `check:licenses`, a step that uses almost no memory. The
  host runs `earlyoom --prefer ^(node|claude|vitest|tsc|esbuild)$`, and the
  actual pressure came from another session's concurrent `verify`. Raising
  `--max-old-space-size` made it worse; splitting `verify` into short-lived
  chunks fixed it.
- **A `check:*` gate's real input beats its prose.** `check:control-chars`
  scans only _tracked_ files, so a literal NUL byte written into the new gate
  script stayed invisible until the file was committed.

Related: ADR-0003 (Node 24 floor, and its 2026-08-31 update), ADR-0017 (exact
pins), ADR-0020 (manual versioning), ADR-0072 (small PRs), ADR-0078 (context
budget ratchet), ADR-0080 (host resource contention).
