# Plan: Add the `exporters` submodule (authoring the implementation plan doc)

## Context

This started as an audit of **submodule implementation status** in
`@m3l-automation/m3l-common`. The audit confirmed the tracker is accurate:
**5 of 22** submodules are implemented (`errors`, `events`, `security`,
`environment`, `utils`); the other 17 are ❌. The Core barrel re-exports exactly
those 5; the AWS barrel is `export {}`.

The user wants to **add the `exporters` submodule**. Crucially, `exporters` is
**already fully documented** — `docs/reference/core/exporters.md` specifies a
9-symbol contract — but has no `src/core/exporters/`, no `tests/exporters.test.ts`,
no barrel re-export, and no provenance sidecar (`docs/implementation-status.md:45`
= ❌). Every implemented submodule, and six unimplemented ones (analysis, config,
files, json, logging, messaging), has a `docs/plans/<name>-submodule-implementation.md`;
**`exporters` does not yet have one**. It is also a hard prerequisite for `logging`
(the file handler uses `M3LFileListExporter`).

**Decided scope (this effort): author `docs/plans/exporters-submodule-implementation.md` only** —
no `src/`, no tests, no dependency installed now. The doc mirrors
`docs/plans/files-submodule-implementation.md` and feeds `implement-submodule`
later. Decisions baked into the doc:

- **`csv-stringify` is approved** as the runtime dep for the CSV path; the plan
  records it as an accepted dependency-gate item (not deferred).
- **Counts are deferred to `/sync-docs`**: no count prose is hand-edited. Adding
  `exporters` does not change the documented total (22) since its page already
  exists; the _implemented_ count only moves once it ships ✅. (Note the
  implemented-count prose already drifts pre-existing across `CLAUDE.md` 5/22,
  root `README.md` 3/22, `packages/m3l-common/README.md` 2/22, `docs/README.md`
  2/22 — out of scope here; `/sync-docs`/`check:doc-counts` gate it.)

## Deliverable — one new file

`docs/plans/exporters-submodule-implementation.md`, mirroring the section
structure of `docs/plans/files-submodule-implementation.md`. No other repo files
change in this effort. Contents, section by section:

### `## Context`

State: spec exists (`docs/reference/core/exporters.md`, 9 symbols), ❌ not
implemented, no `src/core/exporters/` / `tests/exporters.test.ts` / barrel line /
sidecar. Because the page exists, this is an **`implement-submodule`** job (no
`new-subpath`). `exporters` blocks `logging`. Record the `csv-stringify`
approval and the "no manual count edits; 22 denominator unchanged" note.

### `## The contract (docs/reference/core/exporters.md)`

Enumerate the 9 surfaced symbols + their option/event/stream-writer types:
`M3LFileExporter`, `M3LListExporter<TItem>` (the contract), `M3LCSVListExporter`,
`M3LJSONListExporter`, `M3LJSONFileExporter`, `M3LHTMLListExporter`,
`M3LBinaryFileExporter`, `M3LFileListExporter`, plus
`M3LListExporterStreamWriter<TItem>` and the `export:*` event map. Front-load the
behavioral nuances for later hand-offs:

- **Dual mode**: `export(items)` batch vs. `exportStream()` returning a writer
  with `append(item)` / `close()`. All list exporters extend
  `M3LEventEmitterBase` and write through an `fs.WriteStream`.
- **CSV**: `ColumnConflictStrategy` = `'keep-generated'` | `'keep-original'`.
- **JSON vs JSONL**: streaming array mode writes `[` on open, `]` on close, commas
  between items; JSONL writes neither bracket.
- **HTML**: `{{count}}` / `{{items}}` / `{{date}}` substitution with configurable
  column selection/ordering.
- **Binary/whole-file**: `M3LBinaryFileExporter`, `M3LFileExporter`,
  `M3LFileListExporter`.

### `## Section 0 — Dependency gate (csv-stringify, APPROVED)`

Unlike `files` (dep-free), `exporters` needs `csv-stringify`. Record it as an
**approved** runtime dependency to be added to `packages/m3l-common`'s `dependencies`
during GREEN, with a `pnpm install` lockfile update (never hand-edited). Note the
"minimal runtime dependencies" constraint is satisfied by a single, focused dep
required by the documented CSV contract. Non-CSV exporters use Node built-ins only.

