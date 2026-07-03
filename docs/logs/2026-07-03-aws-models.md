# Work log — `aws/models` submodule (2026-07-03)

This log covers implementing `aws/models`, the first submodule of the `AWS`
namespace, through the `implementing-submodules` TDD hub-and-spoke pipeline
(spec-conformance contract → test-author RED → submodule-implementer GREEN →
parallel review → `/syncing-docs`). It records what shipped, what matched the
plan, the one divergence (a speculative runtime-freeze assertion that pulled the
implementation off the repo idiom), and the durable lessons.

## Summary

Shipped `aws/models` — a **dependency-free, types-only shared-vocabulary layer**,
built first per the documented build order (`aws/models → aws/credentials →
aws/clients`) because the credentials manager and client providers will import
its types. Five public exports, surfaced through the AWS namespace barrel
(`export * from "./models/index.js"`, replacing the `export {}` placeholder) — no
new `exports` subpath, so a `feat:` minor:

- `M3LAWSCredentialsErrorType` — a `const` object of 5 categories
  (`SSO_SESSION_EXPIRED`, `SSO_SESSION_INVALID`, `CREDENTIALS_PROVIDER_FAILED`,
  `PROFILE_NOT_FOUND`, `UNKNOWN`) + a same-named derived union type (not a TS `enum`).
- `M3LAWSCredentialsErrorAnalysis`, `M3LAWSRetryContext`, `M3LAWSLoginResult`,
  `M3LAWSCredentialsManagerOptions` — `readonly` interface shapes.

**Tests:** 29 in `tests/models.test.ts` (runtime value + `Object.keys` drift
guard + `expectTypeOf` type-level assertions); full suite 1699 passing.
**Coverage:** the sole runtime value is the const object; `index.ts` is excluded
from V8 instrumentation project-wide (`coverage.exclude: ["**/index.ts"]`), as
for other type-only barrels — not a coverage gap.
**Review (4 spokes, all PASS, zero Must-fix):** code-reviewer PASS (one
Should-fix routed to the hub, below); spec-conformance conformant (exactly 5
symbols, no drift); type-design 9/8/9/10 (union compile-verified as-narrow-as
the 5 literals); security PASS (no secret leakage, no raw-secret field, no SDK
import, no side effects).
**Gates:** `typecheck`, `lint`, `build`, `format`, `check:doc-counts`,
`check:doc-exports`, `check:impl-counts` (18 → 19 of 22), `check:test-counts`
(models 29), `check:index` (22 modules, 226 symbols), `lint:md`, and provenance
all green.
**Commits (worktree `aws-models` via `pnpm worktree:new`):** `dff114d` docs
(authoritative spec), `497334d` feat (implementation), `5295e48` docs (metadata
reconciliation).

## What went as planned

- **Audit correctly predicted the shape of the work** — the parallel Explore
  fan-out identified that `models` had to _own_ the type definitions (built
  first), that it was dependency-free, and that the scaffold seam (src dir, test,
  barrel line) did not yet exist. All confirmed during implementation.
- **RED failed for the right reason** — `Cannot find module
'../src/aws/models/index.js'`, not a logic error in the test assertions.
- **GREEN was clean on first pass** — the implementer delivered lint-clean,
  typecheck-clean code and drove the full suite green without a re-dispatch.
- **All four review spokes returned zero Must-fix** on the implementation logic;
  the type-design reviewer compile-verified the derived union is exactly the five
  literals (neither widened to `string` nor narrowed).
- **The const-object + same-named-union idiom transferred cleanly** from the
  in-repo reference (`core/config/M3LConfigParameterType.ts`) that the contract
  producer surfaced.

## What didn't go as planned, and why

### 1. A speculative `Object.isFrozen` test pulled the implementation off the repo idiom

The test-author added an assertion that `Object.isFrozen(M3LAWSCredentialsErrorType)`
is `true` — a runtime-freeze contract that was **not** in the spec or the
extracted contract. To make it pass, the implementer wrapped the object in
`Object.freeze(... as const)` instead of the bare `as const` used by every other
const-object in the codebase (`M3LConfigParameterType`, `M3LLogEventCategory`).
The code-reviewer flagged the deviation (PASS, but a Should-fix) and asked the
hub to make a conscious accept/revert decision. The hub surfaced it to the user,
who chose to revert to bare `as const` and drop the `isFrozen` test — a
coordinated two-spoke edit (implementer removed the freeze, test-author removed
the assertion), taking the count 30 → 29 tests.

**Why it happened:** The test-author invented a stronger invariant (runtime
immutability) than the contract specified, and the implementer then hardened the
code to satisfy the test — even though the contract producer had explicitly noted
the repo idiom is bare `as const`, not `Object.freeze`. A test asserting behavior
the contract never required steered the implementation away from the house style.

**Fix for future:** Tests should assert exactly the contract — no stronger. For a
const-object "enum replacement," assert the members and the `Object.keys` drift
guard, but do **not** assert `Object.isFrozen`; bare `as const` is the repo idiom
and it is compile-time only. If runtime freezing is genuinely wanted, that is a
project-wide convention decision for the hub, not a per-module test invention.

## Lessons learned

- **Don't assert beyond the contract** — a test that invents an invariant the
  spec never stated (here, runtime `Object.isFrozen`) drags the implementation
  off the house style to satisfy it. Assert exactly what the contract promises,
  no stronger. _(promoted → .claude/agents/test-author.md)_
- **Const-object enums use bare `as const`** — the repo idiom for an "enum
  replacement" (`M3LConfigParameterType`, `M3LLogEventCategory`) is a bare
  `as const` object + same-named derived union, compile-time only. Do not add
  `Object.freeze` for one module without a project-wide decision.
  _(promoted → .claude/agents/test-author.md)_
- **A first-in-namespace module sets precedent** — the first AWS submodule is
  where a stray one-off pattern (a lone `Object.freeze`) would make siblings look
  inconsistent by omission. Surface such "new pattern in a new namespace" choices
  to the hub rather than resolving them unilaterally in a spoke.
- **Own-the-types resolves a circular spec** — when a "shared vocabulary" page
  defers all field definitions to its consumers and they point back, the
  build-first module must become the authoritative definition site. Rewriting
  `models.md` with field tables (and flipping `credentials.md` to reference it)
  removed the circularity the audit flagged and gave the contract producer a
  single unambiguous page.
- **Types-only modules reframe the failure path** — with no functions and no
  thrown errors, "happy + failure path per export" collapses to runtime-value
  assertions on the one const object plus `expectTypeOf` negative type
  assertions (rejecting an out-of-union string / a wrong shape). `silent-failure-hunter`
  is correctly skipped (no error/async paths); `security-reviewer` still runs
  because the surface is under `aws/`, and confirmed a clean types-only layer.
