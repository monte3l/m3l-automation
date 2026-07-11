# Plan: Add the `importers` Core submodule

## Context

`importers` is a **documented-but-unimplemented** submodule: its full contract
already lives at `docs/reference/core/importers.md` (13 symbols; CSV/JSON/JSONL/text
batch + streaming parsing), and the tracker (`docs/implementation-status.md:44`)
marks it `❌ ❌ ❌`. The goal is to take it through the standard
`implement-submodule` TDD pipeline so it ships with the same rigor as the five
already-built modules (errors, events, security, environment, utils).

Because the spec already exists, this is an `implement-submodule` job, **not**
`new-subpath`. Two constraints shape the plan, per audit decisions:

- **`json` is a hard prerequisite.** `M3LJSONListImporter` / `M3LJSONFileImporter`
  and importers' format detection depend on `M3LJSONFormatDetector` from the
  `json` module, which is unimplemented (`implementation-status.md:35`, `❌`).
  The plan gates on this rather than building json here.
- **The implemented-count is bumped only via `/sync-docs` output**, never
  hand-edited ad-hoc. `/sync-docs` stays verify-only; we apply exactly what it
  reports.
- Pre-existing doc drift (stale `packages/m3l-common/README.md` "2 of 22";
  tracker test-count mismatches) is **out of scope** — leave it for a separate
  follow-up.

## 0. Prerequisite gate — verify `json` is implemented (BLOCKING)

Before any importers code is written, confirm the json dependency is satisfiable:

- `packages/m3l-common/src/core/json/index.ts` exists and exports
  `M3LJSONFormatDetector` (and the `{ format, confidence, method }` result type
  the importers spec references at `importers.md:111`).
- `json` is re-exported from `packages/m3l-common/src/core/index.ts`.
- The tracker row for `json` (`implementation-status.md:35`) is `✅`.

If json is **not** implemented, **stop and surface the blocker** — do not start
importers. The remediation is to run the `implement-submodule` pipeline for
`json` first (it is Phase-1 foundational, `implementation-status.md:63`), then
return to this plan. The importers plan doc (section 1) must record json as a
documented hard requirement either way.

## 1. Author the implementation plan doc

Create `docs/plans/importers-submodule-implementation.md`, following the
structure of the existing sibling plans (`docs/plans/json-submodule-implementation.md`,
`exporters-submodule-implementation.md`, `files-submodule-implementation.md`).
It must capture:

- The contract from `importers.md` (all 13 symbols; batch `import()` +
  streaming `importStream()`; the CSV pipeline column-mapping → defaults →
  validator → transformer order from `importers.md:109`; JSON/JSONL dispatch).
- The `csv-parse` runtime dependency (approval + lockfile note — minimal-deps
  constraint).
- The **json hard requirement** from section 0.
- The mirrored relationship with `exporters` (noted as a follow-up, not built here).
- RED → GREEN → review phases and the final `/sync-docs` reconciliation.

## 2. Run the `implement-submodule` pipeline (full TDD loop)

Drive the existing `implement-submodule` skill end-to-end (hub-and-spoke). The
skill already encodes the phases; the importers-specific shape is:

1. **Contract extraction** (`spec-conformance-reviewer`) — enumerate the exact
   13 symbols + behavioral contracts from `importers.md` to seed tests.
2. **RED** (`test-author`) — write `packages/m3l-common/tests/importers.test.ts`:
   happy + failure paths per export, `expectTypeOf` for the generic
   `M3LListImporter<TItem>` / event-map / options types. Confirm they fail for
   the right reason. (The untracked `guard-red-phase-comments.mjs` /
   `guard-eslint-disable-red.mjs` hooks police RED-phase noise — expect them.)
3. **GREEN** (`submodule-implementer`) — create the source tree mirroring the
   `errors`/`utils` layout: `src/core/importers/index.ts` barrel re-exporting
   from split files (e.g. `M3LListImporter.ts`, `M3LCSVListImporter.ts`,
   `M3LJSONListImporter.ts`, `M3LFileImporter.ts`, adapters). All list importers
   extend `M3LEventEmitterBase` (events module) and throw `M3LError` subclasses.
   All relative imports carry `.js`. No `any`; no non-null `!`.
