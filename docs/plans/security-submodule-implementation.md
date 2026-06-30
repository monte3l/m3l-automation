# Plan: Implement the Core `security` submodule

## Context

This audit answered two things: (1) the submodule implementation status, and
(2) how to implement the `security` submodule.

**Status snapshot (verified against the filesystem):** 2 of 25 documented
submodules are implemented — `core/errors` (✅) and `core/events` (✅). The
remaining 23 (19 core minus the 2 done, plus 3 AWS, plus `security`) are
documented-but-empty. `docs/implementation-status.md` is accurate; `src/core/`
contains only `errors/` and `events/`, and `src/aws/index.ts` is a `export {}`
stub.

**`security` is the ideal next target:** it sits in tier 1 of the suggested
build order ("no deps; pure fns; good pipeline smoke test"), has a complete spec
at `docs/reference/core/security.md`, and is needed by the future `config`
module (which references it for prototype-pollution protection during
deserialization). It is two pure functions — small enough to exercise the full
TDD + hub-and-spoke pipeline cleanly.

**Decisions locked in:** strict documented contract only (no scope expansion to
input-validation guardrails or secrets unification — those are separate future
work); `formatUnsafeKeyLocation(key: string): string` with a single key argument
exactly as the spec example shows.

This runs through the **`implement-submodule` skill** (hub-and-spoke TDD). The
hub coordinates and updates the status file; it never writes `src/` or `tests/`.

## The contract (from `docs/reference/core/security.md`)

Two named exports, both pure, no I/O, no dependencies:

- `isDangerousKey(key: string): boolean` — returns `true` for exactly
  `'__proto__'`, `'constructor'`, `'prototype'`; `false` for any other string.
  Key-name based only; never inspects values.
- `formatUnsafeKeyLocation(key: string): string` — returns a human-readable
  diagnostic string identifying the rejected key, suitable for an error message
  or log line.

No `M3LError` subclass is introduced — the spec's example shows the _caller_
throwing with the formatted message; the guard itself only detects and formats.

## 1 — Scaffold the submodule directory

Create `packages/m3l-common/src/core/security/`:

- `DangerousKeys.ts` — the implementation file (name per
  `docs/m3l-common-architecture.md`). Holds both functions with full TSDoc and
  an `@example` on the primary entry point, mirroring the style in
  `src/core/errors/M3LError.ts` and `src/core/events/M3LEventEmitterBase.ts`.
  Define the dangerous-key set as a module-level `readonly` constant.
- `index.ts` — barrel only: `@packageDocumentation` header +
  `export * from "./DangerousKeys.js";`. No logic (coverage excludes
  `**/index.ts`).

ESM rules apply: `.js` extension on the relative import; named exports only; no
`any`; no non-null `!`.

## 2 — Surface it through the Core namespace barrel

Edit `packages/m3l-common/src/core/index.ts`: add
`export * from "./security/index.js";` alongside the existing `errors` and
`events` lines. **Do not touch the `package.json` `exports` map** — the
three-entry contract (`.`, `./core`, `./aws`) is stable and `check:api` /
`check:scaffold` enforce this. `check:scaffold` will fail if the directory
exists without the barrel re-export (and vice-versa), so this edit is mandatory.

## 3 — Tests first (RED), via the `test-author` spoke

Create `packages/m3l-common/tests/security.test.ts` (flat, not nested), citing
`docs/reference/core/security.md` as the contract source. Cover:

- **Happy/true path:** `isDangerousKey` returns `true` for each of
  `'__proto__'`, `'constructor'`, `'prototype'`.
- **False path:** returns `false` for ordinary keys (`'name'`, `''`, `'proto'`,
  `'__proto'`, mixed-case like `'__PROTO__'`) — pin the exact-match behavior.
- **`formatUnsafeKeyLocation`:** returns a non-empty string that includes the
  offending key; assert the contract (contains the key) rather than the exact
  prose, to avoid brittle wording lock-in.
- **Type-level (`expectTypeOf`):** `isDangerousKey` is
  `(key: string) => boolean` and `formatUnsafeKeyLocation` is
  `(key: string) => string`.

Tests must fail first for the right reason (symbols absent) before any
implementation.

## 4 — Implement to green, via the `submodule-implementer` spoke

Write `DangerousKeys.ts` to satisfy the tests with the minimal pure
implementation, then refactor while green. The `post-edit-verify.mjs` hook will
auto-format, lint, typecheck, and run the related tests in-loop.

## 5 — Review, via review spokes

Dispatch (writer ≠ reviewer): `spec-conformance-reviewer` (does code match
`security.md` exactly — no missing/extra/drifted symbols) and `code-reviewer`
(quality/SOLID). `type-design-analyzer` is light-touch here (two primitive
signatures). `security-reviewer` is optional but apt given the module's purpose.
Iterate to clean.

## 6 — Provenance sidecar + status update

- Create `docs/reference/core/security.provenance.json` following the schema
  used by `events.provenance.json`: `$schema`, `doc: "core/security.md"`, and a
  `sections` array mapping the `Public API` / `The prototype-pollution guard`
  headings to `{ file, symbol, lines }` in `DangerousKeys.ts`, stamped with the
  current commit SHA and `retrieved` date. Run `pnpm check:provenance`.
- Update `docs/implementation-status.md`: flip the `security` row through
  🧪 → 🟢 → ✅ as phases complete (hub responsibility, after each phase).
- Doc counts already match (the spec page already exists), so `check:doc-counts`
  needs no prose change.

## Verification checklist

Run from the repo root before reporting done:

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test` — all pass, including new `security.test.ts`
- [ ] `pnpm test:coverage` — security file ≥ 80% on all four metrics (confirm
      via `coverage/coverage-final.json`, not the v8 text table which hides
      100% files)
- [ ] `pnpm build` — tsc emits `dist/core/security/`
- [ ] `pnpm check:scaffold` — barrel re-export ↔ directory in sync
- [ ] `pnpm check:api` — `exports` map snapshot unchanged (three entries)
- [ ] `pnpm check:provenance` — sidecar valid and current
- [ ] `pnpm knip` — no unused exports/files
- [ ] Commit as `feat:` (minor — new public symbols via the barrel, `exports`
      map unchanged)

## Out of scope (deliberately deferred)

Input-validation guardrails (size/depth/complexity) and unifying the scattered
secret-marking/redaction surface (config `M3LSecretsSpecifier` ↔ logging
`redactSensitiveLog*`) — both surfaced by the audit but outside the narrow
documented `security` contract. Track separately if pursued; each would require
a doc-spec change first.
