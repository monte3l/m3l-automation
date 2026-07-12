---
name: researching-anthropic-guidance
description: >-
  Fan out parallel Explore subagents to search the web for best practices,
  whitepapers, recommendations, engineering blog posts, guides, and
  documentation from **official Anthropic sources only**, scoped to the topic
  of the invoking task, then synthesize overlaps into consensus and flag any
  contradictions. Use this skill whenever the user says
  /researching-anthropic-guidance, "what does Anthropic recommend for X",
  "find the official Anthropic guidance on X", "research Anthropic best
  practices for X", "pull the Anthropic docs/blog on X", "what's the official
  Claude Code guidance on X", "is there an Anthropic whitepaper on X", or any
  variant of "check what Anthropic says about X" — even without the word
  "research". Also invoke mid-task whenever a design or audit decision hinges
  on official Anthropic positioning (agent/subagent design, model selection,
  prompt engineering, tool use, MCP, context management) rather than on
  something already decided in this repo. Not for general library/framework
  documentation lookups (use the context7-mcp skill for those) and not for
  open-ended web research on non-Anthropic topics.
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

Derive a short kebab-case topic slug (e.g. `subagent-design`) and a run
directory under the session scratchpad:
`<session-scratchpad-dir>/research-<topic-slug>/`. Every agent in Step 2
writes into this directory — it is what keeps the synthesis in Step 3
grounded in the full findings instead of a lossy summary.

### 2 — Fan out Explore agents (parallel)

Spawn all agents **in a single message** so they run concurrently. Each agent
receives:

- A focused brief scoped to exactly one facet of the research topic.
- The run directory from Step 1 and the exact filename to write:
  `<run-dir>/<facet-slug>.md`.
- The **official-sources allowlist**, to be passed as `WebSearch`'s
  `allowed_domains`:

  ```
  anthropic.com, www.anthropic.com, claude.com, www.claude.com,
  platform.claude.com, code.claude.com, docs.claude.com, docs.anthropic.com
  ```

  Anthropic's engineering posts, research papers, and news all live under
  `anthropic.com` (including `/engineering`, `/research`, `/news`), so this
  one allowlist covers whitepapers and blog posts as well as docs — no
  separate domain list is needed per source type.

- The **GitHub caveat**: `allowed_domains` filters by domain, not path, so a
  bare `github.com` allowance would let through any repo. Instead, tell the
  agent it may include `github.com` and `raw.githubusercontent.com` in its
  search domains, but must **only cite or fetch URLs whose path starts with
  `github.com/anthropics/`** (the official org — SDKs, cookbooks, model
  cards) — drop any other GitHub result, even a highly-ranked one.

- An instruction to **not stop at the first matching source** — search
  broadly enough to surface every distinct official source touching the
  facet, then `WebFetch` each one. A single hit rarely represents the full
  picture; the value of this skill is breadth, not the first plausible link.

- An instruction to **reject any non-allowlisted domain** outright and say so
  in its report, rather than substituting a community blog, a third-party
  summary, or a Stack Overflow answer for missing official coverage. If a
  facet turns up no official source, that is itself a reportable finding
  (a coverage gap), not a reason to lower the bar.

- The **verbatim findings format** to write to its scratchpad file — instruct
  the agent to use this exactly, one entry per distinct source:

  ```
  ## Sources: <facet name>
  - SOURCE: <title> — <url> (type: docs|blog|whitepaper|guide|best-practice; retrieved <date>)
    - CLAIM: <recommendation, tightly paraphrased or a short quote>
    - CONFLICT-WITH: <other source title/url> — <how they disagree>   (only if applicable)
  ```

- The **return-value instruction**: after writing the full file, the agent's
  final message back to the hub must be a **compact digest only** — facet
  name, number of sources found, one line per headline claim, and any
  CONFLICT-WITH flags — plus the scratchpad file path. It must not repeat the
  full file contents in its response. This is what keeps the hub's context
  budget for synthesis rather than for re-reading verbose per-agent output.

Use `subagent_type: "Explore"` with breadth `"very thorough"` for every
agent — it is the only spoke granted `WebSearch`/`WebFetch`. Do not write any
files yourself in this step; the agents write their own scratchpad files.

### 3 — Aggregate and synthesize

Once all agents report back, **read every scratchpad file in the run
directory in full** — the digests are for triage, not synthesis; a claim's
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
`docs/research/<topic-slug>.md`, assembled from the Step-1 scratchpad files
(not re-fetched). Only write it on explicit confirmation — the default is
inline-only, since most research feeds directly into the task that asked for
it and doesn't need a standing file.

If confirmed, write the snapshot with this provenance header (matching the
`references/*.md` snapshot convention used elsewhere in this repo):

```
> **Provenance** — Synthesized via `/researching-anthropic-guidance` from
> <N> official Anthropic sources. Synthesized: <date>.
> Sources: [<title1>](<url1>), [<title2>](<url2>), ...
```

followed by the same Consensus / Contradictions / Coverage gaps / Sources
body as the inline briefing. See `docs/research/README.md` for the directory
convention.
