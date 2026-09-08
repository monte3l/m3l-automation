# 0098. Raise the skill-listing budget fraction from 1% to 2%

- **Status:** Accepted
- **Relations:** partially-supersedes: 0089 (clauses: the Option 2 rejection — raising `skillListingBudgetFraction` — under §Decision and §Considered options)
- **Date:** 2026-09-08
- **Deciders:** Repo maintainer

## Context and problem statement

ADR-0089 (Accepted 2026-09-03) considered and explicitly rejected raising
`skillListingBudgetFraction`, on the reasoning that doing so "hides the
growth signal rather than addressing it — the listing would keep growing
unboundedly with no counter-pressure." It instead gated the listing budget as
a hard-fail check and trimmed the corpus from 21,684 to 7,734 characters,
under the ~8,000-character ceiling Anthropic's documented 1%-of-context-window
default implies at a 200,000-token window.

Five days later, designing a second skill pair
(`researching-typescript-guidance` / `refreshing-typescript-guidance`,
mirroring the existing Anthropic-guidance pair) pushed the corpus to
7,996/8,000 chars before either new description was added — 4 characters of
headroom. Adding both descriptions would push the total to ~8,804 chars, a
hard `check:context-budget` failure on the first push.

Live research against `code.claude.com/docs/en/skills` and
`code.claude.com/docs/en/settings-reference` (2026-09-08, four parallel
Explore agents, official Anthropic domains only) established two facts ADR-0089
did not have:

1. **The 1% figure is a documented _default_, not a fixed ceiling** —
   verbatim: "The budget scales at 1% of the model's context window." Anthropic
   names `skillListingBudgetFraction` as the supported lever to raise it (e.g.
   `0.02` = 2%), alongside `skillListingMaxDescChars` (per-entry cap) and
   `SLASH_COMMAND_TOOL_CHAR_BUDGET` (a fixed-character alternative). Overflow
   is **graceful degradation** — Claude Code drops descriptions starting with
   the least-invoked skills and logs a warning to the debug log — never an
   error. This repo's gate hard-fails the push instead, stricter than
   upstream's own behavior.
2. **The gate's denominator is a pre-existing scope limit, not something this
   raise creates or worsens.** All four skill sources — personal, project,
   plugin, and bundled — share one budgeted listing with no source-based
   carve-out (confirmed against `code.claude.com/docs/en/skills`, `/plugins`,
   and `/settings-reference`). `bin/check-context-budget.mjs` counts only
   `.claude/skills/` (22 entries, 7,996 chars); this session's environment
   separately carried ~6 enabled marketplace plugins and several Anthropic
   built-in skills, pushing the true contended listing to roughly 48
   entries. Uninstalling one plugin (`session-report`) during this same
   session measurably reduced the real listing but left the gate's own count
   of 22 unchanged, since the gate has no visibility into plugin-provided
   skills at all — true at 1% and equally true at 2%. This gate was never a
   precise proxy for a fair per-source share of the platform's true shared
   budget; it is a repo-hygiene ratchet against _this repo's own_
   uncontrolled description growth, with Claude Code's own graceful
   least-invoked-first degradation as the real backstop against true
   overflow of the full listing.

This does not resolve ADR-0089's underlying objection — "no established
practice for handling the next skill past a raised ceiling" — which is a
governance concern about counter-pressure, not a factual claim the new
evidence bears on directly. The maintainer was shown this conflict explicitly
before deciding: raising the fraction again, now with a wider corpus and an
accurately-scoped understanding of what the denominator does and doesn't
cover, is a considered choice to make once more, not an unnoticed reversal.

## Decision drivers

- Two genuinely new skills (`researching-typescript-guidance`,
  `refreshing-typescript-guidance`) should not have to cannibalize existing
  skills' trigger keywords to fit — ADR-0089 itself records that an earlier
  trim "over-cut trigger phrases the eval suite depended on" and five
  descriptions needed restoring.
- The gate's stated purpose (a repo-hygiene ratchet against this repo's own
  authored-description growth) and its actual denominator (repo-only) should
  stay honestly matched — the raise should not be framed as if it makes the
  local number a more accurate proxy for the platform's true shared budget,
  which it does not and was never meant to.
- ADR-0089's counter-pressure concern — growth must stay a conscious,
  reviewed choice, never silent — must survive this change, not be
  abandoned by it.

## Considered options

1. **Hold at 0.01 (do not raise); make room by trimming two existing,
   unencumbered descriptions** (`resolving-merge-conflicts`,
   `typescript-configuration` — the only two large descriptions not already
   carrying a gate-required GitHub/docs/m3l-MCP stance clause). Keeps
   ADR-0089's ceiling untouched but repeats the exact trim pattern that ADR-0089
   itself records as having gone wrong once (over-cutting trigger phrases).
2. **Raise `skillListingBudgetFraction` to 0.02.** Matches the documented
   upstream remedy directly; preserves the gate as a hard fail at the new
   ceiling, so growth still requires a conscious edit to this file and the
   settings key together.
3. **Drop one of the two new skills** to stay within the existing budget.
   Rejected outright — both skills answer distinct, independently-useful
   questions (on-demand research vs. periodic sweep), matching the existing
   Anthropic-guidance pair's own justification for two skills rather than one.

## Decision

We chose **option 2**. ADR-0089's counter-pressure concern is preserved, not
abandoned: `bin/check-context-budget.mjs`'s `checkSkillListingBudget` check
stays a hard fail at `SKILL_LISTING_ENFORCED_WINDOW` (200,000 tokens) — what
changes is only the number the corpus is measured against, moved from
Anthropic's 1% default to the 2% this repo now sets deliberately, matching
the settings key and the gate constant together so neither can drift from the
other silently.

ADR-0089's other decisions — the `/skill-name`-preferred invocation stance,
the skill-fired eval assertion (`evaluateSkillFired`), and the routing-surface
placement (`skill-routing.md` + `harness-guide`) — are unaffected and remain
in force. Only the specific Option 2 rejection under ADR-0089's own
§Considered options / §Decision is superseded.

## Consequences

- **Positive:** two new skills land as full descriptions without trimming
  any existing skill's trigger keywords; the gate's threshold now reflects a
  deliberately-chosen 2% rather than an unexamined default; the raise is
  itself gated (`pnpm check:context-budget` still hard-fails past 16,000
  chars at the 200k window), so a third addition past this new ceiling faces
  the same conscious-choice requirement ADR-0089 established, not a silently
  wider door.
- **Negative / trade-offs:** 0.02 is still a judgment call, not derived from
  a further external signal beyond "matches Anthropic's own worked example
  for raising the setting" — the next raise past this one needs the same
  ceremony (an ADR, since it would again touch a governed constraint). The
  gate's denominator still counts only `.claude/skills/`, so it remains an
  undercount of the true contended listing even at the new fraction; fixing
  that denominator to include enabled plugins and built-ins is a separate,
  larger piece of work this ADR does not attempt.
- **Semver impact:** none — internal harness tooling and documentation only;
  no `@m3l-automation/m3l-common` public API changed.

## Links

- Related: `bin/check-context-budget.mjs`, `.claude/settings.json`,
  `docs/contributing/instruction-authoring.md`,
  `.claude/skills/researching-typescript-guidance/SKILL.md`,
  `.claude/skills/refreshing-typescript-guidance/SKILL.md`
- Related: `code.claude.com/docs/en/skills`,
  `code.claude.com/docs/en/settings-reference` (sources for the 2026-09-08
  research this decision is based on)