### `## Section 1 — Implement exporters via implement-submodule`

Hub-and-spoke TDD, hub coordinates only:

1. **Contract** — `spec-conformance-reviewer` (contract mode) reads
   `exporters.md` (+ relevant `docs/m3l-common-architecture.md`), returns the
   exact exports + contracts; front-load the nuances above.
2. **RED** — `test-author` writes failing happy/failure/`expectTypeOf` tests in
   `packages/m3l-common/tests/exporters.test.ts` importing from
   `../src/core/exporters/index.js`; status `:45` → 🧪.
3. **GREEN** — `submodule-implementer` writes `src/core/exporters/**` (named impl
   files per symbol, private helpers under `src/internal/`), adds
   `export * from "./exporters/index.js";` to `src/core/index.ts`, installs
   `csv-stringify`, drives `pnpm test`/`pnpm typecheck` green **without** touching
   the 3-entry `exports` map; `@example` blocks use `M3LError` subclasses. → 🟢.
4. **Review (parallel)** — `code-reviewer` + `spec-conformance-reviewer`
   (conformance) + `type-design-analyzer` (generics on `M3LListExporter<TItem>` /
   stream writer) + `silent-failure-hunter` (async stream/`WriteStream` error +
   `close()` paths). No `security-reviewer` (not aws/secrets/logging). Iterate to
   clean → ✅.

Note the 3-entry `exports` map (`.`, `./core`, `./aws`) stays unchanged.

### `## Section 2 — Provenance sidecar + final verify`

Generate `docs/reference/core/exporters.provenance.json` per
`docs/reference/provenance.schema.json` (one section per `exporters.md` heading;
each `symbol` a **named export** of `src/core/exporters/index.ts`; `commit` =
HEAD; `retrieved` = today). Run build + test + lint + typecheck +
`pnpm check:provenance`.

### `## Section 3 — Doc reconciliation via /sync-docs (no manual count edits)`

Run `/sync-docs`: re-stamps sidecars to HEAD, runs `pnpm check:doc-counts`
(documented total stays 22 — page pre-existed), confirms status shows `exporters`
✅, runs `pnpm lint:md`. Reuse the `files` plan's note verbatim that
implemented-count prose drifts pre-existing across `CLAUDE.md`/root
`README.md`/`packages/m3l-common/README.md`/`docs/README.md` and is addressed via
the tooling, never manual bumps.

### `## Section 4 — Commit + work log`

`feat:` commit (new barrel-surfaced submodule = minor; `exports` map unchanged),
branch `feat/core-exporters` from `main`; `/write-work-log` →
`docs/logs/YYYY-MM-DD-core-exporters.md`.

### `## Verification checklist`

Mirror the `files` plan checklist, adapted: RED-then-GREEN on
`exporters.test.ts`; barrel re-exports `./exporters/index.js` + `pnpm check:scaffold`
green; typecheck/lint/test/build green; coverage ≥ 80% (read
`coverage/coverage-final.json`); `exports` map still exactly `.`/`./core`/`./aws`;
`csv-stringify` added via `pnpm install` (lockfile updated, not hand-edited);
`exporters.provenance.json` created + `pnpm check:provenance` green; `/sync-docs`
run + `pnpm check:doc-counts` green + status ✅; `feat:` commit + work log.

### Sequencing note (carry into the doc)

The build order lists `exporters` in Phase 4 but `logging` (Phase 3) depends on
`M3LFileListExporter`. Add a one-line callout that `exporters` should be
sequenced **before** `logging`, or at minimum `M3LListExporter` +
`M3LFileListExporter` must ship first — otherwise the logging plan's pre-flight
gate fails.

## Verification of this effort (authoring the plan doc)

- [ ] `docs/plans/exporters-submodule-implementation.md` exists with the sections
      above and reads consistently with the sibling plan docs (compare against
      `docs/plans/files-submodule-implementation.md`).
- [ ] Doc records `csv-stringify` as **approved** and "no manual count edits /
      defer to `/sync-docs`".
- [ ] The doc is auto-formatted by the `post-edit-md-verify.mjs` hook (it skips
      rumdl linting for `docs/plans/`); no other repo file is modified.
- [ ] No `src/`, `tests/`, `package.json`, or count-prose changes were made.
