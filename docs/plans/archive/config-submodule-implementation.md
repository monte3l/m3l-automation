# Plan: Implement the `core/config` submodule

## Context

`config` is documented (`docs/reference/core/config.md`, ~18 public symbols incl.
7 provider classes — the largest module spec to date) but unimplemented: there
is no `src/core/config/`, no `tests/config.test.ts`, and no provenance sidecar.
It is listed in the Core barrel JSDoc (`src/core/index.ts:5`) but is **not** in
the live `export *` block, so the barrel advertises an API it does not yet ship.
The current implemented set is errors, events, security, environment, utils
(json/analysis/messaging are in-flight under separate plans in `docs/plans/`).

Because the spec page already exists, this is a **spec-first implementation**:
use the `implement-submodule` skill directly — do **not** run `new-subpath`.
Two decisions are settled: (1) add the `yaml` runtime dependency so
`M3LYAMLConfigProvider` matches the documented contract, and (2) implement the
full module in a single Contract→RED→GREEN→Review pipeline pass.

The `exports` map stays at three entries (`.`, `./core`, `./aws`); `config` is
surfaced only through the namespace barrel, so this is a `feat:` (minor), not a
breaking change.

## 1 — Dependency gate: add `yaml`

- This is the package's **first runtime dependency** and trips the
  `implement-submodule` dependency-approval gate (already approved here).
- Add `yaml` to `packages/m3l-common/package.json` `dependencies` (not the root,
  not `devDependencies`) via `pnpm add yaml --filter @m3l-automation/m3l-common`
  so the lockfile is updated by the tool (never hand-edit `pnpm-lock.yaml`).
- Pin a current exact version; `yaml` is dependency-free, which keeps the import
  graph shallow per the architecture rules.
- After adding, confirm `pnpm knip` and `pnpm check:deps` still pass (the dep
  must be _used_ by `src/` to avoid an unused-dependency failure).

## 2 — Run `implement-submodule` for `core/config` (full module)

Invoke the skill and let it drive the hub-and-spoke TDD loop end to end. The
established phases and spokes:

1. **Contract (`spec-conformance-reviewer`, producer mode)** — enumerate the
   exact symbols/behaviors from `docs/reference/core/config.md`. The spec is
   looser than prior modules ("Parsers"; "exact constructor option names beyond
   those listed above are not specified by the overview"), so this phase must
   firm up: constructor option shapes, the `M3LConfigParameterType` enum
   (STRING/INT/DOUBLE/BOOL + the three array variants + BUFFER), the 8-level
   resolution order, alias resolution (`getRawValueForKeys`), source tracking
   (`set`/`sourceOf`), and the async `getValueAsync` path. Surface any genuinely
   undefined option-shape choices back to the hub before tests are frozen.
2. **RED (`test-author`)** — write `packages/m3l-common/tests/config.test.ts`:
   per-provider happy + failure paths, the full resolution-order precedence
   (CLI > JSON > YAML > env > Lambda > preset > defaultValue > asyncFallback),
   alias-beats-lower-priority, `M3LUnknownParameterDetector`,
   `M3LSecretsSpecifier`, and `expectTypeOf` tests where the type is the
   contract. Confirm tests fail for the right reason.
3. **GREEN (`submodule-implementer`)** — implement under
   `packages/m3l-common/src/core/config/` mirroring the established layout:
   a barrel `index.ts` that `export *`s from named files, one file per cohesive
   unit (e.g. `M3LConfig.ts`, `M3LConfigReader.ts`, `M3LConfigParameter.ts`,
   provider files), private helpers under `src/internal/config/` only.
4. **Review fan-out** — `code-reviewer`, `spec-conformance-reviewer` (conformance
   mode), `type-design-analyzer` (new public types), `silent-failure-hunter`
   (async/fallback/parse error paths), and **`security-reviewer`** (this module
   parses untrusted JSON/YAML/Lambda payloads and handles secrets). Iterate to
   clean.

### Reuse (do not reinvent)

- **Prototype-pollution guard**: reuse `isDangerousKey` from `core/security`
  (`src/core/security/DangerousKeys.ts`) when building objects from parsed
  JSON/YAML/Lambda input — same pattern the in-flight `json` plan adopts.
- **Errors**: throw `M3LError` subclasses with `cause` chaining (e.g. a
  config-specific error for parse failures / type-coercion failures); never bare
  strings. Follow `core/errors`.
- **Safe stringify / guards**: `core/utils` (`safeJsonStringify`, type guards)
  for any diagnostic formatting — never log secret values.

### Hard rules (enforced by hooks + reviewers)

- ESM relative imports carry `.js`; named exports only; no `any` (use `unknown`
  - narrow); no non-null `!`; TSDoc + `@example` on every exported symbol.
- Add `export * from "./config/index.js";` to `src/core/index.ts` in the live
  block (keep it ordered alongside the existing five). Do **not** touch the
  `exports` map.

## 3 — Verify (final gate, run by the hub)

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm test:coverage      # 80% gate; read coverage/coverage-final.json, not the text table
pnpm knip               # confirms `yaml` is used, no dead exports
pnpm check:exports      # publint + attw, exports map unchanged
pnpm check:scaffold     # barrel ↔ filesystem sync
pnpm check:deps
```

## 4 — Doc metadata: rely on `/sync-docs`, do **not** hand-bump counts

- Update `docs/implementation-status.md` config row (3240→) to ✅/✅/✅ — this is
  the hub-owned status file and the implement-submodule loop updates it.
- Run **`/sync-docs`** to: generate/stamp `docs/reference/core/config.provenance.json`
  to current HEAD, run `check:doc-counts`, and `lint:md`.
- **Do not manually edit the "N of 22 implemented" numerator** in README.md /
  docs/README.md / CLAUDE.md. Verified: `bin/check-doc-counts.mjs` only
  validates the _total_ (22), and `config.md` is already on disk so the total is
  unchanged. The implemented-numerator drift (README 3/22, docs/README 2/22,
  status 5/22) is a pre-existing inconsistency being reconciled by the parallel
  json/messaging plans; leave it to `/sync-docs` and that coordinated work
  rather than fixing it independently here.

## 5 — Work log + commit

- `/write-work-log` to capture lessons (contract-firming under a loose spec; the
  first runtime-dep decision; reuse of `isDangerousKey`).
- Commit as `feat:` (new public surface via the namespace barrel → minor).
  Keep `yaml` dependency addition + lockfile in the same logical change.

## Verification checklist

- [ ] `yaml` added to `packages/m3l-common/package.json` deps; lockfile updated by pnpm; `knip` clean.
- [ ] `src/core/config/` implements all ~18 documented symbols; `config.test.ts` covers each provider + the 8-level resolution order + aliases + secrets/unknown-param detection.
- [ ] `config` added to the live `export *` block in `src/core/index.ts`; `exports` map untouched.
- [ ] `pnpm build / typecheck / lint / test / test:coverage / knip / check:exports / check:scaffold / check:deps` all pass.
- [ ] All five review spokes (incl. security-reviewer) clean.
- [ ] `docs/implementation-status.md` config row ✅; `/sync-docs` run; provenance sidecar created; `check:doc-counts` + `lint:md` pass.
- [ ] No manual edit to the "N of 22 implemented" numerator anywhere.
- [ ] `feat:` commit with TSDoc + tests on every new export.
