# Agent-operator evolution — exploratory design and decision wave

**Status: shipped** — PR `feat/agent-operator-docs` (V1 of the programme).

## Context

Immediately after the CLI-first decision wave (ADR-0053…0057, PR #522), the
user asked for the same exploratory-design treatment for the successor:
LLM/agent integration — AI agents (Claude via AWS Bedrock) using the m3l
CLI to perform the same operations and decisions as a human user, replacing
the human for daily repetitive tasks.

Two parallel evidence tracks ran: a five-facet `/auditing` fan-out
(decision landscape, machine-consumable CLI surface, Bedrock readiness,
autonomy guardrails, in-repo agent prior art — 20 agents, adversarial
verification) and a four-facet `/researching-anthropic-guidance` pass
(tool design for agents, MCP server design, autonomous-agent safety,
Claude on Bedrock — 27 official sources, persisted as
`docs/research/agent-cli-integration.md`). Key findings: ADR-0039 is a
gate whose named-consumer condition this programme satisfies; the CLI's
headless surface is real but lacks a structured result channel; the
target-graded destructive gate exists in the library yet ADR-0048
explicitly disclaims being an authorization control; and neither history
(ring buffer) nor run-report (sensitive crash-dump class) can serve as an
agent audit trail.

## Approach / Decisions

A two-round maintainer interview settled every fork:

- **Phased architecture** over MCP-only, script-only, or a built-in
  `m3l agent` command: Stage 1 repo-native (`aws/bedrock-runtime` wrapper +
  loop primitives + `scripts/agent-operator`), Stage 2 a runtime MCP
  surface in a new `packages/m3l-mcp` (SDK as its own dep; CLI stays
  zero-dep), Stage 3 headless/scheduled.
- **AWS Bedrock** as the model-access binding (Messages API, client-side
  tools, existing SSO chain).
- **Policy-graded autonomy**: read-only auto; non-sensitive mutations auto
  within allowlist+budget; ADR-0048-sensitive always human-approved;
  ungraded targets default to sensitive (A2 retrofit prerequisite noted).
- **Dedicated append-only decision log** (names-never-values, loud write
  failure) registered as a third artifact class in ADR-0035's taxonomy.
- **All four named workloads**: fleet health checks first, then preset
  ETL, log triage, and queue reconciliation via `m3l flow` (post-U10).
- **V-series** tracker identity reusing the registered m3l-cli section
  (keys `impl:cli:v*`, Capability type — zero sync-code/label changes).
- Authoring-time resolutions: loop primitives live in `aws/bedrock-runtime`
  until a second provider is named (ADR-0009 direction rules); policy
  layer is a Core module (two consumers: script + MCP); secrets delivery
  and remote MCP stay gated behind future ADRs.

## Outcome

Shipped as V1: ADR-0058…0063 + index rows; Update blocks on ADR-0039
(gate fired) and ADR-0035 (decision-log artifact class); ADR-0030
amendment (dev-time vs runtime MCP split); the programme plan
`docs/plans/2026-08-20-agent-operator.md` (V1–V12); V-series rows in
IMPLEMENTATION.md + a sync-skipped ROADMAP wave subsection; filing-work
legend → A/B/C/U/V-series; the research snapshot + its README row. All 40
`pnpm verify` steps green; `sync:hub-issues` dry-run previews 11 new
V-issues with clean keys and zero collisions.
