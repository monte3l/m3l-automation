# Skill-eval routing debt — implementation plan (2026-09-10)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** none new; executes issue #1087's own exit criterion
  (`docs/decision-notes/0004-skill-eval-pass-rate-floor.md`).
- **Why this plan exists:** `skill-evals.yml` gates at `MIN_PASS_RATE = 0.60`,
  deliberately set two cases below the observed 63.0-75.0% band as a
  collapse detector rather than a corpus gate. Issue #1087 is the debt
  keeping it there — ~93-95% of every failure in the calibration window is
  the `expect_skill_fired` routing assertion, not a criterion verdict, and
  12 of 92 cases fail in every run. Investigation found all 12 are
  mis-specified corpus data (7 negative-routing cases graded a skill
  correctly declining and naming a sibling while the default required it to
  fire; 4 are `/slug`-invoked prompts the CLI resolves before the model's
  turn; 1, `creating-prs#7`, is genuinely in-scope but two live probes
  confirmed the model satisfies every criterion without invoking the Skill
  tool inline) — not a routing regression from ADR-0089's listing trim, the
  issue's other candidate cause. Also corrects two premises the issue's text
  had drifted from by the time this plan started: the corpus is now 25
  skills / 98 cases / 468 criteria (not 23/92/432), and ADR-0098 raised the
  skill-listing budget fraction from 1% to 2% (16,000 chars, 7,137 headroom
  at 8,863 used), superseding ADR-0089's rejection of that raise.

## Scope and sequencing

| Stage | Contents                                                                                               | Shape                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **1** | Fix the 12 always-failing cases: `expect_routed_to` field + 3 static `check-skill-evals.mjs` guards    | Retires the always-failing 12; ships alone, first                       |
| **2** | Audit the flaky-50 tail for the same negative-routing defect                                           | Same mechanism as Stage 1, applied to a second, larger candidate set    |
| **3** | Raise `MIN_PASS_RATE` against the measured post-Stage-1/2 band + one `workflow_dispatch` run on `main` | The issue's exit criterion; needs Stages 1-2's data first               |
| **4** | Extend `main-health.yml` to open a tracking issue on a red scheduled `skill-evals` run                 | Independent gap (issue #1087's finding #1); no dependency on Stages 1-3 |

## Landing plan

ADR-0072's durable slice record for this non-submodule multi-PR wave — the
same `## Landing plan` heading and `| Slice | Branch | Scope | Status |`
table a submodule's reference page carries, gated by
`pnpm check:landing-plans`.

| Slice | Branch                                  | Scope                                                                                 | Status            |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| P1    | `fix/skill-eval-routing-assertions`     | `expect_routed_to` + fix the 12 always-failing cases + 3 static gate checks (Stage 1) | Landed (PR #1161) |
| P2    | `fix/skill-eval-flaky-negative-routing` | Audit and fix the flaky-50 tail for the same negative-routing defect (Stage 2)        | Landed (PR #1165) |
| P3    | `fix/raise-skill-eval-pass-rate-floor`  | Raise `MIN_PASS_RATE`; one deliberate `workflow_dispatch` run on `main` (Stage 3)     | In Progress       |
| P4    | —                                       | `main-health.yml` coverage for a red scheduled `skill-evals` run (Stage 4)            | To Do             |
