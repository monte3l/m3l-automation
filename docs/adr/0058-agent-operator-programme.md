# 0058. Agent-operator programme: staged AI-agent operation of the m3l fleet

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

The CLI-first programme (ADR-0053…0057) turns the repo into one CLI-first
product. The maintainer has named its successor: **AI agents — Claude,
accessed through AWS Bedrock — operate the m3l CLI to perform the same
operations and decisions a human user performs today**, replacing the human
for daily repetitive tasks.

A five-facet audit (2026-08-20, adversarially verified) plus an
official-Anthropic-guidance research pass
([`docs/research/agent-cli-integration.md`](../research/agent-cli-integration.md))
established the starting position: the CLI already has a genuine headless
machine surface (run/dynamic dispatch, `--json` introspection, verbatim
registry exit codes, `run-report.json`, dry-run), but no structured result
channel at the CLI layer, no runtime-agent contract anywhere, zero Bedrock
precedent in the library, and a safety surface that is real (target-graded
destructive gate, redaction, cancellation) yet explicitly **not** an
authorization control (ADR-0048's own disclaimer). ADR-0039 declined a
speculative Bedrock invoker but recorded the activation path — a named
consumer call-site — which this programme now provides.

This ADR records the programme's direction, stages, and scope; each
mechanism is its own decision (ADR-0059…0063).

## Decision drivers

- **The intake gates are satisfied, not bypassed** (ADR-0021/0037/0039):
  four named daily workloads exist (below), and ADR-0059 is built against
  the named consumer call-site ADR-0039 asked for.
- **Existing boundaries must survive**: ADR-0029 (scripts depend only on
  m3l-common), ADR-0027 (typed AWS wrappers), the CLI's zero-runtime-
  dependency invariant, minimal library dependencies.
- **Official guidance** (research snapshot): intent-grouped few tools;
  approval at high-stakes actions with least-privilege allowlists, budgets,
  and boundary-level audit; Bedrock hosts Claude behind the Messages API
  with client-side tools only.
- **Autonomy must be bounded by policy the repo owns and tests**, not by
  harness configuration alone.

## Considered options

1. **MCP-surface only** — all agent logic in an external harness (Claude
   Code / Agent SDK on Bedrock); the repo builds only tools. Rejected as the
   whole answer: the repo would own no agent, policy enforcement would live
   in harness config rather than tested code, and scheduled daily operation
   would mean scheduling harness sessions.
2. **Repo-native agent only** — a consumer script owns the loop; no MCP.
   Rejected as the whole answer: it forecloses interactive operation of the
   fleet from Claude Code/desktop and any future cloud-hosted agent.
3. **Built-in `m3l agent` command first.** Rejected: it puts a model-client
   dependency inside the zero-dependency CLI; a thin alias that spawns the
   agent-operator script stays possible later under any other option.
4. **Staged: repo-native operator first, MCP surface second, headless
   third.** Chosen.

## Decision

We chose **option 4**. Three stages:

1. **Stage 1 — repo-native operator.** `m3l-common` gains the
   `aws/bedrock-runtime` typed wrapper and tool-use loop primitives
   (ADR-0059 — fires ADR-0039's gate), an **agent policy layer**
   (ADR-0060) and an **agent decision log** (ADR-0061). A new consumer
   script, **`scripts/agent-operator`**, runs the policy-gated tool-use
   loop; its tools are m3l CLI operations consumed through the documented
   machine surface, completed by ADR-0063's structured run results.
   ADR-0029 holds — the script depends only on m3l-common.
2. **Stage 2 — runtime MCP surface.** A new workspace package
   **`packages/m3l-mcp`** (ADR-0062) exposes intent-grouped m3l operations
   to any MCP client (Claude Code / Agent SDK on Bedrock included), stdio
   first. Distinct from the dev-time repo-maintenance MCP server
   (ADR-0030's amendment records the split).
3. **Stage 3 — headless/scheduled operation.** cron/EventBridge-triggered
   agent-operator runs under policy, budget, and the decision log.

**Model access** is AWS Bedrock via the typed wrapper and the existing
SSO/`AWSClientProvider` credential chain — no new credential machinery.

**Autonomy is policy-graded** (ADR-0060): read-only operations fully
autonomous; non-sensitive mutations auto-approved within a declared
allowlist and budget; ADR-0048-sensitive targets always require human
approval.

**Named first workloads** (the intake-gate consumers, in adoption order):

1. **Fleet health checks** — `m3l doctor` + per-script dry-runs, `--json`
   read, anomaly summaries (read-only; first).
2. **Data ETL runs** — routine preset-parameterised runs of the ETL scripts.
3. **Log triage & analysis** — cloudwatch-logs-insights interpretation
   (relates to, but does not depend on, W7/B2's codified procedure).
4. **Queue reconciliation** — triggering and supervising the ADR-0056
   `m3l flow` (after U10 ships).

**Deliberately gated behind future ADRs** (recorded here so neither is
opened by implication): a **secrets-delivery mechanism** beyond argv/.env
(prerequisite for unattended Stage 3 with secret-bearing scripts), and
**remote/HTTP MCP transport** (ADR-0062 records the gate).

**Tracker identity.** The programme is the **V-series** (V1–V12) in
`docs/plans/IMPLEMENTATION.md`'s registered m3l-cli build-out section (keys
`impl:cli:v*`, Issue Type Capability — no sync-code or label changes), with
a coarse ROADMAP subsection; detail in
[`docs/plans/2026-08-20-agent-operator.md`](../plans/2026-08-20-agent-operator.md).

**Relationship to other programmes.** Independent of the U-series except
one hard edge (the queue-reconciliation workload needs U10's flow engine)
and one soft edge (declarative operations, U4/U8, enrich the agent's tool
schemas). The codified-procedure wave's A2 retrofit is the prerequisite for
fleet-wide sensitivity grading (ADR-0060 defines the conservative default
until then). W7/B2 remain uncoupled.

## Consequences

- **Positive:** "replace the human for daily repetitive tasks" gets a
  staged, gate-clean path where every stage is independently shippable; the
  agent's authority is bounded by repo-owned, tested policy rather than
  external configuration; both operating modalities (repo-native scheduled
  operator, interactive external harness) are served.
- **Negative / trade-offs:** two integration surfaces to document and
  maintain (script loop + MCP package); the repo owns a bounded tool-use
  loop (ADR-0059 records why that is acceptable against Agent-SDK-first
  guidance); Stage 3 waits on the gated secrets-delivery decision.
- **Semver impact:** none from this ADR (docs only). Library phases are
  additive minors recorded in their own ADRs.

## Links

- Mechanisms: [ADR-0059](./0059-bedrock-runtime-wrapper-and-loop-primitives.md),
  [ADR-0060](./0060-agent-policy-layer.md),
  [ADR-0061](./0061-agent-decision-log.md),
  [ADR-0062](./0062-runtime-mcp-surface.md),
  [ADR-0063](./0063-cli-structured-run-results.md).
- Gates fired/applied: [ADR-0039 (LLM out-of-scope — Update block)](./0039-llm-integration-out-of-scope.md),
  [ADR-0021](./0021-post-1.0-deepen-first-strategy.md) /
  [ADR-0037](./0037-deepen-first-re-read-against-consumer-pull.md).
- Baseline: [ADR-0053 (CLI-first programme)](./0053-cli-first-evolution-programme.md),
  [ADR-0056 (`m3l flow`)](./0056-cross-script-orchestration-engine.md),
  [ADR-0048 (destructive gate — the disclaimer ADR-0060 answers)](./0048-target-graded-destructive-confirmation.md).
- Research: [`docs/research/agent-cli-integration.md`](../research/agent-cli-integration.md).
- Plan: [`docs/plans/2026-08-20-agent-operator.md`](../plans/2026-08-20-agent-operator.md).

## Update (2026-08-21): tracker identity re-homed by ADR-0073

The Tracker identity paragraph above recorded the V-series under keys
`impl:cli:v*` with Issue Type `Capability` and "no sync-code or label changes".
[ADR-0073](0073-hub-board-classification-and-hierarchy.md) supersedes that: the
V-series moves to its own `## Agent-operator wave (V-series)` section under keys
`impl:agent-operator:v*` (old keys retained as `legacyKeys`), and its rows take
the layer-based Issue Types — `Library capability` for V4–V7,
`CLI capability` for V2/V3, `Consumer script` for V8/V9, `Package capability`
for V10, `Infrastructure` for V11/V12, and `Governance` for V1. Programme scope
and phasing are unaffected.
