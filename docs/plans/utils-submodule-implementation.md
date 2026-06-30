# Plan: Submodule status report + implement the `utils` Core submodule

## Context

This audit answered two things: (1) the **current submodule implementation
status**, and (2) the path to **adding the `utils` submodule**.

**Status as verified against the source tree (not just docs):**

- **22 submodules documented** — 19 Core `.md` pages (incl. `utils.md`) + 3 AWS pages.
- **3 submodules implemented** — `errors`, `events`, `security`. Each has
  `src/core/<m>/`, a `tests/<m>.test.ts`, a barrel re-export, and a
  `docs/reference/core/<m>.provenance.json` sidecar.
- **Count drift exists but is OUT OF SCOPE here**: every "implemented" count
  still reads `2 of 22` / lists only `errors`+`events` (`CLAUDE.md:501`,
  `docs/implementation-status.md:5`, `docs/README.md:5`, `README.md:16` badge).
  `security` shipped without bumping the numerator; `check-doc-counts.mjs`
  validates only the **total** (22), not the implemented numerator, so CI
  missed it. **The parallel `environment` submodule task owns these shared
  count lines — this plan must not edit them** (would collide). Likewise the
  gate-hardening gaps (badge/numerator validation, "every doc page needs a
  sidecar") are **already being resolved in a parallel task**.

**`utils` is a documented-but-empty module**, so this is an
**`implement-submodule`** job (the `docs/reference/core/utils.md` spec already
exists, 141 lines) — **not** `new-subpath`. It surfaces through the `./core`
namespace barrel; the `exports` map stays at three entries (`.`, `./core`,
`./aws`) — **no semver event**.

`utils` is large (~39 symbols) and foundational (blocks ~10 downstream
modules). One dependency edge matters: **`M3LPaths` reads
`M3LExecutionEnvironment`** (`utils.md:129`) from the `environment` submodule
that is being built in parallel.

## Deliverable 1 — Status report (no code)

Already produced above; nothing to build. The authoritative tracker is
`docs/implementation-status.md`. Only change this plan makes to it is the
`utils` **row** (see Deliverable 2, step 5) — not the shared aggregate line.

## Deliverable 2 — Implement `utils` via the `implement-submodule` pipeline

Run the existing `implement-submodule` skill (hub-and-spoke TDD: Contract →
RED → GREEN → Review per phase). Implement in **capability-group phases**,
ordered by dependency so the dependency-free groups land first and the
`environment`-dependent group lands last.

The single shared seam created on the first GREEN phase:

- `packages/m3l-common/src/core/utils/index.ts` — the module barrel.
- `packages/m3l-common/src/core/index.ts` — add **one** line:
  `export * from "./utils/index.js";` (placed in documented order).

Implementation files live as `src/core/utils/<thing>.ts` (mirror the
one-concern-per-file style of `src/core/security/`, e.g. `DangerousKeys.ts`).
Tests go in `packages/m3l-common/tests/utils.test.ts` (or grouped
`utils.<group>.test.ts` if it grows large), importing from `src/` with the
`.js` extension. Every export gets a happy-path + failure-path test, plus
`expectTypeOf` where the type is the contract (the guards especially).

### Phase A — Type guards (zero deps, do first)

~25 guards: `isNullish`, `isPrimitive`, `isError`, `isNodeError`,
`isEnoentError`, `isPlainObject`, `isObject`, `isArray`, `isString`,
`isNumber`, `isBoolean`, `isFunction`, `isDate`, `isValidDate`, `isBuffer`,
`isMap`, `isSet`, `isRegExp`, `isSymbol`, `isBigInt`, `isPromise`,
`isNonEmptyString`, `isNonEmptyArray`, `hasProperty`, `hasMessage`. Each
narrows `unknown`; assert narrowing with `expectTypeOf`. Establishes the
barrel + the one-line core/index.ts export.

### Phase B — Serialization & formatting (zero deps)

`safeJsonStringify` (circular→`[Circular]` via `WeakSet`, depth limit 10
→`[Max Depth]`, BigInt→string, Symbol→description, Function→`''`, Map/Set→JSON;
**never throws** — `utils.md:43-64,131`), `valueToString`, `M3LDateTokens`
(`expand("…{YYYY}-{MM}-{DD}…")`), `formatBytes`, `smartTruncate`,
`truncatePath`, `truncateText`, `isPath`, `formatConfigValueDisplay`,
`formatConfigSourceDisplay`.

### Phase C — `M3LConcurrencyPool` (zero deps)

Bounded async pool: slot-count FIFO, `runEach(items, worker)` consumes on
demand for backpressure proportional to the limit, preserves FIFO start order
(`utils.md:66-78,132`). Test concurrency cap + ordering + error propagation
(no silent failures — surface worker rejections per the M3LError rules).

### Phase D — `M3LPaths` (depends on `environment` — do LAST)

`M3LPaths`, `M3LPathType`, `M3LPathEnvironmentVariables`. Resolves
data/config/input/output/cache vs. monorepo|standalone mode; honors the six
`M3L_*` overrides; `getProjectRoot()` **throws by design** in standalone mode
(throw a typed `M3LError` subclass, not a bare string — `utils.md:41,130`).
**Blocked on `M3LExecutionEnvironment`** from the parallel `environment` task —
sequence after it lands (or coordinate / mock the env seam if env ships first).

### Phase E — Close out

1. **`docs/implementation-status.md`** — flip the `utils` **row** through
   🧪→🟢→✅ as phases complete (this is the utils-specific row, safe to edit).
2. **`docs/reference/core/utils.provenance.json`** — create the sidecar
   (mirror `security.provenance.json`): one `sections` entry per Public-API
   heading, each with `sources` ({file, symbol, lines}), a ≥7-char `commit`
   SHA, and `retrieved` (YYYY-MM-DD). Then run `sync-docs` to stamp it to HEAD
   and validate.

## Scope guardrails (parallel-work coordination)

- **Do NOT** edit the shared count prose/badges (`CLAUDE.md:501`,
  `docs/implementation-status.md:5`, `docs/README.md:5`, `README.md:16`) — the
  parallel `environment` task owns them; reconcile via `sync-docs` at merge.
- **Do NOT** touch `bin/check-doc-counts.mjs` or other `bin/` gates — gate
  hardening is a separate parallel task.
- **Do NOT** add a new `exports` entry — `utils` is namespace-surfaced only.
- Coordinate Phase D timing with the `environment` task to avoid a blocked
  GREEN phase.

## Verification

- Per phase, the `post-edit-verify` hook auto-runs format + eslint + typecheck
  - related tests on the edited package; resolve eslint-only failures in-loop.
- Read coverage from `coverage-final.json`, not the v8 text table (it hides
  100%-covered files); the suite gates at 80% lines/functions/branches/stmts.
- Before "done": `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
  `pnpm check:scaffold` (barrel↔dir sync incl. the new `utils` line),
  `pnpm check:api` (must show **no** `exports`-map change), `pnpm knip`,
  `pnpm check:provenance` (validates the new sidecar), `pnpm lint:md`.
- Commit per phase as `feat: …` (each adds public exports → minor); keep
  commits small and meaningful.
