# 0101. Pre-flight parameter-resolution check for `m3l flow run`

- **Status:** Accepted
- **Relations:** amends: 0056
- **Date:** 2026-09-10
- **Deciders:** repo maintainer; Claude (design synthesis)

## Context and problem statement

[Issue #883](https://github.com/monte3l/m3l-automation/issues/883) reported a
gap in `m3l flow`'s validator: it
checks a step's `parameters` keys in one direction only — every key the
definition declares must be one the target script accepts — but never the
reverse, that every parameter the script marks **required** will actually
have a value. A flow can therefore omit a required parameter, validate
cleanly at `m3l flow run` start, and fail mid-run, after earlier steps have
already executed real side effects (an SQS queue drained, a table written).
The issue was found by mutation-testing the shipped acceptance flow's own
test: deleting a required parameter from `data/config/flows/sqs-roundtrip.yaml`
was caught only by that test's own value-identity assertion, not by
`loadFlowDefinition`, which did not throw.

The issue's own proposed fix — reject at load time when a step's
`parameters` omits a `required: true` descriptor — does not hold up. A
step's `parameters` is only the **first** of several places a script
resolves a required value from (`M3LScriptConfigLoader`'s provider chain:
argv → config files → environment → `defaultValue` → `asyncFallback`), and
the second tier is not exotic: every AWS-touching script declares
`aws.profile` as `required: true`, and the environment provider derives
`AWS_PROFILE` from it (`deriveEnvVarName`). A fail-closed load-time rule
would reject flows that run correctly today — and the repo already
documents exactly this. `data/config/flows/dlq-reconcile.yaml`'s own header
states that a step may omit `aws.profile` and rely on the inherited
`AWS_PROFILE`, with the stricter, all-steps-must-agree rule enforced by a
**consumer**-side verifier (`scripts/agent-operator/src/lib/flow-definitions.ts`),
deliberately not by the engine itself.

## Decision drivers

- **Deliver the issue's actual value** — refuse a run before any step's side
  effect, not merely move a validation rule around.
- **No false positives.** A parameter genuinely resolvable from the
  environment, a declared default, or (unseen by this check) a script's own
  `.env` file must never cause a working flow to be refused.
- **Stay inside `m3l flow`'s established layering.** `flow/validate.ts` is
  pure and fail-closed by design (ADR-0056's format contract); a rule that
  depends on process state (the environment) does not belong there.
- **No `m3l-common` public-API change.** `Core.M3LConfigParameterDescriptor`
  already carries `required`, `defaultValue`, and `operations`
  (ADR-0055) — everything a descriptor-based check needs except
  `asyncFallback`, which is not descriptor-visible. Adding a field for it
  would be a semver event for a case no shipped script currently uses.

## Considered options

1. **Load-time validator rule** (the issue's own proposal). Rejected: proven
   above to produce false positives against the ambient-environment pattern
   the engine already relies on, and against ADR-0085's secret-parameter
   design (a `secret: true` required parameter can **only** be supplied
   through the environment — a load-time rule checking `parameters` would
   reject every flow that uses one correctly).
2. **Live config resolution per step** (drive the real
   `M3LConfigSchema`/`M3LConfigParameter.resolveAsync` machinery). Rejected:
   it would execute a parameter's `validate` callback and await its
   `asyncFallback` — the network-capable tier — which defeats a check whose
   entire purpose is avoiding a side effect before the operator has
   committed to the run. It is also structurally unavailable on a cache hit:
   `commands/flow.ts`'s discovery cache serves descriptors from
   `data/cache/m3l-cli/discovery.json` without ever importing the script's
   `config.ts` module, and the CLI's own loader
   (`Core.loadScriptConfigDescriptors`) reads only the `configParameters`
   export, never `configValidators`.
3. **A pre-flight resolution check, run once at `m3l flow run` start, before
   step 1** — descriptor-based, fail-**open** on uncertainty. Chosen.

## Decision

`m3l flow run` performs a new check, `checkFlowPreflight`
(`packages/m3l-cli/src/flow/preflight.ts`), after the definition validates
and (on `--resume`) after the resume record itself is confirmed valid, but
before any step executes. For every step **reachable** from the run's start
point (a fixed point over `onSuccess`/`onFailure`/`onPartial`, scoped to the
resume point under `--resume` so an already-completed step is never
re-checked), it resolves — from descriptors alone, never live config
resolution — whether each parameter the target script marks required would
be supplied by:

1. the step's own `parameters`, under the exact same execution-mode-dependent
   emission rule `flow/step.ts` uses to build a spawned child's argv (a
   `false`/`null`/empty-array value supplies nothing on the spawn path, but
   does on the `in-process` path, which never builds argv at all);
2. a declared `defaultValue`;
3. the environment (`Core.M3LEnvironmentConfigProvider`, so the derived
   `AWS_PROFILE`-style lookup and canonical-name/alias resolution are
   exercised through the real production code, not re-implemented);
4. a **conditional** per-operation requirement (ADR-0055), when the step
   pins its selector (`command`, `operation`) to a literal string naming a
   declared operation — vacuous under the exact same conditions the real
   runtime validator (`deriveOperationValidators`) is vacuous under, so this
   check is never stricter than the mechanism it predicts.

**The posture is deliberately fail-open, the inverse of `flow/validate.ts`'s
fail-closed one**, because the two guard different things: a committed file
versus a machine's ambient state. Anything the check cannot resolve with
certainty — a required parameter that might be supplied by a script's own
`.env` file (loaded into a spawned child's process, invisible to this
check), or a conditional selector the step gives no value for — is reported
as an advisory warning on stderr (`report.unverified`) and the run proceeds.
Only what is **provably** unsatisfiable refuses the run
(`report.missing` → `rejectFlowPreflight`, throwing `M3LCliError` coded
`ERR_CLI_FLOW_PREFLIGHT_FAILED`). A false refusal here would block a flow
that would have run correctly off an ambient `AWS_PROFILE` or a script-local
`.env` — a regression on a shipped, documented pattern — which is a strictly
worse outcome than the late failure this check exists to prevent.

`--dry-run` does **not** skip the check: a dry run still spawns every step,
and each step's own config load would otherwise fail on exactly this
condition, just later — skipping the check would gut the rehearsal
`docs/reference/cli.md` already tells operators to use.

**Exit code 2**, matching `ERR_CONFIG_MISSING`'s own exit class
(`origin: "caller"` → `CONFIG_USAGE`) — a pre-flight refusal reports the
same code the run would have exited with later, mid-run, just earlier and
with nothing executed.

Both shipped flow definitions (`sqs-roundtrip.yaml`, `dlq-reconcile.yaml`)
were verified against the check under the strictest possible context —
`env: {}`, no readable `.env` file for any script — and pass with zero
`missing` and zero `unverified` findings: every required parameter either
flow's scripts need is supplied by the definition itself.

## Consequences

- **Positive:** the issue's motivating scenario — a multi-step flow that
  drains a real queue before failing on a missing table name — is now caught
  before step 1 runs, with an aggregated report naming every offending step
  and parameter in one pass. Conditional (ADR-0055) requirements are covered
  too, closing the whole class the issue named, not just the unconditional
  half. The two shipped flows needed no changes.
- **Negative / trade-offs:** the check has two acknowledged blind spots by
  design — a script's own `.env` file, and a parameter's `asyncFallback` —
  neither of which this module can see without either executing untrusted
  resolution logic or widening a public `m3l-common` type. The `.env` case
  degrades to a warning; the `asyncFallback` case is currently safe only
  because no script declares one, pinned by a test that fails the moment one
  is added, at which point this ADR's "no descriptor field" trade-off should
  be revisited.
- **Semver impact:** none. No `m3l-common` export changes. `m3l flow run`
  gains a new refusal mode — a behaviour change to the CLI, not to any
  public library API — and a new `M3LCliErrorCode` member
  (`ERR_CLI_FLOW_PREFLIGHT_FAILED`), which is CLI-internal.
- **Follow-ups, deliberately out of scope here:** a flow step naming an
  unknown operation on a selector is not reported by this check (a
  different, undesigned check would own that); `dynamodb-crud`'s
  `REQUIRED_FIELDS` runtime guard and its `DYNAMO_OPERATION_DECLARATIONS`
  ADR-0055 metadata are a mirrored constant with no drift guard, which this
  check's correctness now depends on staying in sync.

## Links

- Amends: [ADR-0056](./0056-cross-script-orchestration-engine.md) (the `m3l
flow` engine this check runs inside).
- Related: [ADR-0055](./0055-declarative-operation-introspection.md)
  (conditional per-operation requirements), [ADR-0085](./0085-cli-secret-delivery-via-spawn-env.md)
  (why a secret required parameter can only be supplied through the
  environment), [ADR-0035](./0035-failure-reporting-and-diagnostics.md) (the
  exit-code registry `ERR_CLI_FLOW_PREFLIGHT_FAILED` joins).
