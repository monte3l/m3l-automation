# 0078. Hub session context management: honest budgets and durable-artifact compaction

- **Status:** Accepted
- **Date:** 2026-08-27
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

`docs/contributing/subagent-context-management.md` gives this repo a mature,
incident-driven doctrine for **subagent** context failure — 20+ logged
truncations, a journal/digest prompt contract on all 9 spokes, a `SubagentStop`
truncation detector, and `bin/spoke-recovery.mjs`. The hub session's own
context — its always-loaded budget, what happens when it compacts, which
`env`/settings knobs govern it — has none of that. A repo-wide grep for
`compact|context rot|context window` across `docs/contributing`,
`.claude/rules`, `.claude/skills`, and `CLAUDE.md` returns 12 hits; every
"compact" hit means _subagent digest shape_ (a bounded return contract), never
`/compact`, `/clear`, or auto-compaction.

Worse, the one gate that claims to govern always-loaded context measures the
wrong thing. `bin/check-claude-md-budget.mjs` reads `CLAUDE.md` raw and never
resolves its two `@`-imports (`@package.json`, `@docs/adr/README.md`), both of
which Anthropic's memory docs confirm are inlined verbatim at launch — imports
"help organization but don't reduce context"
(`code.claude.com/docs/en/memory`). Measured resolved: 391 lines / ~8,839
tokens against the gate's 200-line / 3,000-token caps — 2.0x and 2.9x over,
while the gate itself reports 96% PASS. It measures 37% of what it governs.

An audit (`/auditing`, 2026-08-27) plus official-source research
(`/researching-anthropic-guidance`, snapshotted at
`docs/research/context-window-and-compaction.md`) surfaced this gap and its
fix. This ADR records the resulting policy decisions; the accompanying plan
implements them across six PRs.

## Decision drivers

- **Minimal machinery** — reuse the subagent doctrine's structure (a canonical
  reference doc, a terse dispatch-time extract, a deterministic gate) rather
  than inventing a parallel vocabulary for the hub side.
- **Measure what's actually loaded, not what's declared** — the `@`-import
  blind spot is exactly the failure mode the gate exists to prevent; a gate
  that can't see its own governed surface is worse than no gate, since it
  reports false confidence.
- **Prefer durable artifacts over trusting the summary** — this repo's own
  incident history (subagent truncation) already validated external-memory
  patterns (journals) over relying on the model to narrate state correctly
  under pressure; the same logic applies to hub-session compaction.
- **No new tracker vocabulary** — express the policy through existing
  mechanisms (`.claude/hooks`, `.claude/settings.json`, a widened doctrine
  doc, a ratcheting gate) rather than a new status system.

## Considered options

1. **Do nothing beyond fixing the `@`-import blind spot.** Rejected — closes
   the measurement bug but leaves the hub session with no compaction strategy
   and no doctrine, the larger gap the audit found.
2. **Rename `subagent-context-management.md` to a general
   `context-management.md` and sweep all references.** Rejected — 31 files
   reference the current path, 20 of them immutable historical records
   (15 `docs/logs/*.md`, 5 `docs/plans/archive/*.md`). A rename either
   rewrites the past or leaves dead links across two directories whose whole
   value is being a point-in-time account.
3. **Rely solely on Claude Code's built-in auto-compaction with no
   repo-specific compaction hooks.** Rejected — Anthropic's own harness-design
   guidance (`anthropic.com/engineering/harness-design-long-running-apps`)
   argues structured artifact handoffs outperform in-place summarization for
   long-running work; this repo's incident history agrees at the subagent
   level (journals recovered every truncation losslessly; summaries did not
   exist as a fallback there). Declining to build the hub-side equivalent
   would leave the repo's two context-management stories inconsistent with
   each other.
4. **Widen the existing doctrine doc in place (Part 1: hub, Part 2: spokes,
   same filename); fix the gate to resolve `@`-imports and add a ratchet; add
   `PreCompact`/`SessionStart(compact)` handoff hooks; pin the config knobs
   the research surfaced as relevant.** Chosen.

## Decision

We adopt option 4, in four parts:

### Part A — Honest measurement

