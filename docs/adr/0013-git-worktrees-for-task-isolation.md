# 0013. Git worktrees for task isolation and parallelization

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** Enrico Lionello

## Context and problem statement

Git worktrees were already in ad-hoc use (multiple merged PRs originated from
worktree branches), but the practice was undocumented, unconfigured, and quietly
risky. Three problems followed from having no recorded decision:

- **Cross-branch pollution.** Worktrees created by `claude --worktree` live under
  `.claude/worktrees/`, _nested inside_ the main checkout. Root-level glob commands
  (`pnpm lint`, `pnpm format`, `pnpm test`) traversed into them, so
  `prettier --write .` from the main tree would rewrite files belonging to another
  branch, and lint/test runs reported on foreign code.
- **Setup friction.** A fresh worktree is a clean checkout with no `node_modules`
  and none of the gitignored local files (`.env`, `.claude/` content). This had
  already cost time and was recorded in a skill's eval notes but never surfaced to
  operators.
- **No lifecycle discipline.** Worktrees accumulated and went stale (`prunable`)
  with no cleanup ritual.

We also wanted worktrees to compose with the existing **hub-and-spoke** agent model
so multiple submodule pipelines could run concurrently without colliding.

## Decision drivers

- No breaking changes to the public contract or the release pipeline.
- Minimal tooling; reuse the existing `bin/*.mjs` + `package.json` script style.
- Make the safe path the easy path; keep collisions structurally impossible.
- Keep the common single-task loop simple — parallelism is opt-in.

## Considered options

1. Do nothing (keep the ad-hoc, undocumented practice).
2. Documentation only (record conventions, no config or tooling).
3. Full formalization: technical isolation + config + setup/prune tooling + docs +
   an opt-in spoke-isolation pattern.

## Decision

We chose **option 3** because the verified cross-branch-pollution bug is a
data-loss hazard that documentation alone cannot prevent, and because the project's
parallel-agent ambitions warrant first-class support. Concretely:

- **Technical isolation (now):** `.claude/worktrees/` is excluded from `.gitignore`,
  the ESLint `ignores`, `.prettierignore`, and the Vitest `exclude` so root commands
  never reach nested worktrees. (`lint:md`/rumdl and `knip` already ignored
  `.claude/**`.)
- **Standard human flow:** manual `git worktree add ../m3l-automation-<slug> -b
feat/<slug>` (sibling directory, keeping the `feat/<slug>` branch convention and
  PR/release expectations), provisioned by `pnpm worktree:setup`. _(Superseded by
  ADR-0014: the two steps are now the single `pnpm worktree:new <slug>`, which
  branches from `origin/main` then runs `worktree:setup`. The two-command form
  still works.)_
- **Lifecycle:** `pnpm worktree:prune` removes merged/stale worktrees;
  `cleanupPeriodDays` lets agent/background worktrees auto-sweep.
- **`worktree.baseRef = "fresh"`:** new worktrees branch from `origin/main`.
- **Opt-in spoke isolation:** `isolation: worktree` is documented for running
  multiple `implement-submodule` pipelines concurrently, not hardcoded into agent
  frontmatter; concurrent edits to `docs/implementation-status.md` must be
  partitioned and rebased on land.

## Consequences

- **Positive:** eliminates the `prettier --write` cross-branch hazard; one-command
  worktree provisioning; a repeatable cleanup ritual; true opt-in parallelism for
  the agent pipelines.
- **Negative / trade-offs:** two new maintenance scripts; contributors must learn
  the worktree flow; `.worktreeinclude` applies only to `claude --worktree`/spoke
  worktrees, so the manual flow relies on `pnpm worktree:setup`.
- **Semver impact:** none — no change to `packages/m3l-common/src/**` or the
  `exports` map. Changes are repo tooling and docs (`chore:` / `docs:`).

## Links

- Supersedes / superseded by: none.
- Related: ADR-0012 (defer external code-index MCP; agent-cost/parallelism rationale);
  [Anthropic — Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees);
  [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices).
