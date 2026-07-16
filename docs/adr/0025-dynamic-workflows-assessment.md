# 0025. Selective adoption of dynamic workflows for subagent orchestration

- **Status:** Accepted
- **Date:** 2026-07-12
- **Deciders:** Enrico Lionello

## Context and problem statement

Claude Code exposes a **dynamic workflow** primitive: a JavaScript script that
orchestrates subagents deterministically via `agent()`, `parallel()`, and
`pipeline()` — the control flow is code, and only the work inside each
`agent()` call is model-powered ([Orchestrate subagents at scale with dynamic
workflows](https://code.claude.com/docs/en/workflows)). This is distinct from
this repo's current **hub-and-spoke** model (see `CLAUDE.md` "Agent Operating
Model"), where a hub agent dispatches spokes turn-by-turn following prose
playbooks in `.claude/skills/*/SKILL.md`, reading each spoke's result before
deciding the next step.

The question this ADR answers: should `m3l-automation` adopt dynamic workflows,
and if so, where and under what conditions? No `.claude/workflows/` directory
or Workflow surface exists in the repo today (confirmed by direct search) —
adoption would be greenfield.

## Decision drivers

- Anthropic's own decision rule for choosing between the two models: _"If the
  orchestration logic can be expressed as deterministic code, use a dynamic
  workflow. If the orchestrator needs to reason about what to do next based on
  each intermediate result, use subagents."_ ([workflows
  docs](https://code.claude.com/docs/en/workflows))
- Cost: multi-agent runs use roughly **15× the tokens** of a single-chat
  interaction, and token usage explains ~80% of the variance in task
  performance — multi-agent orchestration pays off "where the value of the
  task is high enough to pay for the increased performance" ([How we built our
  multi-agent research
  system](https://www.anthropic.com/engineering/multi-agent-research-system)).
  The repo currently has **no token/cost governance** of any kind (no budget
  concept, no per-run ceiling).
- The existing governance surface — depth-1 flatness (`disallowedTools: Agent`
  enforced structurally by `bin/check-agents.mjs`) and the MODEL-MATRIX
  model/effort enforcement (`docs/contributing/model-selection.md` +
  `bin/lib/claude-models.mjs`) — covers `.claude/agents/*.md` and
  `.github/workflows/*.yml` only. A new `.claude/workflows/` surface would be
  **entirely unvalidated** by any existing check.
- Anthropic's own caution against over-engineering: _"add complexity only when
  it demonstrably improves outcomes"_ ([Building Effective
  Agents](https://www.anthropic.com/engineering/building-effective-agents)).

## Considered options

1. **Status quo** — keep all orchestration as hub-dispatched prose playbooks;
   do not adopt the Workflow primitive.
2. **Selective adoption**, gated on governance — introduce dynamic workflows
   only for orchestration steps that are genuinely mechanical/repeatable
   (fixed fan-out, no per-result judgment), and only after the surface is
   validated the way `.claude/agents/*.md` already is.
3. **Broad conversion** — re-express the core RED→GREEN→review implementation
   loop (`implementing-submodules`, `implementing-scripts`) as workflow
   scripts.

## Decision

We chose **selective adoption (option 2)**.

Applying Anthropic's decision rule to the repo's actual orchestration shapes
(surveyed across `.claude/skills/*/SKILL.md`) sorts them clearly:

| Candidate                                                            | Value          | Why                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auditing` fan-out + **adversarial verification**                    | **High**       | N identical parallel Explore agents with a fixed report format is textbook parallelization; adding independent adversarial review of each finding is the specific quality upgrade Anthropic's docs call out, and the mechanical fan-out has no per-agent judgment mixed in |
| Review fan-out in `implementing-submodules` / `implementing-scripts` | Medium         | Same parallel-dispatch shape as auditing (reviewers already dispatched "in one message"); reproducibility is a real win, but the reviewer-roster selection differs between the two skills and still needs a human/hub-legible rule, not just a mechanical loop             |
| `syncing-docs`                                                       | Low            | Already a fully deterministic 9-step `bin/*.mjs`/`pnpm` pipeline with **zero subagent dispatch** — there is nothing to orchestrate as agents; it is already the "workflow" pattern, just expressed as shell commands rather than a Workflow script                         |
| Core RED→GREEN→review loop                                           | Low / negative | The retry-until-clean review cycle, truncation-recovery, and resume-vs-redispatch logic require the hub to read each spoke's output and decide the next action — exactly the case Anthropic says to keep agent-driven, not encode as fixed control flow                    |

Option 3 is rejected because it would force judgment-heavy steps into
deterministic code against Anthropic's own guidance, trading flexibility for
an illusion of rigor without the "few isolated contexts → subagents fine, 20+
parallel contexts → workflow" scale threshold ever being met by this repo's
loop-based skills.

The recommended **first pilot** (not built by this ADR — see Consequences) is
the `auditing` fan-out re-expressed as a workflow with adversarial
verification added: highest documented value, lowest risk (Explore agents are
read-only; no `src/`/`tests/` writes to trip branch isolation), and the
clearest match to Anthropic's parallelization pattern.

Whether a future candidate should **coexist** (the skill calls a workflow only
for its mechanical fan-out slice, keeping hub judgment for the rest) or
**replace** the prose version outright is left to be decided per-candidate
when that candidate is actually built — the shapes above differ enough
(pure pipeline vs. fan-out vs. judgment-loop) that a single global rule would
be premature.

## Consequences

- **Positive:** where adopted, dynamic workflows make repeatable orchestration
  (e.g. audit fan-out) rerunnable and give a codified, encoded seam for
  adversarial verification — the specific quality upgrade Anthropic's
  multi-agent research post highlights. At high fan-out, a workflow script
  also keeps the hub's own context lean (only final results return to the hub,
  not every intermediate agent's output).
- **Negative / trade-offs:** roughly 15× token cost versus single-agent
  interactions for whatever is converted, paid with **no existing budget
  guardrail**; a new `.claude/workflows/` surface adds a governance gap until
  closed (see prerequisites below); the MODEL-MATRIX today models one model
  per workflow _file_ (`bin/check-agents.mjs` §5b), which does not fit a
  multi-step script that might reasonably use different models per step.
- **Prerequisites before any pilot lands** (recommended, not implemented by
  this ADR):
  1. **Validate the new surface.** Extend `check:agents` (or add a
     `check:workflows`) to check `.claude/workflows/**` model/effort choices
     against the MODEL-MATRIX, reusing the module-private allowlists in
     `bin/lib/claude-models.mjs` (`isValidWorkflowModel` /
     `isValidEffortLevel`) rather than re-deriving them.
  2. **Add a token/agent-count guardrail.** No budget concept exists anywhere
     in the repo today; use the Workflow tool's own "Large workflow" warning
     threshold (>25 agents or >1.5M projected tokens) as a starting reference
     point for a repo-level ceiling or review trigger.
  3. **Respect branch isolation.** Any workflow whose agents write
     `packages/*/src/**` or `**/tests/**` must dispatch with
     `isolation: worktree` (per ADR-0013) — `guard-branch-isolation.mjs` fires
     per Write/Edit regardless of which agent issues it, and will block a
     fan-out that writes those paths while on `main`.
  4. **Define a per-step effort/model convention** before any workflow needs
     more than one model, since the current matrix schema does not support it.
- **Prerequisite status (2026-07-16):** 1, 2, and 4 are implemented by
  `check:workflows` (`bin/check-workflows.mjs`) and the `workflow-script`
  MODEL-MATRIX surface; 3 is documented in
  `docs/contributing/model-selection.md` § Enforcement.
- **Semver impact:** none — this is a tooling/process decision with no effect
  on `@m3l-automation/m3l-common`'s public contract.

## Links

- [Orchestrate subagents at scale with dynamic workflows — Claude Code
  Docs](https://code.claude.com/docs/en/workflows)
- [Building Effective Agents —
  Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- [How we built our multi-agent research system —
  Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Related: [ADR-0013](./0013-git-worktrees-for-task-isolation.md) (worktree
  isolation, referenced as a prerequisite for any src/test-writing workflow
  fan-out); `CLAUDE.md` "Agent Operating Model"; `docs/contributing/model-selection.md`
  (MODEL-MATRIX, the schema a workflow-validation check would extend)
- Supersedes / superseded by: none
