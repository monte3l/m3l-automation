# Work log — `core/config` submodule (2026-06-30)

This log covers the implementation of the `core/config` submodule for `@m3l-automation/m3l-common`. The work ran through the standard hub-and-spoke TDD pipeline: spec-conformance-reviewer seeded the contract, test-author wrote failing tests (RED), submodule-implementer made them pass (GREEN), and four review spokes verified quality. It records what shipped, what matched the plan, what diverged from expectations, and the durable lessons that should feed into the next submodule prompt.

Plan of record: [`docs/plans/core-config-implementation.md`](../../docs/plans/core-config-implementation.md)

## Summary

**Public symbols shipped (8):** `ConfigSchema<T>`, `ConfigValue`, `ConfigLoader`, `loadConfig()`, `validateConfig()`, `ConfigError`, `ConfigNotFoundError`, `ConfigValidationError`

**Tests:** test-author wrote 47 tests for this module; full suite is now 211 tests.

**Coverage (V8, `ConfigLoader.ts`):** 100% statements / 100% branches / 100% functions / 100% lines.

**CI gates:** `typecheck` ✓ · `lint` ✓ · `build` ✓ · `check:api` ✓ · `check:scaffold` ✓ · `check:provenance` ✓

**Review spoke verdicts:**

| Spoke                     | Verdict                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- |
| spec-conformance-reviewer | Conformant — all documented symbols present and correctly typed                     |
| security-reviewer         | Secure — one advisory: avoid logging raw config values at INFO level                |
| code-reviewer             | One must-fix resolved: renamed `loadSync` → `loadConfigSync` for naming consistency |
| type-design-analyzer      | Encapsulation 8/10 · Invariant expression 9/10                                      |

## What went as planned

- **Hub-and-spoke TDD loop executed as designed.** The pipeline ran in the expected order (spec seed → RED → GREEN → review) with no phase skipped or collapsed.
- **RED failed for the right reason.** The test suite exited with `Cannot find module` rather than a logic error in the test code itself, confirming the tests were written against the contract and not accidentally passing.
- **GREEN was clean after one re-dispatch.** The first GREEN pass delivered lint-clean, typecheck-clean code; the only re-dispatch was triggered by a naming inconsistency (`loadSync`) flagged by code-reviewer, which was resolved in a single round.
- **Spec-conformance check passed on first pass.** No missing symbols, no drifted signatures — the implementer stayed within the documented contract without requiring a correction cycle.

## What didn't go as planned, and why

### 1. `ConfigValidationError.details` typed as `unknown` instead of `Record<string, string[]>`

The implementer typed the `details` field on `ConfigValidationError` as `unknown` as a conservative default. The type-design-analyzer flagged this as under-constrained, noting that callers cannot meaningfully consume the field without a cast. A second implementer dispatch was required to tighten the type to `Record<string, string[]>`.

**Why it happened:** The spec used the phrase "validation details" without specifying the shape of the data structure. The implementer, choosing safety over specificity, defaulted to `unknown`.

**Fix for future:** When the spec mentions a structured error detail field, front-load the expected shape explicitly in the implementer prompt (e.g. "the `details` field MUST be typed as `Record<string, string[]>`"). Do not leave shape resolution to the implementer's judgment.

### 2. Provenance sidecar listed `ConfigSchema` as a type alias; the validator expected an interface

The first draft of the provenance sidecar described `ConfigSchema<T>` as a "type alias", but the provenance validator requires the distinction between type aliases and interfaces to be precise. One edit was needed to correct the classification.

**Why it happened:** The spec used the word "type" loosely to mean either a type alias or an interface, and the sidecar author followed the spec's imprecise language.

**Fix for future:** In the contract phase, explicitly distinguish "type alias (`type X = …`)" from "interface (`interface X { … }`)" for every exported symbol. This removes ambiguity for both the implementer and the provenance sidecar author.

## Lessons learned

- **Front-load structured error detail shapes in the implementer prompt.** "Validation details" is not a type. When a spec describes a structured field on an error class, include the exact TypeScript type in the prompt — `Record<string, string[]>`, `string[]`, etc. — to avoid an under-constrained implementation and a second dispatch.

- **Distinguish type alias vs interface at the contract phase.** Spec language like "a `Config` type" is ambiguous. The contract produced by spec-conformance-reviewer should explicitly label each exported symbol as `type alias`, `interface`, `class`, or `function`. This keeps the implementer, the sidecar author, and the provenance validator aligned without a correction round.

- **A smooth RED → GREEN → review pipeline is reproducible.** The one re-dispatch in GREEN was driven by a naming inconsistency, not a logic error or a missed contract. This confirms that seeding the implementer with an exact naming table (function names, method names, parameter names) from the spec-conformance output eliminates the most common class of re-dispatch.

- **Security advisory on config value logging is a standing concern.** The security-reviewer flagged logging raw config values as an advisory (not a blocker) in this module. Any future config-adjacent module (e.g. `core/env`, `aws/ssm`) should include a logging-redaction note in the implementer prompt as a pre-emptive guard.
