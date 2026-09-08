---
name: researching-typescript-guidance
description: >-
  Answers a TypeScript language, compiler, or toolchain question from
  owner-normative upstream material only — typescriptlang.org, the TypeScript
  devblog, microsoft/TypeScript releases, nodejs.org type stripping,
  typescript-eslint.io. Use for /researching-typescript-guidance, "what does
  the TypeScript team say about X", "is erasableSyntaxOnly still needed", or
  before changing a compiler flag. Not how this repo tsconfig is wired, not
  third-party tutorials.
---

Research a TypeScript language, compiler, or toolchain question by fanning
out parallel web-search agents restricted to **owner-normative TypeScript
sources only**, then synthesizing their findings into a single briefing that
merges agreement into consensus and calls out contradictions. **No code,
config, or test files are written during this skill** unless the user
explicitly asks to persist a snapshot (Step 5) — it otherwise ends with an
inline briefing.

**This skill must only run in the main (hub) agent, never inside a
subagent.** It dispatches subagents via the Agent tool; spokes carry
`disallowedTools: Agent` and cannot do this themselves. If you find yourself
executing this skill as a subagent inside a larger task, stop and surface the
research request back to the hub instead.

**This is not `typescript-configuration`.** That skill answers "how is _this
repo's_ tsconfig wired, and how do I change it safely." This one answers
"what does the _owner_ of the TypeScript language/compiler/toolchain
currently say." A question about `tsconfig.base.json`'s existing flags routes
there; a question about whether a flag's upstream semantics still match what
this repo believes routes here. Same split against `eslint-flat-config`
(this repo's `eslint.config.js` mechanics) and `vitest-testing` (this repo's
Vitest config) — both are "how is X wired here," neither is "what does
upstream currently recommend."

## Steps

### 1 — Scope the topic

Read the research topic from the user's invocation or from the surrounding
task context (e.g. a design decision an audit or plan is blocked on). If the
topic is ambiguous or spans multiple unrelated subjects, ask **one** focused
clarifying question before proceeding — otherwise infer reasonable scope and
proceed immediately.

Identify 3–5 facets of the topic that a thorough research pass should cover.
Each facet becomes one Explore agent brief in the next step. Good facets are
orthogonal and independently searchable (e.g. for "should we adopt
`isolatedDeclarations` repo-wide": declaration-emit semantics, the annotation
constraints it imposes on authors, its packaging/`attw` interaction, and the
build-vs-tooling project split it touches).

Derive a short kebab-case topic slug (e.g. `erasable-syntax-only`) — Step 5
uses it for the optional snapshot's filename.

### 2 — Fan out Explore agents (parallel)

Before building briefs, read
[`references/typescript-sources.md`](references/typescript-sources.md) — the
two-tier (T1/T2) domain allowlist, the GitHub caveat (the `microsoft` org,
not `anthropics`), the first-class sources to enumerate directly, the
stale-Breaking-Changes-wiki warning, and the current-date-anchor requirement.
It's shared with `refreshing-typescript-guidance` so the two skills' source
lists cannot drift apart; edit it, not this file, when the tiering changes.

Spawn all agents **in a single message** so they run concurrently. Each agent
receives:

- A focused brief scoped to exactly one facet of the research topic.
- The **two-tier allowlist and GitHub caveat**, pasted verbatim from
  `references/typescript-sources.md`, plus today's date per that file's
  current-date-anchor requirement.

- An instruction to **not stop at the first matching source** — search
  broadly enough to surface every distinct T1/T2 source touching the facet,
  then `WebFetch` each one. A single hit rarely represents the full picture;
  the value of this skill is breadth, not the first plausible link.

- An instruction to **reject any non-allowlisted domain** outright and say so
  in its report, rather than substituting a community blog, an individual
  author's material, or a Stack Overflow answer for missing T1/T2 coverage.
  If a facet turns up no qualifying source, that is itself a reportable
  finding (a coverage gap), not a reason to lower the bar.

