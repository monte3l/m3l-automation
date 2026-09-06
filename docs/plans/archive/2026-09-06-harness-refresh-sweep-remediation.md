# Harness refresh sweep remediation — 2026-09-06

**Status: shipped** — landed on `feat/harness-refresh-2026-09-06`.

## Context

`/refreshing-anthropic-guidance` runs periodically to diff the harness (agent
frontmatter, `settings.json`, hooks, skills, model pins) against Anthropic's
current guidance, using `docs/research/harness-refresh.md` as the standing
tracker so each run reports what **changed** since the last one rather than
rediscovering the whole harness from scratch. The last sweep ran 2026-09-04 at
Claude Code v2.1.260; this run swept the same five fixed facets
(models-tiering, cc-features-settings, agent-subagent-design,
skills-context-engineering, hooks-lifecycle) against v2.1.263.

## Approach / Decisions

Five `Explore` agents fanned out in parallel, one per facet, each re-fetching
its recorded claims and reporting UNCHANGED/CHANGED/GONE/NEW verdicts with a
repo-impact assessment. The hub verified every claimed repo-impact directly
(reading the cited file) before accepting it, rather than trusting an agent's
citation — this caught the sweep's most consequential finding:

- One facet reported `SessionStart`'s compact-matcher field is
  `session_start_reason`, which would mean
  `.claude/hooks/reinject-compact-handoff.mjs` (reading `input.source`) has
  been silently dead since it shipped. That doc page has now returned five
  mutually inconsistent field names across three sweeps, so rather than
  trust a sixth fetch, the hub grepped local session transcripts directly:
  `SessionStart:compact` had fired 49 times, 14 of them with a populated
  `additionalContext` containing the rendered handoff — proof by execution
  that `input.source` is correct and the hook has always worked. This closed
  a coverage gap the tracker had carried open across three prior sweeps.
- Two more tracker items carried as open drift (`check:hooks` CI-only;
  `CANONICAL_CLAUDE_MODELS` missing Fable 5.1) were independently re-verified
  against the actual files and found already fixed by unrelated prior work —
  closed as stale rather than re-fixed.
- `PostCompact` (open drift item 6, "documented but unwired") was closed as
  **not actionable**: its documented output schema carries no
  `additionalContext` field, so wiring it could never have accomplished the
  handoff re-injection the item proposed.
- The `estimateTokens()` chars/4 under-count (open drift item 4) was
  reclassified from open drift to an accepted, already-documented limitation
  — Anthropic still publishes no local estimator ratio to substitute, and the
  gate's own `--exact` opt-in already covers the accurate path.

The user confirmed all four recommendations (docs-only remediation scope; fix
`Explore.md`'s `color: gray` → `cyan`; close the `PostCompact` item;
leave the token-estimate gap as documented) via `AskUserQuestion` before any
file was written, per the skill's plan-mode contract.

## Outcome

Five files changed, docs-only, zero semver impact:

- `docs/research/harness-refresh.md` — the substance of the change: tracker
  header bumped to `last-verified=2026-09-06 claude-code-version=2.1.263`,
  four outstanding-drift items closed, one reclassified, one corrected count
  (33 documented hook events, not the previously recorded 32 — a prior-sweep
  miscount, not an upstream change), several claims updated in place where
  guidance moved with no repo impact (`MAX_MCP_OUTPUT_TOKENS` default now
  8000, partial compaction via `/rewind`, a documented fork-vs-fresh
  selection rule, Mythos 5.1, `/skill-doctor`,
  `bashOutputMaxChars`/`taskOutputMaxChars`).
- `.claude/agents/Explore.md` — `color: gray` → `cyan` (outside Anthropic's
  documented agent-color enum, unguarded by `check:agents`).
- `docs/contributing/model-selection.md`, `hooks-reference.md`,
  `skills-catalog.md` — a stale confirmation date, a Mythos 5.1 mention, the
  `if:` field's newly-eligible hook events, and a `/skill-doctor` citation as
  the supported way to derive the hand-authored skill-usage evidence in the
  catalog's cost table.

`pnpm verify` passed clean (66 non-skipped steps). No correctness defect was
found in the harness across the 32 recorded claims this sweep re-checked —
the headline result is that the harness remains conformant with current
Anthropic guidance.

Related: `docs/logs/2026-09-02-context-management-compaction-audit.md`
(the prior sweep this tracker's drift items originated from) and
`docs/research/harness-refresh.md` itself (the living tracker this plan
updated).
