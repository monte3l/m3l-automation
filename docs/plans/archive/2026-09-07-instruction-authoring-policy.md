# Document the instruction-authoring policy (issue #1001, H8)

**Status: shipped** — PR pending (this archive lands in the same PR).

## Context

`docs/ROADMAP.md`'s H8 governance row (synced to GitHub issue #1001) recorded
that the repo had no documented policy for where a new Claude Code
instruction belongs — CLAUDE.md, a path-scoped rule, an agent prompt, a
skill, a hook, or `docs/contributing/`. The only routing text was
`promoting-work-log-lessons`/SKILL.md Step 3, a promotion-time tiebreak
reachable only through that skill, missing hooks as a destination entirely.

Re-deriving the premise found the policy already existed, invisibly:
CLAUDE.md's own maintainer comment carries an `EVICTION RULES` note, stripped
by `stripBlockComments` before injection, so neither Claude nor a contributor
browsing `docs/` could ever read it. This work promotes and completes that
note rather than inventing a new policy.

Assessing the issue also surfaced one real, machine-checkable gap: rules were
the only harness artifact class with no bidirectional completeness gate
against their own registry — skills, agents, and hooks each already hard-fail
an unregistered artifact. A simulation proved it: a rule file with empty
`paths:` frontmatter and no CLAUDE.md bullet passed `diffRuleGlobParity` with
zero mismatches, since that check only ever compares rules documented on
both sides.

## Approach / Decisions

- **A new canonical page, `docs/contributing/instruction-authoring.md`**, not
  folded into `skill-routing.md` — the two answer different questions
  ("which skill handles X" vs. "where does a new instruction go") and each
  already has enough content to stand alone.
- **A decision note, not an ADR**, for the placement rule
  (`docs/decision-notes/0005-instruction-tier-placement.md`, per ADR-0095).
  The policy ratifies an arrangement already in force; nothing else depends
  on its exact tier boundaries — the "we'd just change it and move on" bar
  that separates a note from an ADR. Numbered 0005, not 0003 or 0004: two
  separate rebases onto a fast-moving `origin/main` each found the number
  already claimed — H6's own decision note took 0003, then a skill-eval
  collapse-detector note took 0004 — both provisional-number collisions, the
  same class the ADR corpus already handles.
- **The tier choice stays prose; only the deterministic registration gap is
  gated.** No glob can decide whether an instruction is a rule or a skill.
  `deriveRuleRegistrationGaps` was added to the existing
  `bin/check-context-budget.mjs` (no new script, lefthook row, or cadence
  entry) to catch an orphaned rule file, a phantom CLAUDE.md bullet, or a
  pathless rule — mirroring `bin/check-agents.mjs`'s bidirectional
  agent-vs-MODEL-MATRIX shape. `diffRuleGlobParity` was narrowed to skip a
  rule with empty `paths:`, so a documented-but-pathless rule reports once,
  not twice, for one root cause. Verified live against a scratch probe file
  (each failure mode fires, then cleaned up) before writing the synthetic
  test suite, per `.claude/rules/harness-artifacts.md`.
- **`promoting-work-log-lessons` Step 3 collapsed to a citation**, keeping
  the four rule filenames inline — `bin/run-skill-evals.mjs`'s sandbox
  copies only `.claude/skills/`, not `docs/`, and this skill's own
  `evals.json` grades the response naming `.claude/rules/tests.md` as the
  promotion destination. Dropping the names would have silently degraded
  that eval with no gate catching it.
- **The CLAUDE.md pointer paid for itself.** Swapping the hooks/skills
  paragraph for a pointer to the new page was net −59 chars against the
  ~3,000-token budget (which was running at ~1 token of headroom before this
  change), so no separate trim was needed.

## Outcome

Seven commits: the new page + `docs/README.md` index row; the decision note +
its index row; the CLAUDE.md pointer swap + a `skill-routing.md` cross-link;
the `promoting-work-log-lessons` Step 3 collapse; the
`deriveRuleRegistrationGaps` gate + 7 new tests in
`bin/tests/check-context-budget.test.ts` (112/112 passing); a `docs:
reconcile doc metadata` commit (`docs/adr/provenance.json` re-stamped for
the CLAUDE.md edit); and this archive. `pnpm verify` passed in full (66/66
steps) both before and after rebasing onto `origin/main`. `docs/ROADMAP.md`'s
H8 row flips to `Done` and issue #1001 closes on the post-merge `pnpm
sync:hub -- --apply` run (`finishing-work` Step 5), not on merge alone.