`bin/check-claude-md-budget.mjs` is renamed `bin/check-context-budget.mjs` and
widened to resolve `@`-imports (max 4 hops, matching Claude Code's own import
resolution) before measuring, report per-scenario conditional-load totals for
`.claude/rules/*.md` by `paths:` glob, and sum skill-listing description
weight. It gains a ratchet baseline (`bin/context-budget-baseline.json`,
`--update`/`--ref`), mirroring `bin/check-file-budget.mjs`. It moves from
CI-only to also running pre-push, matching its sibling budget gates
(`check:file-budget`, `check:review-size`).

### Part B — Doctrine, not a new file

`docs/contributing/subagent-context-management.md` gains a **Part 1: the hub
session** section above its existing content (which becomes **Part 2:
spokes**, unchanged). The filename stays as-is — see Considered Options #2 for
why a rename was rejected. Part 1 covers the `/clear` vs. `/compact` vs.
`/rewind` decision table, what survives compaction, the handoff-artifact
contract (Part C), and the always-loaded budget philosophy, citing
`docs/research/context-window-and-compaction.md`.

### Part C — Durable-artifact compaction, following the harness-design position

Two new hooks close the gap the subagent doctrine already solved at its own
layer:

- **`PreCompact`** writes a structured handoff artifact (branch, worktree, PR
  number, open spoke journal paths, pending gates, last verified commit and
  its signature status) to the session scratchpad, reusing
  `bin/spoke-recovery.mjs`'s journal-discovery logic rather than duplicating
  it.
- **`SessionStart` matching source `compact`** reads that artifact back as
  `additionalContext`, so post-compaction state reconstruction does not
  depend on the summary having retained it — Claude Code confirms this hook
  matcher re-fires after compaction.

This explicitly follows the harness-design source's position (durable
artifact first, in-place summary as the fallback) over the platform
compaction docs' "primary strategy" framing — see
`docs/research/context-window-and-compaction.md` § Contradictions for why both
are treated as scope-dependent rather than one superseding the other, and why
this repo's own incident history tips the choice.

### Part D — Config knobs pinned, one explicitly deferred

`.claude/settings.json` gains an `env`/settings block for: `autoCompactWindow`
(explicit, reproducible trigger point rather than a value that varies by model
and provider), `skillListingBudgetFraction`/`skillListingMaxDescChars` (20
local skills, 19,608 chars of descriptions, plus 10 enabled plugins),
`MAX_MCP_OUTPUT_TOKENS` (three MCP servers enabled; no hook in this repo caps
tool output at all today), and `promptCacheTtl`/`subagentPromptCacheTtl`
(cache is scoped per machine+directory, so ADR-0013/0014's worktree-heavy
workflow means a fresh worktree pays full cache-creation cost with no
shared-checkout discount).

**`MAX_THINKING_TOKENS` is deliberately not set.** Adaptive-reasoning models
ignore a nonzero fixed thinking budget; `/effort` is the correct lever for
this repo's model tier, already used per `docs/contributing/model-selection.md`.
Recording this here so it is not re-proposed by a future audit.

## Consequences

- **Positive:** the always-loaded budget gate now measures its actual
  governed surface and will catch the next `@`-import regression it could not
  see before; the hub session gets the same durable-artifact discipline that
  already recovered every logged subagent truncation losslessly; the
  compaction stance is recorded rather than left to platform defaults that
  vary by model/provider; no historical doc or log is rewritten.
- **Negative / trade-offs:** two new hooks to maintain and keep within the
  `bin/check-hooks.mjs` timeout requirement; the widened doctrine doc's
  filename now under-describes its contents (accepted per Considered Options
  #2 rather than paying a 31-file rename); pinning `autoCompactWindow` and
  cache TTLs couples the repo to today's understood precedence rules, which
  Anthropic's own docs note aren't fully specified for the on/off toggle (see
  the research snapshot's Contradictions section) — a future platform change
  to that precedence could require revisiting the pinned values.
- **Semver impact:** none. Tooling, hooks, and documentation only; no
  `packages/m3l-common` public surface changes.

## Update (2026-08-27) — Part D dropped; PR 5 folded into this note

Part D's config-knob pins (`autoCompactWindow`, `skillListingBudgetFraction`/
`skillListingMaxDescChars`, `MAX_MCP_OUTPUT_TOKENS`,
`promptCacheTtl`/`subagentPromptCacheTtl`) were never landed. Presented with
the specific values before implementation, the maintainer's call was to skip
all of them rather than guess:

- **`autoCompactWindow`**: left at the platform default. The research
  snapshot's own Contradictions section already flagged that Anthropic's
  docs don't fully specify precedence for the on/off toggle (only the window
  value); pinning a number couples the repo to partially-understood platform
  behavior for a benefit that was never concretely demonstrated.
