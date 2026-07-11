# Plan: Implement the `files` Core submodule

## Context

`@m3l-automation/m3l-common` is a fully-documented but largely-empty scaffold:
22 submodules are documented (19 core + 3 aws), of which **5 are implemented**
(`errors`, `events`, `security`, `environment`, `utils`). The user wants to
**add the `files` submodule** next.

`files` is already **documented** — `docs/reference/core/files.md` exists with an
8-symbol contract — but **not implemented**: there is no `src/core/files/`, no
`tests/files.test.ts`, no barrel re-export, and no provenance sidecar. Status in
`docs/implementation-status.md:40` is `❌`; the suggested build order places it in
phase 3. Because the spec page already exists, this is an **`implement-submodule`**
job (no `new-subpath` scaffold needed — the GREEN spoke creates `src/core/files/`
and wires the barrel).

The audit surfaced that the `files` spec leans on two capabilities that are **not
yet in the codebase**. Per the user's decision, both are treated as **blocking
hard requirements** to verify _before_ starting, not as things to stub or design
around:

1. **`utils.M3LPaths`** — the spec's "See also" says `M3LPaths` "resolves the
   data/input/output directories used here". `M3LPaths` is **deferred** (utils
   Phase D, per `docs/logs/2026-06-30-core-utils.md`); utils shipped 36 of 39
   symbols and the 3 `M3LPaths` symbols are absent.
2. **core `prompt`** — the spec says large files trigger an interactive prompt
   "before archiving an unusually large file". The `prompt` submodule is `❌`
   not-started.

Adding `files` does **not** change the documented count (22) — its page already
exists. It moves the _implemented_ count 5 → 6, reconciled by `/sync-docs`; per
the user's instruction, **no count prose is hand-edited**.

## The contract (`docs/reference/core/files.md`)

Eight exported symbols, surfaced through the `Core` namespace barrel:

- `M3LFileCopier` — class; `registerFile(sourcePath, options)` queues a file with
  a subdir hint; `finalizeRegisteredFiles()` (async) executes the copies and
  returns an `M3LFileCopyReport`.
- `M3L_FILE_COPIER_DEFAULTS` — default option values.
- `getDefaultSubdirForPathType` — maps a path type (e.g. `"input"`) to its default
  subdirectory (this helper belongs to `files`, not utils).
- Types: `M3LFileCopierOptions`, `M3LFileCopyResult`, `M3LFileCopySkipReason`
  (incl. `'size-too-large'`), `M3LFileCopyReport`, `M3LFileCopyReportSummary`.

Behavioral contracts: per-file result (size, destination, timestamp, skip status)
aggregate summary; size-based skip with reason `'size-too-large'`; configurable
overwrite control; optional manifest JSON; configurable large-file prompt
threshold. All filesystem work uses Node built-ins (`node:fs/promises`,
`node:path`) — **dep-free**, so the `implement-submodule` dependency gate is
skipped.

## Section 0 — Prerequisite gate (BLOCKING — do this first)

Before any `files` work, verify both prerequisites are implemented and exported.
**If either is missing, stop and report the blocker — do not start `files`.**

- **Verify `utils.M3LPaths`**: confirm `M3LPaths` (and the directory-resolution
  surface `files` needs for the output dir) is exported from
  `packages/m3l-common/src/core/utils/` and re-exported via the `Core` barrel.
  Check `docs/implementation-status.md` shows utils Phase D done, and grep the
  utils source/exports for `M3LPaths`. Currently this is **deferred** — expect
  this gate to fail until utils Phase D ships.
- **Verify core `prompt`**: confirm `docs/reference/core/prompt.md` has a built,
  reviewed implementation under `src/core/prompt/`, re-exported via the barrel,
  exposing the interactive-confirm capability `files` will call for large files.
  Currently `❌` — expect this gate to fail until `prompt` ships.
- **Decision rule**: `files` consumes `M3LPaths` for output-directory resolution
  and the `prompt` submodule for large-file confirmation (no injected-callback
  decoupling, no `data/output` hardcoding). Both must be green first. If the user
  wants these prerequisites built as part of this effort, each is its own
  `implement-submodule` run (and `M3LPaths` is utils Phase D) sequenced ahead of
  `files`.

Verification: `pnpm check:scaffold` lists the barrel-exported modules; grep
`src/core/index.ts` and the utils/prompt sources for the required symbols.

## Section 1 — Implement `files` via `implement-submodule`

Run the `implement-submodule` skill (hub-and-spoke TDD). The hub coordinates only
and never edits `src/**` or `tests/**`. Phases:

