# Plan — F8-adopt + F6-adopt in `scripts/json-etl`

## Context

Two P1 "adoption" loose ends remain from the P0 F-series (both library seams
already shipped): `json-etl` should now consume the preset seam (F8) and the
importer skip-count seam (F6). Investigation (2 Explore agents + direct reads)
showed the two items are **not** symmetric:

- **F8-adopt is clean, worth doing.** The `M3LScriptOptions.preset` path seam
  exists; `json-etl` never wired `--preset` (it was pulled from docs, never
  coded). This is small net-new composition-root wiring.
- **F6-adopt is a poor fit and will be handled docs-only.** `json-etl` keeps
  its `import:error` subscription regardless (it logs each skip's index+cause —
  the summary carries only an aggregate). Worse, its **bare-`limit`** path
  truncates the stream (`break` at [run-json-etl.ts:250](../../scripts/json-etl/src/steps/run-json-etl.ts#L250)),
  so the `yield*` chain calls `.return()` up to `importStream()` and its natural
  `return { processed, skipped, durationMs }` **never executes** — the summary
  is lost. Reading `summary.skipped` would _add_ generator-return plumbing
  through 3 functions while removing only a 3-line counter, and introduce a
  truncation regression. The event-driven counter is the **correct** mechanism
  for a truncating consumer.

**Decisions (confirmed with user):**

- **F6-adopt** → keep the event counter; **no `src` change**. Re-scope the
  backlog row and file the seam limitation as F-series friction (docs-only).
- **F8-adopt** → `--preset <path>` **explicit path** passed through to
  `M3LScriptOptions.preset` (matches `.claude/rules/scripts.md`: presets are
  "passed to the loader by explicit path — no library search root").
- **Setup** → shared checkout, branch **`feat/json-etl-adopt-seams`**, land via
  **PR** to `origin` (guarded scope: `scripts/json-etl/src` + tests).
- Model tier (advisory): matrix row 2, Opus 4.8 `xhigh` hub; TDD spokes carry
  their own matrix pins.

Outcome: `--preset <path>` works end-to-end in `json-etl`; the trackers reflect
reality; the library-seam gap (summary unusable under stream truncation) is
recorded instead of silently worked around.

## Scope

Guarded **code** work is F8-adopt only. F6-adopt + the friction filing are
docs/tracker edits.

### F8-adopt — re-enable `--preset` (code)

Run the `implementing-scripts` TDD loop (RED → GREEN → review) for one small
module + its wiring.

- **New module `scripts/json-etl/src/steps/resolve-preset.ts`** — a named-export
  helper (keeps `main.ts` a pure composition root; extra `steps/` modules are
  the expected place for logic). Reads the CLI flag via the library seam and
  returns a spreadable fragment:

  ```ts
  import { Core } from "@m3l-automation/m3l-common";

  /** Resolves `--preset <path>` into a spreadable M3LScriptOptions fragment.
   * Explicit path only (no search root, per scripts.md). Returns {} when the
   * flag is absent, a bare boolean, or blank — so main.ts can spread it without
   * passing `undefined` (exactOptionalPropertyTypes). */
  export function resolvePresetOption(argv?: readonly string[]): {
    readonly preset?: string;
  } {
    const raw = new Core.M3LCommandLineConfigProvider(argv).getRawValue(
      "preset",
    );
    return typeof raw === "string" && raw.trim().length > 0
      ? { preset: raw }
      : {};
  }
  ```

  `argv?` (defaulting to `process.argv.slice(2)` inside the provider) keeps it
  unit-testable. Blank guarded because the library treats `""` as present →
  `ERR_PRESET_LOAD`.

- **Wire `scripts/json-etl/src/main.ts`** — spread the fragment into the options
  literal (pure wiring, reviewer-safe):

  ```ts
  const script = new Core.M3LScript({
    metadata: { name: "json-etl", version: "0.0.0" },
    config: { params: configParameters },
    hooks,
    ...resolvePresetOption(),
  });
  ```

- **`config.ts`** — no change (`preset` is a constructor option, not a param).

- **RED test `scripts/json-etl/tests/resolve-preset.test.ts`** (test-author):
  `--preset=path` → `{ preset }`; `--preset path` → `{ preset }`; bare
  `--preset` (boolean) → `{}`; absent → `{}`; blank/whitespace → `{}`; a
  type-level `expectTypeOf` that the return is `{ readonly preset?: string }`.

### F6-adopt — keep counter, document (docs-only, no `src` change)

- **`docs/plans/IMPLEMENTATION.md`** — edit the single **F6-adopt** row
  (ADR-0024 row-locality): status `done`, description recording that `json-etl`
  keeps the event-driven counter because the drain-to-completion
  `summary.skipped` cannot serve a consumer that truncates the stream, and that
  the seam gap is filed as friction (below). Flip **F8-adopt** row → `done`.
- **File new friction row** in `docs/plans/IMPLEMENTATION.md` (F-series), e.g.
  **`F6b`** (P2, gated): _"`M3LJSONListImporter.importStream()`'s summary
  (async-generator return value) is discarded on early `.return()`, so a
  consumer that truncates the stream (`break` before drain) can't read
  `.skipped`. A truncating consumer must keep event-based counting. Unblocks
  when a 2nd truncating consumer needs the count — candidate seams: a `skipped`
  getter on the importer, or an `import:done`/summary event."_ Source:
  `scripts/json-etl` bare-`limit` path.
- **`docs/ROADMAP.md`** — F6/F8 "done" rows already reference `F*-adopt` in
  their Notes; light touch only if the note wording needs it (no new rows —
  adopt items live in `IMPLEMENTATION.md`).

### F8-adopt docs (working example replaces the gap language)

- **`docs/reference/scripts/json-etl.md`** — "Presets" section (~~:83-97):
  replace the "does not yet drive a run" gap text with a working `--preset
data/config/presets/report.yaml` example; confirm the resolution-order line
  (~~:29-30) still reads `CLI > JSON > YAML > env/.env > preset > default`.
- **`scripts/json-etl/README.md`** — "Presets" section (~:38-46): replace the
  gap language with a working `--preset` usage example (the example presets
  `report.yaml` / `report-active.yaml` already exist under
  `data/config/presets/`).

## Steps (implementing-scripts loop)

1. `git switch -c feat/json-etl-adopt-seams` (shared checkout). **Done.**
2. **RED** — dispatch `test-author` for `tests/resolve-preset.test.ts`; confirm
   it fails for the right reason (module missing).
3. **GREEN** — dispatch `code-implementer` for `steps/resolve-preset.ts` +
   `main.ts` wiring; tests pass.
4. **Review** — dispatch `code-reviewer` (script quality / `main.ts` purity);
   `spec-conformance-reviewer` against the json-etl contract page.
5. **Docs** — apply the F8 example edits + F6 re-scope + F6b friction row, then
   run `/syncing-docs` (provenance, `gen:counts`, reference index incl. the
   consumer-scripts catalog, markdown lint) + `docs-consistency-reviewer`.
6. **Gates** — `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus
   `pnpm check:script-scaffold` (confirm the extra `steps/` module + test are
   tolerated) and `pnpm knip` (new module is used by `main.ts` + test).
7. **Commit** (small, Conventional, signed, AI trailer):
   - `feat(json-etl): re-enable --preset via explicit-path seam` — resolve-preset
     module, `main.ts` wiring, test, contract-page + README preset examples.
   - `docs: re-scope F6-adopt; file importStream summary truncation friction` —
     `IMPLEMENTATION.md` F6-adopt/F8-adopt rows + new F6b row.
   - `docs: reconcile doc metadata` — only if `/syncing-docs` reports dirty
     provenance/index/count sites.
8. **PR** via `creating-prs` → `origin feat/json-etl-adopt-seams`.

## Files to modify

- `scripts/json-etl/src/steps/resolve-preset.ts` (new)
- `scripts/json-etl/src/main.ts` (spread wiring)
- `scripts/json-etl/tests/resolve-preset.test.ts` (new)
- `scripts/json-etl/README.md` (Presets example)
- `docs/reference/scripts/json-etl.md` (Presets example)
- `docs/plans/IMPLEMENTATION.md` (F8-adopt→done, F6-adopt re-scope, new F6b row)
- `docs/ROADMAP.md` (note wording only, if needed)
- reconciliation outputs from `/syncing-docs` (provenance/index/counts as dirty)

## Reuse (do not re-implement)

- `Core.M3LCommandLineConfigProvider.getRawValue` — the argv-read seam (avoids
  touching `process.argv` directly).
- `M3LScriptOptions.preset` + `M3LScript.buildPresetProviders()` /
  `M3LScriptConfigLoader` — the library owns load, schema-validation against the
  declared `config.params`, `extends` resolution, and precedence-6 insertion.
  `json-etl` supplies only the path string.

## Verification (end-to-end)

- Unit: `pnpm --filter @m3l-automation/json-etl test` (resolve-preset RED→GREEN;
  existing run-json-etl skip assertions still pass — no `src` behavior change).
- **Smoke-run the real flag** from repo root against an example preset, e.g.
  `node scripts/json-etl/dist/main.js --preset data/config/presets/report.yaml`
  (after `pnpm build`) — confirm the preset's values drive the run (a preset-only
  value appears in resolved config) and that omitting `--preset` is unchanged.
  Confirm a blank `--preset=` is treated as "no preset" (no `ERR_PRESET_LOAD`).
- Gates green (step 6) and `docs-consistency-reviewer` clean before PR.
