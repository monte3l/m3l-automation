# Plan: add the `storage` submodule (full implementation)

## Context

An audit of submodule implementation status found the current tracker is
**accurate**: 5 of 22 submodules are implemented and reviewed (`errors`,
`events`, `security`, `environment`, `utils`), with barrels, tests, and
provenance sidecars all consistent. The `storage` submodule already has a
**complete spec** (`docs/reference/core/storage.md`, 9 symbols) and a status row
(`docs/implementation-status.md:46`, currently ❌, build-order step 5), but
**zero code footprint** — no `src/core/storage/`, no test, no barrel re-export,
no provenance sidecar.

Because the spec page already exists, `new-subpath` does **not** apply; the
correct path is the **`implement-submodule`** TDD pipeline. The user chose a
**full implementation** (RED → GREEN with `better-sqlite3` → reviews → ✅) and
to **leave the count machinery unchanged**. Per the standing instruction, the
implemented-count prose (`5 of 22`) is **not hand-bumped** during this work —
count reconciliation is deferred to a `/sync-docs` pass after the row flips to ✅.

> Audit-discovered caveat (not fixed here, by user choice): `check-doc-counts.mjs:41`
> validates only the **total** (`22`); the implemented count `N` is never
> validated, and `/sync-docs` only _verifies/surfaces_ it (never auto-edits). So
> after storage ships, the `5 → 6` bump must be applied via the `/sync-docs`
> Step 5 prompt across all five prose sites — CI will **not** catch it if missed.

## The contract to implement (`docs/reference/core/storage.md`)

Surface from `Core` (the `storage` sub-barrel). 1 class + 8 types:

- `M3LFtsIndex` (class) — FTS5-backed full-text index.
- Types: `M3LFtsIndexConfig`, `M3LFtsIndexDocument`, `M3LFtsIndexSearchMode`
  (`'full-text' | 'literal'`), `M3LFtsIndexSearchOptions`,
  `M3LFtsIndexSearchResult`, `M3LFtsIndexStats`, `M3LSqliteDatabase`,
  `M3LSqliteStatement`.

Behavioral contract: 3 managed structures (`<fts_table>`, `<fts_table>_meta`,
`_m3l_fts_meta`); write ops `upsert` / `upsertMany` (single transaction) /
`delete` / `deleteMany`; two search modes (FTS5 `MATCH` + BM25 + `snippet()`
vs. case-insensitive `literal` substring); prepared-statement cache keyed by
mode + filter-signature; `getDatabase()` escape hatch; **synchronous** (no
promises); **tokenizer string validated to prevent SQLite injection**.

## Implementation sections

### 1. Approve and add the native dependency

- `better-sqlite3` is a **native, synchronous** runtime dep (the documented
  gate for storage). Adding it is a deliberate exception to the "minimal
  runtime deps" rule, pre-blessed by the build order.
- Add as a workspace dependency of `packages/m3l-common` via `pnpm add`
  (updates the lockfile — never hand-edit). Add `@types/better-sqlite3` as a
  dev dep if upstream types are insufficient.
- Verify `attw`/`publint` (`pnpm check:exports`) still pass with the new dep
  (ESM-only, types resolution).

### 2. Run the `implement-submodule` pipeline for `storage`

Drive the standard hub-and-spoke TDD loop (do **not** write src/test code at the
hub):

1. **Contract seed** — `spec-conformance-reviewer` (producer mode) enumerates
   the exact 9 symbols + behavioral contracts from `storage.md`.
2. **RED** — `test-author` writes failing Vitest tests in
   `packages/m3l-common/tests/storage.test.ts`: happy + failure path per
   export, `expectTypeOf` for the type contracts, plus targeted tests for the
   transaction atomicity of `upsertMany`, both search modes, the
   prepared-statement cache, and **tokenizer-injection rejection**. Confirm they
   fail for the right reason.
3. **GREEN** — `submodule-implementer` writes the minimal
   `packages/m3l-common/src/core/storage/` (e.g. `index.ts` + `M3LFtsIndex.ts`
   and type files), `.js` extensions on all relative imports, no `any`, typed
   `M3LError` subclasses for failure modes (invalid tokenizer, etc.), TSDoc +
   `@example` on every export.
4. **Barrel** — add `export * from "./storage/index.js";` to
   `packages/m3l-common/src/core/index.ts` (and drop `storage` from the
   "not-yet-exported" comment). No change to the `exports` map (surfaced via the
   namespace barrel — not a new subpath).
5. **Review spokes** (writer ≠ reviewer): `code-reviewer`,
   `spec-conformance-reviewer` (conformance mode), `security-reviewer`
   (tokenizer validation / SQL injection / no secret logging),
   `type-design-analyzer`, `silent-failure-hunter` (sync error paths, no
   swallowed SQLite errors). Apply must-fixes.

### 3. Update the source-of-truth tracker

- Flip the `storage` row in `docs/implementation-status.md:46` ❌ → ✅ once tests
  - GREEN + reviews are done (record test count / coverage / dep note, matching
    the format of the existing 5 rows). Update the intro line's reviewed-list and
    remove `storage` from the suggested-order remaining work as appropriate.
- **Do not** edit the `5 of 22` prose anywhere — that is Section 5's job via
  `/sync-docs`.

### 4. Add the provenance sidecar

- Create `docs/reference/core/storage.provenance.json` mirroring the schema of
  `docs/reference/core/errors.provenance.json`: `$schema`, `doc: "core/storage.md"`,
  and `sections[]` mapping each heading to its source file(s), `commit` (HEAD),
  `retrieved` (today). Required before `/sync-docs` Step 1 will pass.

### 5. Reconcile docs via `/sync-docs` (no manual count bump)

Run the `sync-docs` skill end-to-end:

- Provenance pre-flight + re-stamp all sidecars to HEAD.
- `check:doc-counts` (total stays 22 — storage.md already counted).
- **Step 5** surfaces the implemented-count prose (`5 → 6`); apply that bump
  through the skill's prompt across the five sites — `README.md:16` (badge
  `modules-5%2F22` → `6%2F22`), `README.md:20`, `docs/README.md:5`,
  `CLAUDE.md:505`, `implementation-status.md:5` — rather than pre-editing them.
- `pnpm lint:md`.

## Verification checklist

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all pass.
- [ ] `pnpm test:coverage` ≥ 80% (lines/functions/branches/statements);
      confirm `storage` via `coverage-final.json`, not just the text table.
- [ ] `pnpm check:exports` (publint + attw) passes with `better-sqlite3` added.
- [ ] `pnpm check:scaffold` — barrel re-export present and in sync.
- [ ] `pnpm check:provenance` clean after the new sidecar + re-stamp.
- [ ] `pnpm check:doc-counts` passes (total = 22).
- [ ] `/sync-docs` full pass green; implemented count reads `6 of 22` everywhere.
- [ ] Tokenizer-injection test proves a malicious tokenizer string is rejected.
- [ ] `upsertMany` atomicity test proves a mid-batch failure rolls back.
- [ ] Conventional Commit reflects semver: `feat(storage): …` (new public
      surface via the Core barrel → **minor**).
