# Instruction authoring: which tier does it go in?

You have a new instruction for Claude Code to follow in this repo — a
constraint, a convention, a procedure — and need to know where it lives:
CLAUDE.md, a path-scoped rule, an agent prompt, a skill, a hook, or a
`docs/contributing/` page. This is the authoring counterpart to
[`skill-routing.md`](./skill-routing.md)'s lookup table: that page answers
"which skill handles X"; this one answers "where does a new instruction go."

The policy below isn't new — it ratifies an arrangement already in force.
CLAUDE.md's own maintainer comment has carried an `EVICTION RULES` note
since the file's budget was first enforced (ADR-0078), but that note sits
inside an HTML comment stripped before injection, so neither Claude nor a
contributor browsing `docs/` could ever read it. This page is that note,
completed to six tiers and made visible.
([Decision note 0005](../decision-notes/0005-instruction-tier-placement.md)
records why a note rather than an ADR.)

## The six tiers

| Tier                            | When it loads                                                                                                                                                         | What it costs                                                                                                                                                                                                                                   | Route here when…                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                     | Every session, every spoke dispatch                                                                                                                                   | Hard cap: 200 lines / ~3,000 tokens, enforced by `pnpm check:context-budget` (ADR-0078). Historically runs close to full — check the gate's own output before assuming there's room; an addition often needs an offsetting trim in the same PR. | Every session needs it, and it's short enough to survive being read every time.                         |
| `.claude/rules/*.md`            | Conditionally, when an edited/read file matches its `paths:` glob                                                                                                     | Ratchet: an unbaselined file must stay ≤10,000 bytes (`RULE_CEILING_BYTES`); a baselined file may shrink but never grow.                                                                                                                        | It's a constraint or convention scoped to files matching one glob pattern.                              |
| `.claude/agents/*.md`           | Only inside that one spoke's own dispatch                                                                                                                             | Not budget-gated; paid once per dispatch of that spoke, never by the hub.                                                                                                                                                                       | It's a tactic for how one specific writer or reviewer spoke should behave.                              |
| `.claude/skills/*/SKILL.md`     | On explicit `/slug` invocation (deterministic) or prose match (subject to the ~16,000-char aggregate skill-listing budget, `SKILL_LISTING_BUDGET_FRACTION`, ADR-0098) | Per-description WARN at 1,536 chars; aggregate listing is a HARD ceiling — an overflow drops the least-invoked skills' descriptions first.                                                                                                      | It's a multi-step procedure with an ordering that matters.                                              |
| Hooks (`.claude/settings.json`) | Deterministically, on the wired lifecycle event, whether or not Claude "remembers"                                                                                    | No context budget at all — it's config, not prose.                                                                                                                                                                                              | The rule must **always** hold, with no dependence on the model reading and following prose.             |
| `docs/contributing/*.md`        | Only when a human or Claude deliberately reads it                                                                                                                     | No enforced budget; gated only by `lint:md`/`format:check`/`check:control-chars` like any other doc.                                                                                                                                            | It's explanation, rationale, or a lookup table — not something a session needs loaded to act correctly. |

## The decision sequence

Ask in this order; stop at the first "yes":

1. **Must it always hold, with no room for the model to miss it?** → a hook.
   CLAUDE.md is advisory context Claude reads, not enforced config — see
   [`hooks-reference.md`](./hooks-reference.md)'s framing of the same split.
2. **Is it a multi-step procedure, or does step order matter?** → a skill.
3. **Is it scoped to files matching one path pattern?** → a rule, with
   `paths:` frontmatter naming that pattern.
4. **Is it specific to how one spoke (a writer or reviewer agent) should
   act, not a general convention?** → that agent's own file.
5. **Does every session need it, and is it short?** → CLAUDE.md.
6. **Is it explanation rather than something a session must act on
   unprompted?** → a `docs/contributing/*.md` page, linked from wherever a
   session would actually need it.

