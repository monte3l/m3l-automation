# 0060. Agent policy layer: graded autonomy as a real authorization control

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

[ADR-0048](./0048-target-graded-destructive-confirmation.md) is explicit
about what the destructive gate is not: "an operator-safety prompt, not an
authorization control" — anyone who can pass the opt-in can bypass it, and
no downstream decision may treat a passed gate as proof of entitlement.
That honesty is exactly the problem for an autonomous operator: an agent
holding `--yes`/`--yes-sensitive` flags has no safety layer at all, only a
disabled prompt.

The audit confirmed nothing in the repo bounds what an autonomous operator
may do: no allowlist of scripts/operations, no budget or rate limits
(ADR-0025 itself notes the repo has "no token/cost governance of any
kind"), no machine-approvable vs human-only distinction, no dry-run-first
discipline. Official guidance (research snapshot: secure-deployment doc,
CISO guide, autonomy research) converges on least-privilege allowlists,
budget/iteration ceilings, and approval positioned at high-stakes actions.

## Decision drivers

- **The agent's authority must be declared, tested, repo-owned data** — not
  harness configuration, not the absence of a prompt.
- **Ride, never reinterpret, ADR-0048's grades**: target sensitivity is the
  gate's vocabulary; the policy layer adds authorization on top, it does
  not turn the safety prompt into an entitlement check.
- **Two consumers exist** (the W5 promotion bar): the agent-operator script
  (Stage 1) and the MCP surface (Stage 2) both need identical enforcement.
- **Fail closed**: an operation the policy cannot classify must escalate,
  not proceed.

## Considered options

1. **Policy local to `scripts/agent-operator`.** Rejected: the MCP surface
   would re-implement it, and script-local policy is config of one consumer
   rather than a tested library contract.
2. **Rely on ADR-0048's gate plus harness permissions.** Rejected: the gate
   disclaims authorization by design, and harness config is outside the
   repo's test surface.
3. **A library-owned policy module consumed by every agent surface.**
   Chosen.

## Decision

We chose **option 3**. `m3l-common` gains an agent policy module (Core
namespace; final name and count movement settled at implementation, V6)
that evaluates every intended agent action **before** it is attempted and
returns a typed verdict: `auto-approved`, `escalate` (human approval
required), or `denied`. Contract bounds:

- **Declared allowlist** — which scripts, and which declared operations
  (richer once ADR-0055's declarative operations ship), the agent may
  invoke at all. Absence from the allowlist is `denied`.
- **Autonomy tiers** — read-only/introspection actions: `auto-approved`;
  mutations on non-sensitive targets inside the allowlist and budget:
  `auto-approved`; mutations on ADR-0048-**sensitive** targets: always
  `escalate` — the policy layer never emits the `yesSensitive` bypass on
  its own authority.
- **Conservative default for ungraded targets**: until a script has
  adopted ADR-0048 target grading (the codified-wave A2 retrofit, still
  open), any mutation through it is treated as **sensitive** — grading
  opts a target _down_ to auto-approvable, never up. This is what makes A2
  a soft prerequisite instead of a blocker.
- **Budgets and rate caps** — per-run and per-day invocation counts, token
  and (Bedrock) cost ceilings, and a loop-iteration ceiling; exhaustion is
  `escalate`, surfaced as a named outcome, never a silent stop.
- **Dry-run-first** — the first execution of a mutating script+parameter
  shape in a run must be a dry-run whose outcome the agent inspects before
  the real run is eligible for `auto-approved`.
- Every verdict is recorded in the agent decision log (ADR-0061) with the
  policy rule that produced it.

Policy is **declared data** (config-schema-validated, preset-storable) so a
deployment's authority grant is reviewable in one place.

## Consequences

- **Positive:** the repo finally has an authorization control where
  ADR-0048 deliberately is not one; both agent surfaces enforce identical,
  tested bounds; "legible and bounded" autonomy per the CISO-guide framing;
  the ungraded-target default lets the programme proceed ahead of A2
  without weakening anywhere.
- **Negative / trade-offs:** one more Core module to document and test; a
  policy layer is only as good as its declaration — a maintainer who
  allowlists everything and raises every ceiling has re-created the status
  quo (accepted: single-maintainer repo, the point is legibility);
  dry-run-first doubles invocations for first-seen mutations.
- **Semver impact:** none from this ADR (docs only). Implementation is an
  **additive minor** on `m3l-common`.

## Links

- Programme: [ADR-0058](./0058-agent-operator-programme.md). Verdict sink:
  [ADR-0061](./0061-agent-decision-log.md). Enforced by both
  [ADR-0059](./0059-bedrock-runtime-wrapper-and-loop-primitives.md)'s loop
  and [ADR-0062](./0062-runtime-mcp-surface.md)'s surface.
- Rides: [ADR-0048](./0048-target-graded-destructive-confirmation.md)
  (target grades + the authorization disclaimer this ADR answers),
  [ADR-0055](./0055-declarative-operation-introspection.md) (operation
  vocabulary, soft dependency).
- Research: [`docs/research/agent-cli-integration.md`](../research/agent-cli-integration.md).
