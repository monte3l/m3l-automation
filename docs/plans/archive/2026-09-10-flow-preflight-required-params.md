# A pre-flight parameter-resolution check for `m3l flow run`

**Status: shipped** — one PR (`fix/flow-preflight-required-params`),
resolving issue #883. ADR-0101 records the design and amends ADR-0056.

## Context

Issue #883 reported that `m3l flow`'s validator checked a step's
`parameters` keys in one direction only — rejecting an undeclared key, but
never checking that every parameter a target script marks **required**
would actually have a value. A flow could validate cleanly and fail
mid-run, after earlier steps had already run real side effects (an SQS
queue drained before a step failed on a missing table name). The issue
itself proposed a load-time validator rule rejecting a step whose
`parameters` omitted a `required: true` descriptor.

## Approach / Decisions

Exploration disproved the issue's own proposed fix before any code was
written: a step's `parameters` is only the first of several places a
script resolves a required value from (argv → environment → default →
`asyncFallback`), and every AWS-touching script relies on an ambient
`AWS_PROFILE` for `aws.profile` — a load-time rule would reject flows
that run correctly today, including the shipped `dlq-reconcile.yaml`,
whose own header documents exactly this reliance. That finding was put to
the user directly; the confirmed redirect was a **pre-flight resolution
check at run start** instead of a load-time validator rule, covering
conditional per-operation (ADR-0055) requirements too, delivered in one
PR.

- **Design**: `checkFlowPreflight` (`flow/preflight.ts` +
  `flow/preflight-supply.ts`) resolves, from script descriptors alone —
  never live config resolution, which would execute `validate` callbacks
  and await `asyncFallback` — whether each required parameter would be
  supplied by the step's own `parameters` (mirroring `flow/step.ts`'s
  execution-mode-dependent argv-emission rule exactly), a declared
  default, or the environment (`Core.M3LEnvironmentConfigProvider`,
  reused rather than re-implemented). Deliberately **fail-open** on
  uncertainty — the inverse of `flow/validate.ts`'s fail-closed posture —
  because an env-file blind spot and an unresolvable conditional selector
  degrade to an advisory warning (`report.unverified`) rather than a
  refusal; only what is provably unsatisfiable refuses the run
  (`report.missing`).
- **TDD hub-and-spoke loop**: RED/GREEN pairs for the error code, the pure
  check module, and the `commands/flow.ts` wiring; a dedicated acceptance
  pass proving both shipped flow definitions pass the check under the
  strictest possible context (`env: {}`, no readable `.env` file for any
  script) — the critical regression gate, with an explicit instruction to
  stop and investigate rather than force it green if either flow failed.
  Both passed with zero `missing` and zero `unverified` findings.
- **Review pass** (code-reviewer, silent-failure-hunter,
  type-design-analyzer, run in parallel against the landed module) found
  two genuine HIGH-severity silent-failure gaps — an unknown-script
  `?? []` fallback and a malformed ADR-0055 descriptor silently dropped,
  both converting an uncertain state into a false "clean" result instead
  of routing to the module's own `unverified` warning tier — plus a
  taxonomy issue three reviewers converged on independently (an
  unreachable exhaustiveness-guard branch reusing the operator-facing
  refusal code). All three fixed; lower-severity type-design nits (a
  single-call-site invariant, a private-only anti-pattern) deferred as
  documented follow-ups per "smallest change that satisfies the task."
- New `ERR_CLI_FLOW_PREFLIGHT_FAILED` at exit 2 — matching the exit class
  `ERR_CONFIG_MISSING` would exit with later, mid-run, just earlier and
  with nothing executed.

## Outcome

`pnpm verify`'s full pipeline (lint, typecheck, build, coverage-gated
tests, knip, `check:command-catalog`, and every `check:*` governance gate)
passed clean. `packages/m3l-cli`'s test suite: 1706/1706 passing. Both
shipped flow definitions needed no changes. `docs/reference/cli.md` gained
a pre-flight paragraph in the `m3l flow` section, an author-facing note in
§ Flows, and an exit-code table entry; ADR-0101 records the design and
amends ADR-0056 with a reciprocal `amended-by` relation.

Deliberately out of scope, recorded in ADR-0101's Consequences: a flow
step naming an unknown operation on a selector is not reported by this
check (a different, undesigned check would own that); `dynamodb-crud`'s
`REQUIRED_FIELDS` runtime guard and its ADR-0055 metadata are a mirrored
constant with no drift guard the check's correctness now depends on.
