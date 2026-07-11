# Plan — Implement the AWS `credentials` submodule (with `aws/models` as a blocking prerequisite)

## Context

`@m3l-automation/m3l-common` has **18 of 22** submodules implemented and reviewed.
The entire **AWS namespace is greenfield**: `src/aws/index.ts` is `export {}`
(packages/m3l-common/src/aws/index.ts:11) and no `src/aws/` subdirectories exist.
Build order slot 6 is `aws/models → aws/credentials`. This plan implements
**`aws/models`** (the shared credential type vocabulary — a **hard blocking
prerequisite**, per user decision) and then **`aws/credentials`**
(`M3LAWSCredentialsManager`), the SSO credential layer that validates credentials
via STS `GetCallerIdentity`, drives `aws sso login`, classifies credential errors,
and wraps operations with retry-on-relogin.

The credentials spec (docs/reference/aws/credentials.md) documents the 6 public
symbol **names** and all behavioral contracts, but **not the field shapes** of four
types. Per decision, we design those shapes and back-fill the spec before tests.
AWS SDK packages are added as **direct runtime dependencies** (lazy-imported).
Interactive relogin prompts are wired through an **optionally injected `M3LPrompt`**.

This is a TDD hub-and-spoke build (RED test-author → GREEN submodule-implementer →
parallel review incl. **mandatory `security-reviewer`**), ending in doc reconciliation.

## Decisions locked (from clarifying questions)

- **`aws/models` is a blocking prerequisite** — implemented and green before any
  `credentials` implementation begins. It owns the 5 shared types; `credentials`
  imports them.
- **AWS SDK deps**: `@aws-sdk/client-sts` + `@aws-sdk/credential-providers` in
  `dependencies` (lazy `await import(...)` inside methods to keep the import graph
  shallow / tree-shakeable).
- **Type fields**: design now, document in the spec pages before RED.
- **Prompt**: structurally inject an optional `M3LPrompt`; absent injection ⇒
  non-interactive (never prompts, treats recoverable errors per `interactive` flag).

## 0 — Run `/starting-work` (mandatory first step)

This plan writes `packages/m3l-common/src/aws/**` and `**/tests/**`.
`guard-branch-isolation.mjs` blocks those writes while `HEAD` is `main`, and we are
currently on `main`. `/starting-work` settles location / branch / PR / push and
confirms them. Expected: worktree or shared checkout, branch `feat/aws-credentials`
(covers both models + credentials as one dependency-linked unit), lands via PR.

## 1 — Design + document the shared type contract (spec back-fill)

Update **docs/reference/aws/models.md** and **docs/reference/aws/credentials.md** to
document the concrete field shapes below, so `spec-conformance-reviewer` can seed a
precise contract and the RED tests assert against a documented surface. Proposed
shapes (implementer/reviewer firm up during contract production):

- `M3LAWSCredentialsErrorType` — **const object + derived type** (follow the
  logging `enum→const-object` lesson), values `SSO_SESSION_EXPIRED`,
  `SSO_SESSION_INVALID`, `CREDENTIALS_PROVIDER_FAILED`, `PROFILE_NOT_FOUND`,
  `UNKNOWN`. (Only runtime symbol in `models`.)
- `M3LAWSCredentialsErrorAnalysis` — `{ readonly type; readonly recoverable: boolean;
readonly profile?: string; readonly reason: string }` (`reason` is redacted text).
- `M3LAWSRetryContext` — `{ readonly attempt: number; readonly maxAttempts: number;
readonly profile?: string; readonly analysis: M3LAWSCredentialsErrorAnalysis }`.
- `M3LAWSLoginResult` — `{ readonly profile: string; readonly success: boolean;
readonly exitCode: number | null; readonly durationMs: number; readonly timedOut:
boolean }`. **No stdout/stderr** (stdio is `inherit`; never capture credential output).
- `M3LAWSCredentialsManagerOptions` — `{ readonly profile?: string; readonly region?:
string; readonly loginTimeoutMs?: number (default 120000); readonly maxRetries?:
number; readonly interactive?: boolean; readonly prompt?: M3LPrompt }`. Test seams
  (`spawn`, STS client factory) are injected as **internal** constructor params, kept
  **out** of this public type.
