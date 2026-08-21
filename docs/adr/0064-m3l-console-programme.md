# 0064. m3l console programme: a full-stack operations console

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

The CLI-first programme (ADR-0053…0057) made the repo one CLI-first product;
the agent-operator programme (ADR-0058…0063) made it operable by AI agents.
The maintainer has named the third front: **the m3l console** — a full-stack
application for monitoring, operations, and troubleshooting on AWS
services/resources, with a graphical interface that launches tasks and
spawns scripts at the press of a button, interactive drill-down workflows
(canonically: list SQS queues → dump one → view pretty JSON → select field
values → query DynamoDB by those keys → decide how to proceed), and
comprehensive persistent logging of every user action plus the
application's own self-monitoring.

A five-facet audit (2026-08-20, adversarially verified) fixed the ground
truth: the baselines provide exactly the right _seams_ (the commandModule
hybrid execution contract, structured run envelopes, policy verdicts, the
decision log, the flow engine, intent-grouped MCP tools) but **no HTTP
server, daemon pattern, run registry, push/streaming channel, session
state, frontend toolchain, or containerization exists anywhere** — every
current surface is batch CLI, stdio MCP, or Lambda. The drill-down
scenario is additionally blocked on an sqs-etl list-queues operation that
does not exist and on the inter-step artifact convention ADR-0047/0056
deferred to U10.

This ADR records the programme's direction, package shape, staging, and
gate registry; each mechanism is its own decision (ADR-0065…0071).

## Decision drivers

- **Decoupled, containerized, service-oriented** is the maintainer's
  stated lean — weighed against a single-maintainer operational budget.
- **Consume the seams, don't fork them**: the console must be the third
  consumer of the ADR-0054 execution contract and of the ADR-0060/0061
  policy/audit machinery, not a parallel stack.
- **Standing invariants survive**: m3l-cli stays zero-dependency,
  m3l-common stays minimal-dependency, ADR-0029's script boundary is
  untouched; new capability lands in new packages with their own
  dependency budgets (the m3l-mcp precedent).
- **Gated broadening**: every speculative extension (microservices,
  multi-user, cloud database) is a recorded gate, not a day-one build.

## Considered options

1. **Full microservices from day one** (gateway + run/session/audit
   services + frontend). Rejected: the audit found zero service
   infrastructure exists — every cross-cutting concern would be built
   before the first button works, and the drill-down's session state
   becomes a distributed-state problem immediately; org-scale costs
   without org-scale benefits for one maintainer.
2. **Single deployable** (server also serves the SPA). Rejected as the
   _decision_ (weakest fit to the decoupling lean) but retained as a
   valid interim packaging: the chosen shape can ship this way first.
3. **Modular service core + separate frontend, two containers.** Chosen.

## Decision

We chose **option 3**. Two new workspace packages, following m3l-mcp's
governance-registration precedent (own dependencies allowed):

- **`packages/m3l-console-server`** — the HTTP API and service core:
  run orchestration, workbench sessions, human-action audit and
  self-telemetry, policy integration — internally split into **hard
  module boundaries** (runs / sessions / audit / policy adapters) so any
  module can later become its own service without redesign
  (microservice-READY, deliberately not split; ADR-0065).
- **`packages/m3l-console-web`** — the React SPA (ADR-0067).

The mechanism decisions: server architecture and execution integration
(ADR-0065), the REST + SSE API contract (ADR-0066), the frontend stack
with its scoped bundler exception (ADR-0067), workbench sessions and the
addressable-artifact/data-binding convention (ADR-0068), embedded
persistence via `node:sqlite` (ADR-0069), human-action audit,
self-observability, and the display-vs-persist exposure model (ADR-0070),
and containerized local-first deployment (ADR-0071).

