# Plan: Add the `logging` Core submodule

## Context

`@m3l-automation/m3l-common` ships 5 of 22 documented submodules (`errors`,
`events`, `security`, `environment`, `utils`), with three more being implemented
in parallel via untracked plans (`analysis`, `json`, `messaging`). `logging` is
fully documented (`docs/reference/core/logging.md`, 11 public symbols) but has no
source, no barrel wiring, no tests, and no provenance sidecar. This plan adds it
end-to-end through the established **implement-submodule** TDD + hub-and-spoke
pipeline.

Two audit findings shape the approach:

1. **Hard blocking dependency.** `M3LFileLoggerHandler` is documented to stream
   "through a `M3LFileListExporter`" (`logging.md:82`). That symbol lives in the
   **`exporters`** submodule (`exporters.md:32`), which is ❌ not-started and sits
   _later_ in the build order (Phase 4) than `logging` (Phase 3). This dependency
   must be treated as a **blocking precondition checked before implementation
   starts** — not worked around.
2. **First runtime dependency.** `M3LTableFormatter` needs `string-width` for
   ANSI-aware column widths. The package currently has zero runtime deps; we will
   add `string-width` as the first one.

The implemented-count prose (`"5 of 22"`) will **not** be hand-edited — count
reconciliation is deferred to the `/sync-docs` pass per the task constraint (see
§6 for the nuance).

## 1 — Pre-flight: resolve the blocking `M3LFileListExporter` dependency

**This is a gate, not an implementation step.** Before any logging code is
written, the hub must confirm `M3LFileListExporter` exists and is surfaced from
`src/core/index.ts`.

- Check `packages/m3l-common/src/core/exporters/` for `M3LFileListExporter` (and
  its `M3LListExporter<TItem>` base contract, which extends the already-shipped
  `M3LEventEmitterBase`).
- **If present:** proceed; logging's `M3LFileLoggerHandler` delegates to it as
  documented.
- **If absent (current state):** `logging` is **blocked**. Surface this to the
  user as a sequencing decision: either pull the minimal exporter prerequisite
  (`M3LListExporter` base + `M3LFileListExporter` only — not the CSV/HTML/JSON
  exporters) forward as its own implement-submodule run first, or re-sequence.
  Do not silently substitute an internal writer — that diverges from the
  documented contract the spec-conformance reviewer enforces.

Record the resolution in `docs/implementation-status.md` (dependency note already
reads "uses `files`/exporters for file handler").

## 2 — Add the `string-width` runtime dependency

- Add `string-width` to `packages/m3l-common/package.json` `dependencies`
  (creating the field — it does not exist yet).
- Install via `pnpm add string-width --filter @m3l-automation/m3l-common` so the
  lockfile updates (never hand-edit the lockfile).
- `dependency-review.yml` and `check:deps` will vet it on PR.

## 3 — Run the implement-submodule pipeline for `logging`

Drive the `implement-submodule` skill (hub dispatches spokes; hub never writes
`src/`/tests). Front-load these exact contract nuances into the spoke hand-offs:

- **11 public symbols** (barrel `logging/index.ts`): `M3LLogger`; `M3LLogEvent`;
  `M3LLogEventCategory` (enum, **9** values: `TEXT STEP SUCCESS ERROR FATAL
WARNING HEADER INFO SECTION`); `M3LConsoleLoggerHandler`,
  `M3LFileLoggerHandler`, `M3LJsonLoggerHandler`; `M3LTableFormatter`,
  `M3LTableOptions`, `M3LTableColumn`; `redactSensitiveLogText`,
  `redactSensitiveLogValue`.
- **`M3LLogger` methods**: `text step info success warning error fatal section
header newline table simpleTable keyValueTable` — each emits one
  `M3LLogEvent` fanned out to handlers in array order.
- **Console handler**: colored `stdout`/`stderr` with indentation; auto-disable
  ANSI when `process.stdout.isTTY === false` (Lambda/CI/pipes).
- **File handler**: `{ filePath }` ctor; delegates to `M3LFileListExporter`
  (per §1); internal sequential write-queue preserves ordering under concurrent
  emits; `reset()` is intentionally a **no-op**.