- **`MAX_MCP_OUTPUT_TOKENS` and the prompt-cache TTL overrides**: skipped.
  No hook in this repo caps tool output at all today, so this would have
  been the first such cap with no way to verify the right threshold ahead of
  time — a wrong guess risks truncating a legitimate large MCP response.
  Cache TTL defaults were judged to already fit this repo's usage tier;
  the worktree-per-PR cache-miss cost this ADR's Part D cited (ADR-0013/0014)
  is left as a future observation, not a blind guess now.

This ADR's Decision section (Part D) is left as-is per the "ADRs are
immutable once Accepted" convention — this Update records the reversal
rather than rewriting the original text. PRs 1-4 (Parts A-C) landed as
described; PR 5 (Part D) is dropped; PR 6 (`bin/check-agents.mjs`
enforcement, four correctness fixes surfaced by the original audit, and the
`subagent-dispatch.md` bounded-output-instruction gap in three skills) closes
out the sequence.

## Update (2026-09-01) — Part C's shipped scope corrected

A `/auditing` sweep on 2026-09-01 (context management, token optimization,
and compaction) found the "PRs 1-4 (Parts A-C) landed as described" claim
above does not hold for Part C. The Decision text specifies the `PreCompact`
artifact carry the **PR number**, **open spoke journal paths** (discovered by
reusing `bin/spoke-recovery.mjs`'s journal-discovery logic), and **pending
gates**, written to the **session scratchpad**. What shipped in
`.claude/hooks/write-compact-handoff.mjs` is narrower by deliberate design,
documented in the hook's own header comment: no `gh` lookup (a `PreCompact`
hook runs on every compaction's hot path; a network round-trip was judged too
costly), no `bin/spoke-recovery.mjs` reuse (that script takes an explicit
`--journal <path>` rather than discovering journals itself, and a hook has no
documented way to address the ephemeral session-scratchpad directory a
subagent may have journaled to), "pending gates" approximated as `git status
--porcelain` rather than a live `pnpm verify` re-run, and the artifact written
to this repo's gitignored `tmp/` rather than the session scratchpad. These are
sound engineering trade-offs, made and recorded at implementation time — the
defect is this ADR's summary line, not the hook.

Per the immutability convention, the Decision section's Part C text is left
as originally written; this note is the correction. `bin/check-hooks.mjs`
also does not validate `matcher` values on `PreCompact`/`SessionStart`
entries, so a wiring regression on either hook (e.g. a typo in
`matcher: "compact"`) would not be caught by any gate today — tracked as a
follow-up in the same sweep's remediation plan
(`docs/research/harness-refresh.md`, first populated by this sweep).

## Links

- Supersedes / superseded by: none.
- Related: [ADR-0072 (reviewable-slice discipline, whose PR-sequencing this
  work follows)](./0072-reviewable-slice-discipline.md), [ADR-0016 (signed-commit
  enforcement and the pre-work decision gate)](./0016-signed-commits-and-decision-gate.md),
  [ADR-0013/0014 (worktree tooling, relevant to the prompt-cache-TTL
  decision)](./0013-git-worktrees-for-task-isolation.md).
- Evidence: `docs/research/context-window-and-compaction.md` (43-source
  synthesis); `docs/contributing/subagent-context-management.md` § Efficacy
  watch (the subagent-side precedent for durable artifacts over summaries).
- Gate: `bin/check-context-budget.mjs` (formerly `check-claude-md-budget.mjs`).