**Staging** (detail in
[`docs/plans/2026-08-20-m3l-console.md`](../plans/2026-08-20-m3l-console.md)):
foundation (server skeleton, persistence, the sqs-etl list-queues fleet
gap) → first end-to-end value (run orchestration, web skeleton, the
run-launcher MVP — spawn-first, so nothing waits on U7) → the flagship
drill-down (sessions, the SQS scenario as e2e acceptance) → hardening
(audit, telemetry, containers, session→flow export).

**Gate registry** (recorded here; nothing opens by implication):
remote/multi-user deployment behind a future OIDC-posture ADR (X14);
the microservice split behind ADR-0065's trigger (X15); Aurora table
migration behind ADR-0069's trigger (X16); console packages'
publish-set membership deferred to an ADR-0057 Update at decision time.

**Tracker identity**: the **X-series** (X1–X16) in
`docs/plans/IMPLEMENTATION.md`'s registered m3l-cli build-out section
(keys `impl:cli:x*`, Capability type — zero sync-code or label changes),
with a coarse ROADMAP wave subsection.

**Cross-programme edges**: U3/U6/U7 are hard prerequisites only for the
_in-process_ execution path (spawn works for all fourteen scripts from
day one); U4/U8 soften into richer UI forms when they land; **U10
consumes ADR-0068's binding convention** (a deliberately reversed
dependency, recorded in ADR-0056's Update); V6/V7 integrate with an
escalate-by-default posture until they ship; the W-series is untouched.

## Consequences

- **Positive:** the fleet gains a human-facing product with the same
  policy, audit, and execution contracts as the CLI and the agent — three
  consumers now justify every promoted seam; the decoupled two-container
  shape honours the maintainer's lean at single-maintainer cost; every
  speculative expansion has a named gate.
- **Negative / trade-offs:** the repo's first browser dependency tree
  materially grows the Dependabot/license-policy surface (ADR-0007/0036 —
  process unchanged, volume up); its first long-running process and first
  served UI create operational surface (supervision, drain, retention)
  that batch scripts never had; two more workspace packages to govern.
- **Semver impact:** none from this ADR (docs only). Console packages are
  new, private, unpublished 0.x; `m3l-common` changes only where a phase
  records an additive minor.

## Links

- Mechanisms: [ADR-0065](./0065-console-server-architecture.md),
  [ADR-0066](./0066-console-api-rest-sse.md),
  [ADR-0067](./0067-console-frontend-stack.md),
  [ADR-0068](./0068-workbench-sessions.md),
  [ADR-0069](./0069-console-embedded-persistence.md),
  [ADR-0070](./0070-console-audit-and-observability.md),
  [ADR-0071](./0071-console-containerization-deployment.md).
- Baselines consumed: [ADR-0054](./0054-command-module-contract-and-hybrid-execution.md),
  [ADR-0060](./0060-agent-policy-layer.md),
  [ADR-0061](./0061-agent-decision-log.md),
  [ADR-0056](./0056-cross-script-orchestration-engine.md),
  [ADR-0062](./0062-runtime-mcp-surface.md) (package-precedent),
  [ADR-0063](./0063-cli-structured-run-results.md).
- Plan: [`docs/plans/2026-08-20-m3l-console.md`](../plans/2026-08-20-m3l-console.md).

## Update (2026-08-21): tracker identity re-homed by ADR-0073

The Tracker identity note above recorded the X-series under keys
`impl:cli:x*` with `Capability` type and "zero sync-code or label changes".
[ADR-0073](0073-hub-board-classification-and-hierarchy.md) supersedes that: the
X-series moves to its own `## m3l console wave (X-series)` section under keys
`impl:console:x*` (old keys retained as `legacyKeys`), and its rows take the
layer-based Issue Types — `Package capability` for X2/X3/X4/X6/X7/X8/X9/X13,
`UI` for X10/X11, `Infrastructure` for X12/X14/X15/X16, `Fleet retrofit` for
X5, and `Governance` for X1. Programme scope, phasing, and the deferral
conditions on X14–X16 are unaffected.
