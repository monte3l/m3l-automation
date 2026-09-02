---
name: researching-anthropic-guidance
description: >-
  Fan out parallel Explore subagents to search official Anthropic sources only
  for best practices on a topic, then synthesize consensus and flag
  contradictions. Use for /researching-anthropic-guidance, "what does Anthropic
  recommend for X", or mid-task when a decision hinges on Anthropic's position.
  Not for general library docs or non-Anthropic web research.
---

Research a topic by fanning out parallel web-search agents restricted to
**official Anthropic domains only**, then synthesizing their findings into a
single briefing that merges agreement into consensus and calls out
contradictions. **No code, config, or test files are written during this
skill** unless the user explicitly asks to persist a snapshot (Step 5) — it
otherwise ends with an inline briefing.

**This skill must only run in the main (hub) agent, never inside a
subagent.** It dispatches subagents via the Agent tool; spokes carry
`disallowedTools: Agent` and cannot do this themselves. If you find yourself
executing this skill as a subagent inside a larger task, stop and surface the
research request back to the hub instead.

## Steps

### 1 — Scope the topic

Read the research topic from the user's invocation or from the surrounding
task context (e.g. a design decision an audit or plan is blocked on). If the
topic is ambiguous or spans multiple unrelated subjects, ask **one** focused
clarifying question before proceeding — otherwise infer reasonable scope and
proceed immediately.

Identify 3–5 facets of the topic that a thorough research pass should cover.
Each facet becomes one Explore agent brief in the next step. Good facets are
orthogonal and independently searchable (e.g. for "subagent design":
architecture/composition patterns, tool-grant philosophy, model selection
guidance, prompt-writing conventions, context/token management).

Derive a short kebab-case topic slug (e.g. `subagent-design`) — Step 5 uses
it for the optional snapshot's filename.

### 2 — Fan out Explore agents (parallel)

Before building briefs, read
[`references/official-sources.md`](references/official-sources.md) — the
domain allowlist, the GitHub caveat, the first-class sources to enumerate
directly (including the Claude Code CHANGELOG and the blog/news/engineering
index pages), and the current-date-anchor requirement. It's shared with
`refreshing-anthropic-guidance` so the two skills' source lists cannot drift
apart; edit it, not this file, when Anthropic moves or adds a domain.

Spawn all agents **in a single message** so they run concurrently. Each agent
receives:

- A focused brief scoped to exactly one facet of the research topic.
- The **official-sources allowlist and GitHub caveat**, pasted verbatim from
  `references/official-sources.md`, plus today's date per that file's
  current-date-anchor requirement.

- An instruction to **not stop at the first matching source** — search
  broadly enough to surface every distinct official source touching the
  facet, then `WebFetch` each one. A single hit rarely represents the full
  picture; the value of this skill is breadth, not the first plausible link.

- An instruction to **reject any non-allowlisted domain** outright and say so
  in its report, rather than substituting a community blog, a third-party
  summary, or a Stack Overflow answer for missing official coverage. If a
  facet turns up no official source, that is itself a reportable finding
  (a coverage gap), not a reason to lower the bar.

- An explicit statement that the agent **holds no write tool and cannot write
  any file** — this repo's read-only Bash guard (`guard-readonly-bash.mjs`)
  blocks every shell write route regardless, so a scratchpad handoff is never
  an option. Its full findings travel back only in its response.

- The **verbatim findings format** to return inline, one entry per distinct
  source:

  ```
  ## Sources: <facet name>
  - SOURCE: <title> — <url> (type: docs|blog|whitepaper|guide|best-practice; retrieved <date>)
    - CLAIM: <recommendation, tightly paraphrased or a short quote>
    - CONFLICT-WITH: <other source title/url> — <how they disagree>   (only if applicable)
  ```

- The **return-value instruction**: the agent's response must contain the
  full findings above, capped at roughly 8,000 characters (~2,000 tokens —
  the sub-agent output band Anthropic documents, and the same cap
  `.claude/workflows/audit-fanout.js` already enforces mechanically for its
  own read-only Explore fan-out), followed by a compact digest — facet name,
  number of sources found, one line per headline claim, and any
  CONFLICT-WITH flags. If the full findings would exceed the cap, prioritize
  breadth (every source, tightly paraphrased) over exhaustive per-source
  quoting.

Use `subagent_type: "Explore"` with breadth `"very thorough"` for every
agent — check `.claude/agents/*.md` if unsure which spokes carry
`WebSearch`/`WebFetch` before assuming Explore is the only one. Do not write
any files yourself in this step — nothing in this fan-out touches disk.

### 3 — Aggregate and synthesize

Once all agents report back, **read every agent's full findings in its own
response, in full** — the digests are for triage, not synthesis; a claim's
exact wording and its source's retrieval date matter for spotting
contradictions and staleness.

1. Assign each distinct source a short id (`S1`, `S2`, …) in encounter order,
   deduping sources that multiple agents independently found.
2. **Merge overlapping claims into consensus.** When two or more sources
   agree (even in different words), state the consensus once and tag it with
   every supporting source id — don't repeat the same recommendation once
   per source.
3. **Flag contradictions explicitly.** When sources disagree — including a
   `CONFLICT-WITH` an agent already flagged, or one you notice yourself while
   reading — state both positions, cite both source ids, and note which
   source is more recent or more authoritative (e.g. current docs outrank an
   older blog post; a model-specific guide outranks a general one) so the
   reader isn't left to guess which to follow.
4. Note any facet where no agent found qualifying sources as a **coverage
   gap** rather than silently omitting it.

Emit the synthesis as an inline briefing, using this structure:

```
## Research: <topic> — official Anthropic guidance
### Consensus / best practices
<point, tagged [S1, S3]>
### Contradictions / drift
<S2 vs S4 — what they disagree on, and which is more current/authoritative>
### Coverage gaps
<facet with no official source found, if any>
### Sources
S1: <title> — <url> (retrieved <date>)
S2: ...
```

### 4 — Ask a clarifying question only if genuinely needed

If the synthesis surfaces a live contradiction between two current, equally
authoritative sources that materially changes what the invoking task should
do, ask the user which position to follow via `AskUserQuestion` rather than
picking silently. Skip this when the briefing is unambiguous — most research
passes don't need it.

### 5 — Offer an optional snapshot

Ask whether the user wants the briefing persisted as a durable record at
`docs/research/<topic-slug>.md`, assembled from the Step-2 agents' full
inline findings and the Step-3 synthesis (not re-fetched). Only write it on
explicit confirmation — the default is inline-only, since most research
feeds directly into the task that asked for it and doesn't need a standing
file.

If confirmed, write the snapshot with this provenance header (matching this
skill's own `references/*.md` convention and `docs/research/README.md`'s
snapshot format):

```
> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> <N> official Anthropic sources. Synthesized: <date>.
> Sources: [<title1>](<url1>), [<title2>](<url2>), ...
```

followed by the same Consensus / Contradictions / Coverage gaps / Sources
body as the inline briefing. See `docs/research/README.md` for the directory
convention.
