# 0005. Name and complete the six instruction-authoring tiers

- **Date:** 2026-09-07
- **Decider:** repo maintainer

Issue #1001 (ROADMAP H8) reported no documented policy for where a new
Claude Code instruction belongs — CLAUDE.md, a path-scoped rule, an agent
prompt, a skill, a hook, or `docs/contributing/`. Re-deriving the premise
found the policy already existed, just nowhere anyone could read it: an
`EVICTION RULES` block sits inside CLAUDE.md's own maintainer comment
(`CLAUDE.md:22-29`), stripped by `stripBlockComments` before injection, so
neither Claude nor a contributor browsing `docs/` ever sees it. The only
other routing text, `promoting-work-log-lessons`/SKILL.md Step 3, is a
promotion-time tiebreak that fires only when a work-log lesson is being
routed, and omits hooks as a destination entirely. This note ratifies the
arrangement already in force — the tiers, their order, and which one wins a
tie — rather than inventing a new one; that "we'd just be naming what's
already true" character is the decision-notes bar (ADR-0095), not an ADR's.

The publish-time work also found the one deterministic hole this policy
touches: `.claude/rules/*` is the only harness artifact class with no
completeness gate against its own registration. Skills, agents, and hooks
each hard-fail an unregistered artifact (`bin/lib/skill-frontmatter.mjs`'s
catalog check, `bin/check-agents.mjs`'s MODEL-MATRIX parity, `bin/check-hooks.mjs`'s
table parity); `diffRuleGlobParity` in `bin/check-context-budget.mjs`
deliberately skips a rule file with no CLAUDE.md bullet (asserted in its own
test), and that gap is real — its own header records the CLAUDE.md/rule-glob
prose drifting apart twice before that check existed. `deriveRuleRegistrationGaps`
closes it additively, in the same gate, with no new script or lefthook row:
an unregistered rule, a phantom CLAUDE.md bullet naming a rule that no
longer exists, and a rule with no (or empty) `paths:` frontmatter — which
can never conditionally load regardless of what CLAUDE.md says about it —
now all hard-fail `pnpm check:context-budget`.

The tier choice itself stays prose. No glob can decide whether a given
instruction is a rule or a skill; only the deterministic registration
failure that follows from _any_ choice is machine-checkable, which is the
line the new gate holds and no further.

## Links

- Related: [#1001](https://github.com/monte3l/m3l-automation/issues/1001)
  (ROADMAP H8), `docs/contributing/instruction-authoring.md` (the canonical
  page this note backs), ADR-0078 (the context budget this gate lives
  inside), ADR-0095 (the decision-note tier this record uses)
