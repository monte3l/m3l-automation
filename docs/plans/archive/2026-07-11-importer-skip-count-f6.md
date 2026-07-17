# Importer stream skip-count summary (F6)

**Status: shipped** (PR #103, branch `feat/importer-skip-count`)

## Context

`docs/ROADMAP.md` listed six P0 library-friction items that had to land before
more consumer scripts; F6 was the last one without an active worktree.
`M3LListImporter.importStream()` returned a bare `AsyncGenerator<TItem>`, so
the only way to learn how many malformed records were skipped was to
subscribe to the `import:error` event and hand-count — every streaming
consumer (starting with `json-etl`) had to wire its own listener and counter,
even though the batch path already exposed this via
`M3LListImporterResult.errors[]`.

## Approach / Decisions

- Isolation: new linked worktree, branch `feat/importer-skip-count`,
  PR-required (guarded `src/**` + `tests/**`).
- Scope: both `M3LJSONListImporter` and `M3LCSVListImporter` return the
  summary, keeping `M3LListImporter<TItem>` uniform across implementations.
- New exported `M3LImportStreamSummary { processed, skipped, durationMs }`
  mirroring the batch result and the `import:completed` event payload.
- `importStream()`'s return type widened to
  `AsyncGenerator<TItem, M3LImportStreamSummary, void>` — additive/
  semver-minor, since existing `for await…of` loops discard the generator's
  return value and are unaffected.
- Both importer bodies (structurally identical) track a `skipped` counter
  incremented in the existing skip branch, returning the summary right after
  the `import:completed` emit. Surfaced through the namespace barrel
  (`src/core/index.ts`); no new `exports` subpath.
- Deliberately deferred: simplifying `json-etl`'s own `import:error`
  listener/counter was left as a separate follow-up rather than folded into
  this additive library PR.

## Outcome

Landed through the standard contract → RED → GREEN → review loop. On
evaluation (**F6-adopt**), `json-etl` kept its event-based counter rather
than switching to the returned summary: its bare-`limit` path truncates the
stream via `break`, so the generator's `.return()` — and therefore the
summary — never fires. Adopting would have added generator-return plumbing
through three functions to save a three-line counter while introducing a
truncation regression. That gap was filed as **F6b** in
`docs/plans/IMPLEMENTATION.md` and is also recorded in
[`2026-07-12-json-etl-adopt-seams.md`](./2026-07-12-json-etl-adopt-seams.md).
Originally surfaced in `docs/logs/2026-07-11-scripts-json-etl.md`.
