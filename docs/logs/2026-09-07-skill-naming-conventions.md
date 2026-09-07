# Work log — skill naming conventions (2026-09-07)

Reviewed five harness artifacts against Anthropic's official Agent Skills
naming conventions on request, found two skill names that matched neither
the spec's gerund-phrase nor noun-phrase shape, fixed both, and added an
enforcement gate so the drift can't recur silently. Shipped as two stacked
PRs and merged the same session.

Plan of record: [`docs/plans/archive/2026-09-07-skill-naming-conventions.md`](../plans/archive/2026-09-07-skill-naming-conventions.md)

## Summary

- Reviewed `eslint-flat-config`, `tsconfig-strict-esm`, `audit-fanout`,
  `harness-guide`, `vitest-coverage-types-mocks` against
  platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
  § Naming conventions. `audit-fanout` ruled out of scope (a Workflow
  script, not a Skill). Found `tsconfig-strict-esm` and
  `vitest-coverage-types-mocks` matched neither this repo's gerund-phrase
  nor `<topic>-<head-noun>` house convention.
- **PR #1077**: `git mv` renamed `tsconfig-strict-esm` →
  `typescript-configuration`, `vitest-coverage-types-mocks` →
  `vitest-testing`; updated internal self-links, `evals.json`'s
  `skill_name` field, `skill-routing.md`'s dispatch table,
  `skills-catalog.md`'s usage rows, and a dated ADR-0093 post-acceptance
  footnote. `eslint-flat-config`/`harness-guide` kept as deliberate
  exceptions.
- **PR #1078**: added `deriveNameIssues` to `bin/lib/skill-frontmatter.mjs`,
  wired as a new hard-fail check in `check:skill-frontmatter`;
  `GRANDFATHERED_NAMES` exempts the two kept names from the shape check
  only; a spec-reserved-word hit ("anthropic"/"claude") warns rather than
  hard-fails (two real skills already violate it). 11 new tests (36 total
  in the suite). `skills-catalog.md` gained a "Naming convention" section.
- Both PRs: `pnpm verify` 66/66 locally before push; merged via
  `gh pr merge --squash` after required checks (`Dependency Review`,
  `CodeQL`, `verify`, `review`) passed. PR #1078 needed a
  `git rebase --onto origin/main` + `git push --force-with-lease` after
  #1077 merged and GitHub auto-retargeted its base to `main`.
- Skills used: `skill-creator` (naming-convention research trigger),
  `starting-work`, `creating-prs`, `writing-commits`, `finishing-work`,
  `writing-work-logs`.
- Spoke incidents: 1 resume-equivalent (dispatched `test-author` once for
  the guarded `bin/tests/**` write, no truncation) / 0 stalls / 0
  `SendMessage` resumes.
- Compaction events: none.

## What went as planned

- **The naming-shape design held up against the real 23-skill corpus on
  the first live run** — 0 spec violations, 0 shape violations, exactly 2
  reserved-word warnings, matching the pre-registered expectation before
  the test suite was even written.
- **The negative test caught what it was supposed to** — a throwaway
  `foo-helper` skill hard-failed the gate with exactly one shape-violation
  message and no other category, confirmed live, then removed cleanly with
  no trace left in `git status`.
- **`test-author` delivered a clean, correctly-scoped diff on the first
  dispatch** — only `bin/tests/check-skill-frontmatter.test.ts` touched,
  11 new tests matching the pre-resolved contract exactly, typecheck/lint/
  vitest all clean, no re-dispatch needed.
- **Both PRs' CI settled cleanly against their required checks** —
  `Dependency Review`, `CodeQL`, `verify`, `review` all passed on the first
  run for #1077 and the rebased run for #1078; no Must-fix findings from
  `claude-pr-review.yml`.

## What didn't go as planned, and why

### 1. A stale `git config user.signingkey` blocked the first commit outright

`git commit` failed with `gpg: skipped "<key>": No secret key`. The
repo-level `user.signingkey` pointed at a key with no matching secret key
in this environment's GPG keyring; `gpg --list-secret-keys` showed a
different key present, same identity (`Enrico Lionello
<enri3l@monte3l.com>`). Asked the user rather than guessing, confirmed
updating the repo-level config to the key actually present, and the
signed commit succeeded immediately after.

**Why it happened:** the signing key configured for this repo checkout and
the key material actually loaded into this environment's GPG agent had
drifted apart — likely from a prior key rotation that updated one side but
not the other.

**Fix for future:** when `gpg: No secret key` blocks a commit, run
`gpg --list-secret-keys` before assuming the fix is "disable signing" or
"generate a new key" — the right key is often already present under a
different fingerprint, and updating `user.signingkey` to match is a
one-line fix that needs no new key material.

### 2. `gh` CLI was unauthenticated when the PRs were first ready to open

