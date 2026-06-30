# Plan: Close out `utils` — implement the deferred `M3LPaths` cluster (Phase D)

## Context

`utils` shipped 36 of 39 spec'd symbols (Phases A–C: type guards,
serialization/formatting, `M3LConcurrencyPool`). The remaining 3 — the
**`M3LPaths` cluster** (`M3LPaths`, `M3LPathType`,
`M3LPathEnvironmentVariables`) — were deferred as **Phase D** of the original,
now-immutable plan (`docs/plans/utils-submodule-implementation.md:87-94`) because
they depend on `M3LExecutionEnvironment` from the `environment` submodule, which
was being built in parallel.

That blocker is gone: `environment` is fully implemented.
`M3LExecutionEnvironment.detect()`
(`packages/m3l-common/src/core/environment/index.ts:770`) returns a discriminated
union on `deploymentMode` — `monorepoRoot: string` in `MONOREPO`, `undefined` in
`STANDALONE` — and exposes `detectFresh()` / `resetForTesting()` test seams. So
Phase D is unblocked.

This plan finishes `utils` by implementing only the deferred cluster, via the
**`implement-submodule`** TDD hub-and-spoke pipeline. It adds public exports to
the `Core` namespace barrel → **minor semver, no `exports`-map change**. It is a
follow-up to the immutable predecessor plan above, not an edit of it.

**Confirmed design decisions (this plan):**

1. `getOutputDir()` returns the **stable base `output/` dir** — no auto
   timestamping. Callers build run-archive dirs themselves via
   `Core.M3LDateTokens.expand(...)`. Keeps `M3LPaths` a pure resolver.
2. `M3LPaths` is **pure resolution** — getters compute absolute path strings and
   perform **no filesystem I/O**. Directory creation belongs to the downstream
   `files` submodule. Aligns with the no-side-effects / tree-shaking rules.
3. `getProjectRoot()` throws a **new `M3LPathResolutionError`** (an `M3LError`
   subclass) in standalone mode; this symbol is added to the `utils.md` Public
   API list (small, spec-conformant doc update).

## Reference contract (authoritative)

`docs/reference/core/utils.md:17-41,127-132`:

- `M3LPaths` resolves the standard directories — **data, config, input, output,
  cache** — relative to the detected deployment mode (monorepo root vs. a
  standalone base dir). Instantiated as `new Core.M3LPaths()` (no args).
- Six env-var overrides take precedence over detection:
  `M3L_DATA_DIR`, `M3L_CONFIG_DIR`, `M3L_INPUT_DIR`, `M3L_OUTPUT_DIR`,
  `M3L_BASE_DIR` (standalone base), `M3L_DEPLOYMENT_MODE` (forces mode — already
  honored inside `M3LExecutionEnvironment`).
- `getInputDir()` / `getOutputDir()` shown explicitly; `getProjectRoot()` throws
  by design in standalone (no monorepo root to return).
- `M3LPaths` reads deployment mode from `M3LExecutionEnvironment`; overrides win.

## Implementation (single GREEN seam, TDD)

Run the `implement-submodule` skill (Contract → RED → GREEN → Review). The seam:

- New file `packages/m3l-common/src/core/utils/M3LPaths.ts` — one concern per
  file, mirroring `src/core/security/` style.
- `packages/m3l-common/src/core/utils/index.ts` — add the
  `export * from "./M3LPaths.js";` barrel line (documented order).
- No change to `src/core/index.ts` (already re-exports `./utils/index.js`) and
  **no `exports`-map change**.

### 1 — `M3LPathType` and `M3LPathEnvironmentVariables` (types)

- `M3LPathType` — string-literal union of the five directory kinds:
  `"data" | "config" | "input" | "output" | "cache"`. Use `type` (union).
