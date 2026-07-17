# Skills catalog and usage audit (2026-07-17)

This is the durable reference for "how often should this skill fire?" A usage
audit on 2026-07-17 found several skills with zero or very low usage evidence
in `docs/logs/` and git history, and traced each one to a specific cause
before proposing any fix. The tables below record that classification so a
future reader doesn't have to re-run the audit to tell "working as intended"
apart from "actually neglected."

**Read this before "fixing" a low-usage skill.** Several skills in this repo
are intentionally low-frequency — an incident-response skill firing rarely
means the repo is healthy, not that the skill is unused. See
[Low usage ≠ broken](#low-usage--broken) below before changing a skill's
trigger conditions on the basis of a low mention count alone.

## Usage tiers

### Core pipeline — high usage, this is the primary work loop

| Skill                     | Purpose                               | Evidence (as of 2026-07-17)                                     |
| ------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `starting-work`           | Pre-work branch/worktree/PR/push gate | ~28 mentions across `docs/logs` and `docs/plans/archive`        |
| `implementing-submodules` | TDD loop for Core/AWS library modules | ~44 mentions; referenced in all 20 submodule work logs          |
| `scaffolding-submodules`  | Greenfield library module scaffold    | ~10 mentions                                                    |
| `implementing-scripts`    | TDD loop for consumer scripts         | ~19 mentions                                                    |
| `scaffolding-scripts`     | Greenfield consumer-script scaffold   | ~18 mentions                                                    |
| `syncing-docs`            | Doc/provenance/exports reconciliation | ~67 mentions — the single most-referenced skill                 |
| `auditing`                | Fan-out audit + plan, no code writes  | ~29 mentions                                                    |
| `creating-prs`            | Quality gates → push → PR             | ~14 mentions in logs/plans, plus 4 direct git-commit references |

### Confirmed used, but undercounted by a name-grep audit

| Skill                   | Why it looked unused                                                | Actual evidence                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolving-pr-comments` | Grepping `docs/logs`/git for the literal skill name returned 0 hits | 9+ commits ("resolve claude-pr-review must-fix findings") confirm it fires every time a PR gets a FAIL verdict — it's just narrated by what it did, not by its own name |

This is the strongest argument for the traceability fix in
[How to re-check usage](#how-to-re-check-usage): a skill can be in active,
correct use and still read as "zero usage" to a naive grep.

### Low usage by design — the repo is currently healthy

These are incident-response skills. A quiet skill means there's nothing to
respond to right now, not that the skill has gone stale.

| Skill                      | Trigger condition                     | State as of 2026-07-17                                                        |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| `triaging-ci`              | A CI run fails                        | 0 failures in the last 50 workflow runs (44 success, 4 skipped, 1 cancelled)  |
| `triaging-scan-alerts`     | An open CodeQL/Scorecard alert exists | 0 open alerts (5 fixed, 4 dismissed)                                          |
| `reviewing-dependabot-prs` | An open Dependabot PR exists          | 0 open Dependabot PRs right now; 13+ already reviewed and merged historically |

### Low usage by design — the trigger is structurally rare

| Skill                       | Trigger condition                                                | Evidence                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolving-merge-conflicts` | An active rebase/merge has real (non-derived-artifact) conflicts | ADR-0024's registered merge driver auto-resolves most derived-artifact conflicts (`catalog.json`, `symbol-map.json`, `pnpm-lock.yaml`) before this skill would ever need to run |
| `tsconfig-strict-esm`       | Editing `tsconfig*.json`                                         | `tsconfig.base.json` has been edited exactly once in the repo's entire history                                                                                                  |

### Path-scoped reference skills — likely under-narrated, not under-used

These auto-load when their file-pattern matches (per `CLAUDE.md`'s "Coding,
errors & tests" section). A session that touches `eslint.config.js` loads
`eslint-flat-config` automatically; nobody writes "used eslint-flat-config" in
a work log for that, so log-mention counts undercount how often these
actually apply.

| Skill                         | File-edit opportunity                                                                                                                       | Skill-name mentions |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `eslint-flat-config`          | 15 commits touching `eslint.config.js`                                                                                                      | ~3                  |
| `vitest-coverage-types-mocks` | 4 commits touching `vitest.config.ts`, plus every mock-writing/coverage-failure session (broader trigger surface than just the config file) | ~3                  |

### Habitual, likely absorbed into default behavior

| Skill             | Evidence                                                 | Why this probably isn't a gap                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writing-commits` | Only 1 explicit mention despite 150+ commits in the repo | The `commit-msg` hook (`bin/lint-commit.mjs`) enforces the same Conventional Commits shape on every commit regardless of whether the skill's checklist was explicitly walked — the guidance is baked into default agent behavior via `CLAUDE.md`'s Git Workflow section, not just the skill |

### Periodic maintenance — genuine gap

| Skill                        | Evidence                             | Gap                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promoting-work-log-lessons` | ~3 mentions; no scheduling mechanism | 20+ work logs have accumulated since the pipeline started with no clear evidence the periodic sweep has run recently. See `docs/logs/README.md` for the manual cadence note added alongside this catalog. |

### Moderate — possibly bypassed for a cheaper ad-hoc alternative

| Skill                            | Evidence                                                                      | Watch for                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `researching-anthropic-guidance` | ~7 mentions — not "very low," but its multi-agent fan-out has real token cost | The hub may be tempted to do a lightweight ad-hoc web search instead of invoking the full skill for a quick Anthropic-guidance question. Not a confirmed gap, just a pattern worth watching in future audits. |

## Low usage ≠ broken

Before proposing to widen a trigger or otherwise "fix" a low-usage skill,
check whether it's already accounted for above:

- **Incident-response skills** (`triaging-ci`, `triaging-scan-alerts`,
  `reviewing-dependabot-prs`) firing rarely is the expected, desired outcome —
  it means CI is green, scanning is clean, and dependency PRs aren't piling
  up. Re-run the [re-check usage](#how-to-re-check-usage) commands to confirm
  the backlog is still empty before assuming neglect.
- **`resolving-merge-conflicts`** stays rare as long as ADR-0024's merge
  driver keeps auto-resolving derived-artifact conflicts; a spike in manual
  invocations would actually be the anomaly worth investigating.
- **`tsconfig-strict-esm`** stays rare as long as `tsconfig.base.json` stays
  stable; this tracks the config's own volatility, not the skill's relevance.
- **Path-scoped reference skills** (`eslint-flat-config`,
  `vitest-coverage-types-mocks`) auto-load silently — a low mention count in
  `docs/logs` reflects narration habits, not actual load frequency.

## How to re-check usage

The commands this audit used, so a future check is a repeat of these instead
of a fresh investigation:

```bash
# Skill-name mentions across logs, archived plans, and git history
grep -rn "<skill-name>" docs/logs docs/plans/archive
git log --all --oneline | grep -i "<skill-name>"

# Live incident-response backlog
gh pr list --state open --author "app/dependabot"
gh run list --limit 50 --json conclusion,workflowName,createdAt
gh api repos/{owner}/{repo}/code-scanning/alerts --paginate \
  -q '.[] | select(.state=="open") | .rule.id'

# Config-file volatility (for the path-scoped reference skills)
git log --oneline -- tsconfig.base.json
git log --oneline -- eslint.config.js
git log --oneline -- packages/m3l-common/vitest.config.ts
```

A skill-name grep alone undercounts real usage (see `resolving-pr-comments`
above) — cross-check against what the skill actually _produces_ (a specific
commit-message pattern, a specific file change) rather than its own name.