If an insight could land in two places, prefer the most specific one an agent
actually reads while doing the relevant work — a tactic buried in CLAUDE.md
is weaker than the same tactic in the spoke prompt that governs the task.
(This is the one line inherited unchanged from the promotion-time tiebreak
this page now supersedes — see [Superseding note](#superseding-note) below.)

## The budgets are real, and three of them are hard

`pnpm check:context-budget` (ADR-0078) enforces three ceilings, in this
repo's pre-push cadence:

- **CLAUDE.md's always-loaded content** — 200 lines / ~3,000 tokens,
  comment-stripped, blank-run-collapsed, including any resolved `@path`
  import as its own block (an import expands in full at launch; it is
  never free). This is the tightest budget in the repo today.
- **The `.claude/rules/*.md` ratchet** — see the table above. A rule only
  ever gets cheaper to add, never more expensive without a deliberate
  baseline bump.
- **The aggregate skill-listing budget** — every skill description Claude
  Code holds in context to decide which skill a prose request matches,
  summed against ~2% of a 200,000-token context window (raised from
  Anthropic's 1% default — ADR-0098). `/slug` invocation
  bypasses this entirely (`skill-routing.md`'s "Slash command or plain
  English" section) — a skill you invoke by name never needs to fit here.

Two are informational only, tracked for visibility but not gated: total
`.claude/skills/*/SKILL.md` body bytes, and total `.claude/agents/*.md` body
bytes.

## Registration is not optional

Writing the file is half the work — each tier also needs to be _registered_
somewhere else, or it silently never fires. Every tier but one has a
machine-checked completeness gate:

| Tier                 | Registration step                                                                                                                      | Enforced by                                                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills               | A row in [`skills-catalog.md`](./skills-catalog.md)                                                                                    | `bin/lib/skill-frontmatter.mjs`'s catalog check (`pnpm check:skill-frontmatter`) — hard-fails a skill directory absent from the catalog text.                                                                                                                                 |
| Agents               | A row in the `MODEL-MATRIX` block of [`model-selection.md`](./model-selection.md)                                                      | `bin/check-agents.mjs` — hard-fails in both directions: an agent with no matrix row, and a matrix row naming no agent.                                                                                                                                                        |
| Hooks                | A row in [`hooks-reference.md`](./hooks-reference.md)                                                                                  | `bin/check-hooks.mjs` — hard-fails on table/wiring parity.                                                                                                                                                                                                                    |
| Rules                | A bullet in this file's CLAUDE.md counterpart, `## Coding, errors & tests (path-scoped)`, naming the rule and its exact `paths:` globs | `pnpm check:context-budget`'s `diffRuleGlobParity` (glob parity) and `deriveRuleRegistrationGaps` (registration completeness — an orphaned rule file, a phantom CLAUDE.md bullet, or a rule with no `paths:` at all, so it can never load regardless of what CLAUDE.md says). |
| CLAUDE.md            | None — it's read in full every session by construction                                                                                 | N/A                                                                                                                                                                                                                                                                           |
| `docs/contributing/` | A row in [`docs/README.md`](../README.md)'s Contributing section                                                                       | None — hand-maintained, not gated.                                                                                                                                                                                                                                            |

The rules row above closes a hole found while writing this page: rules were
the only tier with no bidirectional completeness check.
`bin/check-context-budget.mjs`'s own history records the CLAUDE.md-vs-rules
prose drifting apart twice before `diffRuleGlobParity` existed at all — and
that check only ever compared globs for rules documented on _both_ sides,
so an unregistered rule (no CLAUDE.md bullet, or no `paths:` frontmatter)
still passed with zero mismatches. `deriveRuleRegistrationGaps` closes that,
additively, in the same gate.

## Superseding note

`promoting-work-log-insights`/SKILL.md Step 3 held the only routing guidance
that existed before this page, scoped to insights promoted from a work log
and missing hooks as a destination entirely. Step 3 now cites this page
instead of restating its own copy of the tier list.

## See also

- [Skill routing guide](./skill-routing.md) — the "which skill handles X"
  counterpart to this page's "where does a new instruction go"
- [Agent operating model](./agent-operating-model.md) — the hub-and-spoke
  split that agent prompts encode
- [Hooks reference](./hooks-reference.md) — the full wired-hook inventory
- [Skills catalog](./skills-catalog.md) — naming convention and usage tiers
- [Decision note 0005](../decision-notes/0005-instruction-tier-placement.md) —
  the record of this policy as a decision