- **JSON handler**: one JSON line per event; promotes scalar fields from `data`
  to top level (CloudWatch Insights); drops empty spacer events.
- **Table formatter**: per-column alignment; ANSI-aware width via `string-width`;
  three `border` styles — `full` (Unicode box-drawing), `border-less`, `compact`.
- **Redaction**: net-new in `logging` — `security` exports only `DangerousKeys`,
  so there is nothing to reuse; implement standalone.

Phase order (each phase = an isolated spoke; hub bookkeeps status):

1. **Contract** — `spec-conformance-reviewer` produces the exact symbol/behavior
   contract from `logging.md`.
2. **RED** — `test-author` writes `tests/logging.test.ts` (happy + failure +
   `expectTypeOf` where the type is the contract); confirm it fails for the right
   reason. Hub flips status row to 🧪.
3. **GREEN** — `submodule-implementer` writes `src/core/logging/` (split logic
   into named files so coverage gates every line; keep `index.ts` a pure
   re-export barrel). Hub verifies `pnpm test` + `pnpm typecheck`; status → 🟢.
4. **Review** — fan out `code-reviewer`, `spec-conformance-reviewer` (conformance
   mode), `security-reviewer` (redaction + no-secret-logging),
   `type-design-analyzer`, `silent-failure-hunter`. Hub iterates must-fixes;
   status → ✅.

**Files created:** `packages/m3l-common/src/core/logging/index.ts` + named impl
files; `packages/m3l-common/tests/logging.test.ts`.

## 4 — Wire the namespace barrel (no exports-map change)

Add `export * from "./logging/index.js";` to
`packages/m3l-common/src/core/index.ts` (alphabetically among the existing
re-exports). **Never** touch the package `exports` map — submodules surface via
the namespace; a new subpath would be a semver-major event. `check:api` must stay
green throughout (proof no accidental semver event).

## 5 — Provenance sidecar

Create `docs/reference/core/logging.provenance.json` (schema
`../provenance.schema.json`): one section per `###` heading in `logging.md`, each
`source` referencing a **named export** of its impl file, with `commit` (HEAD)
and `retrieved` (today). `check:provenance` validates heading↔file↔exported-symbol
linkage.

## 6 — Doc-count handling (deferred to /sync-docs)

- Flip the `logging` row in `docs/implementation-status.md` to ✅ — this is
  normal hub status bookkeeping, **not** a count bump.
- **Do not hand-edit** the `"N of 22"` prose anywhere.
- Run `/sync-docs` at the end to re-stamp provenance and verify counts.
- **Nuance to flag:** `check:doc-counts` only validates the _denominator_ (regex
  `/\d+ of (\d+) submodules are implemented/`), and `/sync-docs` _verifies_ counts
  - surfaces a reminder but does **not** auto-edit the numerator. Because the
    three parallel untracked plans (`analysis`, `json`, `messaging`) each assume a
    different total (6/22, 7/22, no-bump), the final numerator reconciliation must
    happen in a single coordinated `/sync-docs` pass once the parallel work settles
    — confirm the target number with the user at that point rather than in this
    plan.

## 7 — Work log

After ✅, run `/write-work-log` to capture lessons (e.g. the exporter-dependency
sequencing call, the first-runtime-dep decision) into `docs/logs/`.

## Verification checklist

- [ ] `M3LFileListExporter` precondition resolved (§1) before GREEN.
- [ ] `string-width` in `dependencies`; lockfile updated via `pnpm add`.
- [ ] `tests/logging.test.ts` fails first (RED), then passes (GREEN).
- [ ] All 11 symbols exported from `logging/index.ts` and re-exported from
      `src/core/index.ts`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass.
- [ ] `pnpm test:coverage` ≥ 80% (read `coverage-final.json`, not the v8 text
      table, which hides 100%-covered files).
- [ ] `pnpm check:api` green (exports map untouched — no semver event).
- [ ] `pnpm check:exports` (publint + attw) and `pnpm check:scaffold` green.
- [ ] `docs/reference/core/logging.provenance.json` passes `pnpm check:provenance`.
- [ ] `implementation-status.md` logging row = ✅; prose count NOT hand-edited.
- [ ] `/sync-docs` run; markdown lint clean.
- [ ] Conventional Commit `feat: …` (minor bump).