After both branches were pushed and verified, `gh pr create` failed with
"You are not logged into any GitHub hosts" — and the GitHub MCP server had
also failed to connect at session start ("bad Authorization header").
Reported the blocker with both PR-creation URLs and stopped rather than
retrying blindly. A later turn (after a session context refresh) showed
`gh auth status` succeeding and GitHub MCP tools available, and both PRs
opened immediately.

**Why it happened:** the session's GitHub credentials weren't available at
the point the work was ready to ship — an environment-level auth gap, not
anything the task caused.

**Fix for future:** when `gh pr create` fails on auth, give the exact
`gh auth status` output and the PR-creation URLs git already printed on
push, then stop — don't retry `gh pr create` speculatively. Re-check
`gh auth status` fresh at the start of the next turn rather than assuming
the prior failure still holds.

### 3. Background-task monitoring for CI/push completion had three false starts before settling

First, a `pnpm verify` was launched via `nohup <cmd> & ... run_in_background:
true` together — double-backgrounding, so the harness's "completed"
notification was for the instantly-returning wrapper shell, not the actual
verify run, which kept running invisibly. Second, while cleaning up what
looked like a stray duplicate process from that mistake, a `kill -9` with a
manually-guessed PID list killed a _different_ worktree's `lint:library`
child that belonged to the real, still-wanted run. Third, an early
`Monitor` polling script re-emitted an identical "still pending" line every
20 seconds regardless of whether anything had changed, producing a stream
of duplicate, low-signal notifications before being rewritten to emit only
on an actual state transition.

**Why it happened:** backgrounding a command that itself contains `&`/
`nohup` creates two independent process trees with only one tracked by the
harness; and a `ps aux`-based guess at "which PID belongs to which run" is
unreliable once two similar command lines are running concurrently — the
actual parent-chain (`ps -o pid,ppid,cmd`) is the only reliable signal.

**Fix for future:** never combine `nohup ... &` with `run_in_background:
true` in the same call — pass the plain command and let the tool background
it. Before killing a process to free resources, walk its actual
`ppid`/`cmd` chain to confirm which run it belongs to, never guess from
`ps aux` output alone. Design a polling `Monitor` loop to be quiet by
default — track and diff the previous state, emit only on change or on the
terminal condition — rather than echoing every poll tick.

### 4. Plan mode auto-exited unexpectedly mid-task on a later "Try again" turn

A later turn reopened in plan mode (apparently a session-state artifact,
with the working directory reset to the main checkout and the on-disk
skill listing reverting to the pre-rename names as a result — expected,
since `main` didn't have the renames yet). A single read-only `git status`
call was enough to trigger an automatic exit from plan mode before any
plan-file edit was made.

**Why it happened:** unclear from within the session — plausibly a harness
transition, not anything the task did.

**Fix for future:** treat an unexpected plan-mode entry/exit as a signal to
re-verify actual repository state (branches, worktrees, PR status) before
trusting anything from before it, rather than assuming context carried
over unchanged.

## Lessons learned

- **Check `gpg --list-secret-keys` before touching signing config.** A "No
  secret key" failure often means the right key already exists under a
  different fingerprint than the one configured — fix the config, not the
  keyring.
- **Never combine your own `nohup ... &` with `run_in_background: true`.**
  This double-backgrounds the command; the harness's completion
  notification will be for the instantly-returning wrapper, not the real
  work, which then runs invisibly.
- **Confirm a process's actual parent chain (`ps -o pid,ppid,cmd`) before
  killing it to free resources**, especially when two similar commands
  from different worktrees are running concurrently — a `ps aux` guess can
  kill the wrong one.
- **Design a polling `Monitor` script to emit only on state change, not on
  every poll tick.** A loop that echoes its current status every N seconds
  regardless of whether anything changed produces a stream of duplicate
  notifications that trains the reader to skim past them.
- **A squash-merged branch's commits are never ancestors of the base after
  a stacked PR's base branch changes** — after PR1 merged, PR2's own base
  auto-retargeted to `main`, but its commit still carried PR1's
  now-duplicate content. `git rebase --onto <new-base> <old-branch-tip>
<branch>` cleanly drops the duplicate and triggers a fresh, correctly-scoped
  CI run against the real base, rather than leaving stale/duplicate commits
  or requiring a fresh branch.
  _(promoted → `.claude/skills/creating-prs/SKILL.md`)_
- **A GitHub required-status-checks list is the actual merge gate, not
  every check shown on the PR.** `Run skill evals` (26+ minutes) and `Test`
  are real CI jobs but neither is in `main`'s
  `required_status_checks.contexts` — only `Dependency Review`, `CodeQL`,
  `verify`, and `review` are. Query branch protection directly
  (`gh api repos/.../branches/main/protection/required_status_checks`)
  rather than waiting for every visible check to go green before merging.
  _(promoted → `.claude/skills/creating-prs/SKILL.md`)_
