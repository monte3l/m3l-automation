# Skills catalog and usage audit (originally 2026-07-17, patched since)

Looking for **which skill to use**, not how often each one fires? See
[`skill-routing.md`](./skill-routing.md) — an intent-to-skill lookup table,
organized by what you're trying to do rather than by usage frequency.

This is the durable reference for "how often should this skill fire?" A usage
audit on 2026-07-17 found several skills with zero or very low usage evidence
in `docs/logs/` and git history, and traced each one to a specific cause
before proposing any fix. The tables below record that classification so a
future reader doesn't have to re-run the audit to tell "working as intended"
apart from "actually neglected."

Individual rows and cells carry their own `as of <date>` evidence where it
was re-checked after the original audit (e.g. the 2026-08-31 scan-alert
recount below) — the file has been patched in place rather than re-dated as a
whole, so no single date at the top describes every row's evidence.

**Read this before "fixing" a low-usage skill.** Several skills in this repo
are intentionally low-frequency — an incident-response skill firing rarely
means the repo is healthy, not that the skill is unused. See
[Low usage ≠ broken](#low-usage--broken) below before changing a skill's
trigger conditions on the basis of a low mention count alone.

## Usage tiers

### Core pipeline — high usage, this is the primary work loop

| Skill                     | Purpose                                             | Evidence (as of 2026-07-17)                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting-work`           | Pre-work branch/worktree/PR/push gate               | ~28 mentions across `docs/logs` and `docs/plans/archive`                                                                                                                                                                                                                                                         |
| `implementing-submodules` | TDD loop for Core/AWS library modules               | ~44 mentions; referenced in all 20 submodule work logs                                                                                                                                                                                                                                                           |
| `scaffolding-submodules`  | Greenfield library module scaffold                  | ~10 mentions                                                                                                                                                                                                                                                                                                     |
| `implementing-scripts`    | TDD loop for consumer scripts                       | ~19 mentions                                                                                                                                                                                                                                                                                                     |
| `scaffolding-scripts`     | Greenfield consumer-script scaffold                 | ~18 mentions                                                                                                                                                                                                                                                                                                     |
| `syncing-docs`            | Doc/provenance/exports reconciliation               | ~67 mentions — the single most-referenced skill                                                                                                                                                                                                                                                                  |
| `auditing`                | Fan-out audit + plan, no code writes                | ~29 mentions                                                                                                                                                                                                                                                                                                     |
| `creating-prs`            | Quality gates → push → PR                           | ~14 mentions in logs/plans, plus 4 direct git-commit references                                                                                                                                                                                                                                                  |
| `finishing-work`          | Post-merge close-out (branch/worktree/refs cleanup) | Added 2026-09-02 (PR #857), post-dates this file's 2026-07-17 audit — no usage evidence to report yet. Fills the gap `creating-prs` stops short of ("confirm mergeability" was previously the last owned step). Re-audit alongside `refreshing-anthropic-guidance` once it has a few months of real invocations. |

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

| Skill                      | Trigger condition                     | State as of 2026-07-17                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triaging-ci`              | A CI run fails                        | 0 failures in the last 50 workflow runs (44 success, 4 skipped, 1 cancelled)                                                                                                                                                                |
| `triaging-scan-alerts`     | An open CodeQL/Scorecard alert exists | 0 open alerts as of 2026-08-31 (6 fixed, 7 dismissed). The previous "5 fixed, 4 dismissed" was stale: #17 never closed and #18 arrived with `maintain-scan.yml`; both were Scorecard `PinnedDependenciesID` and are now dismissed won't-fix |
| `reviewing-dependabot-prs` | An open Dependabot PR exists          | 0 open Dependabot PRs right now; 13+ already reviewed and merged historically                                                                                                                                                               |

### Low usage by design — the trigger is structurally rare

| Skill                       | Trigger condition                                                | Evidence                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolving-merge-conflicts` | An active rebase/merge has real (non-derived-artifact) conflicts | ADR-0024's registered merge driver auto-resolves most derived-artifact conflicts (`catalog.json`, `symbol-map.json`, `pnpm-lock.yaml`) before this skill would ever need to run                                                                                                                                                                       |
| `tsconfig-strict-esm`       | Editing `tsconfig*.json`                                         | `tsconfig.base.json` has been edited exactly once in the repo's entire history                                                                                                                                                                                                                                                                        |
| `harness-guide`             | The maintainer types `/harness-guide` to ask which skill applies | Added 2026-09-03. `disable-model-invocation: true` — unlike every other row in this table, its trigger isn't just rare, it's **never automatic**: it fires only when explicitly typed, so its usage count is a direct measure of how often the maintainer reaches for it rather than of anything the harness does on its own. See `skill-routing.md`. |

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

| Skill                           | Evidence                                                                                     | Gap                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promoting-work-log-lessons`    | ~3 mentions; no scheduling mechanism                                                         | Partially closed 2026-07-22: a documented cadence now exists — the sweep runs after **every 5 new logs**, checked as a `/writing-work-logs` Step 5 checklist item (it counts logs since the newest `promoted →` stamp and prompts the sweep). See `docs/logs/README.md`. Still checklist-driven, not hook-driven — re-audit whether it actually fires.                                      |
| `refreshing-anthropic-guidance` | Added 2026-08-30, post-dates this file's 2026-07-17 audit — no usage evidence to report yet. | Closed at creation, not partially: cadence is a gate, not a checklist — a machine-readable `last-verified` stamp in `docs/research/harness-refresh.md` plus the `check:harness-freshness` `pre-push` warning (ADR-0082), the self-polling design this table's other row explicitly lacked. Re-audit alongside `promoting-work-log-lessons` once both have a few months of real invocations. |

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

## GitHub integration

Five skills talk to GitHub: `creating-prs`, `resolving-pr-comments`,
`reviewing-dependabot-prs`, `triaging-ci`, `triaging-scan-alerts`. The
governing decision is `docs/adr/0030-targeted-workflow-tooling-and-mcp.md`'s
2026-07-27 amendment — read it before changing any of the mechanisms below.

| Skill                      | Mechanism                     | Why                                                                                                                                                                                 |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolving-pr-comments`    | GitHub MCP (`mcp__github__*`) | Hub-only, in-process, never a spoke or headless CI — full MCP coverage applies                                                                                                      |
| `creating-prs`             | gh CLI                        | Needs the code-scanning-alerts endpoint and `gh pr merge [--auto] --squash` (Step 15); `mcp__github__merge_pull_request` has no auto-merge equivalent, same reason as the row below |
| `reviewing-dependabot-prs` | gh CLI                        | Needs `gh pr merge --auto --squash`; `mcp__github__merge_pull_request` merges immediately, no auto-merge equivalent                                                                 |
| `triaging-scan-alerts`     | gh CLI                        | Needs the code-scanning-alerts endpoint; not in the configured default toolset                                                                                                      |
| `triaging-ci`              | gh CLI                        | Needs Actions run/log tools; not in the configured default toolset                                                                                                                  |

Two structural constraints apply to all five, independent of per-skill
coverage (see `docs/contributing/agent-operating-model.md`): **MCP is
hub-only** (no spoke holds an `mcp__*` tool grant), and **MCP is unavailable
in headless CI** (`claude-pr-review.yml` pins a scoped `--allowedTools`
allowlist with no `--mcp-config`). A skill that must run inside either context
stays gh-CLI-based regardless of toolset coverage. The 2026-07-27 amendment's
revisit trigger was retired by
ADR-0030's 2026-08-14 amendment (issue #344) — don't migrate a skill's
mechanism without re-reading that amendment's re-open condition first.

## How to re-check usage

**Primary source: real invocation counts, not a name grep.** `resolving-pr-
comments` above is the standing proof that a skill-name grep alone
undercounts — it fires every time, but is narrated by what it did rather than
its own name, so the grep this section used to recommend returned a false
zero for it. `pnpm telemetry:sessions` reads Claude Code's own session
transcripts for this project (via the `session-report` plugin, ADR-0084) and
reports a `by_skill` breakdown of what actually invoked, independent of how
any commit or log describes it:

```bash
pnpm telemetry:sessions              # last 30 days (default), this project
pnpm telemetry:sessions --since 90d  # wider window
pnpm telemetry:sessions --json | jq '.payload.by_skill'
```

It only sees sessions still on disk (Claude Code prunes old transcripts), so
it answers "recent real usage," not full history — cross-check against the
commands below for a skill's documentation trail further back:

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

These re-check commands intentionally stay on the gh CLI even though
`resolving-pr-comments` has migrated to MCP — they're one-off ad-hoc lookups
run interactively, not a skill's steady-state mechanism, which is exactly the
"plain Bash/CLI for ad-hoc work" case in
`docs/research/writing-custom-tools-and-mcp.md`.

For a skill not yet re-audited against `by_skill` (every row in this file
predates `pnpm telemetry:sessions`), still cross-check against what the
skill actually _produces_ (a specific commit-message pattern, a specific
file change) rather than trusting a name grep alone.
