# 0061. Agent decision log: an append-only audit artifact class

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

An autonomous operator needs an audit trail answering "which agent decided
what, under which policy verdict, with what outcome and cost" — durably,
after the fact. The audit confirmed neither existing artifact can be that
record:

- The CLI **history** is a best-effort 100-entry ring buffer storing
  parameter names and exit codes; overwrite-on-cap and never-fatal
  semantics are right for a convenience view and wrong for an audit trail.
- **`run-report.json`** is classified by ADR-0035's 2026-07-23 Update as a
  sensitive crash-dump-class artifact with best-effort redaction — the
  wrong exposure class to lean on as the authoritative agent record, and
  it exists per script run, not per agent decision (denied or escalated
  actions produce no run at all).

## Decision drivers

- **Every verdict must be recorded, including the ones that never run** —
  `denied` and `escalate` decisions are the audit trail's most important
  entries.
- **Non-sensitive by construction**: the record must be safe to retain and
  read broadly, so it carries parameter **names, never values** (the same
  stance history and presets already take).
- **Append-only, durable**: an agent must not be able to shrink or rewrite
  its own trail; rotation may segment the stream but never silently drop
  it.
- One artifact class serving both agent surfaces (script loop and MCP).

## Considered options

1. **Extend history + run-report with agent fields.** Rejected: inherits
   the ring buffer's overwrite semantics and the crash-dump sensitivity
   classification — the two problems the audit flagged.
2. **Full observability stack (decision log + OTel-style export).**
   Rejected as the first step: the CISO-guide end state, but heavy; the
   export layer can be a later, gated addition reading the same log.
3. **A dedicated append-only decision-log artifact class.** Chosen.

## Decision

We chose **option 3**. The library (alongside ADR-0060's policy module —
one Core home, settled at implementation V6/V7) gains an agent decision-log
writer producing a new artifact class:

- **Location**: a cross-run append-only JSONL stream under
  **`data/agent-log/`** (workspace-anchored via `M3LExecutionEnvironment`,
  gitignored like all `data/`). Cross-run — not per-run under
  `data/output/<startedAt>/` — because the trail's value is the sequence of
  decisions across runs, and because denied/escalated actions have no run
  directory.
- **Entry schema** (one JSON object per line): timestamp; **agent
  identity** — logical agent name (config-declared, required), model id,
  and the AWS principal/profile when resolvable; the tool/script and
  operation acted on; parameter **names never values**; the ADR-0060
  policy verdict (`auto-approved` / `escalate` / `denied`) plus the rule
  that produced it; the outcome (exit code / registry name / dry-run flag)
  when a run happened; and token/cost figures from ADR-0059's accounting.
- **Semantics**: append-only; write failure is **loud** (a named error that
  fails the action's eligibility for `auto-approved` — an unauditable
  action escalates), unlike history's best-effort stance; rotation is
  size/age-segmented with segments retained, never truncated in place.
- **Classification**: registered as a third artifact class in ADR-0035's
  taxonomy (dated Update block on ADR-0035, same change set):
  non-sensitive by construction, distinct from the run report (sensitive
  crash dump) and breadcrumbs.

## Consequences

- **Positive:** the programme's autonomy claim becomes reviewable — every
  agent decision, including refusals, is one grep away; the
  names-never-values stance keeps the log safe to retain; loud-write
  semantics mean autonomy degrades to escalation rather than running
  unaudited.
- **Negative / trade-offs:** a second per-action write path (log + report)
  with its own tests; unbounded-ish growth managed only by segmentation
  (acceptable for a single-maintainer fleet; an export/retention layer is
  the recorded later step); "append-only" is filesystem-honest, not
  cryptographically tamper-evident (recorded as out of scope).
- **Semver impact:** none from this ADR (docs only). Implementation is an
  **additive minor** on `m3l-common`.

## Links

- Programme: [ADR-0058](./0058-agent-operator-programme.md). Verdict
  source: [ADR-0060](./0060-agent-policy-layer.md). Cost figures:
  [ADR-0059](./0059-bedrock-runtime-wrapper-and-loop-primitives.md).
- Taxonomy: [ADR-0035](./0035-failure-reporting-and-diagnostics.md) (its
  2026-08-20 Update registers this class).
- Research: [`docs/research/agent-cli-integration.md`](../research/agent-cli-integration.md).