4. **Surface in the barrel** — add `export * from "./importers/index.js";` to
   `packages/m3l-common/src/core/index.ts`. Do **not** touch the `exports` map
   in `package.json` (3-entry contract is semver-locked; the namespace barrel is
   the surfacing mechanism — `check:scaffold` enforces 1:1 barrel↔dir).
5. **Review fan-out** — `code-reviewer`, `spec-conformance-reviewer` (drift vs
   `importers.md`), plus `silent-failure-hunter` (parsing/streaming error paths)
   and `type-design-analyzer` (the generic importer types). `security-reviewer`
   only if any external-input boundary warrants it.

Update `docs/implementation-status.md` row 44 through the lifecycle
(`❌ → 🧪 → 🟢 → ✅`) as each phase lands — this is the hub's durable state and
is NOT the same as the prose count (handled in section 4).

## 3. Provenance sidecar

Generate `docs/reference/core/importers.provenance.json` once the source exists,
matching the schema/shape of the existing sidecars
(`docs/reference/core/errors.provenance.json` et al.) — stamped to the source
files the spec now maps to. This is produced/re-stamped by `/sync-docs` step 1.

## 4. Reconcile docs via `/sync-docs` (count bump flows through here)

After implementation is `✅`, run the `sync-docs` skill. It will:

- Re-stamp all provenance sidecars (incl. the new importers one) to HEAD.
- Run `check:doc-counts` — total stays 22 (the spec page already existed), so
  this passes untouched.
- Run `check:test-counts` — record importers' actual test count in the tracker
  Notes column as the skill directs.
- **Step 5** will report that the `✅`-row count no longer matches the "N of 22"
  prose in `README.md` (badge + callout), `docs/README.md`, and `CLAUDE.md`.
  Apply **exactly** the edits `/sync-docs` reports — this is the only path by
  which the implemented count is bumped (no manual ad-hoc bump). Do **not** add
  `packages/m3l-common/README.md` here — that stale "2 of 22" is out of scope.
- Run `lint:md`.

## 5. Commit

Conventional Commit `feat(importers): ...` (new public submodule → minor). The
tracker, plan doc, and the `/sync-docs`-driven count edits ride along. Never
hand-bump `version` (semantic-release owns it).

## Verification checklist

- [ ] Section 0 gate passed: `src/core/json/` exists and exports
      `M3LJSONFormatDetector`; json row is `✅`. (Else: blocked — build json first.)
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` clean (no stale RED-phase `eslint-disable` left after GREEN).
- [ ] `pnpm test` green; `pnpm test:coverage` ≥ 80% across lines/functions/
      branches/statements for the importers files (verify via
      `coverage-final.json`, since the v8 text table hides 100% files).
- [ ] `pnpm build` emits `dist/core/importers/*.js` + `.d.ts`.
- [ ] `pnpm check:scaffold` passes (barrel re-export ↔ `src/core/importers/`).
- [ ] `pnpm check:exports` (publint + attw) clean — importable as
      `import { Core } from "@m3l-automation/m3l-common"` and via `/core`.
- [ ] `pnpm check:provenance` + `pnpm check:doc-counts` + `pnpm check:test-counts`
      pass.
- [ ] `spec-conformance-reviewer` reports zero drift vs `importers.md` (all 13
      symbols present, no extras).
- [ ] `docs/implementation-status.md` row 44 = `✅`; "N of 22" prose updated
      solely from `/sync-docs` output (package README left as-is).

## Out of scope (follow-ups)

- The `exporters` mirror submodule.
- Fixing stale `packages/m3l-common/README.md` "2 of 22".
- Reconciling pre-existing tracker test-count drift beyond importers.
- Documenting the new `check:test-counts` script / `guard-red-phase-comments.mjs`
  hook in `CLAUDE.md`.
