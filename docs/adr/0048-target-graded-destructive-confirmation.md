# 0048. Grade the destructive confirmation by target, not only by action

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

`Core.confirmDestructive` (`core/prompt/M3LDestructiveGate.ts`) is the fleet's
confirm-before-destroy gate, promoted in the W5 pass from a step duplicated across
several scripts. It now has **15 call sites across 11 consumer scripts**
(`api-gateway-client`, `cloudformation-stacks`, `codepipeline-ops`,
`dynamodb-crud`, `ecs-ops`, `eks-ops`, `eventbridge-schedules`, `lambda-ops`,
`rds-data-sql`, `s3-objects`, `sqs-etl`), and it is also the gate phase of
`M3LOperationPipeline`.

A security-shaped reading of that gate found a gap. `M3LConfirmDestructiveOptions`
declares exactly `{ prompt, logger, description, yes, code }` — it keys entirely on
**what the action is**, and carries no notion of **what the action is pointed at**.
Meanwhile `M3LScript` resolves an `aws.profile` / `aws.region` pair
(`M3LScript.ts:969`, `:1034`) and every consumer script in the fleet reaches real
AWS through it.

The consequence: deleting an object in a scratch account and deleting the same
object in a production account produce an **identical** prompt, and a single
`--yes` flag bypasses both **identically**. The gate expresses how dangerous the
verb is; it cannot express how dangerous the blast radius is. In an automation
fleet whose stated failure mode is "wrong thing done to production infrastructure",
that is the wrong axis to be graded on alone.

## Decision drivers

- **The gate is the last brake.** Everything downstream of a confirmed
  `confirmDestructive` is a real, usually irreversible AWS mutation.
- **`--yes` exists for good reasons** — unattended and batch use — and must keep
  working for routine targets, or it will be worked around.
- **Additive only.** Eleven scripts and one engine call this function; a change
  that forces all of them to move at once is not acceptable.
- **Never invent authorization.** This is an operator-safety prompt, not an access
  control; it must not be mistaken for one.
- **Fail at the earliest honest moment** — a nonsensical flag combination should be
  rejected when it is parsed, not after the run has begun doing work.

## Considered options

1. **Leave the gate action-only** and rely on operators pointing at the right
   profile. Rejected: it is the status quo, and it makes the most consequential
   dimension of a destructive action invisible to the one mechanism designed to
   stop it.
2. **Make the target-sensitivity check a per-script concern**, each script deciding
   before it calls the gate. Rejected: this is precisely the duplication the W5
   promotion removed, it would reappear across 11 scripts, and the decision would
   drift between them.
3. **Add an optional target dimension to `confirmDestructive`**, with a
   sensitivity policy and a distinct opt-in for sensitive targets. Chosen.
4. **Block sensitive targets outright.** Rejected: the library cannot know which
   targets a maintainer is legitimately entitled to mutate, and an unconditional
   block would simply be routed around.

## Decision

We chose **option 3**.

`confirmDestructive` gains an **optional** target dimension: the caller supplies
the resolved target identity (profile, region, and where it is already cheaply
available, the account id) together with a sensitivity policy that classifies it.

The behavioural contract:

- **No target supplied → byte-identical to today.** All 15 existing call sites keep
  their current behaviour until they opt in, and the pipeline gate phase is
  unchanged.
- **Non-sensitive target → today's path**, including the plain `yes` bypass.
- **Sensitive target → the prompt is escalated and states the target**, so the
  operator confirms against the blast radius rather than the verb alone.
- **A sensitive target is not bypassable by the plain `yes` flag.** Bypassing one
  requires a separate, explicitly named opt-in. This is the load-bearing half of
  the decision: a flag added for convenience on routine work must not silently
  carry the same authority on the most consequential target.
- **A bypass on a sensitive target is always logged as a warning**, naming the
  target, so the run report records that it happened.

### Parse-time rejection of unsafe combinations

Adopted in the same change: an unsupported or unsafe flag combination fails **when
flags are parsed**, with a message naming the supported alternative — rather than
being accepted and failing somewhere downstream, or worse, proceeding. A mode that
is not available should say so at the boundary, not produce a confusing failure
after work has started.

### What this is not

This is an **operator-safety prompt, not an authorization control**. It does not
authenticate, does not consult IAM, and can be bypassed by anyone who can pass the
opt-in. It reduces the chance of an accident; it does not defend against an
adversary, and no downstream decision may treat a passed gate as proof of
entitlement. The existing display-escaping contract on `description` is unchanged.

## Consequences

- **Positive:** the fleet's last brake finally grades on blast radius; the most
  dangerous single keystroke in the system (`--yes` against production) stops being
  indistinguishable from the safest; adoption is incremental, script by script; and
  the parse-time discipline removes a class of late, confusing failures.
- **Negative / trade-offs:** callers must supply target identity to benefit, so the
  protection is opt-in and absent until each script is retrofitted; classifying a
  target as sensitive is a policy the caller owns, and a mis-declared policy gives
  false assurance; and operators running legitimate production work acquire one
  extra deliberate step.
- **Semver impact:** **additive minor.** New optional fields on an existing options
  interface and no change to default behaviour; the `exports` map is untouched.

## Links

- Related: [ADR-0035 (run reporting; the warning surfaces there)](./0035-failure-reporting-and-diagnostics.md),
  [ADR-0043 / `core/pipeline` (the gate phase that calls this function)](./0043-step-pipeline-engine-deferred.md),
  [ADR-0046 (the procedure engine, whose `decide` steps use the same prompt facade)](./0046-codified-procedure-engine.md).
- Capability reference: [`core/prompt`](../reference/core/prompt.md),
  [`core/pipeline`](../reference/core/pipeline.md).
- Implementation plan: `docs/plans/2026-08-18-codified-procedure-engine.md`.