- An explicit statement that the agent **holds no write tool and cannot write
  any file** — this repo's read-only Bash guard (`guard-readonly-bash.mjs`)
  blocks every shell write route regardless, so a scratchpad handoff is never
  an option. Its full findings travel back only in its response.

- The **verbatim findings format** to return inline, one entry per distinct
  source:

  ```
  ## Sources: <facet name>
  - SOURCE: <title> — <url> (type: docs|release-note|reference|spec|tool-docs; retrieved <date>)
    - TIER: T1 | T2
    - CLAIM: <recommendation or semantics, tightly paraphrased or a short quote>
    - CONFLICT-WITH: <other source title/url> — <how they disagree>   (only if applicable)
  ```

  The `TIER:` field has no analogue in the Anthropic-guidance pair — that
  allowlist has one owner and one authority level. This corpus has two;
  every source must be labeled so Step 3's synthesis can apply the
  precedence rule below.

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
exact wording, its tier, and its source's retrieval date all matter for
spotting contradictions and staleness.

1. Assign each distinct source a short id (`S1`, `S2`, …) in encounter order,
   deduping sources that multiple agents independently found.
2. **Merge overlapping claims into consensus.** When two or more sources
   agree (even in different words), state the consensus once and tag it with
   every supporting source id — don't repeat the same recommendation once
   per source.
3. **Flag contradictions explicitly**, applying this precedence rule:
   - **T1 outranks T2.** A T2 claim (e.g. typescript-eslint's
     characterization of a compiler behavior) never outranks a T1 claim it
     conflicts with — surface the disagreement and say which tier each side
     is.
   - **Within T1, a devblog release post outranks the Handbook** when they
     disagree about current behavior — the Handbook lags releases.
   - **The Breaking-Changes wiki is stale at TS 4.9.** A conflict where the
     only "T1" side is that wiki page citing TS 5+ behavior is not a real
     conflict — it's a stale source, and the finding is that the wiki is
     stale, not that two current sources disagree.
   - **On the Node↔TypeScript boundary, nodejs.org is co-normative T1, not
     subordinate to Microsoft.** A genuine Microsoft/Node disagreement there
     is a real two-owner conflict to surface, never one to silently
     arbitrate.
   - For everything else, note which source is more recent or more
     authoritative so the reader isn't left to guess which to follow.
4. Note any facet where no agent found qualifying sources as a **coverage
   gap** rather than silently omitting it.

Emit the synthesis as an inline briefing, using this structure:

```
## Research: <topic> — upstream TypeScript guidance
### Consensus / best practices
<point, tagged [S1, S3]>
### Contradictions / drift
<S2 vs S4 — what they disagree on, which tier each is, and which is more current/authoritative>
### Coverage gaps
<facet with no qualifying source found, if any>
### Sources
S1: <title> — <url> (tier T1|T2, retrieved <date>)
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
`docs/research/typescript/<topic-slug>.md`, assembled from the Step-2 agents'
full inline findings and the Step-3 synthesis (not re-fetched). Only write it
on explicit confirmation — the default is inline-only, since most research
feeds directly into the task that asked for it and doesn't need a standing
file.

If confirmed, write the snapshot with this provenance header (matching this
skill's own `references/*.md` convention and `docs/research/README.md`'s
snapshot format):

```
> **Provenance** — Synthesized via `/researching-typescript-guidance` from
> <N> upstream TypeScript sources (T1/T2 per
> `.claude/skills/researching-typescript-guidance/references/typescript-sources.md`).
> Synthesized: <date>.
> Sources: [<title1>](<url1>), [<title2>](<url2>), ...
```

followed by the same Consensus / Contradictions / Coverage gaps / Sources
body as the inline briefing. See `docs/research/README.md` for the directory
convention.

Do **not** write the string "Source: Context7" in this header or anywhere in
the snapshot — `bin/lib/reference-freshness.mjs`'s `isContext7Sourced` check
matches that exact phrase and would demand a
`<!-- reference-freshness: ... -->` stamp against a file this skill never
pulled from Context7.
