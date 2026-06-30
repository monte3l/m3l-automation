# Work log — `core/config` submodule (2026-06-30)

Implementation of the fourth library submodule, `@m3l-automation/m3l-common`
`core/config`, run end-to-end through the hub-and-spoke TDD pipeline. This log
records what shipped, what matched the plan, what diverged and why, and the
durable lessons for the remaining 18 submodules.

Plan of record:
[`docs/plans/core-config-implementation.md`](../plans/core-config-implementation.md).

## Summary

The `core/config` submodule is implemented, tested, reviewed, and green across
all quality gates.

- **8 public symbols:** `ConfigSchema<T>`, `ConfigValue`, `ConfigLoader`,
  `loadConfig()`, `validateConfig()`, `ConfigError`, `ConfigNotFoundError`,
  `ConfigValidationError`.
- Surfaced through the `Core` namespace barrel; the three-entry `exports` map
  (`.`, `./core`, `./aws`) is unchanged — **minor** release, no breaking change.
- **47 tests** written by `test-author` (211 across the full suite); 100%
  statement / branch / function / line coverage on `ConfigLoader.ts`;
  `typecheck`, `lint`, `build`, `check:api`, `check:scaffold`, and
  `check:provenance` all green.
- 4 review spokes ran: `spec-conformance-reviewer` (conformant),
  `security-reviewer` (secure; one advisory), `code-reviewer` (one must-fix
  applied), `type-design-analyzer` (8/10 encapsulation, 9/10 invariant
  expression).

## What went as planned

- The **hub-and-spoke TDD loop** executed as designed: contract extraction →
  RED → GREEN → parallel review. The hub never wrote `src/` or test code; spokes
  did the substantive work in isolation.
- **RED failed for the right reason** — `Cannot find module` on the missing
  import, not a test logic error.
- **GREEN was clean after one re-dispatch.** The first GREEN pass had a naming
  inconsistency (`loadSync` vs `loadConfigSync`) flagged by `code-reviewer` as a
  must-fix; the implementer applied the rename in a single follow-up round
  without requiring additional hub intervention.
- **Conformance came back conformant on the first pass.** All 8 documented
  symbols present with the correct signatures; barrel wiring correct.
- The **`exports` map was never touched**; `check:api` stayed green throughout.

## What didn't go as planned, and why

### 1. `ConfigValidationError.details` was under-constrained on first GREEN pass

The implementer typed the `details` field of `ConfigValidationError` as
`unknown` — a safe default under the project's no-`any` rule. The spec used the
phrase "validation details" without specifying a shape. The
`type-design-analyzer` flagged the field as under-constrained (encapsulation
8/10): callers cannot iterate or display the errors without a type assertion,
which defeats the purpose of a structured error type. A second implementer
dispatch was required to tighten the type to `Record<string, string[]>`.

**Why it happened:** The spec wording was ambiguous — "validation details" could
mean any structured payload. The implementer defaulted to `unknown` as the
conservative choice, which is correct under the rules, but incorrect for the
intended contract.

**Fix for future submodules:** When the spec mentions a structured error detail
field, front-load the expected shape explicitly in the implementer prompt (e.g.,
`details: Record<string, string[]>` — field name maps to the list of messages
for that field). Do not rely on the implementer inferring the shape from the
type name alone.

### 2. The provenance sidecar listed `ConfigSchema` as a type alias; the validator expected an interface

The first draft of the provenance sidecar described `ConfigSchema<T>` as a
`"type alias"` in the `kind` field. The `check:provenance` validator rejected it
because the implementation exported `ConfigSchema` as an `interface`, and the
validator enforces consistency between the sidecar's declared kind and the
symbol's actual TypeScript construct. The fix was a one-line edit.

**Why it happened:** The spec used "type" loosely — it described the shape
without distinguishing whether it would be implemented as a `type` alias or an
`interface`. The sidecar author defaulted to "type alias" (the more generic
term).

**Fix for future submodules:** During the contract phase, when a spec describes
a structural type, resolve the `type` vs `interface` distinction explicitly
before the provenance sidecar is authored. Prefer `interface` for object shapes
that consumers may extend or implement; reserve `type` aliases for union types,
branded primitives, and mapped types.

## Lessons learned

- **When a spec mentions a structured error detail field, specify the exact
  shape in the implementer prompt.** A field typed as `unknown` is always
  defensible under the project rules but usually under-serves callers who need
  to inspect the field programmatically. Tightening it requires an extra
  implementer dispatch; specifying it up front costs nothing.

- **Resolve `type` alias vs `interface` explicitly before authoring the
  provenance sidecar.** Loose spec language ("type", "shape", "definition") maps
  to different TypeScript constructs that the validator distinguishes. Use
  `interface` for extendable object shapes; use `type` for unions, branded
  scalars, and mapped types.

- **A naming-consistency must-fix is cheap when caught at review, expensive
  when shipped.** The `loadSync` → `loadConfigSync` rename was one round; the
  same rename on a published minor would require a deprecation cycle. Review
  spokes catching naming inconsistencies in the GREEN phase is the pipeline
  working correctly.

- **`security-reviewer` advisories on config value logging are worth recording
  even when the implementation is otherwise clean.** The advisory (logging raw
  config values may expose secrets) is not a defect — it is a constraint for
  future callers and script authors to respect. Any config-adjacent module
  (e.g. `core/env`, `aws/ssm`) should include a logging-redaction note in the
  implementer prompt as a pre-emptive guard.

- **Lessons from `core/errors`, `core/events`, and `core/security` that
  continued to hold:** running `pnpm lint` in-loop (no hub-gate lint failures),
  reading coverage from `coverage-final.json` (not the v8 text table), trusting
  the CLI over the LSP, and front-loading exact contract nuances into spoke
  prompts.
