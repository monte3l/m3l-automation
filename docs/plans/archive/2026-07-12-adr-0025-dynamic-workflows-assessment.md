# Dynamic workflows: research, audit, and ADR-0025 assessment (2026-07-12)

**Status: shipped** (PR #113, commit b4d91b6)

## Context

The user asked for Anthropic's official best practices on orchestrating
subagents at scale with **dynamic workflows** — the Claude Code Workflow
primitive, where a JavaScript script deterministically orchestrates subagents
(`agent()`, `parallel()`, `pipeline()`) and only the work inside each
`agent()` call is model-powered — and whether/how the repo should adopt them.
This is distinct from the repo's existing model, where the hub dispatches
spokes turn-by-turn from prose playbooks in `.claude/skills/*/SKILL.md`. The
work ran as an audit → plan: web research via 5 Explore agents against
official Anthropic sources, then a repo audit reconciling the findings
against the live agent-operating model. No `src/`, test, or config code was
written — the deliverable was an assessment.

## Approach / Decisions

- Applied Anthropic's own decision rule verbatim: use a dynamic workflow when
  orchestration logic is expressible as deterministic code; stay
  agent-driven when the orchestrator must reason about each intermediate
  result. The repo's hub loop (reads spoke output, decides next step, updates
  trackers) is correctly agent-driven and was _not_ forced into a script.
- Verdict: **selective / moderate value, not transformative.** Genuine wins
  are confined to mechanical, high-fan-out, repeatable slices — chiefly the
  `auditing` skill's Explore fan-out, which is a textbook parallelization
  case and the best fit for Anthropic's recommended quality upgrade:
  **encoded adversarial verification** (independent agents refute each
  other's findings before they're reported).
- Recommended first pilot (documented, not built): the `auditing` fan-out +
  adversarial verification — highest value, lowest src-write risk.
- Recommended adoption governance, framed as prerequisites rather than
  built in this pass: (a) validate `.claude/workflows/**` model/effort
  choices against the MODEL-MATRIX the way `.claude/agents/` already is;
  (b) a token/agent-count guardrail (reference: the >25-agent / >1.5M-token
  warning threshold); (c) any src/test-writing fan-out must use
  `isolation: "worktree"` (ADR-0013) to satisfy `guard-branch-isolation.mjs`;
  (d) a per-step model/effort convention, since the matrix today models one
  model per workflow _file_.
- Chose an ADR as the vehicle (architecturally significant, governance-bearing
  decision about the agent operating model) with Status **Proposed** — a
  deliberate "adopt selectively, gated on governance" posture rather than a
  built feature.
- Explicitly out of scope: no `.claude/workflows/*.js` script, no
  `check:workflows` or budget-guardrail code, no changes to any `SKILL.md` or
  `check-agents.mjs`.

## Outcome

`docs/adr/0025-dynamic-workflows-assessment.md` landed with Status: Proposed,
plus its index row in `docs/adr/README.md`. This is **stage 1 of a two-stage
program**: the prerequisites and pilot recommended here as gates were built
and the ADR flipped to Accepted in
[2026-07-16-adr-0025-dynamic-workflows-implementation.md](2026-07-16-adr-0025-dynamic-workflows-implementation.md).
