# Harness invocation, listing budget, and a routing surface

**Status: shipped** — five sequenced PRs: #907, #908, #914, #921, and this
PR (`feat/skill-routing-guide`), closing out an `/auditing`-triggered
5-PR plan. ADR-0089 records the invocation stance, the listing-budget
ceiling, and the placement decision.

## Context

The harness had grown to 22 skills, 10 agents, 28 hooks, 7 rules and 1
workflow with no recorded decision on how the model chooses among them.
Three questions prompted the audit: whether invoking skills as `/slash`
rather than in prose matters; whether the harness now needs a mechanism to
help the maintainer use it well; and where that mechanism should live.

Slash and prose turned out to be the same underlying mechanism with a
measurable divergence: prose depends on the model matching a request
against a skill's `description`, injected inside a skill-listing budget
capped at ~1% of the context window. Measured before this plan: 22
descriptions totaled 21,684 characters (~5,421 tokens) — 2.7x over the
~2,000-token budget a 200,000-token context window enforces.
`bin/check-context-budget.mjs` already printed this number and never
compared it to any budget.

## Approach / Decisions

Sequenced per ADR-0072 rather than one large PR — gate-then-trim (verifiable
over guessed), placement decided as both a durable doc and an in-session
surface, evals extended to assert which skill fired rather than only
self-graded response quality.

- **PR1 (#907) — hygiene and stale-claim fixes.** Corrected two "21 skills"
  header-comment claims (there are 22), de-duplicated a byte-identical eval
  case pair in `starting-work`'s corpus, and added the missing
  `finishing-work` row to `skills-catalog.md`.
- **PR2 (#908) — listing-budget gate, then trim.** Extended
  `check-context-budget.mjs` with `checkSkillListingBudget`, hard-failing on
  200k-window overflow. The approved plan's "trim the longest 5" scope
  turned out insufficient by measurement — even zeroing those 5 wouldn't
  reach budget — so all 22 descriptions were trimmed (~63% average
  reduction), confirmed with the user via `AskUserQuestion` before
  proceeding on the wider scope. A first CI failure
  (`check-integration-stance.mjs`) caught that the trim had dropped the
  literal string "ADR-0030" from 5 skills' GitHub-stance clauses; restored.
  Final listing: 7,739 of ~8,000 budget characters.
- **PR3 (#914) — skill frontmatter and overlap gates.** New
  `check:skill-frontmatter` (hard-fail empty description, hard-fail
  name/directory mismatch, hard-fail missing catalog row; warn-only on
  Jaccard description-overlap ≥ 15%, calibrated against the real 22-skill
  corpus). First CI failure was a missed fifth wiring location for any new
  `check:*` script — `bin/lib/command-catalog.mjs` — beyond the four already
  known (`package.json`, `lefthook.yml`, `ci.yml`, `verify-steps.mjs`,
  CLAUDE.md's cadence row).
- **PR4 (#921) — evals assert which skill fired.** A spike with
  `--output-format stream-json --verbose` confirmed a `Skill` tool
  invocation is observable mid-stream as a `tool_use` block, so
  `bin/run-skill-evals.mjs` switched formats and gained
  `parseStreamEvents`/`extractInvokedSkills`/`extractResultEnvelope`/
  `evaluateSkillFired`, failing a case whose skill under test never fired —
  additive to the existing pass/fail verdict, not a replacement.
  `starting-work`'s read-only-research case opts out via
  `expect_skill_fired: false`, since NOT firing is the behavior it tests.
- **PR5 (this PR) — the routing surface + ADR.**
  `docs/contributing/skill-routing.md` (a user-facing intent→skill table,
  unlike every other harness doc which addresses Claude), a new
  `.claude/skills/harness-guide/SKILL.md` (`disable-model-invocation: true`,
  reachable only via `/harness-guide`), `skills-catalog.md`'s usage-recheck
  section repointed at `pnpm telemetry:sessions`, and ADR-0089.

  Building `harness-guide` surfaced a second, structural blind spot in
  PR4's fired-skill mechanism: a prompt invoking a skill via a literal
  leading `/slug` is resolved by the CLI **before** the model's turn, so no
  `Skill` tool_use block ever appears even though the skill's instructions
  are genuinely followed (verified: the model correctly read a seeded
  routing-table file and answered from it). `harness-guide`'s own evals use
  `expect_skill_fired: false` for this reason, and `evaluateSkillFired`'s
  JSDoc now documents both opt-out reasons. Making `harness-guide` cost
  zero listing-budget chars also required extending
  `collectSkillDescriptions` to exclude any `disable-model-invocation: true`
  skill from the listing total, not just from the model's actual listing —
  confirmed empirically (`pnpm check:context-budget` reports 22 counted
  descriptions / 7,734 chars, unchanged, with `harness-guide` present as a
  23rd skill directory).

## Outcome

All 5 PRs merged; `pnpm verify` green on each. The listing-budget gate now
fails a push that regrows the listing past its enforced window; the
fired-skill assertion has a live, verified positive case
(`pnpm eval:skills starting-work`, 5/5 including the opt-out case) and a
live, verified `harness-guide` case (`pnpm eval:skills harness-guide`,
3/3, all correctly opted out). `docs/contributing/skill-routing.md` covers
all 23 skills (22 auto-invocable + `harness-guide`) organized by intent, and
ADR-0089 records the invocation stance, the budget ceiling, and the
placement decision for future reference.

Deliberately out of scope, per the original plan: adopting
`skillListingBudgetFraction` in `settings.json` (gate-then-trim was the
chosen approach — raising the fraction would hide the growth signal);
prose/slash A/B eval pairs (declined as roughly doubling eval cost — the
fired-skill assertion already detects silent non-firing); any change to the
hub-and-spoke model, agent roster, or wired hooks.
