# W4 `api-gateway-client` vertical slice (2026-07-17)

**Status: shipped** (PRs #149, #152, and the `api-gateway-client` script PR)

## Context

`/starting-work` was invoked to build "m3l-common submodules for the W3–W5
consumer fleet." Exploration of `main` (post ADR-0031, PR #143) found the
W3–W5 library surface nearly empty: W3 needs zero new submodules (every
`AWSClientProvider` getter it needs already ships), and across W4 the only
net-new library unit is `aws/signing`. The user chose to target W4
`api-gateway-client` end-to-end, full TDD to a shippable gated PR.

A second finding reshaped the scope mid-exploration: `api-gateway-client`'s
spec (§7.3 of the archived `2026-07-09-consumer-scripts-implementation-plan.md`
— request specs carry method + body template, plus batch-POST ETL) could not
run on `Core.M3LHttpClient` as it stood — GET-only, headers fixed at
construction. That gap was a second library prerequisite (the deferred D4
"`M3LHttpClient` POST enhancement" row). The user chose "all three, done
properly": a three-unit, dependency-ordered build rather than narrowing scope.

## Approach / Decisions

- **Unit A — `core/network`:** extended `M3LHttpClient` with a general
  `request<T>()`/`requestAbortable<T>()` (arbitrary method, per-request
  headers, body, configurable `expectedStatus`), keeping `get()`/`getAbortable()`
  as thin wrappers so the existing GET-only contract stayed behavior-identical.
  Shipped as PR #149, merged 2026-07-16.
- **Unit B — `aws/signing`:** a new AWS submodule (`M3LRequestSigner`) wrapping
  `@smithy/signature-v4` behind a `node:crypto` SHA-256/HMAC adapter (avoiding
  a heavier `@aws-crypto/*` dependency), plus a lazily-cached `requestSigner`
  getter on `AWSClientProvider`. Two review-round fixes hardened it: repeated
  query-string keys were being collapsed to their last value, and a
  caller-supplied `host` header could win over the computed hostname
  (signature/target mismatch). Shipped as PR #152, merged 2026-07-17.
- **Unit C — `scripts/api-gateway-client`:** the consumer script itself,
  consuming both A and B. Built in the `m3l-automation-api-gateway-w4` linked
  worktree once A and B had merged, so it branched cleanly off a fresh
  `origin/main` instead of stacking on unmerged dependencies. Full TDD
  RED→GREEN→4-spoke-review pipeline (`code-reviewer`,
  `spec-conformance-reviewer`, `silent-failure-hunter`, and a mandatory
  `security-reviewer` — the one fleet script that touches raw credentials).
- The review fan-out surfaced a real security finding beyond documentation
  polish: an absolute-URL `path` in a `batch` mode JSONL record silently
  overrode `baseUrl`, so a malicious/malformed batch input could route the
  signed SigV4/`x-api-key` credential to an arbitrary origin. Fixed with an
  origin-equality guard evaluated before any auth-header resolution or
  dispatch, rejecting the record to `failed.jsonl` with
  `reason: "path-origin-mismatch"` instead. `silent-failure-hunter` also
  caught a genuine CRITICAL: the per-record failure write to `failed.jsonl`
  was itself unguarded, so a disk-write failure while persisting one record's
  failure could escape uncaught and abort the whole bounded-concurrency batch
  via `M3LConcurrencyPool`'s fail-fast `runEach` — defeating the module's own
  documented per-record-isolation contract. Both were fixed and independently
  re-verified PASS by fresh instances of the same reviewer roles before push.
- A drafted contract-page claim — that the `apiKey` secret would be
  "registered in the script's `M3LSecretsSpecifier` so config diagnostics
  redact it" — was corrected before tests were written against it:
  `M3LSecretsSpecifier` exists as a classification-only utility but isn't
  wired into `M3LScript` or its logger anywhere in the codebase, so no value
  is redacted automatically. The contract now states the secret-never-logged
  guarantee is enforced by discipline in `resolve-auth-headers.ts`, not a
  library guarantee — and a follow-up security finding (S2: `apiKey` remains
  resolvable via a CLI flag despite the doc's ".env-only" convention, since
  the config system has no per-parameter source restriction) was recorded as
  an accepted, out-of-scope library limitation rather than patched around at
  the script level.

## Outcome

All three units shipped. `api-gateway-client` supports `none`/`api-key`/`iam`
(SigV4) auth, single-request and bounded-concurrency batch modes
(`Core.M3LConcurrencyPool`), a destructive-gate on mutating HTTP verbs, and a
`failed.jsonl` re-drive convention with distinct failure reasons
(`path-origin-mismatch`, `output-write-failed`) so operators don't accidentally
resend an already-successful mutating call. 81 tests across 7 files. No
`src/`, test, or `exports`-map changes to the published library from this
script PR — the two library units (A, B) were each additive-minor through
their respective namespace barrels with the three-entry `exports` map
unchanged. The other eight W3–W5 scripts (`s3-objects`, `lambda-ops`,
`ecs-ops`, `cloudformation-stacks`, `codepipeline-ops`,
`eventbridge-schedules`, `athena-query`, `eks-ops`) and the W5
library-promotion pass remain greenfield, tracked live in `docs/ROADMAP.md`
and `docs/plans/IMPLEMENTATION.md`.
