# 0065. Console server architecture and execution integration

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

`packages/m3l-console-server` is the repo's first long-running process:
it must accept HTTP requests, orchestrate script runs concurrently, hold
workbench-session state, and write audit/telemetry — none of which the
batch-shaped `M3LScript` world provides (the audit confirmed: no daemon
pattern, no run registry, no concurrent-run management anywhere). This
ADR decides how the server is built and how it executes scripts; the
wire contract it speaks is ADR-0066's decision.

## Decision drivers

- **Microservice-ready without microservice cost**: the maintainer's
  decoupling lean, at single-operator operational budget.
- **Third consumer, not a fork**: execution must reuse the ADR-0054
  hybrid seam; policy (ADR-0060) and the decision log (ADR-0061) must
  apply to console-initiated actions identically.
- **Minimal dependencies** even inside the console's own budget.
- **The CLI and the console coexist** on one workspace's `data/`.

## Considered options

1. **Separate services per module from day one.** Rejected (ADR-0064's
   comparison): all cost, no single-operator benefit.
2. **Unstructured monolith.** Rejected: forecloses the recorded split
   gate and invites the coupling the module boundaries exist to prevent.
3. **Modular monolith with guard-enforced internal boundaries.** Chosen.

## Decision

We chose **option 3**.

- **Modules with hard boundaries** — `runs` (orchestration + registry),
  `sessions` (ADR-0068), `audit` (ADR-0070 writers), `policy`
  (ADR-0060/0061 adapters), `http` (transport only) — enforced with the
  repo's existing dependency-direction-guard pattern (an ESLint
  restricted-paths zone per module, the ADR-0009 mechanism). The
  **microservice-split gate (X15)**: unbundle a module only when
  multi-instance or independent-scaling pressure is demonstrated; until
  then the boundaries are the architecture.
- **Execution — the ADR-0054 hybrid seam's third consumer**: interactive
  and streaming operations run **in-process** via a script's
  `commandModule` (direct parameter binding; ADR-0049 `AbortSignal`;
  output port → the SSE stream); batch runs **spawn**
  `scripts/<name>/dist/main.js` exactly as `m3l run` does, preserving the
  exit-code + run-report contract. Until U6/U7 land the console is
  spawn-only — fully functional for all fourteen scripts, with live
  output degraded to spawn log-tailing.
- **Policy and audit are non-optional**: every console-initiated
  execution passes an ADR-0060 verdict check and lands in the audit
  surfaces (ADR-0070 human-action audit; the ADR-0061 decision log where
  the action is agent-adjacent). Until V6/V7 ship, the posture is
  **escalate-by-default**: mutations require the operator's explicit
  confirmation step; the seam is designed now, wired to the library when
  it exists.
- **Concurrency**: a run registry (ADR-0069 store) tracks every
  console-initiated run; default **one concurrent run per script**
  (per-script mutex) with a configurable global cap; submissions beyond
  a bounded queue are rejected loudly, never silently dropped. CLI-side
  runs of the same script are outside the registry's control — safe at
  the artifact level (per-run timestamped directories) and recorded as
  an advisory limitation.
- **Registry vs `m3l history`**: console runs write the same script-owned
  `data/output/<startedAt>/` artifacts, but the console's queryable run
  registry is its own record; `m3l history` remains CLI-invocation
  history and does not ingest console runs. One workspace `data/`
  anchor, two invocation histories, each owned by its surface.
- **HTTP core — `node:http` + a small internal router**, no framework:
  the API is bounded (REST + SSE, ADR-0066) and the repo's zero-to-
  minimal dependency culture holds inside the console's budget too.
  **Recorded fallback**: adopt a minimal routing framework (as the
  console-server's own dependency, never m3l-common's) if SSE lifecycle
  or routing ergonomics demonstrably force it during X2–X4 — a dated
  Update here, not a silent drift.
- **Server lifecycle**: health/readiness endpoints; graceful drain on
  shutdown — stop accepting, cancel in-flight runs through the ADR-0049
  signal as an ordinary caller (outcomes resolve to the existing
  `interrupted` classification), flush audit writers, close the store.
  **ADR-0049 is consumed unchanged**; if implementation finds a missing
  library seam, that is a flagged m3l-common decision, not an implicit
  widening.

## Consequences

- **Positive:** the execution contract gains its third consumer with
  zero new execution machinery; module boundaries make the future split
  a refactor, not a redesign; the server core stays dependency-lean and
  fully testable with the existing Vitest setup.
- **Negative / trade-offs:** a hand-rolled router is repo-owned code a
  framework would have provided (bounded by the recorded fallback);
  one backend failure domain until X15 fires; two invocation histories
  (CLI vs console) is a documented, deliberate asymmetry.
- **Semver impact:** none from this ADR (docs only). X2–X4 build a new
  private package; `m3l-common` is untouched unless a flagged seam
  decision lands separately.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Wire contract:
  [ADR-0066](./0066-console-api-rest-sse.md). Store:
  [ADR-0069](./0069-console-embedded-persistence.md).
- Consumed seams: [ADR-0054](./0054-command-module-contract-and-hybrid-execution.md),
  [ADR-0060](./0060-agent-policy-layer.md),
  [ADR-0061](./0061-agent-decision-log.md),
  [ADR-0049](./0049-cooperative-cancellation-contract.md),
  [ADR-0009](./0009-dependency-direction-guard.md) (the boundary
  mechanism reused).