- **Add a 7th export** not in the original 6: `M3LAWSCredentialsError extends M3LError`
  (`override readonly code = "ERR_AWS_CREDENTIALS" as const`), carrying the classified
  `type`/`profile` in `context` and chaining the SDK failure via `cause`. Precedent:
  files added `M3LFileCopyError`, storage added `M3LFtsIndexError`. Document it in the
  spec so it is not "drift". This lives in `credentials`, not `models`.

Doc-only edits (`docs/**`) are allowed off any branch, but do them on the feature
branch for a clean PR.

## 2 — Add AWS SDK runtime dependencies

In `packages/m3l-common/package.json` add to `dependencies`:
`@aws-sdk/client-sts` and `@aws-sdk/credential-providers`. Run `pnpm install` to
update the authoritative lockfile (never hand-edit it). Lazy-import both inside the
manager methods (`const { STSClient, GetCallerIdentityCommand } = await import(...)`)
so the main entry stays tree-shakeable. `pnpm check:deps` / CI `--frozen-lockfile`
must stay green.

## 3 — Build `aws/models` (BLOCKING prerequisite) — TDD

Location: `packages/m3l-common/src/aws/models/`.

- Define the 5 shared types (section 1). Split runtime (the error-type const object)
  into its own file so it is coverage-gated; keep pure-type declarations next to it.
- `src/aws/models/index.ts` re-exports the public types (barrel = re-export only, no
  logic — keep logic out of `index.ts`, it is coverage-excluded).
- Surface through `src/aws/index.ts` (`export * from "./models/index.js"`).
- **RED** (`test-author`): `expectTypeOf` assertions pin each type's fields; a runtime
  test locks the const-object values/keys. Confirm they fail for the right reason
  (missing module), not a typo.
- **GREEN** (`submodule-implementer`): minimal definitions to pass; `pnpm lint` +
  `pnpm typecheck` inside the loop; verify 100% coverage via `coverage-final.json`.
- **Gate**: `models` must be green + barrel-wired before section 4 starts. Verify the
  filesystem directly (files created, barrel line present) — do not trust the spoke's
  report.

## 4 — Build `aws/credentials` — TDD

Location: `packages/m3l-common/src/aws/credentials/`. Imports the shared types from
`../models/index.js`. Suggested file split (each line test-gated):

- `M3LAWSCredentialsError.ts` — the error class (section 1).
- `errorAnalysis.ts` — regex classification → `M3LAWSCredentialsErrorAnalysis`
  (multiple expired-session patterns + invalid-session + profile-not-found;
  fall through to `UNKNOWN`). Pure, fully unit-testable.
- `M3LAWSCredentialsManager.ts` — the class and its methods:
  - `ensureValidCredentials(profile?)` — resolve via `fromIni`/default chain, validate
    with STS `GetCallerIdentity`; on recoverable error, (optionally prompt via injected
    `M3LPrompt`,) run SSO login, retry.
  - `ensureValidCredentialsMultiple(profiles)` — 3 phases: **parallel** validation →
    partition valid/invalid → **sequential** SSO login for invalid (parallel browser
    windows are unusable — assert sequencing in tests).
  - `retryWithRelogin<T>(operation, options?)` — wrap an operation; on recoverable
    credential error with retries remaining, relogin then retry; surface
    `M3LAWSRetryContext` per attempt.
  - `analyzeError(error)` — public classification entry point.
  - SSO login: `spawn("aws", ["sso","login","--profile", name], { stdio: "inherit" })`,
    `loginTimeoutMs` timeout (default 120000) → `timedOut: true` + kill child; returns
    `M3LAWSLoginResult`.
- **Injectable seams** (internal, not in public Options): a `spawn` function and an STS
  client factory, defaulting to the real ones — so tests mock child_process + STS
  without hitting AWS. Mock the impl's I/O primitive by inference, not `extends`.
