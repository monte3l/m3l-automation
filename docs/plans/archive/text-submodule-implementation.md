# Plan: Add the `core/text` submodule

## Context

`m3l-automation` has 5 of 22 documented submodules implemented (`errors`,
`events`, `security`, `environment`, `utils`). This work adds the 6th:
`core/text`, a multi-format text-extraction registry.

The audit established that `text` is **fully specified** (`docs/reference/core/text.md`,
12 symbols) but **completely unimplemented** — no `src/core/text/`, no barrel
re-export, no tests, no provenance sidecar. The path is therefore the
`implement-submodule` skill (the spec exists), **not** `new-subpath`.

Two findings shape this plan:

1. **Dependency collision.** The spec mandates 6 runtime libraries (`unpdf`,
   `mammoth`, `read-excel-file`, `mailparser`, `cheerio`, `adm-zip`), which
   conflicts with the project's non-negotiable "minimal runtime dependencies"
   constraint. **Decision: re-spec `text.md` first** to reconcile the dependency
   posture before any code is written, then run the full implementation against
   the revised spec.
2. **Count handling.** No tool derives or validates the _implemented_ count (the
   "5" in "5 of 22"); `check:doc-counts` validates only the total (22), and
   since `text.md` already exists the total stays 22. Per direction, the
   implemented-count bump (5 → 6) is reconciled **inside the normal `/sync-docs`
   pass** — there is **no manual bump step** in this plan and **no new
   count-automation tooling** (explicitly out of scope).

## Phase 1 — Re-spec `text.md` for the minimal-deps constraint

Revisit `docs/reference/core/text.md` and resolve the dependency posture so the
documented contract is honest about the "minimal runtime dependencies" rule
_before_ tests or code exist. This is the only edit that precedes
`implement-submodule`.

- **What to decide & document** (the re-spec must land an explicit posture):
  - Which extractors are **core / always-available** vs **optional**. Recommended
    baseline: `M3LTextExtractorRegistry` + `M3LPlainTextExtractor` stay dep-free
    (Node `fs` only); the 5 library-backed extractors become opt-in.
  - How the backing libraries are **declared** — `optionalDependencies` /
    `peerDependencies` with per-extractor **lazy dynamic import**, so the base
    install stays minimal and the import graph stays tree-shakeable (the spec
    already claims "dependencies are per-extractor… tree-shakeable" at
    `text.md:100` — make the declaration match that claim).
  - The **failure mode** when an optional library is absent: surface a typed
    `M3LTextExtractionError` (with `cause`), never a bare module-resolution
    throw.
- **Where it lives:** `docs/reference/core/text.md` (reference spec — not a
  `docs/plans/` file, so editing is allowed). Update the Public API table, the
  extractor→library table, and the "Notes & behavior" section to state the
  optional-dependency posture and absent-library behavior.
- **Review the re-spec:** dispatch `spec-conformance-reviewer` (contract mode)
  and `docs-consistency-reviewer` to confirm the revised spec is internally
  consistent and still cross-links correctly (`importers`, `json`, `storage`,
  `errors`, capability index).
- **Commit** the re-spec as `docs:` (no semver impact) before implementation
  begins — satisfies the `implement-submodule` Step 2 "format & commit docs
  first" requirement and keeps the RED phase building against a stable contract.

## Phase 2 — Run `implement-submodule` for `core/text`

Invoke the `implement-submodule` skill with: namespace `core`, module `text`,
spec `docs/reference/core/text.md` (revised). The hub coordinates; spokes write
code and review. The standard loop:

1. **Dependency gate (Step 3):** pause for explicit approval of whichever
   libraries the revised spec keeps, and add them in the declaration form the
   re-spec chose (`optionalDependencies` / `peer`). Update the pnpm lockfile via
   `pnpm add` — never hand-edit it.
2. **Contract phase:** `spec-conformance-reviewer` (contract mode) enumerates the
   exact exported symbols + behavioral contracts (MIME-then-extension dispatch,
   first-registered-wins, ZIP depth cap via `ZIP_DEPTH_SYMBOL`, uniform
   `{ text, pages?, truncated }` result, absent-library error path). Hub keeps
   this text.
