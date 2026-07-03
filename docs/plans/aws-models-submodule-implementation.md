# Plan: Implement the AWS `models` submodule

## Context

The library has 18 of 22 submodules implemented and reviewed — all Core except
`script`. The entire AWS namespace is unbuilt: `src/aws/index.ts` is an
`export {}` placeholder and `models` → `credentials` → `clients` are all `❌`.
The documented build order puts **`aws/models` first**, because it is the shared
type-vocabulary layer the credentials manager and client providers exchange.

The audit surfaced a blocking inconsistency: `models.md`, `credentials.md`, and
`clients.md` reference each other circularly, and **no page defines the field
shapes** of the shared types. Since `models` is built first, it must _own_ the
type definitions the later modules import. Confirmed decisions: models owns the
definitions and its spec becomes authoritative; scope is the **five credential
types only**; the error categories are a **const-object + union** (not a TS
`enum`); field shapes are **minimal and zero-dependency** (no `@aws-sdk/*` yet).

Outcome: a dep-free, types-only `aws/models` submodule surfaced under the `AWS`
namespace, unblocking `credentials` next, and taking the tracker to 19 of 22.

## The five symbols models will own

Authored into `src/aws/models/index.ts` (illustrative shapes; the
`spec-conformance-reviewer` contract pass finalizes them from the rewritten spec,
`type-design-analyzer` ratifies them in review):

- `M3LAWSCredentialsErrorType` — const object of the 5 categories
  (`SSO_SESSION_EXPIRED`, `SSO_SESSION_INVALID`, `CREDENTIALS_PROVIDER_FAILED`,
  `PROFILE_NOT_FOUND`, `UNKNOWN`) + a same-named derived union type. Mirrors the
  project convention (logging's `enum → const-object` should-fix).
- `M3LAWSCredentialsErrorAnalysis` — `{ readonly type; readonly recoverable: boolean; readonly cause?: unknown }`.
- `M3LAWSRetryContext` — `{ readonly attempt: number; readonly maxAttempts: number; readonly analysis: M3LAWSCredentialsErrorAnalysis }`.
- `M3LAWSLoginResult` — `{ readonly profile: string; readonly success: boolean; readonly durationMs: number }`.
- `M3LAWSCredentialsManagerOptions` — `{ readonly profile?: string; readonly loginTimeoutMs?: number; readonly interactive?: boolean }` (default login timeout 120 000 ms, documented).

Object shapes use `interface`; the error-category union uses `type`. All pure
domain types — no `@aws-sdk` import, so `models` stays dependency-free.

## Implementation sections

### 1. Start-work gate (must run first)

Run `/starting-work`. This edits `src/**`, `tests/**`, and docs, and
`guard-branch-isolation.mjs` blocks `src/`/`tests/` writes on `main`. Expected
decisions: linked worktree or shared checkout; branch `feat/aws-models` off
`main`; lands via **PR**; push `origin feat/aws-models`. Semver: new public
exports under the existing `./aws` subpath → `feat:` (minor).

### 2. Make `models.md` the authoritative spec (before tests)

Do this before RED — `test-author` and the contract producer read the spec.

- Rewrite `docs/reference/aws/models.md`: add a real **Public API** section
  listing the five symbols with field tables (the shapes above), keeping the
  existing `M3LAWSCredentialsErrorType` value table.
- Flip the cross-references: `docs/reference/aws/credentials.md` (lines 15, 81)
  and `docs/reference/aws/clients.md` (line 94) should point _to_ `models.md` as
  the authoritative home for these types, removing the circular
  "documented in credentials.md" claim in `models.md`.

### 3. Run the `implementing-submodules` pipeline for `aws/models`

The spec page now exists and is authoritative, so this is the normal entry point
(not `scaffolding-submodules`). The pipeline:

- **Contract** — `spec-conformance-reviewer` (contract mode) enumerates the five
  symbols + contracts from the rewritten `models.md`.
- **RED** — `test-author` writes `packages/m3l-common/tests/models.test.ts`: a
  runtime test for the `M3LAWSCredentialsErrorType` const object (all 5 values,
  frozen, exhaustive union) plus `expectTypeOf` type-level assertions for each
  interface (field presence, `readonly`, optionality). Tests fail for the right
  reason (symbols absent).
- **GREEN** — `submodule-implementer` writes
  `packages/m3l-common/src/aws/models/index.ts` and replaces `export {}` in
  `packages/m3l-common/src/aws/index.ts` with
  `export * from "./models/index.js";` (literal `.js`). TSDoc on every export.
- **Review fan-out** — `code-reviewer`, `spec-conformance-reviewer` (conformance
  mode), `type-design-analyzer`, `silent-failure-hunter`, and
  `security-reviewer` (runs because the path is `aws/*`; clean since models holds
  no secrets/credentials logic). Iterate to zero must-fix.

Update `docs/implementation-status.md` after each phase (`❌ → 🧪 → 🟢 → ✅`;
symbol count `—` → 5).

### 4. Reconcile docs and counts

Run `/syncing-docs`: create the `docs/reference/aws/models.provenance.json`
sidecar (every `symbol` a named export), bump the implemented count **18 → 19**
across the count sites (root + package `README.md` badges/prose,
`docs/README.md`, `implementation-status.md` intro), regenerate the reference
index, and run markdown lint.

### 5. Commit and open the PR

Small Conventional commits (`feat:` for the submodule, `docs:` for the spec
rewrite/reconciliation) via `/writing-commits`, then `/creating-prs`.

## Verification checklist

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all green.
- `pnpm test:coverage` — per-file ≥ 80% (the const-object file carries the only
  runtime; type-only interfaces emit no executable lines).
- `pnpm check:scaffold` and `pnpm check:scaffold-seam` pass (src dir + barrel
  line + `tests/models.test.ts` + status row all present and consistent).
- `pnpm check:api` / `pnpm check:exports` (`publint` + `attw`) — `./aws` now
  resolves real exports; no exports-map change.
- `pnpm check:provenance`, `pnpm check:impl-counts`, `pnpm check:doc-exports`,
  `pnpm check:index` pass after `/syncing-docs`.
- `import { AWS } from "@m3l-automation/m3l-common"` exposes the five symbols;
  `AWS.M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED` resolves at runtime.
- No `@aws-sdk/*` entry added to `packages/m3l-common/package.json`.
