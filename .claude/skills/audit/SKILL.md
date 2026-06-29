---
name: audit
description: >-
  Fan out parallel Explore subagents to audit a topic in the codebase, aggregate
  and dedupe their findings against current repo state, ask focused clarifying
  questions, then enter plan mode with a structured plan — without touching any
  code. Use this skill whenever the user says /audit, "audit the codebase",
  "audit [topic]", "do an audit of", "audit and plan", "fan out agents to audit",
  "spawn Explore subagents to audit", "review the current state of", "investigate
  and plan", or any variant of 'look at X and make a plan'. Also invoke when the
  user asks to "audit X and then plan how to fix it" or "find gaps in X and plan
  the fixes" — even without the word audit. This is always the right skill when
  the intent is: read the codebase broadly on a topic, surface what's missing or
  wrong, and produce a plan.
---

Audit a topic in the `m3l-automation` codebase by fanning out parallel read-only
Explore agents, aggregating their findings, and then producing a structured plan.
**No code, config, or test files are written during this skill** — it ends with an
approved plan in plan mode.

**This skill must only run in the main (hub) agent, never inside a subagent.**
Step 5 calls `EnterPlanMode`, which is only available to the hub. If you find
yourself executing this skill as a subagent inside a larger task, stop and
surface the audit request back to the hub instead.

## Steps

### 1 — Clarify the target

Read the audit target from the user's invocation (e.g. "release config",
"scaffolding", "README consistency", "CI pipeline"). If the target is ambiguous
or has multiple equally plausible interpretations, ask **one** focused clarifying
question before proceeding — otherwise infer reasonable scope from the topic and
proceed immediately.

Identify 3–5 facets of the topic that a thorough audit should cover. Each facet
becomes one Explore agent brief in the next step. Good facets are orthogonal and
independently checkable (e.g. for "CI pipeline": step ordering, cache config,
gate thresholds, secret handling, trigger conditions).

### 2 — Fan out Explore agents (parallel)

Spawn all agents **in a single message** so they run concurrently. Each agent
receives:

- A focused brief scoped to exactly one facet of the audit target.
- This fixed report format (instruct each agent to use it verbatim):

  ```
  ## Findings: <facet name>
  - EXISTING: <description of what is already in place>
  - GAP: <something absent that would be expected>
  - INCONSISTENCY: <something that conflicts with another part of the repo>
  ```

- An explicit instruction to **read relevant files in full** (not just search),
  since excerpts miss content past the read window.
- An instruction to mark items `EXISTING` when they can confirm the thing is
  implemented — not just when they cannot find evidence of a gap.

Use `subagent_type: "Explore"` for every agent. Do not write any files in this step.

### 3 — Aggregate and verify

Collect all agent reports. For each `GAP` or `INCONSISTENCY` item:

1. Verify the claim is accurate — check the relevant file(s) yourself before
   treating it as a real gap. Agents sometimes flag things that exist under
   different names or paths.
2. Discard anything that turns out to be already implemented.
3. Group surviving items by theme (e.g. "missing CI gate", "doc drift",
   "hook coverage").

Write a concise aggregated summary: themes as headings, bullet-listed items
under each, **preserving the EXISTING / GAP / INCONSISTENCY prefix on every
item** exactly as the agents used it. Do not rewrite items using prose labels
like "Inconsistencies:" or "Gaps:" — keeping the prefixes makes the aggregated
summary machine-readable for evals and lets the user scan findings by type at a
glance. This becomes the input to the clarifying questions.

### 4 — Ask focused clarifying questions

Use `AskUserQuestion` to ask **2–4** questions — one per open dimension that
would block planning (scope, priority, sequencing, approach). Skip any question
whose answer can be inferred from the codebase or the user's invocation.

Good question triggers:

- Two equally valid implementation approaches exist and the choice affects
  what the plan looks like.
- The scope of the fix is genuinely ambiguous (e.g. fix all instances vs.
  fix the worst one first).
- The user's priority ordering is unclear when multiple gaps exist.

Bad question triggers (do not ask):

- How the repo works (read it).
- Whether to follow existing conventions (always yes).
- Confirmation that you understood the topic correctly (just proceed).

### 5 — Enter plan mode

Call `EnterPlanMode`. Write a structured plan with:

- A brief context section (2–3 sentences: what was audited, what the key
  findings were).
- Numbered implementation sections, one per theme or deliverable.
- Each section: what to build, where it lives, how to verify it.
- A verification checklist at the end.

The plan must not contain any code edits or file writes — it is a plan only.
Do not exit plan mode; leave it for the user to approve or redirect.