1. **Contract** — `spec-conformance-reviewer` in contract mode reads
   `docs/reference/core/files.md` (+ relevant contracts in
   `docs/m3l-common-architecture.md`) and returns the exact 8 exports and
   behavioral contracts. Front-load nuances into later hand-offs: the
   `'size-too-large'` skip reason value, the async signature of
   `finalizeRegisteredFiles()`, the report/summary shapes, and **how the output
   dir is obtained from `M3LPaths`** and **how large-file confirmation calls
   `prompt`** (the two prerequisites from Section 0).
2. **RED** — `test-author` writes failing happy-path, failure-path, and
   `expectTypeOf` tests in `packages/m3l-common/tests/files.test.ts`, importing
   from `../src/core/files/index.js`; confirm they fail because the symbols don't
   exist. Update `docs/implementation-status.md:40` → 🧪.
3. **GREEN** — `submodule-implementer` writes `src/core/files/index.ts` (private
   helpers under `src/internal/`), re-exports via `src/core/index.ts`
   (`export * from "./files/index.js";`), and drives `pnpm test` + `pnpm typecheck`
   green **without** touching the `exports` map. `@example` blocks use `M3LError`
   subclasses, not bare `new Error()`. Update status → 🟢.
4. **Review (parallel)** — `code-reviewer` + `spec-conformance-reviewer`
   (conformance mode) + `type-design-analyzer` (new public types) +
   `silent-failure-hunter` (async/error + filesystem paths). No
   `security-reviewer` needed (not aws/secrets/logging). Send must-fix items back
   to `submodule-implementer`; iterate until clean. Update status → ✅.

Critical files created/modified: `packages/m3l-common/src/core/files/index.ts`
(new), `packages/m3l-common/src/core/index.ts` (add re-export line),
`packages/m3l-common/tests/files.test.ts` (new), possibly
`packages/m3l-common/src/internal/*` (private helpers). The 3-entry `exports` map
(`.`, `./core`, `./aws`) is **unchanged** — `files` surfaces through the namespace
barrel, never a new subpath.

## Section 2 — Provenance sidecar + final verify

- Generate `docs/reference/core/files.provenance.json` matching the schema
  (`docs/reference/provenance.schema.json`): one section per `files.md` heading,
  each `symbol` referencing a **named export** of `src/core/files/index.ts`
  (never a private helper), `commit` = HEAD, `retrieved` = today.
- Run `pnpm -C packages/m3l-common build && pnpm test && pnpm lint && pnpm typecheck`
  and `pnpm check:provenance`.

## Section 3 — Doc reconciliation via `/sync-docs` (no manual count edits)

After review passes, run **`/sync-docs`** to reconcile doc metadata — do **not**
hand-edit any submodule-count prose:

- Re-stamps every provenance sidecar to HEAD; validates structure.
- Runs `pnpm check:doc-counts` (documented total stays 22 — the page already
  existed, so this should pass unchanged).
- Confirms `docs/implementation-status.md` shows `files` ✅.
- Runs `pnpm lint:md`.

Note for the run: the _implemented_-count prose already drifts pre-existing across
`CLAUDE.md` (5/22), root `README.md` (3/22), `packages/m3l-common/README.md`
(2/22), and `docs/README.md` (2/22). This is out of scope for the `files` change;
let `/sync-docs` / `check:doc-counts` surface whatever it gates, and address any
flagged drift through that tooling rather than manual bumps.

## Section 4 — Commit + work log

- Commit as **`feat:`** (a new submodule surfaced through the barrel is a minor;
  the 3-entry `exports` map is unchanged — not a breaking change). Branch
  `feat/core-files` from `main`.
- Run `/write-work-log` → `docs/logs/YYYY-MM-DD-core-files.md` while context is
  intact.

## Verification checklist

- [ ] Section 0 gate passed: `utils.M3LPaths` and core `prompt` are implemented,
      reviewed, and barrel-exported (else: stopped and reported the blocker).
- [ ] `files.test.ts` failed first (RED), then passed (GREEN).
- [ ] `src/core/index.ts` re-exports `./files/index.js`; `pnpm check:scaffold` green.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green.
- [ ] `pnpm test:coverage` ≥ 80% on lines/functions/branches/statements (verify
      via `coverage/coverage-final.json`, not the v8 text table).
- [ ] `exports` map still exactly `.`, `./core`, `./aws` (no new subpath).
- [ ] `files.provenance.json` created; `pnpm check:provenance` green.
- [ ] `/sync-docs` run; `pnpm check:doc-counts` green; status file shows `files` ✅.
- [ ] `feat:` commit; work log written.
