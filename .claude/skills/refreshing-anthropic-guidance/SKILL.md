---
name: refreshing-anthropic-guidance
description: >-
  Sweep the whole local Claude Code harness — agents, skills, hooks, rules,
  workflows, and CLAUDE.md — against Anthropic's current guidance, the
  Claude Code changelog, and the newest Claude models, then diff against the
  last verified state and enter plan mode with a remediation plan. Use this
  skill whenever the user says /refreshing-anthropic-guidance, "is our
  harness still up to date with Anthropic", "check the harness against
  Anthropic's latest guidance", "did Claude Code change anything we rely
  on", "refresh our Anthropic guidance", "are our agent model pins still
  current", "audit the harness for drift from Anthropic recommendations", or
  any variant of "has anything we built gone stale relative to what
  Anthropic recommends now". Distinct from `researching-anthropic-guidance`,
  which answers a single topic question on demand and does not touch repo
  state — this skill is push-shaped, sweeps fixed facets of the harness
  itself against those same sources, and always ends in a remediation plan.
  Also distinct from `auditing`, which reads the repo against itself; this
  skill reads the repo against an external, time-varying source and is the
  only one of the three that tracks what a page said last time versus what
  it says now.
---

Sweep the local Claude Code harness against Anthropic's current guidance and
diff it against what was true the last time this ran, then enter plan mode
with a remediation plan. **No code, config, or agent/skill/hook file is
edited by this skill** — the only write is the tracker (Step 5); every actual
fix goes through the user-approved plan, the same as `auditing`.

**This skill must only run in the main (hub) agent, never inside a
subagent.** Step 6 calls `EnterPlanMode`, and Step 3 dispatches subagents via
the Agent tool; spokes carry `disallowedTools: Agent` and cannot do either. If
you find yourself executing this skill as a subagent inside a larger task,
stop and surface the refresh request back to the hub instead.

## Why this exists, not just `researching-anthropic-guidance`

That skill answers "what does Anthropic recommend for X" once, for whatever
X the invoking task names. Nothing in the repo ever asks the inverse
question — is what's _already built_ still what Anthropic recommends? The
harness hardcodes a lot of Anthropic-owned surface (model IDs in every agent
frontmatter, hook event names, `settings.json` schema keys, `maxTurns`/
`disallowedTools`/`permissionMode` semantics) and none of the repo's `check:*`
gates compare any of it to upstream — they're all closed loops that check the
repo's own prior decisions against itself. This skill is the missing outward
check, run periodically rather than once.

## Steps

### 1 — Read the tracker and establish anchors

Read `docs/research/harness-refresh.md` in full. Its header comment
(`<!-- harness-refresh: last-verified=<date> claude-code-version=<version> -->`)
gives the last-verified date and Claude Code version; its body gives the
recorded claim, URL, and retrieved date for every source checked last time,
per facet. This is what turns a sweep into a **diff** instead of a
rediscovery — Step 3's agents check "does this claim still hold" rather than
re-deriving everything from scratch.

If the tracker doesn't exist yet or has no entries for a facet, treat that
facet as first-run: no prior claims to diff against, only `NEW` findings.

Read
[`../researching-anthropic-guidance/references/official-sources.md`](../researching-anthropic-guidance/references/official-sources.md)
(shared with `researching-anthropic-guidance` — edit that file, not this one,
when Anthropic moves or adds a domain). State today's date; every agent brief
in Step 3 needs it as the current-date anchor per that file.

Derive the run directory: `<session-scratchpad-dir>/refresh-<today's-date>/`.

### 2 — Build the changelog delta

`WebFetch` the Claude Code CHANGELOG
(`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`).
Extract every version entry newer than the tracker's recorded
`claude-code-version`. This delta gets passed into every facet brief in Step 3
so agents know specifically what changed recently, rather than re-reading
docs that haven't moved. If the CHANGELOG is unreachable, note it as a
coverage gap for this run and proceed with the remaining sources — don't
block the whole sweep on one fetch.

### 3 — Fan out five fixed facets (parallel)

Spawn all five agents **in a single message** so they run concurrently — the
facets are fixed, not derived per-run, so sweeps stay comparable to each
other and the tracker stays diffable over time. Each facet maps to concrete
repo files the agent must check the fetched guidance against:

| Facet slug                   | What it validates against Anthropic's current guidance                                       | Repo files to check                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models-tiering`             | Model IDs, effort levels, context/output limits, tiering advice                              | `.claude/agents/*.md` frontmatter; `docs/contributing/model-selection.md` (incl. the `MODEL-MATRIX` block); `.claude/settings.json`'s `availableModels`; `bin/lib/claude-models.mjs` |
| `cc-features-settings`       | Claude Code feature/settings surface (hook fields, permission modes, `settings.json` schema) | `.claude/settings.json`; `CLAUDE.md`; `docs/contributing/hooks-reference.md`'s `if:` field description                                                                               |
| `agent-subagent-design`      | Subagent/agent design conventions (tool grants, `maxTurns`, composition patterns)            | `.claude/agents/*.md`; `docs/contributing/agent-operating-model.md`; `.claude/rules/subagent-dispatch.md`                                                                            |
| `skills-context-engineering` | Skill authoring conventions, context/token management guidance                               | `.claude/skills/*`; `docs/contributing/skills-catalog.md`; the description-length threshold in `bin/check-context-budget.mjs`                                                        |
| `hooks-lifecycle`            | Hook lifecycle events and their documented semantics                                         | Event names/matchers in `.claude/settings.json`; the event list in `bin/check-hooks.mjs`; `docs/contributing/hooks-reference.md`                                                     |

Each agent brief carries:

- The facet's row from the table above (what to check, which files).
- The Step 2 changelog delta.
- The tracker's recorded claims for this facet from Step 1 (if any).
- The domain allowlist, GitHub caveat, and current-date anchor from
  `references/official-sources.md`.
- The run directory and exact filename: `<run-dir>/<facet-slug>.md`.
- The **verbatim per-claim verdict format** to write to its scratchpad file:

  ```
  ## Refresh: <facet name>
  - CLAIM: <recorded claim from the tracker> — <url> (recorded <old date>)
    - VERDICT: UNCHANGED | CHANGED | GONE   (re-fetched <today>)
    - NOW: <what the page says today — only if CHANGED>
    - REPO-IMPACT: <file:line this invalidates, or "none">
  - NEW: <guidance found with no recorded prior claim> — <url>
    - REPO-IMPACT: <file:line, or "none">
  ```

  `GONE` (the URL 404s, redirects to unrelated content, or the claim is no
  longer findable on the page) matters as much as `CHANGED` — the repo
  already has one live redirect (`docs.claude.com` → `platform.claude.com`)
  among its ~150 Anthropic doc citations, and nothing else checks for link
  rot.

- The **return-value instruction**: after writing the full file, return only
  a compact digest — facet name, counts of UNCHANGED/CHANGED/GONE/NEW, and
  one line per item with a non-`none` REPO-IMPACT — plus the scratchpad file
  path. Full findings stay in the file.

Use `subagent_type: "Explore"` with breadth `"very thorough"` for every
agent. Do not write any files yourself in this step.

### 4 — Aggregate

Read every scratchpad file in the run directory **in full** — digests are for
triage, not judgment; a verdict's exact wording and the file:line it cites
matter for the plan. Group findings into:

1. **Confirmed drift with repo impact** — a `CHANGED` or `GONE` verdict, or a
   `NEW` item, whose `REPO-IMPACT` names a real file:line. Verify each one
   yourself against that file before treating it as real — an agent can
   misread a page or cite a file that doesn't say what it claims.
2. **Guidance changes with no repo impact** — worth recording in the tracker
   so a later run doesn't re-flag them, but nothing to act on now.
3. **Dead or moved URLs** (`GONE`) — flag for a citation fix wherever they're
   referenced, independent of whether the underlying guidance changed.
4. **Coverage gaps** — a facet where a source was unreachable or nothing
   qualifying was found this run.

Write a concise aggregated summary using the same theme-grouped,
prefix-preserved style as `auditing` Step 3 — this keeps the two skills'
output scannable the same way.

### 5 — Update the tracker

This is the skill's only write outside plan mode. Update
`docs/research/harness-refresh.md` in place (not a new dated file):

- Bump the header comment's `last-verified` to today and
  `claude-code-version` to the newest version seen in the Step 2 delta.
- For every source checked this run, update its recorded claim, URL, and
  retrieved date under the source's facet section — whether the verdict was
  UNCHANGED (just bump the date) or CHANGED (replace the claim with what the
  page says now).
- Add any `NEW` sources found.
- Update the outstanding-drift table: remove items resolved since the last
  run (the user will confirm resolution status), add newly confirmed drift
  from Step 4.1.

### 6 — Enter plan mode

Call `EnterPlanMode` with a remediation plan, one section per confirmed-drift
item from Step 4.1, mirroring `auditing`'s Step 5 structure: context section,
numbered implementation sections (what to fix, where, how to verify), a
verification checklist. This skill never edits agent frontmatter,
`settings.json`, hooks, or docs itself outside the tracker — every harness
edit stays human-approved through the plan.

If Step 4 found no confirmed drift, skip plan mode and report a clean sweep
instead — updating the tracker (Step 5) is still worth doing so the next run
has a fresh baseline.
