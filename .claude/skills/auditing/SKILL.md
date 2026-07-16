---
name: auditing
description: >-
  Fan out parallel Explore subagents to audit a topic in the codebase, aggregate
  and dedupe their findings against current repo state, ask focused clarifying
  questions, then enter plan mode with a structured plan — without touching any
  code. Use this skill whenever the user says /auditing, "audit the codebase",
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

Derive a short kebab-case topic slug (e.g. `ci-pipeline`) and a run directory
under the session scratchpad: `<session-scratchpad-dir>/audit-<topic-slug>/`.
Every agent in Step 2 writes into this directory — it is what keeps a
thorough agent's full findings out of its return payload (see below) while
still being available to you in full during aggregation.

### 2 — Fan out via the `audit-fanout` workflow

Invoke the **`Workflow` tool** with the named workflow `audit-fanout`
(`.claude/workflows/audit-fanout.js`, the ADR-0025 pilot), passing as `args`:

```json
{
  "topic": "<the audit target>",
  "runDir": "<run-dir from Step 1>",
  "facets": [{ "name": "...", "slug": "...", "brief": "..." }]
}
```

One facet entry per Step-1 facet (the workflow accepts at most 5). Each
`brief` is the focused, single-facet instruction you would previously have
written into an Explore agent prompt — restate any repo rule that matters,
because the workflow's Explore agents skip `CLAUDE.md` exactly like manually
dispatched ones. This skill-directed call is the Workflow tool's opt-in; no
extra user confirmation is needed.

The workflow owns the mechanical slice end-to-end:

- **Find:** one read-only Explore agent per facet writes a full report in the
  fixed format below to `<run-dir>/<facet-slug>.md` and returns a compact
  digest only (facet, counts, one entry per GAP/INCONSISTENCY) — keeping both
  the agents' and your context budgets intact.
- **Verify:** each GAP/INCONSISTENCY finding gets an independent adversarial
  refute agent (the security-reviewer refute-mode pattern) that returns
  `confirmed` only when a genuine refutation attempt fails.
- **Return:** `{ confirmed, refuted, unverified, facets }` — findings past the
  workflow's verify budget arrive in `unverified` for you to check manually
  in Step 3.

The fixed report format every finder uses verbatim:

```
## Findings: <facet name>
- EXISTING: <description of what is already in place>
- GAP: <something absent that would be expected>
- INCONSISTENCY: <something that conflicts with another part of the repo>
```

**Fallback — Workflow tool unavailable in the session:** dispatch the fan-out
manually instead: one `subagent_type: "Explore"` agent per facet, all in a
single message, each given the facet brief, the exact scratchpad path, the
fixed report format above, an instruction to read relevant files in full, the
mark-EXISTING-only-when-confirmed rule, and the compact-digest return rule.
The adversarial refute pass is then skipped — every finding lands in Step 3
for your own verification, which is the backstop either way.

Do not write any files yourself in this step; the agents write their own
scratchpad files.

### 3 — Aggregate and verify (hub judgment)

Read every scratchpad file in the run directory **in full** — digests and
workflow verdicts are for triage, not final judgment; an item's exact wording
and the file/line it cites matter for the plan. If a facet's report file is
missing (a finder can fail to write it even after returning a digest), its
digest items still arrived — treat them like `unverified` and check each one
yourself. Then:

1. Personally verify every `unverified` item (findings past the workflow's
   verify budget, refuters that died mid-run, or the whole set on the manual
   fallback path) — check the relevant file(s) yourself before treating it
   as a real gap. Agents sometimes flag things that exist under different
   names or paths.
2. Spot-check any `refuted` verdict that discards a finding the user
   explicitly asked about — a refuter can be wrong too.
3. Discard anything that turns out to be already implemented.
4. Group surviving items by theme (e.g. "missing CI gate", "doc drift",
   "hook coverage").

**When the audit target is (or cites) a stored `docs/plans/*.md`, treat every
factual claim in that plan as possibly rotted** — counts, line numbers, file
lists, and "what already exists" premises drift between authoring and audit.
Re-validate each against the live repo rather than inheriting it; delegate any
count reconciliation to `/syncing-docs`, which owns the authoritative count-site
list. The core/json audit found its source plan asserted an
already-fixed inconsistency and missed two count-bearing files
(`docs/logs/2026-07-01-core-json.md`, divergence 1).

**When a finding needs to be checked against what Anthropic itself
recommends** — not just against repo state — invoke
`researching-anthropic-guidance` and fold its briefing into the aggregated
summary. The two skills read different sources: this one reads the repo,
that one reads official Anthropic docs/blogs/whitepapers; a `GAP` this skill
surfaces (e.g. "no documented subagent tool-grant policy") is often best
resolved by first learning what Anthropic recommends before drafting the plan.

Write a concise aggregated summary: themes as headings, bullet-listed items
under each, **preserving the EXISTING / GAP / INCONSISTENCY prefix on every
item** exactly as the agents used it. Do not rewrite items using prose labels
like "Inconsistencies:" or "Gaps:" — keeping the prefixes makes the aggregated
summary machine-readable for evals and lets the user scan findings by type at a
glance. This becomes the input to the clarifying questions.

### 4 — Ask focused clarifying questions

Use `AskUserQuestion` to ask **5–7** questions — one per open dimension that
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

When the plan will touch `packages/*/src/**`, `scripts/*/src/**`, or
`**/tests/**`, make **running `/starting-work` the first implementation step** — it
is the single source of truth for the branch/worktree, PR, and push decisions and
confirms them with the user. This matters because `guard-branch-isolation.mjs`
blocks those writes while `HEAD` is `main`, so a plan that omits isolation stalls
on the first edit.

The plan must not contain any code edits or file writes — it is a plan only.
Do not exit plan mode; leave it for the user to approve or redirect.
