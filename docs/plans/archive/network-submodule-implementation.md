# Plan: Implement the `network` Core submodule

## Context

The `network` submodule is **documented but not implemented**. Its contract
already exists at `docs/reference/core/network.md` — an event-emitting
`M3LHttpClient` wrapping `undici`, with `M3LHttpClientOptions`,
`M3LHttpClientError`, and typed event payloads. The implementation-status
tracker (`docs/implementation-status.md:41`) lists it `❌` with a dependency
gate on **`undici`**. Because a `docs/reference` page already exists, this
skips `new-subpath` and runs the **`implement-submodule` TDD pipeline directly**.

Two decisions shape this plan:

1. **Transport:** add `undici` as the library's **first runtime dependency**,
   implementing the spec exactly (including `proxyUrl` → `ProxyAgent`). This is
   in deliberate tension with the "minimal runtime dependencies" constraint and
   must clear the dependency gate.
2. **Counts:** do **not** hand-edit the "5 of 22" implemented-count prose. The
   per-submodule status row for `network` is updated per phase (that is the
   pipeline's job), but the aggregate count is reconciled afterward by
   **`/sync-docs`**. (Note: `/sync-docs` does not currently touch the stale
   package-level README `packages/m3l-common/README.md` — left as-is per your
   instruction.)

The submodule sits in phase 3 of the build order and depends only on `events`
(`M3LEventEmitterBase`) and `errors` (`M3LError`), both already implemented and
reusable.

## 1 — Dependency gate: add `undici`

- Add `undici` to `dependencies` (not `devDependencies`) in
  `packages/m3l-common/package.json`. `undici` ships its own types, so no
  `@types/*` needed.
- Run `pnpm install` to update `pnpm-lock.yaml` (never hand-edit the lockfile).
- This is the first runtime dep, so confirm it survives the hygiene gates:
  `pnpm check:deps`, `pnpm knip` (must be a _used_ dep), `pnpm check:exports`
  (`publint` + `attw --profile esm-only` must still pass — `undici` is ESM-safe),
  and the `dependency-review.yml` PR gate (blocks HIGH/CRITICAL advisories).

## 2 — Contract extraction (Phase 1)

- Dispatch `spec-conformance-reviewer` in producer mode against
  `docs/reference/core/network.md` (+ the authoritative
  `docs/m3l-common-architecture.md`) to enumerate the exact symbols and
  behavioral contracts:
  - `M3LHttpClient` extends `M3LEventEmitterBase`; methods incl. `get<T>()` and
    `getAbortable<T>()` returning `{ promise, abort() }`.
  - `M3LHttpClientOptions`: `baseUrl`, `defaultHeaders`, `timeout` (default
    `30000`), `debug`, `proxyUrl`.
  - `M3LHttpClientError extends M3LError`, thrown on any non-2xx, chaining
    `cause`.
  - Typed event payloads (no `any`); JSON auto-parse when `Content-Type`
    matches `/[/+]json\b/i`; timeout enforced via `AbortController`.
- Optionally seed `docs/plans/network-submodule-implementation.md` matching the
  json/analysis/messaging plan format (Context → Contract → RED/GREEN →
  Review → Provenance/Status → Verification).

## 2 — RED: failing tests (Phase 2)

- Dispatch `test-author` to write `packages/m3l-common/tests/network.test.ts`:
  happy-path (JSON parse, default headers, base URL join), failure-path (non-2xx
  → `M3LHttpClientError` with `cause`; timeout abort), event emission (handler
  isolation), `getAbortable` cancellation, and `expectTypeOf` type-level tests
  for `M3LHttpClientOptions` and the generic response type.
- Network must be mocked — unit tests stay pure (no real sockets); stub the
  `undici` dispatcher / `fetch`.
- Confirm tests fail _for the right reason_ (missing symbols, not assertion
  noise). Update `docs/implementation-status.md` row `network` → `🧪`.

## 3 — GREEN: implementation (Phase 3)

- Dispatch `submodule-implementer` to create `src/core/network/` (e.g.
  `index.ts` + `M3LHttpClient.ts`), reusing `M3LEventEmitterBase` and
  `M3LError`. All relative imports carry `.js`.
- Wire `proxyUrl` to an `undici` `ProxyAgent` (per-request `dispatcher`).
- Add the barrel re-export to `packages/m3l-common/src/core/index.ts`:
  `export * from "./network/index.js";` (exact form `check-scaffold.mjs`
  expects). **Do not touch the `exports` map** — `network` is surfaced through
  the Core namespace barrel only; the 3 entries (`.`, `./core`, `./aws`) are the
  frozen public contract.
- Iterate to green; update the `network` row → `🟢`.

## 4 — Review (Phase 4)

Dispatch reviewers (writer ≠ reviewer): `code-reviewer`,
`spec-conformance-reviewer` (conformance mode vs. `network.md`),
`type-design-analyzer`, and — because this adds a network surface, a new runtime
dep, and error/abort handling — `security-reviewer` and `silent-failure-hunter`
(abort/timeout/non-2xx paths must surface, never swallow). Apply must-fixes;
update the row → `✅`.

## 5 — Provenance, counts & verification (Phase 5)

- Create `docs/reference/core/network.provenance.json` mapping each `network.md`
  heading to its source symbol(s) + file, then stamp it with
  `node bin/check-doc-provenance.mjs --update` (or via `/sync-docs`).
- Run **`/sync-docs`** to reconcile the implemented count (5 → 6 of 22) across
  root `README.md`, `docs/README.md`, and `CLAUDE.md`. Do **not** hand-bump.
- Write a work log to `docs/logs/<date>-core-network.md`.

## Verification checklist

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all pass
- [ ] `pnpm test:coverage` clears the 80% gate (verify `network` via
      `coverage-final.json`, not just the v8 text table)
- [ ] `pnpm check:scaffold` passes (barrel ↔ filesystem in sync)
- [ ] `pnpm check:provenance` passes (network sidecar valid, not stale)
- [ ] `pnpm check:exports` passes (`publint` + `attw` with `undici` present)
- [ ] `pnpm check:deps` / `pnpm knip` accept `undici` as a used runtime dep
- [ ] `exports` map unchanged (still exactly `.`, `./core`, `./aws`)
- [ ] `/sync-docs` run; counts reconciled to 6/22 (not hand-edited)
- [ ] Conventional Commit reflects semver: `feat(network): …` (minor) — adding
      `undici` is a new runtime dep but the public contract gains a feature