- `src/aws/credentials/index.ts` re-exports the manager + error class; surface through
  `src/aws/index.ts`.

- **RED** (`test-author`): happy + failure path per export; assert failures surface as
  `M3LAWSCredentialsError` with `cause` chained; cover **post-acquire** failure paths
  (STS rejects after a resolved provider; login child exits non-zero; login timeout;
  each error-type regex branch); assert multi-profile **sequential** login ordering;
  `expectTypeOf` where the type is the contract. Error-channel tests will need
  justified `eslint-disable-next-line -- <why>` for intentional non-`Error` throws.
- **GREEN** (`submodule-implementer`): lazy-import AWS SDK; never log credentials/
  tokens/SSO output; redact any error `context`/`reason` via `redactSensitiveLogValue`/
  `redactSensitiveLogText` before it can reach a sink; validate caller input (profile
  names) at the boundary and throw `M3LAWSCredentialsError` on violation. Run
  `pnpm lint` inside the loop; confirm coverage via `coverage-final.json`.

## 5 — Parallel review (hub dispatches spokes)

- **`spec-conformance-reviewer`** — diff code vs the back-filled spec (7 exports:
  6 documented + `M3LAWSCredentialsError`); no missing/extra/drifted symbols.
- **`security-reviewer`** (mandatory here) — no credential/token/SSO-output logging;
  redaction on error paths; input validation at the boundary; no secrets in
  tests/fixtures; `stdio: "inherit"` (not `pipe`-and-log).
- **`code-reviewer`** — four-part checklist, `M3LError`+`cause`, no swallowed errors,
  resource lifecycle (child process kill/cleanup in `finally`; a failing kill must not
  shadow the real error).
- **`silent-failure-hunter`** — the retry/login/timeout loops must surface exhaustion,
  never silently return.
- **`type-design-analyzer`** — the options/result/analysis types + the error-type
  discriminated set.

Apply must-fixes via the implementer spoke; re-verify green.

## 6 — Doc reconciliation + barrel/state sync

- Update `packages/m3l-common/src/aws/index.ts` JSDoc to the dependency order
  (`models`, `credentials`, `clients`) — fixes the noted INCONSISTENCY.
- Update `docs/implementation-status.md`: mark `models` and `credentials` ✅ with test
  counts/coverage/deps; bump the "18 of 22" tally to **20 of 22**.
- Run `/syncing-docs` (owns provenance re-stamp, doc counts, impl count, doc-exports,
  reference index, markdown lint).
- Add a work log under `docs/logs/` (`/writing-work-logs`).
- Commit as Conventional Commits: `feat: add aws/models submodule`,
  `feat: add aws/credentials submodule` (minor bumps), plus `docs:` reconciliation.
  Then `/creating-prs`.

## Verification checklist

- [ ] `/starting-work` run; on a `feat/aws-credentials` branch (not `main`).
- [ ] `@aws-sdk/client-sts` + `@aws-sdk/credential-providers` in `dependencies`;
      lockfile updated; `pnpm check:deps` green.
- [ ] `aws/models` green + barrel-wired **before** credentials work (blocking gate met);
      filesystem verified directly.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all pass.
- [ ] Coverage ≥ 80%/file verified from `coverage/coverage-final.json` (not the text table).
- [ ] All four review spokes clean, `security-reviewer` explicitly PASS; must-fixes applied.
- [ ] Spec pages document all field shapes + the 7th export; `check:doc-exports` /
      `check:scaffold` / `check:api` green.
- [ ] `aws/index.ts` re-exports `models` + `credentials`; `AWS.M3LAWSCredentialsManager`
      importable from `@m3l-automation/m3l-common`.
- [ ] `implementation-status.md` shows 20 of 22; `/syncing-docs` clean; work log added.
- [ ] Manual smoke: `new AWS.M3LAWSCredentialsManager({ profile })` +
      `ensureValidCredentials()` against a real profile validates via STS and triggers
      `aws sso login` on an expired session (or mocked equivalent in tests).
