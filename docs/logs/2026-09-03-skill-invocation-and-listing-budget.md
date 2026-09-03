# Work log — `skill-invocation-and-listing-budget` (2026-09-03)

This log covers the whole 5-PR initiative that closed ADR-0089: an
`/auditing`-triggered investigation into whether `/slash` vs. prose skill
invocation matters, whether the 22-skill harness needed a routing
mechanism, and where that mechanism should live. It records what shipped
across all five sequenced PRs, what matched the approved plan, what
diverged and why, and durable lessons for the next harness-scale change.

Plan of record: [`docs/plans/archive/2026-09-03-skill-invocation-and-listing-budget.md`](../plans/archive/2026-09-03-skill-invocation-and-listing-budget.md)

## Summary

Five sequenced PRs (ADR-0072 discipline), each independently reviewed and
merged:

- **PR1 (#907)** — hygiene: corrected two stale "21 skills" claims, de-duplicated
  a byte-identical eval case, added `finishing-work`'s missing catalog row.
- **PR2 (#908)** — `checkSkillListingBudget` hard-fail gate in
  `check-context-budget.mjs`; trimmed all 22 skill descriptions from 21,684 to
  ~7,700 chars (the plan's "trim the longest 5" scope was measurably
  insufficient — confirmed with the user before widening it to all 22).
- **PR3 (#914)** — `check:skill-frontmatter` (empty-description/name-mismatch/
  catalog-coverage hard gates, description-overlap warning at a 15% Jaccard
  threshold calibrated against the real corpus).
- **PR4 (#921)** — switched `run-skill-evals.mjs` to `--output-format
stream-json`, added `evaluateSkillFired`/`extractInvokedSkills` to assert the
  skill under test actually fired, closing the selection-level version of
  CI-run-33390425486's loading-level defect.
- **PR5 (#924)** — `docs/contributing/skill-routing.md` (user-facing
  intent→skill table), `.claude/skills/harness-guide/SKILL.md`
  (`disable-model-invocation: true`, zero listing cost — verified
  empirically), repointed `skills-catalog.md`'s usage-recheck section at
  `pnpm telemetry:sessions`, and ADR-0089.

`pnpm verify` passed on every PR before push (58 steps each). Final skill
listing: 7,739 of ~8,000 budget characters at a 200,000-token context window.

**Skills used:** auditing, starting-work, creating-prs, syncing-docs,
triaging-ci, finishing-work, writing-work-logs.

**Spoke incidents:** 1 truncation (recorded in `tmp/session-incidents.jsonl`,
predates this log's visible session context — likely from a pre-compaction
dispatch) / 0 stalls / 0 `SendMessage` resumes needed. Every writer-spoke
(`test-author`) dispatch this session converged cleanly on its first pass;
one review-spoke dispatch (PR2's `docs-consistency-reviewer`) truncated at
its 40-turn limit with zero output on an over-broad 6-check/24-file scope —
resolved by narrowing to a single focused re-dispatch via a `fork` rather
than a full re-dispatch, per `.claude/rules/subagent-dispatch.md`'s own
bound-review-scope rule (see divergence #4 below).

**Compaction events:** 2 compactions / 2 recovered via the ADR-0078 handoff
artifact — one automatic mid-conversation summary (recovered correctly, work
resumed from the exact PR3 in-progress state) and one explicit `/compact`
(the `SessionStart` re-injection was verified against live `git status`
before acting on it, per the handoff's own re-verify instruction). No state
was lost in either case.

## What went as planned

- **PR1 landed with zero CI friction** — pure hygiene, no gate touched a
  behavior it hadn't already covered.
- **The listing-budget gate's design matched the plan exactly** once the trim
  scope was corrected — hard-fail at the 200k-window budget, informational at
  1M, both windows reported together so a 200k overflow is visible even from
  a 1M session.
- **PR3's overlap-threshold calibration held with zero false positives** — the
  0.15 Jaccard threshold, chosen by probing the real 22-skill corpus, caught
  exactly the 3 pairs already independently flagged as legitimate clusters
  and nothing else.
- **PR4's spike-first approach paid off immediately.** Verifying
  `--output-format stream-json` actually surfaces `Skill` tool_use blocks
  (via a real `claude -p` probe) before writing any implementation meant the
  whole mechanism was built once, correctly, with no rework.
- **PR4's live end-to-end smoke test passed on the first run** —
  `pnpm eval:skills starting-work`, 5/5 including the `expect_skill_fired:
false` opt-out case.
- **PR5's zero-listing-cost claim for `harness-guide` was correct on first
  implementation** — `pnpm check:context-budget` showed 22 counted
  descriptions both before and after adding the skill, no iteration needed.
- **Hub-and-spoke discipline held throughout.** Every guarded-path edit
  (`bin/tests/*.test.ts`) was routed to `test-author`, never hub-authored
  directly, across all 5 PRs.

## What didn't go as planned, and why

### 1. PR2's trim scope was underestimated in the approved plan

The plan said "trim the longest 5 descriptions." Measurement showed that even
zeroing those 5 entirely would not reach the ~8,000-char budget — all 22
needed roughly a 63% average reduction. This was surfaced explicitly via
`AskUserQuestion` rather than silently expanding scope, and the user
confirmed "Trim all 22 to fit."

**Why it happened:** The plan's scope estimate was a reasonable guess from
the audit phase, made before the actual per-skill character counts were
tallied against the real budget arithmetic.

**Fix for future:** When a plan names a specific remediation scope ("trim the
longest N"), verify the scope closes the actual gap by doing the arithmetic
before starting the edit — not after a partial trim reveals it's insufficient.

### 2. PR2's trim silently dropped a machine-checked substring

The bulk trim of all 22 descriptions removed the literal string "ADR-0030"
from 5 skills' compacted "GitHub stance:" clauses, tripping
`check-integration-stance.mjs` in CI (that gate requires the literal ADR
reference in any skill's frontmatter whose body talks to GitHub via
`gh`/`mcp__github__`).

**Why it happened:** A bulk rewrite optimizing for character count treated
every clause as equally compressible prose, when one substring inside it was
actually a machine-checked token a downstream gate depended on.

**Fix for future:** Before a bulk text-compression edit across many files,
grep the affected files for any substring a `check:*` gate is known to assert
on literally, and treat those substrings as non-negotiable regardless of
length pressure.

### 3. An over-broad review dispatch truncated with zero output

A single `docs-consistency-reviewer` dispatch asking 6 checks across 24 files
in PR2 hit its 40-turn limit and returned nothing substantive.

**Why it happened:** The dispatch scope (6 checks × 24 files) was sized to
the task's total surface rather than to what one spoke turn can converge on
— exactly the failure mode `.claude/rules/subagent-dispatch.md` already
documents ("bound review-spoke INPUT scope too, not just output").

**Fix for future:** Already codified in the existing rule; this was a live
confirmation instance, not a new lesson. Verified 5 of 6 checks directly and
resumed the spoke narrowly (via `fork`, not a fresh broad dispatch) for the
one check needing independent judgment.

### 4. PR3's worktree and branch vanished mid-session

An `EnterWorktree` call was rejected by the user with "Rebase on main then
get back to work." Investigation found the previously-created
`feat/skill-frontmatter-gates` worktree and branch had both disappeared
entirely — traced to concurrent session activity in the shared checkout.

**Why it happened:** Another session was actively using the shared checkout
for unrelated work at the same time, and its own branch operations removed
state this session depended on.

**Fix for future:** Confirmed nothing was lost (the branch had zero commits)
before recreating; this reinforces the existing preference for a linked
worktree over the shared checkout whenever concurrent session activity is a
realistic risk — which the rest of this initiative's PRs (2 through 5) then
consistently used.

### 5. A `check:*` gate needs a fifth wiring location, not four

PR3's first CI failure was `check:command-catalog` — every `package.json`
script needs a matching entry in `bin/lib/command-catalog.mjs`, a wiring
location beyond the four already tracked (`package.json`, `lefthook.yml`,
`.github/workflows/ci.yml`, `bin/lib/verify-steps.mjs`, CLAUDE.md's cadence
table).

**Why it happened:** The four-location convention was carried forward from
memory without re-verifying it against the actual set of gates a new
`check:*` script must satisfy in this repo's current state.

**Fix for future:** Applied for the rest of this initiative (PR4/PR5 needed
no new `check:*` scripts, so this didn't recur) — the corrected five-location
list is: `package.json`, `lefthook.yml`, `ci.yml`, `verify-steps.mjs`,
CLAUDE.md's cadence table, **and** `bin/lib/command-catalog.mjs`.

### 6. A live repo-policy change landed mid-session

A concurrent session merged PRs that made `commit-msg` strip/reject any
`Claude-*` git trailer other than `Co-Authored-By:`, and updated
`creating-prs/SKILL.md` to forbid a session-link footer in PR bodies.

**Why it happened:** External, unrelated to this initiative — the repo's own
harness-hygiene work landed concurrently and changed a convention this
session had been following.

**Fix for future:** Adopted immediately upon discovery (dropped the trailer
and the session-link line from all subsequent commits/PRs in this
initiative, starting with PR3). No promotion needed — the enforcement is now
mechanical (`commit-msg` hook), not something to remember by convention.

### 7. `harness-guide`'s evals surfaced a second, structural blind spot in PR4's own mechanism

Building `harness-guide` — a skill reachable only via the literal
`/harness-guide` command — required its eval prompts to use that literal
slash prefix, since `disable-model-invocation: true` makes it unreachable by
prose. A live probe found that a `/slug`-prefixed prompt is resolved by the
CLI **before** the model's turn: the skill's instructions were genuinely
followed (verified — the model correctly read a seeded file and answered
from it), but no `Skill` tool_use block ever appeared in the stream, because
the model never autonomously chose to call the tool.

**Why it happened:** PR4's fired-skill assertion was designed and verified
against prose-triggered invocation only (the entire pre-existing 85-case
corpus is prose), so this second invocation path was untested territory
until a skill that could only be invoked the other way was built.

**Fix for future:** Documented both opt-out reasons in `evaluateSkillFired`'s
JSDoc; `harness-guide`'s 3 eval cases use `expect_skill_fired: false`
explicitly for this reason, distinct from `starting-work`#4's "not firing is
the correct behavior" exemption.

### 8. A drafted ADR number was claimed by a concurrent PR

The new ADR was drafted as 0088, then a different, unrelated PR (#920,
automatic session naming) merged first and claimed that number.

**Why it happened:** Exactly the scenario `docs/adr/README.md`'s own
Conventions section already names: "a faster-merging sibling PR can claim
the same number first."

**Fix for future:** Already documented and this session followed the
documented procedure precisely — renumbered the file to 0089, fixed every
cross-reference (`grep -rl` the old number/filename across the change),
resolved the resulting rebase conflict in `docs/adr/README.md`'s index
table, and re-verified before pushing. No new lesson to promote; a clean
confirmation of an existing procedure.

## Lessons learned

- **Verify a remediation scope closes the actual gap before starting.** A
  plan naming "trim the longest N" is a guess until the arithmetic is done
  against the real numbers — do the math first, or expect to re-scope
  mid-task via `AskUserQuestion` rather than silently expanding.
- **A bulk text-compression edit can silently strip a machine-checked
  substring.** Grep for known gate-asserted literals (an ADR reference, a
  required phrase) before and after a broad rewrite across many files.
- **Spike observable CLI behavior before designing an assertion around it —
  and re-spike when the invocation SHAPE changes, not just when the mechanism
  is new.** PR4 correctly spiked prose-triggered `Skill` tool_use once; the
  same care was needed again when PR5 introduced a genuinely different
  invocation shape (`/slug`-prefixed) that the original spike never covered.
- **The check:\* gate wiring count for a new script is five, not four** —
  `bin/lib/command-catalog.mjs` joins `package.json`, `lefthook.yml`,
  `ci.yml`, `verify-steps.mjs`, and CLAUDE.md's cadence table.
- **A drafted-but-unpushed sequential ID is provisional, not reserved** —
  already documented in `docs/adr/README.md`; this session is a second live
  confirmation that the recovery procedure works as written (the first was
  `docs/logs/2026-09-02-session-naming-convention.md`).
- **Bounding review-spoke input scope, not just output, prevents silent
  truncation** — already codified in `.claude/rules/subagent-dispatch.md`;
  this session's PR2 dispatch is another confirming instance, resolved by
  narrowing and resuming via `fork` rather than a fresh broad re-dispatch.

## Follow-ups filed

None. Every deliberately-out-of-scope item from the originating plan
(adopting `skillListingBudgetFraction`, prose/slash A/B eval pairs, any
change to the hub-and-spoke model/agent roster/wired hooks) was a considered
rejection with stated reasoning, not a deferred gap — nothing here rises to
a `docs/plans/IMPLEMENTATION.md` friction item.