- `M3LPathEnvironmentVariables` — a type documenting the six override variable
  names (e.g. a readonly record / const-object + union mirroring the
  `environment` submodule's const-enum idiom). Drives the override lookup table.

### 2 — `M3LPathResolutionError` (new error)

- Subclass of `M3LError` (import from `../errors/index.js`), code
  `"ERR_PATH_RESOLUTION"`, following the `M3LEnvironmentDetectionError` shape at
  `environment/index.ts:229`. Thrown only by `getProjectRoot()` in standalone
  mode. Full TSDoc + `@example`.

### 3 — `M3LPaths` class

- Constructor: no args. Capture the deployment snapshot once via
  `M3LExecutionEnvironment.detect()` and read `process.env` overrides at
  construction (or lazily per getter — pick one and test it; construction-time
  capture is simplest and matches the cached-singleton model).
- Base-dir resolution:
  - MONOREPO → anchor at `info.monorepoRoot`; `data/` lives at the workspace
    root (per `CLAUDE.md`).
  - STANDALONE → anchor at `M3L_BASE_DIR` if set, else `process.cwd()`.
- Per-kind getters: `getDataDir()`, `getConfigDir()`, `getInputDir()`,
  `getOutputDir()`, `getCacheDir()` → `data/<kind>/` style absolute paths under
  the resolved base, each overridable by its `M3L_*_DIR` var (override wins,
  absolute paths used as-is). Use `node:path` join; no I/O.
- `getProjectRoot()` → returns `info.monorepoRoot` in MONOREPO; throws
  `M3LPathResolutionError` in STANDALONE.
- TSDoc + `@example` on the class and every public method.

### 4 — Tests (`packages/m3l-common/tests/utils.test.ts`, extend Phase-D block)

- Drive deployment mode deterministically: set `process.env` then
  `M3LExecutionEnvironment.detectFresh()` (and `resetForTesting()` in
  `beforeEach`/`afterEach`), restoring env after each test — no real walk-up
  reliance for the assertion paths.
- Cover, per export: monorepo vs standalone base resolution; each of the six env
  overrides taking precedence; every per-kind getter; `getProjectRoot()` happy
  path (monorepo) **and** the standalone throw (assert `M3LPathResolutionError`
  - `code`); `M3LPathType` / `M3LPathEnvironmentVariables` via `expectTypeOf`
    where the type is the contract.

### 5 — Docs + close-out

- `docs/reference/core/utils.md` — add `M3LPathResolutionError` to the Public API
  list (Paths group) and a one-line note that `getProjectRoot()` throws it.
- `docs/implementation-status.md` — update the **`utils` row only** to reflect
  39/39 symbols, M3LPaths shipped (do **not** touch shared aggregate count
  lines / badges — those are owned elsewhere and reconciled via `sync-docs`).
- `docs/reference/core/utils.provenance.json` — add `sections` entries for the
  M3LPaths cluster (sources: file/symbol/lines), then run `sync-docs` to stamp
  the sidecar to HEAD and validate.
- `docs/logs/2026-06-30-core-utils.md` — append a short Phase-D close-out note
  (or a new dated log) recording the three design decisions above.

## Scope guardrails

- Do **not** add a new `exports` entry — `utils` is namespace-surfaced only.
- Do **not** edit the shared submodule-count prose/badges
  (`CLAUDE.md`, `docs/implementation-status.md:5`, `docs/README.md`,
  `README.md` badge) — reconcile via `sync-docs`.
- Do **not** edit the immutable predecessor plan
  (`docs/plans/utils-submodule-implementation.md`).
- `getProjectRoot()` throws a typed `M3LError` subclass, never a bare string.

## Verification

- Per edit, the `post-edit-verify` hook auto-runs format + eslint + typecheck +
  related tests; resolve eslint-only failures in-loop.
- Read coverage from `coverage-final.json` (the v8 text table hides
  100%-covered files); suite gates at 80% lines/functions/branches/statements.
- Before "done": `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
  `pnpm check:scaffold` (barrel↔dir sync), `pnpm check:api` (must show **no**
  `exports`-map change), `pnpm knip`, `pnpm check:provenance` (validates the
  updated sidecar), `pnpm check:doc-sync`, `pnpm lint:md`.
- Commit as `feat: …` (adds public exports → minor); small, meaningful commits.
