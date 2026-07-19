# Integrate Anthropic stall/truncation guidance into spoke-recovery infrastructure (2026-07-19)

**Status: shipped** (commits `a75f3f7`, `756d40c` on `feat/subagent-stall-integration`)

## Context

The work logs recorded 20+ occurrences of subagent stalls across two modes:
writer-spoke mid-turn/summarization truncation, and review-fan-out stalls on
oversized scope (`docs/logs/2026-07-18-aws-athena.md`,
`-aws-eventbridge.md`, `-aws-s3.md`: 3-of-5 spokes stalled 30–60+ minutes,
fixed each time by narrowing the per-spoke file list). The repo already had a
strong manual playbook (`docs/contributing/subagent-context-management.md`,
the `spoke_recover` MCP tool, an advisory pre-dispatch journal hook), but
recovery was entirely hub-driven, and the `aws-eventbridge` log explicitly
flagged that the review-fan-out lesson was "not yet folded into a durable
rule." A 5-facet audit (via the `audit-fanout` workflow, 20 agents,
adversarial verify: 11 confirmed / 4 refuted) cross-referenced the repo
against a synthesized briefing of ~29 official Anthropic sources on subagent
stall detection, prevention, and recovery, surfacing concrete integration
gaps.

## Approach / Decisions

- **New `SubagentStop` hook, detector-only** (`.claude/hooks/detect-spoke-truncation.mjs`):
  the repo's first output-inspecting subagent hook, closing the gap that
  every prior hook in the dispatch lifecycle fired only _before_ dispatch.
  Scoped to advisory/notifier per an explicit user decision (over a
  detector-plus-auto-recovery variant) — it flags a suspicious-looking return
  and reminds the hub to verify, but never auto-invokes recovery itself. The
  first-draft heuristic (flag any message lacking terminal punctuation)
  false-positived on a clean bounded digest during manual testing and was
  tightened to three narrower signals (empty message, trailing ellipsis, an
  unclosed trailing-intent phrase) to stay quiet on legitimate output.
- **Codify the review-fan-out lesson**: a new "bound review-spoke INPUT
  scope too" bullet in `.claude/rules/subagent-dispatch.md`, mirrored into
  the Phase 4 step of both `implementing-submodules`/`implementing-scripts`
  `SKILL.md` files, plus a "converge and report" instruction added to all six
  reviewer prompts.
- **Bounded-output coverage**: `Explore.md` and `docs-consistency-reviewer.md`
  were the two spokes missing the "Bounded output (survive a turn limit)"
  scratchpad-spill pattern the other reviewers already carried; added per an
  explicit uniformity decision.
- **Journal verification-gating**: both writer-spoke prompts now instruct
  logging a step "done" only after its gate passes, closing a premature-
  completion gap in `spoke-recovery.mjs`'s positional `outstandingPending`
  heuristic (documented via a cross-linking comment, no behavioral change).
- **Doc drift**: `docs/contributing/hooks-reference.md`'s table was stale
  (18 rows vs. 19 wired hooks at audit time, now 20 with the new hook);
  `CLAUDE.md`'s hook count, `subagent-context-management.md`'s detection-
  signal list (added the Claude Code v2.1.199 partial-output behavior and
  `ResultMessage` subtypes), and `agent-operating-model.md`'s recovery-tool
  cross-reference were all brought current.
- **Research snapshot persisted**: `docs/research/subagent-stall-recovery.md`,
  synthesizing the 5-facet Anthropic-guidance research pass, per an explicit
  user decision to keep a standing reference rather than leave it inline-only.
- Three audit findings were **deliberately not acted on** (refuted by the
  workflow's adversarial verify pass, confirmed correct on inspection): the
  memory-tool "ASSUME INTERRUPTION" protocol doesn't apply (a category
  mismatch — this repo's same-session `SendMessage` resume already satisfies
  the specific Anthropic quote the journal pattern is grounded on); a
  claimed JSON-vs-Markdown journal durability gap was backwards (Markdown/
  line-based logging degrades more gracefully under truncation); and an
  append-log-vs-checklist "inconsistency" was already explicitly reconciled
  in `outstandingPending`'s own docstring.

## Outcome

21 files changed across two commits (`a75f3f7` implementation, `756d40c`
work log), zero `src/`/`tests/`/exports-map changes, zero semver impact. All
quality gates passed on first full run: `check:hooks` (20 wired hooks),
`check:agents`, `check:doc-counts`, `check:index`, `lint:md`, `eslint`,
`typecheck`, `format:check`, the full test suite (132 files / 3,865 tests,
97.61% statement coverage), and `build`. See
[`docs/logs/2026-07-19-subagent-stall-integration.md`](../../logs/2026-07-19-subagent-stall-integration.md)
for the full narrative, including the truncation-heuristic divergence and
its lesson.
