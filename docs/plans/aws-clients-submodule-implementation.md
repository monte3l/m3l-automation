# Plan: implement the AWS `clients` submodule

## Context

`@m3l-automation/m3l-common` has **18 of 22** submodules implemented and reviewed.
The four not-started are `core/script`, `aws/models`, `aws/credentials`, and
`aws/clients` — the AWS namespace barrel (`src/aws/index.ts`) is still an empty
`export {}`. The audit confirmed `aws/clients` is **technically unblocked**: it
resolves credentials via `@aws-sdk/credential-provider-ini`'s `fromIni()`
directly (not through the unbuilt `aws/credentials` manager), and its
dependencies `core/errors`, `core/config`, and `core/logging` are all shipped.
The one hard blocker in the spec — `AWSProvider`'s `script.aws` facade — is
handled by building `AWSProvider` standalone now and letting `core/script`
consume it later.

Confirmed decisions:

- **Scope:** build `aws/clients` standalone; defer `aws/models`, `aws/credentials`, and the `script.aws` wiring.
- **Client surface:** enumerated lazy getters for **S3, DynamoDB, STS**.
- **SDK deps:** declare `@aws-sdk/*` as hard `dependencies` (the `undici` pattern).
- **Error class:** add `M3LAWSClientError` (chaining SDK failures via `cause`) and update the spec, since the library mandates a typed `M3LError` hierarchy.
- **`AWSProvider`:** build now as a standalone facade exposing a `clients` getter; `core/script` wires it in when built.

Corrected audit noise: an Explore agent flagged `src/core/index.ts` as
re-exporting a non-existent `script` submodule (a "build failure"). Verified
false — there is no `./script/index.js` export line; `script` appears only in the
docstring prose. The repo is green.

## 1 — Run `/starting-work` (MUST be first)

This plan writes `packages/m3l-common/src/**` and `**/tests/**`, which
`guard-branch-isolation.mjs` blocks while `HEAD` is `main`. Run `/starting-work`
to settle location / branch / PR / push before any file is written. Expected:
new branch `feat/aws-clients` off `main`, land via PR.

## 2 — Update the spec (contract-first)

Before tests, reconcile `docs/reference/aws/clients.md` with the confirmed design
so the TDD contract is authoritative:

- Enumerate the exposed service-client getters: `s3`, `dynamoDB`, `sts`.
- Document `M3LAWSClientError` (its `code` literal, when it is thrown, `cause` chaining).
- State where `AWS_REGION` is exported and how a per-provider `region` option overrides it.
- Note `AWSProvider` is standalone now, consumed by `core/script` later.
- Touch `docs/reference/aws/models.md` only if a shared client-option type is introduced (otherwise leave models untouched — keep option shapes local to `clients`).

## 3 — Add AWS SDK runtime dependencies

Add to `packages/m3l-common/package.json` `dependencies` (pin exact versions like
the existing `undici`/`csv-parse` entries) and refresh the lockfile via
`pnpm install` (never hand-edit `pnpm-lock.yaml`):

- `@aws-sdk/client-s3`
- `@aws-sdk/client-dynamodb`
- `@aws-sdk/client-sts`
- `@aws-sdk/credential-provider-ini`

Use Context7 to confirm the current AWS SDK v3 major and the `fromIni()` /
per-service-client API before pinning. `check:deps` must stay green.

## 4 — Implement the submodule (TDD hub-and-spoke via `implementing-submodules`)

New directory `packages/m3l-common/src/aws/clients/`, one symbol per file
(follows the `core/network` layout):

- `constants.ts` — `AWS_REGION` (`'eu-south-1'`).
- `M3LAWSClientError.ts` — `extends M3LError`, `override readonly code = "ERR_AWS_CLIENT" as const`, forwards `{ cause }`; local (unexported) options interface.
- `AWSClientProvider.ts` — single-profile provider. Constructor `{ profile?, region? }`; `fromIni({ profile })` when a profile is given, else the SDK default chain; lazy `s3`/`dynamoDB`/`sts` getters caching each client on first access; `close()` calls `.destroy()` on every cached client. Wrap SDK construction/credential failures in `M3LAWSClientError`.
- `AWSMultiClientProvider.ts` — `{ profiles }`; dedupe profile names on construction into a map of `AWSClientProvider`; `mapParallel<T>(fn)` (rejects on any throw) and `mapParallelSettled<T>(fn)` (per-profile results/errors, never throws — reuse `M3LResult`/`ok`/`err` from `core/errors`).
- `AWSProvider.ts` — standalone facade; lazily instantiates sub-provider(s) from its options and exposes a `clients` getter.
- `index.ts` — barrel re-exporting `AWSClientProvider`, `AWSMultiClientProvider`, `AWSProvider`, `AWS_REGION`, `M3LAWSClientError`.

Then surface the submodule through the namespace barrel — add
`export * from "./clients/index.js";` to `packages/m3l-common/src/aws/index.ts`
(no new `exports` subpath; `./aws` already exists).

Pipeline: `spec-conformance-reviewer` (seed contract from the updated spec) →
`test-author` (RED) → `submodule-implementer` (GREEN) → review spokes
(`code-reviewer`, `type-design-analyzer`, `silent-failure-hunter`,
`security-reviewer` — AWS/credential surface, and `spec-conformance-reviewer`
again). Hub applies must-fixes between rounds.

### Tests — `packages/m3l-common/tests/clients.test.ts`

`vi.mock` the `@aws-sdk/*` packages; assert lazy construction + caching (client
built once, reused), `close()` destroys clients, `fromIni` vs default-chain
selection by presence of `profile`, region defaulting/override, profile
dedup, `mapParallel` rejects on throw while `mapParallelSettled` collects
errors, and `M3LAWSClientError` wraps SDK failures with `cause` preserved. Add
`expectTypeOf` assertions where the getter/option types are the contract.
Per-file coverage ≥ 80%.

## 5 — Reconcile docs (`/syncing-docs`)

- Bump `docs/implementation-status.md`: **18 → 19 of 22**; flip the `clients` row to ✅ with a notes line (exports, test count, deps); update the intro sentence's implemented list.
- Re-stamp provenance, verify doc/impl/test counts, confirm every new export is documented, regenerate the reference index, run markdown lint.
- Write a `docs/logs/2026-07-03-aws-clients.md` work log via `/writing-work-logs`.

## 6 — Commit & PR

Conventional Commits (`feat: add aws/clients submodule` → minor; a `feat(deps)`
or `build(deps)` for the SDK deps; `docs:` for the reconciliation). Signed
commits. Open the PR with `/creating-prs`; the mandatory `claude-pr-review` gate
must PASS before merge.

## Verification checklist

- [ ] `/starting-work` ran; working on `feat/aws-clients`, not `main`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all green.
- [ ] `clients.test.ts` covers happy + failure paths for all 5 exports; per-file coverage ≥ 80%.
- [ ] `import { AWS } from "@m3l-automation/m3l-common"` exposes `AWS.AWSClientProvider`, `AWS.AWSMultiClientProvider`, `AWS.AWSProvider`, `AWS.AWS_REGION`, `AWS.M3LAWSClientError`.
- [ ] `check:deps`, `check:api`, `check:exports`, `check:scaffold`, `check:index` pass (no new `exports` subpath; `pnpm-lock.yaml` updated by pnpm).
- [ ] `docs/implementation-status.md` reads 19 of 22; provenance/counts/index reconciled; work log written.
- [ ] PR opened; `claude-pr-review` verdict PASS.