3. **RED phase:** `test-author` writes failing happy-path + failure-path +
   `expectTypeOf` tests in `packages/m3l-common/tests/text.test.ts`. Hub flips
   the `text` row in `docs/implementation-status.md` to 🧪.
4. **GREEN phase:** `submodule-implementer` writes `src/core/text/` (registry +
   extractor classes, lazy imports), adds the
   `export * from "./text/index.js";` line to `src/core/index.ts`, and puts any
   private helpers under `src/internal/`. Hub flips the row to 🟢.
5. **Review phase (parallel spokes):** `code-reviewer`,
   `spec-conformance-reviewer` (conformance mode), `security-reviewer` (ZIP entry
   / email / HTML deserialization, zip-bomb depth guard), `type-design-analyzer`
   (the `M3LTextExtractor` interface + options/result types), and
   `silent-failure-hunter` (library exceptions wrapped as
   `M3LTextExtractionError`, async paths, optional-import fallbacks). Hub
   consolidates must-fixes, returns them to `submodule-implementer`, re-runs
   until clean, then flips the row to ✅.

Representative files touched: `packages/m3l-common/src/core/text/index.ts` (+
per-extractor files), `packages/m3l-common/src/core/index.ts` (one barrel line),
`packages/m3l-common/tests/text.test.ts`, `package.json` (deps).

## Phase 3 — Verify, stamp provenance, reconcile docs

1. **Full gate:** `pnpm build && pnpm test && pnpm lint && pnpm typecheck`, plus
   `pnpm check:scaffold` (barrel sync), `pnpm check:exports`, and `pnpm knip`.
   Coverage must clear the 80% V8 gate (read `coverage-final.json`, not the text
   table — it hides 100% files).
2. **Provenance:** generate `docs/reference/core/text.provenance.json` mapping
   each of the documented symbols to its named export + source file + line range
   - git commit + retrieval date; validate with `pnpm check:provenance`. Every
     entry must reference a _named export_ — never an internal helper.
3. **Status file:** confirm the `text` row reads ✅ in
   `docs/implementation-status.md`.
4. **`/sync-docs`:** run the skill to re-stamp provenance to HEAD, verify doc
   counts (total stays 22), and lint markdown. The implemented-count prose
   (5 → 6 in `README.md`, `docs/README.md`, `CLAUDE.md`) is reconciled **here as
   part of the sync-docs pass** — no separate manual bump, no new automation.
5. **Work log:** `/write-work-log` → `docs/logs/2026-06-30-core-text.md` while
   context is intact.
6. **Commit:** `feat:` (new submodule surfaced through the barrel = minor; the
   `exports` map is unchanged, so not breaking).

## Out of scope (noted, not done)

- **Implemented-count automation.** Building a tool / extending
  `check-doc-counts.mjs` or `/sync-docs` to _derive and auto-fix_ the numerator
  is deliberately excluded. Tracked as a separate follow-up if desired.
- **Barrel JSDoc aspirational lists.** The placeholder submodule lists in
  `src/core/index.ts` / `src/aws/index.ts` are expected scaffolding, not a
  defect — left as-is.

## Verification checklist

- [ ] `text.md` re-spec states the optional-dependency posture + absent-library
      error behavior; reviewed and committed as `docs:`.
- [ ] Dependency gate approved; `package.json` + lockfile updated via `pnpm add`.
- [ ] `tests/text.test.ts` failed for the right reason (RED) before code existed.
- [ ] All 12 (or revised) symbols implemented; `src/core/index.ts` re-exports
      `text`; `pnpm check:scaffold` passes.
- [ ] All five review spokes clean; must-fixes resolved.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm typecheck` green; coverage
      ≥ 80% verified via `coverage-final.json`.
- [ ] `text.provenance.json` created; `pnpm check:provenance` passes.
- [ ] `docs/implementation-status.md` shows `text` = ✅.
- [ ] `/sync-docs` run; counts consistent (total 22, implemented reconciled to 6
      by the sync-docs pass — no manual edit).
- [ ] Work log written; `feat:` commit made.
